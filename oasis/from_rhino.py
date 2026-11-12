"""Rhino model (.3dm) -> OASIS building parameters.

How to draw the model so OASIS can read it:
  - World +Y is north. Any unit (mm, cm, m, inches, feet).
  - The room: one box on a layer whose name contains "room" (or "zone" / "flat").
  - Windows: flat rectangles on the walls, on a layer whose name contains
    "window" (or "glaz" / "opening").
Only size, and window area per wall, are read. Materials, roof colour,
shading, floor level and occupants are not in the geometry: choose them
in the tool.

Limits of this first version: the room is treated as a box aligned with the
X and Y axes (its bounding box), and windows as rectangles on its four walls.
"""
from pathlib import Path

import rhino3dm

ROOM_WORDS = ("room", "zone", "flat")
WINDOW_WORDS = ("window", "glaz", "opening")

METRES_PER_UNIT = {
    "Millimeters": 0.001, "Centimeters": 0.01, "Decimeters": 0.1,
    "Meters": 1.0, "Inches": 0.0254, "Feet": 0.3048,
}


def unit_scale(model):
    """Metres per model unit."""
    name = str(model.Settings.ModelUnitSystem).split(".")[-1]
    if name not in METRES_PER_UNIT:
        raise ValueError(f"Model units '{name}' are not supported. "
                         "Use mm, cm, m, inches or feet.")
    return METRES_PER_UNIT[name], name


def box_of(obj, scale):
    """Bounding box of one object in metres: ((x0, y0, z0), (x1, y1, z1))."""
    b = obj.Geometry.GetBoundingBox()
    lo = (b.Min.X * scale, b.Min.Y * scale, b.Min.Z * scale)
    hi = (b.Max.X * scale, b.Max.Y * scale, b.Max.Z * scale)
    return lo, hi


def read_model(path):
    """Read a .3dm file. Returns (params, report):
    params  values to put on top of the baseline parameters
    report  what was found, in plain words, plus any warnings."""
    path = Path(path)
    model = rhino3dm.File3dm.Read(str(path))
    if model is None:
        raise ValueError(f"Could not read {path.name} as a Rhino .3dm file.")
    scale, unit_name = unit_scale(model)
    warnings = []

    # Sort objects into room / windows by the name of their layer
    layer_names = {layer.Index: layer.Name.lower() for layer in model.Layers}
    rooms, windows = [], []
    for obj in model.Objects:
        layer = layer_names.get(obj.Attributes.LayerIndex, "")
        if any(word in layer for word in WINDOW_WORDS):
            windows.append(box_of(obj, scale))
        elif any(word in layer for word in ROOM_WORDS):
            rooms.append(box_of(obj, scale))
    if not rooms:
        raise ValueError('No room found. Put the room box on a layer whose '
                         'name contains "room".')
    if len(rooms) > 1:
        warnings.append(f"{len(rooms)} objects on the room layer: "
                        "their overall bounding box is used as one room.")

    # The room = bounding box of everything on the room layer
    lo = tuple(min(r[0][i] for r in rooms) for i in range(3))
    hi = tuple(max(r[1][i] for r in rooms) for i in range(3))
    length, width, height = (hi[i] - lo[i] for i in range(3))
    if min(length, width, height) <= 0.1:
        raise ValueError("The room has no volume. It must be a 3D box.")

    # Each window: which wall is it on, and how big is it?
    areas = {"north": 0.0, "south": 0.0, "east": 0.0, "west": 0.0}
    counts = dict.fromkeys(areas, 0)
    for w_lo, w_hi in windows:
        dx, dy, dz = (w_hi[i] - w_lo[i] for i in range(3))
        if dz <= min(dx, dy):
            warnings.append("A horizontal window (skylight) was ignored.")
            continue
        if dy <= dx:      # thin in Y: lies on the north or south wall
            centre = (w_lo[1] + w_hi[1]) / 2
            side = "south" if abs(centre - lo[1]) < abs(centre - hi[1]) else "north"
            gap = min(abs(centre - lo[1]), abs(centre - hi[1]))
            area = dx * dz
        else:             # thin in X: lies on the east or west wall
            centre = (w_lo[0] + w_hi[0]) / 2
            side = "west" if abs(centre - lo[0]) < abs(centre - hi[0]) else "east"
            gap = min(abs(centre - lo[0]), abs(centre - hi[0]))
            area = dy * dz
        if gap > 0.5:
            warnings.append(f"A window is {gap:.2f} m away from the {side} "
                            "wall; it was counted on that wall anyway.")
        areas[side] += area
        counts[side] += 1
    if not windows:
        warnings.append("No windows found: the room is simulated without any.")

    wall_area = {"north": length * height, "south": length * height,
                 "east": width * height, "west": width * height}
    for side in areas:
        if areas[side] > 0.9 * wall_area[side]:
            warnings.append(f"Windows on the {side} wall are larger than the "
                            "wall; limited to 90 % of it.")
            areas[side] = 0.9 * wall_area[side]

    params = {
        "length_m": round(length, 3),      # along X (east-west)
        "width_m": round(width, 3),        # along Y (north-south)
        "height_m": round(height, 3),
        "orientation_deg": 0,              # model is used as drawn: +Y = north
        "window_area_m2": {s: round(a, 3) for s, a in areas.items() if a > 0},
    }
    report = {
        "file": path.name,
        "units": unit_name,
        "floor_area_m2": round(length * width, 1),
        "size": f"{length:.2f} m east-west x {width:.2f} m north-south x {height:.2f} m high",
        "windows": {s: {"count": counts[s], "area_m2": round(areas[s], 2),
                        "share_of_wall_pct": round(100 * areas[s] / wall_area[s], 1)}
                    for s in areas if counts[s]},
        "window_to_wall_pct": round(100 * sum(areas.values()) / sum(wall_area.values()), 1),
        "warnings": warnings,
    }
    return params, report
