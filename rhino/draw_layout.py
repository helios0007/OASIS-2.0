# Draw an OASIS layout (data/layouts/*.json) on the OASIS:: layers that the
# energy model reads back (oasis/read_layout_3dm.py). Runs INSIDE Rhino (IronPython 2.7):
#     LAYOUT = r"D:\IAAC\OASIS 2.0\data\layouts\amudha_3bhk.json"
#     execfile(r"D:\IAAC\OASIS 2.0\rhino\draw_layout.py")
# Layers (metres, plan on z = 0, y = north unless the north arrow says otherwise):
#   OASIS::room::<name>   closed rectangle per room part; user text type, fan (yes/no)
#   OASIS::window / ventilator / balcony_door / entrance   a line along the outside wall
#   OASIS::door           a line on the wall two rooms share; user text kind (door/doorway)
#   OASIS::balcony        closed rectangle against the room's outside wall
#   OASIS::party_wall     a line along a wall shared with a neighbour flat or stair core
#   OASIS::north          a line from tail to tip pointing north
#   OASIS::preview        3D boxes for looking only (not read)
# It replaces any earlier OASIS:: layers; other layers (e.g. Detail::) are kept.
import rhinoscriptsyntax as rs, json, io

for lp in sorted([l for l in rs.LayerNames() if l.startswith("OASIS")], key=lambda s: -s.count("::")):
    objs = rs.ObjectsByLayer(lp)
    if objs:
        rs.DeleteObjects(objs)
    rs.DeleteLayer(lp)

FT = 0.3048
lay = json.load(io.open(LAYOUT, encoding="utf-8"))
H = lay.get("height_m", 3.0)
ymax = max(r[3] for room in lay["rooms"].values() for r in room["rects"])
fx = lambda x: x * FT
fy = lambda y: (ymax - y) * FT
COL = {"bedroom": (214, 140, 90), "living": (200, 200, 190), "kitchen": (190, 205, 170),
       "toilet": (150, 150, 120), "pooja": (220, 200, 150)}
OPEN_COL = {"window": (2, 132, 199), "ventilator": (56, 189, 248), "balcony_door": (234, 88, 12),
            "entrance": (63, 63, 70), "door": (161, 98, 7)}
KIND_H = {"window": (0.9, 2.1), "ventilator": (1.8, 2.4), "balcony_door": (0.0, 2.1), "entrance": (0.0, 2.1)}


def layer(path, color=None):
    parts = path.split("::")
    for i in range(1, len(parts) + 1):
        p = "::".join(parts[:i])
        if not rs.IsLayer(p):
            rs.AddLayer(parts[i - 1], color if (i == len(parts) and color) else None,
                        parent=("::".join(parts[:i - 1]) or None))
    return path


layer("OASIS"); layer("OASIS::room"); layer("OASIS::preview", (180, 180, 180))
layer("OASIS::party_wall", (220, 38, 38))
for name, room in lay["rooms"].items():
    lp = layer("OASIS::room::" + name, COL.get(room["type"]))
    for x0, y0, x1, y1 in room["rects"]:
        a, b, c, d = fx(x0), fy(y1), fx(x1), fy(y0)
        crv = rs.AddPolyline([(a, b, 0), (c, b, 0), (c, d, 0), (a, d, 0), (a, b, 0)])
        rs.ObjectLayer(crv, lp); rs.ObjectName(crv, name)
        rs.SetUserText(crv, "type", room["type"]); rs.SetUserText(crv, "fan", "yes" if room["fan"] else "no")
        box = rs.AddBox([(a, b, 0), (c, b, 0), (c, d, 0), (a, d, 0), (a, b, H), (c, b, H), (c, d, H), (a, d, H)])
        rs.ObjectLayer(box, "OASIS::preview"); rs.ObjectColor(box, COL.get(room["type"]))
    rect = room["rects"][0]
    t = rs.AddText(name.replace("_", " "), (fx((rect[0] + rect[2]) / 2), fy((rect[1] + rect[3]) / 2), H + 0.05),
                   0.3, justification=2 + 131072)
    rs.ObjectLayer(t, "OASIS::preview")


def wall_line(room, wall, a0, a1):
    rects = lay["rooms"][room]["rects"]
    if wall in ("north", "south"):
        r = [r for r in rects if r[0] - 1e-6 <= min(a0, a1) and max(a0, a1) <= r[2] + 1e-6][0]
        y = fy(r[1] if wall == "north" else r[3])
        return (fx(a0), y), (fx(a1), y)
    r = [r for r in rects if r[1] - 1e-6 <= min(a0, a1) and max(a0, a1) <= r[3] + 1e-6][0]
    x = fx(r[0] if wall == "west" else r[2])
    return (x, fy(a0)), (x, fy(a1))


for o in lay["openings"]:
    lp = layer("OASIS::" + o["kind"], OPEN_COL[o["kind"]])
    (x0, y0), (x1, y1) = wall_line(o["room"], o["wall"], o["from"], o["to"])
    ln = rs.AddLine((x0, y0, 0), (x1, y1, 0)); rs.ObjectLayer(ln, lp)
    rs.SetUserText(ln, "room", o["room"]); rs.SetUserText(ln, "wall", o["wall"])
    z0, z1 = KIND_H[o["kind"]]
    pan = rs.AddSrfPt([(x0, y0, z0), (x1, y1, z0), (x1, y1, z1), (x0, y0, z1)])
    rs.ObjectLayer(pan, "OASIS::preview"); rs.ObjectColor(pan, OPEN_COL[o["kind"]])


def shared_edges(a, b):
    out = []
    for r in lay["rooms"][a]["rects"]:
        for s in lay["rooms"][b]["rects"]:
            for ea, eb, axis in ((r[2], s[0], "x"), (r[0], s[2], "x"), (r[3], s[1], "y"), (r[1], s[3], "y")):
                if abs(ea - eb) < 1e-6:
                    lo, hi = ((max(r[1], s[1]), min(r[3], s[3])) if axis == "x" else (max(r[0], s[0]), min(r[2], s[2])))
                    if hi > lo:
                        out.append((axis, ea, lo, hi))
    return out


lp = layer("OASIS::door", OPEN_COL["door"])
missing = []
for d in lay["doors"]:
    done = False
    for axis, at, lo, hi in shared_edges(*d["rooms"]):
        if lo - 1e-6 <= d["from"] and d["to"] <= hi + 1e-6:
            if axis == "x":
                p0, p1 = (fx(at), fy(d["from"])), (fx(at), fy(d["to"]))
            else:
                p0, p1 = (fx(d["from"]), fy(at)), (fx(d["to"]), fy(at))
            ln = rs.AddLine((p0[0], p0[1], 0), (p1[0], p1[1], 0)); rs.ObjectLayer(ln, lp)
            rs.SetUserText(ln, "rooms", ",".join(d["rooms"])); rs.SetUserText(ln, "kind", d.get("kind", "door"))
            pan = rs.AddSrfPt([(p0[0], p0[1], 0), (p1[0], p1[1], 0), (p1[0], p1[1], 2.1), (p0[0], p0[1], 2.1)])
            rs.ObjectLayer(pan, "OASIS::preview"); rs.ObjectColor(pan, OPEN_COL["door"])
            done = True
            break
    if not done:
        missing.append(d["rooms"])

lp = layer("OASIS::balcony", (120, 113, 108))
for bal in lay.get("balconies", []):
    x0, y0, x1, y1 = lay["rooms"][bal["room"]]["rects"][0]
    a, b, c, e = fx(x0), fy(y1), fx(x1), fy(y0); dd = bal["depth"] * FT
    pts = {"west": [(a - dd, b), (a, b), (a, e), (a - dd, e)], "east": [(c, b), (c + dd, b), (c + dd, e), (c, e)],
           "north": [(a, e), (c, e), (c, e + dd), (a, e + dd)], "south": [(a, b - dd), (c, b - dd), (c, b), (a, b)]}[bal["wall"]]
    crv = rs.AddPolyline([(x, y, 0) for x, y in pts] + [(pts[0][0], pts[0][1], 0)])
    rs.ObjectLayer(crv, lp); rs.SetUserText(crv, "room", bal["room"]); rs.SetUserText(crv, "depth_m", str(round(dd, 3)))

lp = layer("OASIS::north", (0, 0, 0))
X = fx(max(r[2] for room in lay["rooms"].values() for r in room["rects"])) + 1.5
Y = fy(0)
ar = rs.AddLine((X, Y - 1.5, 0), (X, Y, 0)); rs.ObjectLayer(ar, lp)          # tail -> tip
hd = rs.AddPolyline([(X - 0.25, Y - 0.4, 0), (X, Y, 0), (X + 0.25, Y - 0.4, 0)]); rs.ObjectLayer(hd, lp)
t = rs.AddText("N", (X, Y + 0.3, 0), 0.4, justification=2 + 131072); rs.ObjectLayer(t, lp)
rs.ZoomExtents(all=True)
print("OASIS layers drawn; doors not placed: %s" % missing)
