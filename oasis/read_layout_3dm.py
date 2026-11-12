"""Rhino plan (.3dm on the OASIS:: layers) -> layout for oasis/build_layout.py.

Layers (see rhino/draw_layout.py, which draws them from a plan JSON):
  OASIS::room::<name>   closed axis-aligned rectangle(s); user text type, fan (yes/no)
  OASIS::window, ::ventilator, ::balcony_door, ::entrance   line along an outside wall
  OASIS::door           line on a wall two rooms share; user text kind (door / doorway)
  OASIS::balcony        closed rectangle against a room's outside wall
  OASIS::party_wall     line along a wall shared with a neighbour flat or stair core
  OASIS::north          line drawn from tail to tip, pointing north (optional)

Only geometry decides which room and wall an opening, door or balcony belongs
to (user text on those is ignored), so a plan edited or drawn by hand in Rhino
works the same as one drawn by the script. Walls must run along x or y; turn
the building with the north arrow instead.
"""
import math
from pathlib import Path

import rhino3dm

SNAP_M = 0.30          # a line this close to a room edge belongs to it (a 230 mm wall drawn on either face)
OPENING_LAYERS = ("window", "ventilator", "balcony_door", "entrance")
UNIT_TO_M = {"Millimeters": 0.001, "Centimeters": 0.01, "Meters": 1.0, "Feet": 0.3048, "Inches": 0.0254}
ROOM_TYPES = ("bedroom", "living", "kitchen", "toilet", "pooja")


def _points(geom):
    """Corner points of a curve on the plan (z ignored)."""
    if isinstance(geom, rhino3dm.LineCurve):
        return [(geom.PointAtStart.X, geom.PointAtStart.Y), (geom.PointAtEnd.X, geom.PointAtEnd.Y)]
    if isinstance(geom, rhino3dm.PolylineCurve):
        return [(geom.Point(i).X, geom.Point(i).Y) for i in range(geom.PointCount)]
    ok, pl = geom.TryGetPolyline() if hasattr(geom, "TryGetPolyline") else (False, None)
    if ok:
        return [(pl[i].X, pl[i].Y) for i in range(pl.Count)]
    raise ValueError(f"cannot read a {type(geom).__name__} as plan lines")


def _rect(pts, where, tol=1e-3):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    if any(min(abs(x - x0), abs(x - x1)) > tol or min(abs(y - y0), abs(y - y1)) > tol for x, y in pts):
        raise ValueError(f"{where}: not a rectangle along x and y (turn the plan with the north arrow instead)")
    return (x0, y0, x1, y1)


def _line(pts, where, tol=1e-3):
    (ax, ay), (bx, by) = pts[0], pts[-1]
    if abs(ax - bx) < tol:
        return "y", ax, min(ay, by), max(ay, by)      # runs along y at x = ax
    if abs(ay - by) < tol:
        return "x", ay, min(ax, bx), max(ax, bx)      # runs along x at y = ay
    raise ValueError(f"{where}: line is not along x or y")


def _room_edges(rooms):
    """Every room edge: (room, side, axis it runs along, fixed coordinate, start, end)."""
    for name, room in rooms.items():
        for x0, y0, x1, y1 in room["rects"]:
            yield name, "south", "x", y0, x0, x1
            yield name, "north", "x", y1, x0, x1
            yield name, "west", "y", x0, y0, y1
            yield name, "east", "y", x1, y0, y1


def _edges_holding(rooms, axis, at, lo, hi):
    """Room edges a line lies on (within SNAP_M across, fully inside along)."""
    tol = 1e-3
    return [(n, s, f) for n, s, ax, f, a0, a1 in _room_edges(rooms)
            if ax == axis and abs(f - at) <= SNAP_M and a0 - tol <= lo and hi <= a1 + tol]


def read_layout_3dm(path):
    """Return a layout in the form oasis.build_layout.load_layout gives (metres, y north)."""
    path = Path(path)
    model = rhino3dm.File3dm.Read(str(path))
    if model is None:
        raise ValueError(f"cannot open {path}")
    k = UNIT_TO_M.get(str(model.Settings.ModelUnitSystem).split(".")[-1], 1.0)
    layer_of = {i: l.FullPath for i, l in enumerate(model.Layers)}

    by_layer = {}
    for obj in model.Objects:
        lp = layer_of.get(obj.Attributes.LayerIndex, "")
        if not lp.startswith("OASIS::") or lp.startswith("OASIS::preview"):
            continue
        if not isinstance(obj.Geometry, rhino3dm.Curve):
            continue          # text, arrow heads drawn as other objects, ...
        pts = [(x * k, y * k) for x, y in _points(obj.Geometry)]
        by_layer.setdefault(lp, []).append((pts, obj.Attributes))

    # Rooms
    rooms = {}
    for lp, items in by_layer.items():
        if not lp.startswith("OASIS::room::"):
            continue
        name = lp.split("::")[2]
        for pts, attr in items:
            room = rooms.setdefault(name, {"rects": []})
            room["rects"].append(_rect(pts, lp))
            t = attr.GetUserString("type")
            if t:
                room["type"] = t
            fan = attr.GetUserString("fan")
            if fan:
                room["fan"] = fan.strip().lower() in ("yes", "true", "1")
    if not rooms:
        raise ValueError(f"{path.name}: no rooms on OASIS::room::<name> layers")
    for name, room in rooms.items():
        room.setdefault("type", next((t for t in ROOM_TYPES if name.startswith(t)), "other"))
        room.setdefault("fan", room["type"] in ("bedroom", "living"))

    # Party walls (read before openings so an opening on one is reported)
    party = [_line(pts, "OASIS::party_wall") for pts, _ in by_layer.get("OASIS::party_wall", [])]

    # Openings in outside walls
    openings = []
    for kind in OPENING_LAYERS:
        for pts, _ in by_layer.get(f"OASIS::{kind}", []):
            axis, at, lo, hi = _line(pts, f"OASIS::{kind}")
            held = _edges_holding(rooms, axis, at, lo, hi)
            outside = [h for h in held if not _shared(rooms, h[0], h[1], h[2], lo, hi)]
            if len(outside) != 1:
                raise ValueError(f"OASIS::{kind} at {_where(axis, at, lo, hi)}: on {len(outside)} outside room walls, "
                                 f"needs exactly one")
            room, side, _ = outside[0]
            openings.append({"room": room, "wall": side, "kind": kind, "span": (lo, hi)})

    # Doors between rooms
    doors = []
    for pts, attr in by_layer.get("OASIS::door", []):
        axis, at, lo, hi = _line(pts, "OASIS::door")
        held = sorted({h[0] for h in _edges_holding(rooms, axis, at, lo, hi)})
        if len(held) != 2:
            raise ValueError(f"OASIS::door at {_where(axis, at, lo, hi)}: touches rooms {held}, needs two")
        doors.append({"rooms": held, "kind": attr.GetUserString("kind") or "door",
                      "span_x": (lo, hi), "span_y": (lo, hi)})

    # Balconies: the room wall the rectangle touches; depth across it
    balconies = []
    for pts, _ in by_layer.get("OASIS::balcony", []):
        bx0, by0, bx1, by1 = _rect(pts, "OASIS::balcony")
        found = None
        for n, side, axis, f, a0, a1 in _room_edges(rooms):
            lo, hi = (bx0, bx1) if axis == "x" else (by0, by1)
            near = {"west": bx1, "east": bx0, "south": by1, "north": by0}[side]
            if abs(near - f) <= SNAP_M and min(a1, hi) - max(a0, lo) > 0.5 * (hi - lo):
                found = (n, side, (bx1 - bx0) if axis == "y" else (by1 - by0))
                break
        if not found:
            raise ValueError("OASIS::balcony: does not touch a room's outside wall")
        balconies.append({"room": found[0], "wall": found[1], "depth_m": found[2]})

    lay = {"name": path.stem.replace("_", " "), "source": str(path), "height_m": 3.0, "rooms": rooms,
           "openings": openings, "doors": doors, "balconies": balconies, "party_walls": party}
    north = by_layer.get("OASIS::north", [])
    lines = [pts for pts, _ in north if len(pts) == 2]
    if lines:
        (ax, ay), (bx, by) = lines[0]
        theta = math.degrees(math.atan2(bx - ax, by - ay))      # north, clockwise from the plan's +y
        lay["orientation_deg"] = round((-theta) % 360, 1)       # EnergyPlus North_Axis of the plan
    return lay


def _shared(rooms, room, side, at, lo, hi):
    """True if another room sits across this edge over the line."""
    opp = {"north": "south", "south": "north", "east": "west", "west": "east"}[side]
    axis = "x" if side in ("north", "south") else "y"
    return any(n != room and s == opp and abs(f - at) < 1e-3 and min(a1, hi) - max(a0, lo) > 1e-3
               for n, s, ax, f, a0, a1 in _room_edges(rooms) if ax == axis)


def _where(axis, at, lo, hi):
    return f"{'y' if axis == 'x' else 'x'} = {at:.2f} m, {axis} {lo:.2f}–{hi:.2f} m"
