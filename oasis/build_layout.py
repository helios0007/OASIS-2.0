"""Floor plan (data/layouts/*.json) -> multi-room EnergyPlus model (.idf).

Each room is its own zone. Walls are found from the plan: an edge that two
rooms share becomes an internal wall (115 mm brick partition) between their
zones; an edge with no room on the other side faces outdoors. Doors between
rooms, windows, balcony doors and balconies (as overhangs) come from the plan.
Air moves through the flat with the EnergyPlus AirflowNetwork: wind pressure
on each outside wall, two-way flow through windows and open internal doors.

Constructions, materials, schedules and the heatwave week are the same as the
single-room model (oasis/build_idf.py), so the two can be compared.
"""
import json
from pathlib import Path

from oasis import build_idf as b
from oasis.build_idf import IDF, StringIO

FT = 0.3048   # m per foot

# Opening height and sill by kind (not on the plans; NBC-style defaults)
OPENING_KINDS = {
    "window":       {"height": 1.2, "sill": 0.9, "surface": "Window", "opens": b.OPENABLE_FRACTION},
    "ventilator":   {"height": 0.6, "sill": 1.8, "surface": "Window", "opens": b.OPENABLE_FRACTION},
    "balcony_door": {"height": 2.1, "sill": 0.0, "surface": "Door",   "opens": 1.0},
    "entrance":     {"height": 2.1, "sill": 0.0, "surface": "Door",   "opens": None},   # kept shut
}
DOOR_HEIGHT_M = 2.1
WOOD = (0.035, 0.15, 608, 1630)   # 35 mm timber door leaf: thickness, k, density, cp

SIDES = ("north", "east", "south", "west")
OPPOSITE = {"north": "south", "south": "north", "east": "west", "west": "east"}


# --- Plan geometry --------------------------------------------------------------
def load_layout(path):
    """Read a plan (JSON in ft, y down; or a Rhino .3dm on the OASIS:: layers)
    and return it in metres, y pointing north."""
    if str(path).lower().endswith(".3dm"):
        from oasis.read_layout_3dm import read_layout_3dm
        return read_layout_3dm(path)
    lay = json.loads(Path(path).read_text(encoding="utf-8"))
    k = FT if lay.get("units", "ft") == "ft" else 1.0
    y_max = max(r[3] for room in lay["rooms"].values() for r in room["rects"])
    flip = lambda y: (y_max - y) * k
    for room in lay["rooms"].values():
        room["rects"] = [(x0 * k, flip(y1), x1 * k, flip(y0)) for x0, y0, x1, y1 in room["rects"]]

    def along(wall, a, c):
        """Position along a wall in metres (x for north/south, y for east/west)."""
        lo, hi = (a * k, c * k) if wall in ("north", "south") else (flip(c), flip(a))
        return min(lo, hi), max(lo, hi)

    for o in lay["openings"]:
        o["span"] = along(o["wall"], o["from"], o["to"])
    for d in lay["doors"]:
        d["span_x"] = (d["from"] * k, d["to"] * k)
        d["span_y"] = tuple(sorted((flip(d["from"]), flip(d["to"]))))
    for bal in lay.get("balconies", []):
        bal["depth_m"] = bal["depth"] * k
    lay["height_m"] = lay.get("height_m", 3.0)
    lay["party_walls"] = [(axis, flip(at) if axis == "x" else at * k,
                           *sorted(along("north" if axis == "x" else "west", a, c)))
                          for axis, at, a, c in lay.get("party_walls", [])]
    return lay


def edges(rect):
    """The four edges of a rectangle: side -> (fixed coordinate, start, end)."""
    x0, y0, x1, y1 = rect
    return {"south": (y0, x0, x1), "north": (y1, x0, x1), "west": (x0, y0, y1), "east": (x1, y0, y1)}


def wall_segments(rooms, tol=1e-6):
    """Split every room edge into pieces: (room, side, fixed, a0, a1, neighbour).
    neighbour is the room across the edge, the same room (an internal edge of an
    L-shaped room: no wall), or None (outdoors)."""
    out = []
    for name, room in rooms.items():
        for rect in room["rects"]:
            for side, (fixed, a0, a1) in edges(rect).items():
                cover = []    # (start, end, neighbour)
                for other, oroom in rooms.items():
                    for orect in oroom["rects"]:
                        if orect is rect:
                            continue
                        ofixed, b0, b1 = edges(orect)[OPPOSITE[side]]
                        if abs(ofixed - fixed) < tol and min(a1, b1) - max(a0, b0) > tol:
                            cover.append((max(a0, b0), min(a1, b1), other))
                cover.sort()
                pos = a0
                for c0, c1, other in cover:
                    if c0 - pos > tol:
                        out.append((name, side, fixed, pos, c0, None))
                    out.append((name, side, fixed, c0, c1, other))
                    pos = max(pos, c1)
                if a1 - pos > tol:
                    out.append((name, side, fixed, pos, a1, None))
    return [s for s in out if s[5] != s[0]]


def split_party(segs, party, snap=0.30, tol=1e-6):
    """Mark the parts of outside wall pieces that lie on a party wall line
    (axis, fixed, start, end) with neighbour "party": they face another flat or
    the stair core, so no sun, no wind, no heat flow (adiabatic)."""
    out = []
    for seg in segs:
        room, side, fixed, a0, a1, other = seg
        axis = "x" if side in ("north", "south") else "y"
        cover = sorted((max(a0, lo), min(a1, hi)) for ax, at, lo, hi in party
                       if other is None and ax == axis and abs(at - fixed) <= snap and min(a1, hi) - max(a0, lo) > tol)
        if not cover:
            out.append(seg)
            continue
        pos = a0
        for c0, c1 in cover:
            if c0 - pos > tol:
                out.append((room, side, fixed, pos, c0, None))
            if c1 - max(pos, c0) > tol:
                out.append((room, side, fixed, max(pos, c0), c1, "party"))
            pos = max(pos, c1)
        if a1 - pos > tol:
            out.append((room, side, fixed, pos, a1, None))
    return out


def windowless_party(segs, openings, tol=1e-6):
    """Bound for plans that do not show the neighbours: every outside wall piece
    with no window, ventilator or door in it is taken as shared (adiabatic).
    A shut entrance door does not count as an opening (it leads to the corridor)."""
    def has_opening(room, side, a0, a1):
        return any(o["room"] == room and o["wall"] == side and o["kind"] != "entrance"
                   and a0 - tol <= o["span"][0] and o["span"][1] <= a1 + tol for o in openings)
    return [(r, sd, f, a0, a1, "party") if other is None and not has_opening(r, sd, a0, a1)
            else (r, sd, f, a0, a1, other) for r, sd, f, a0, a1, other in segs]


def wall_vertices(side, fixed, a0, a1, z0, z1):
    """Upper-left first, counterclockwise seen from outside the zone."""
    return {
        "south": [(a0, fixed, z1), (a0, fixed, z0), (a1, fixed, z0), (a1, fixed, z1)],
        "east":  [(fixed, a0, z1), (fixed, a0, z0), (fixed, a1, z0), (fixed, a1, z1)],
        "north": [(a1, fixed, z1), (a1, fixed, z0), (a0, fixed, z0), (a0, fixed, z1)],
        "west":  [(fixed, a1, z1), (fixed, a1, z0), (fixed, a0, z0), (fixed, a0, z1)],
    }[side]


def set_vertices(obj, vertices):
    for i, (x, y, z) in enumerate(vertices, start=1):
        setattr(obj, f"Vertex_{i}_Xcoordinate", round(x, 4))
        setattr(obj, f"Vertex_{i}_Ycoordinate", round(y, 4))
        setattr(obj, f"Vertex_{i}_Zcoordinate", round(z, 4))


def zone_id(name):
    return name.upper()


def seg_name(prefix, room, side, a0):
    return f"{prefix}_{room}_{side}_{a0:.2f}"


# --- Model ----------------------------------------------------------------------
def build_layout_idf(lay, p, out_path):
    """p: the usual OASIS parameters (wall, roof, roof colour, night_vent,
    occupants, run period, calibration settings ...); geometry comes from lay."""
    idf = IDF(StringIO("Version,26.2;"))
    p = dict(p, name=lay["name"].replace(",", "").replace(";", ""))   # IDF field separators
    H = lay["height_m"]
    rooms = lay["rooms"]

    b.add_settings(idf, p)
    b.add_constructions(idf, p)
    b.add_construction(idf, "partition", ["plaster", "brick_115", "plaster"])
    idf.newidfobject("MATERIAL", Name="wood", Roughness="MediumSmooth", Thickness=WOOD[0],
                     Conductivity=WOOD[1], Density=WOOD[2], Specific_Heat=WOOD[3])
    b.add_construction(idf, "door", ["wood"])
    idf.newidfobject("WINDOWMATERIAL:SIMPLEGLAZINGSYSTEM", Name="single_glass",
                     UFactor=b.GLASS_U, Solar_Heat_Gain_Coefficient=b.GLASS_SHGC)
    b.add_construction(idf, "window", ["single_glass"])

    for name in rooms:
        idf.newidfobject("ZONE", Name=zone_id(name), Z_Origin=p.get("height_above_ground_m", 0.0))

    # Walls
    segs = split_party(wall_segments(rooms), lay.get("party_walls", []))
    if p.get("party_walls") == "windowless":
        segs = windowless_party(segs, lay["openings"])
    for room, side, fixed, a0, a1, other in segs:
        s = idf.newidfobject("BUILDINGSURFACE:DETAILED", Surface_Type="Wall", Zone_Name=zone_id(room),
                             Number_of_Vertices=4)
        if other == "party":
            s.Name, s.Construction_Name = seg_name("pw", room, side, a0), "wall"
            s.Outside_Boundary_Condition, s.Sun_Exposure, s.Wind_Exposure = "Adiabatic", "NoSun", "NoWind"
        elif other is None:
            s.Name, s.Construction_Name = seg_name("ew", room, side, a0), "wall"
            s.Outside_Boundary_Condition, s.Sun_Exposure, s.Wind_Exposure = "Outdoors", "SunExposed", "WindExposed"
        else:
            s.Name, s.Construction_Name = seg_name("iw", room, side, a0), "partition"
            s.Outside_Boundary_Condition = "Surface"
            s.Outside_Boundary_Condition_Object = seg_name("iw", other, OPPOSITE[side], a0)
            s.Sun_Exposure, s.Wind_Exposure = "NoSun", "NoWind"
        set_vertices(s, wall_vertices(side, fixed, a0, a1, 0.0, H))

    # Roof (or ceiling) and floor, one per rectangle
    top_floor = p.get("floor", "top") == "top"
    for room, r in ((n, rect) for n, rm in rooms.items() for rect in rm["rects"]):
        x0, y0, x1, y1 = r
        tag = f"{room}_{x0:.2f}_{y0:.2f}"
        roof = idf.newidfobject("BUILDINGSURFACE:DETAILED", Name=f"roof_{tag}", Zone_Name=zone_id(room),
                                Surface_Type="Roof" if top_floor else "Ceiling",
                                Construction_Name="roof" if top_floor else "ceiling",
                                Outside_Boundary_Condition="Outdoors" if top_floor else "Adiabatic",
                                Sun_Exposure="SunExposed" if top_floor else "NoSun",
                                Wind_Exposure="WindExposed" if top_floor else "NoWind", Number_of_Vertices=4)
        set_vertices(roof, [(x0, y0, H), (x1, y0, H), (x1, y1, H), (x0, y1, H)])
        fl = idf.newidfobject("BUILDINGSURFACE:DETAILED", Name=f"floor_{tag}", Zone_Name=zone_id(room),
                              Surface_Type="Floor", Construction_Name="floor", Outside_Boundary_Condition="Adiabatic",
                              Sun_Exposure="NoSun", Wind_Exposure="NoWind", Number_of_Vertices=4)
        set_vertices(fl, [(x0, y1, 0), (x1, y1, 0), (x1, y0, 0), (x0, y0, 0)])

    # Windows and doors to the outside, on the outside wall piece that holds them
    balcony = {(bal["room"], bal["wall"]): bal["depth_m"] for bal in lay.get("balconies", [])}
    vents = []    # (surface name, opening factor) for the AirflowNetwork
    for i, o in enumerate(lay["openings"]):
        kind = OPENING_KINDS[o["kind"]]
        lo, hi = o["span"]
        host = [s for s in segs if s[0] == o["room"] and s[1] == o["wall"] and s[5] is None
                and s[3] - 1e-6 <= lo and hi <= s[4] + 1e-6]
        if not host and kind["opens"] is None and any(
                s[0] == o["room"] and s[1] == o["wall"] and s[5] == "party" for s in segs):
            continue          # shut entrance in a shared wall: modelled as wall
        if not host:
            raise ValueError(f"opening {i} ({o['room']} {o['wall']}) is not on an outside wall")
        room, side, fixed, a0, _, _ = host[0]
        name = f"{o['kind']}_{room}_{i}"
        f = idf.newidfobject("FENESTRATIONSURFACE:DETAILED", Name=name, Surface_Type=kind["surface"],
                             Construction_Name="window" if kind["surface"] == "Window" else "door",
                             Building_Surface_Name=seg_name("ew", room, side, a0), Number_of_Vertices=4)
        set_vertices(f, wall_vertices(side, fixed, lo, hi, kind["sill"], kind["sill"] + kind["height"]))
        depth = balcony.get((room, side), 0.0) + p.get("shading_depth_m", 0.0)
        if depth > 0:
            idf.newidfobject("SHADING:OVERHANG", Name=f"overhang_{name}", Window_or_Door_Name=name,
                             Height_above_Window_or_Door=H - kind["sill"] - kind["height"],
                             Tilt_Angle_from_WindowDoor=90, Left_extension_from_WindowDoor_Width=0.0,
                             Right_extension_from_WindowDoor_Width=0.0, Depth=depth)
        if kind["opens"]:
            vents.append((name, kind["opens"]))

    # Doors between rooms: a pair of door surfaces, one in each room's wall
    inner = []
    for i, d in enumerate(lay["doors"]):
        a, c = d["rooms"]
        found = None
        for room, side, fixed, a0, a1, other in segs:
            if room == a and other == c:
                lo, hi = d["span_x"] if side in ("north", "south") else d["span_y"]
                lo, hi = min(lo, hi), max(lo, hi)
                if a0 - 1e-6 <= lo and hi <= a1 + 1e-6:
                    found = (side, fixed, a0, lo, hi)
                    break
        if not found:
            raise ValueError(f"door {i} ({a} - {c}) is not on a wall the two rooms share")
        side, fixed, a0, lo, hi = found
        top = DOOR_HEIGHT_M
        for host, guest, hside in ((a, c, side), (c, a, OPPOSITE[side])):
            f = idf.newidfobject("FENESTRATIONSURFACE:DETAILED", Name=f"door_{host}_{guest}_{i}", Surface_Type="Door",
                                 Construction_Name="door", Building_Surface_Name=seg_name("iw", host, hside, a0),
                                 Outside_Boundary_Condition_Object=f"door_{guest}_{host}_{i}", Number_of_Vertices=4)
            set_vertices(f, wall_vertices(hside, fixed, lo, hi, 0.0, top))
        inner.append(f"door_{a}_{c}_{i}")

    # Partition faces already in the model (each listed once per room side)
    partition_m2 = sum((a1 - a0) * H for room, side, fixed, a0, a1, other in segs
                       if other not in (None, "party", room))
    add_gains(idf, p, rooms, partition_m2)
    add_afn(idf, p, lay, segs, vents, inner)
    add_outputs(idf)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    idf.saveas(str(out_path))
    return out_path


def add_gains(idf, p, rooms, partition_m2=0.0):
    """People in the living room by day and in the bedrooms at night (split
    evenly); appliance and cooking heat half in the kitchen, half in the living
    room, on the same daily profile as the single-room model."""
    b.add_day_schedule(idf, "in_living", [(6, 0.0), (8, 1.0), (18, 0.5), (22, 1.0), (24, 0.0)])
    b.add_day_schedule(idf, "in_bedroom", [(6, 1.0), (22, 0.0), (24, 1.0)])
    b.add_day_schedule(idf, "appliance_use", [(6, 0.15), (8, 0.5), (18, 0.2), (22, 1.0), (24, 0.15)])
    idf.newidfobject("SCHEDULE:CONSTANT", Name="activity_w", Schedule_Type_Limits_Name="any_number",
                     Hourly_Value=b.ACTIVITY_W)
    bedrooms = [n for n, r in rooms.items() if r["type"] == "bedroom"]
    n = p["occupants"]
    for name, r in rooms.items():
        if r["type"] == "living":
            people, sched = n, "in_living"
        elif r["type"] == "bedroom":
            people, sched = n / len(bedrooms), "in_bedroom"
        else:
            continue
        idf.newidfobject("PEOPLE", Name=f"people_{name}", Zone_or_ZoneList_or_Space_or_SpaceList_Name=zone_id(name),
                         Number_of_People_Schedule_Name=sched, Number_of_People_Calculation_Method="People",
                         Number_of_People=people, Fraction_Radiant=0.3, Activity_Level_Schedule_Name="activity_w")
    heat_rooms = [n for n, r in rooms.items() if r["type"] in ("kitchen", "living")]
    for name in heat_rooms:
        idf.newidfobject("ELECTRICEQUIPMENT", Name=f"appliances_{name}",
                         Zone_or_ZoneList_or_Space_or_SpaceList_Name=zone_id(name), Schedule_Name="appliance_use",
                         Design_Level_Calculation_Method="EquipmentLevel",
                         Design_Level=b.setting(p, "appliances_peak_w") / len(heat_rooms),
                         Fraction_Latent=b.APPLIANCES_LATENT, Fraction_Radiant=0.3)
    # Calibrated internal mass is for the 30 m2 single-room box (partitions and
    # furniture together). Scale it to this flat's floor, take off the partitions
    # that are now real walls, and share the rest between rooms by floor area.
    floor = {n: sum((x1 - x0) * (y1 - y0) for x0, y0, x1, y1 in r["rects"]) for n, r in rooms.items()}
    per_m2 = b.setting(p, "internal_mass_m2") / (b.BOX_FLOOR_M2)
    furniture = max(0.0, per_m2 * sum(floor.values()) - partition_m2)
    for name, a in floor.items():
        if furniture * a > 0:
            idf.newidfobject("INTERNALMASS", Name=f"furniture_{zone_id(name)}", Construction_Name="partition",
                             Zone_or_ZoneList_Name=zone_id(name), Surface_Area=round(furniture * a / sum(floor.values()), 2))


def add_afn(idf, p, lay, segs, vents, inner):
    """AirflowNetwork for the whole flat (see build_idf.add_airflow_network)."""
    xs = [v for r in lay["rooms"].values() for rect in r["rects"] for v in (rect[0], rect[2])]
    ys = [v for r in lay["rooms"].values() for rect in r["rects"] for v in (rect[1], rect[3])]
    L, W = max(xs) - min(xs), max(ys) - min(ys)
    if p["night_vent"]:
        b.add_day_schedule(idf, "windows_open", [(24, 1.0)])
    else:
        b.add_day_schedule(idf, "windows_open", [(b.setting(p, "windows_open_hour"), 0.0),
                                                 (b.setting(p, "windows_close_hour"), 1.0), (24, 0.0)])
    idf.newidfobject("SCHEDULE:CONSTANT", Name="always_on", Schedule_Type_Limits_Name="any_number", Hourly_Value=1.0)
    long_axis = (p.get("orientation_deg", 0) + (90 if L >= W else 0)) % 180
    b.add_obj(idf, "AIRFLOWNETWORK:SIMULATIONCONTROL", "afn", "MultizoneWithoutDistribution",
              "SurfaceAverageCalculation", "OpeningHeight", "LowRise", 500, "ZeroNodePressures",
              1e-4, 1e-6, -0.5, long_axis, min(L, W) / max(L, W))
    for name in lay["rooms"]:
        b.add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:ZONE", zone_id(name), "Constant", "", 1.0,
                  0.0, 100.0, 0.0, 300000.0, "windows_open")
    b.add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:REFERENCECRACKCONDITIONS", "ref_crack", 20.0, 101325, 0.0)
    b.add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:COMPONENT:SIMPLEOPENING", "opening",
              b.CLOSED_WINDOW_COEFF, b.FLOW_EXPONENT, 0.0001, b.DISCHARGE_COEFF)
    for name, factor in vents:
        b.add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:SURFACE", name, "opening", "", factor, "ZoneLevel")
    for name in inner:   # internal doors: always open
        b.add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:SURFACE", name, "opening", "", 1.0, "Constant",
                  "", 0.0, 0.0, 100.0, 0.0, 300000.0, "always_on")
    leak = b.setting(p, "wall_leakage_cm2_per_m2") * 1e-4
    for room, side, fixed, a0, a1, other in segs:
        if other is None:
            nm = seg_name("ew", room, side, a0)
            b.add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:SURFACE:EFFECTIVELEAKAGEAREA", f"leak_{nm}",
                      leak * (a1 - a0) * lay["height_m"], 1.0, 4.0, b.FLOW_EXPONENT)
            b.add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:SURFACE", nm, f"leak_{nm}", "", 1.0)


def add_outputs(idf):
    for variable in ("Zone Mean Air Temperature", "Zone Mean Radiant Temperature",
                     "Zone Air Relative Humidity", "Site Outdoor Air Drybulb Temperature",
                     "Site Outdoor Air Relative Humidity", "AFN Zone Ventilation Air Change Rate",
                     "AFN Zone Infiltration Air Change Rate"):
        idf.newidfobject("OUTPUT:VARIABLE", Key_Value="*", Variable_Name=variable, Reporting_Frequency="Hourly")
