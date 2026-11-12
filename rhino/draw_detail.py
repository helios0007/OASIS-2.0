# Detailed Rhino model of an OASIS layout: 230 mm outside walls, 115 mm partitions,
# openings cut through the walls, glass, door leaves, slabs and balconies.
# Runs INSIDE Rhino (IronPython 2.7), e.g. from the Rhino MCP or EditPythonScript:
#     LAYOUT = r"D:\IAAC\OASIS 2.0\data\layouts\amudha_3bhk.json"
#     execfile(r"D:\IAAC\OASIS 2.0\rhino\draw_detail.py")
# It replaces any earlier Detail:: layers. The OASIS:: layers (room outlines and
# openings, which the energy model reads) are not touched.
import rhinoscriptsyntax as rs, json, io

FT = 0.3048
TE, TI, SLAB = 0.23, 0.115, 0.15          # exterior wall, partition, slab (m)
PARAPET_H, PARAPET_T = 1.0, 0.10          # balcony parapet
KIND = {"window": (0.9, 1.2), "ventilator": (1.8, 0.6), "balcony_door": (0.0, 2.1),
        "entrance": (0.0, 2.1), "door": (0.0, 2.1), "doorway": (0.0, 2.1)}   # sill, height
NORMAL = {"south": (0, -1), "north": (0, 1), "west": (-1, 0), "east": (1, 0)}
OPP = {"north": "south", "south": "north", "east": "west", "west": "east"}

lay = json.load(io.open(LAYOUT, encoding="utf-8"))
H = lay.get("height_m", 3.0)
ymax = max(r[3] for room in lay["rooms"].values() for r in room["rects"])
flip = lambda y: (ymax - y) * FT
rooms = dict((n, [(x0 * FT, flip(y1), x1 * FT, flip(y0)) for x0, y0, x1, y1 in r["rects"]])
             for n, r in lay["rooms"].items())

def along(wall, a, c):
    lo, hi = (a * FT, c * FT) if wall in ("north", "south") else (flip(c), flip(a))
    return min(lo, hi), max(lo, hi)

def edges(r):
    x0, y0, x1, y1 = r
    return {"south": (y0, x0, x1), "north": (y1, x0, x1), "west": (x0, y0, y1), "east": (x1, y0, y1)}

def segments():
    out = []
    for name, rects in rooms.items():
        for rect in rects:
            for side, (fixed, a0, a1) in edges(rect).items():
                cover = []
                for other, orects in rooms.items():
                    for o in orects:
                        if o is rect:
                            continue
                        of, b0, b1 = edges(o)[OPP[side]]
                        if abs(of - fixed) < 1e-6 and min(a1, b1) - max(a0, b0) > 1e-6:
                            cover.append((max(a0, b0), min(a1, b1), other))
                cover.sort()
                pos = a0
                for c0, c1, other in cover:
                    if c0 - pos > 1e-6:
                        out.append((name, side, fixed, pos, c0, None))
                    out.append((name, side, fixed, c0, c1, other))
                    pos = max(pos, c1)
                if a1 - pos > 1e-6:
                    out.append((name, side, fixed, pos, a1, None))
    return [s for s in out if s[5] != s[0]]

def box(x0, x1, y0, y1, z0, z1):
    x0, x1 = min(x0, x1), max(x0, x1); y0, y1 = min(y0, y1), max(y0, y1)
    return rs.AddBox([(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                      (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)])

def slab_across(side, fixed, a0, a1, t0, t1, z0, z1):
    """Box along a wall line: a0..a1 along it, t0..t1 across it (from the line, outward positive)."""
    nx, ny = NORMAL[side]
    if side in ("north", "south"):
        return box(a0, a1, fixed + ny * t0, fixed + ny * t1, z0, z1)
    return box(fixed + nx * t0, fixed + nx * t1, a0, a1, z0, z1)

def layer(path, color):
    parts = path.split("::")
    for i in range(1, len(parts) + 1):
        p = "::".join(parts[:i])
        if not rs.IsLayer(p):
            rs.AddLayer(parts[i - 1], color if i == len(parts) else None, parent=("::".join(parts[:i - 1]) or None))
    return path

# Remove an earlier detailed model
for lp in sorted([l for l in rs.LayerNames() if l.startswith("Detail")], key=lambda s: -s.count("::")):
    objs = rs.ObjectsByLayer(lp)
    if objs:
        rs.DeleteObjects(objs)
    rs.DeleteLayer(lp)

L_EXT = layer("Detail::walls::exterior 230 brick", (236, 232, 224))
L_INT = layer("Detail::walls::partition 115 brick", (205, 200, 190))
L_GLASS = layer("Detail::glass", (125, 211, 252))
L_DOOR = layer("Detail::doors", (161, 98, 7))
L_SLAB = layer("Detail::slabs", (170, 170, 165))
L_BAL = layer("Detail::balcony", (190, 185, 175))
m = rs.AddMaterialToLayer(L_GLASS)
rs.MaterialColor(m, (125, 211, 252)); rs.MaterialTransparency(m, 0.6)

segs = segments()
walls = []   # (id, side, fixed, a0, a1, exterior)
for room, side, fixed, a0, a1, other in segs:
    if other is None:
        w = slab_across(side, fixed, a0 - TE, a1 + TE, 0, TE, 0, H)
        rs.ObjectLayer(w, L_EXT); walls.append([w, side, fixed, a0, a1, True])
    elif room < other:               # each partition once
        w = slab_across(side, fixed, a0 - TI / 2, a1 + TI / 2, -TI / 2, TI / 2, 0, H)
        rs.ObjectLayer(w, L_INT); walls.append([w, side, fixed, a0, a1, False])

# Openings: cutters, glass, door leaves
cuts = []      # (cutter id, side, fixed, lo, hi)
for o in lay["openings"]:
    lo, hi = along(o["wall"], o["from"], o["to"])
    host = [s for s in segs if s[0] == o["room"] and s[1] == o["wall"] and s[5] is None
            and s[3] - 1e-6 <= lo and hi <= s[4] + 1e-6][0]
    side, fixed = host[1], host[2]
    sill, h = KIND[o["kind"]]
    cuts.append((slab_across(side, fixed, lo, hi, -0.05, TE + 0.05, sill, sill + h), side, fixed, lo, hi))
    if o["kind"] in ("window", "ventilator"):
        g = slab_across(side, fixed, lo, hi, TE / 2 - 0.003, TE / 2 + 0.003, sill, sill + h)
        rs.ObjectLayer(g, L_GLASS)
    else:
        d = slab_across(side, fixed, lo, hi, 0.0, 0.04, sill, sill + h)
        rs.ObjectLayer(d, L_DOOR)

for d in lay["doors"]:
    a, b = d["rooms"]
    for room, side, fixed, a0, a1, other in segs:
        if room != a or other != b:
            continue
        lo, hi = along(side, d["from"], d["to"])
        if a0 - 1e-6 <= lo and hi <= a1 + 1e-6:
            sill, h = KIND[d.get("kind", "door")]
            cuts.append((slab_across(side, fixed, lo, hi, -TI / 2 - 0.05, TI / 2 + 0.05, sill, sill + h), side, fixed, lo, hi))
            break

def overlaps(b1, b2):
    return all(b1[0][i] < b2[6][i] - 1e-6 and b2[0][i] < b1[6][i] - 1e-6 for i in range(3))

failed = 0
for wall in walls:
    wb = rs.BoundingBox(wall[0])
    mine = [c[0] for c in cuts if overlaps(wb, rs.BoundingBox(c[0]))]
    if not mine:
        continue
    lp = rs.ObjectLayer(wall[0])
    res = rs.BooleanDifference([wall[0]], [rs.CopyObject(c) for c in mine], True)
    if res:
        for r in res:
            rs.ObjectLayer(r, lp)
    else:
        failed += 1
rs.DeleteObjects([c[0] for c in cuts])

# Floor and roof slabs: each room expanded to the outside face of the walls
for z0, z1 in ((-SLAB, 0.0), (H, H + SLAB)):
    parts = [box(x0 - TE, x1 + TE, y0 - TE, y1 + TE, z0, z1) for rects in rooms.values() for x0, y0, x1, y1 in rects]
    u = rs.BooleanUnion(parts, True) or parts
    for s in u:
        rs.ObjectLayer(s, L_SLAB)

# Balconies: slab, parapet on the open sides, the slab of the floor above
for bal in lay.get("balconies", []):
    x0, y0, x1, y1 = rooms[bal["room"]][0]
    side = bal["wall"]
    fixed, a0, a1 = edges((x0, y0, x1, y1))[side]
    dpt = bal["depth"] * FT
    t0, t1 = TE, TE + dpt
    for z0, z1 in ((-SLAB, 0.0), (H, H + SLAB)):
        rs.ObjectLayer(slab_across(side, fixed, a0, a1, t0, t1, z0, z1), L_BAL)
    rs.ObjectLayer(slab_across(side, fixed, a0, a1, t1 - PARAPET_T, t1, 0, PARAPET_H), L_BAL)
    rs.ObjectLayer(slab_across(side, fixed, a0, a0 + PARAPET_T, t0, t1, 0, PARAPET_H), L_BAL)
    rs.ObjectLayer(slab_across(side, fixed, a1 - PARAPET_T, a1, t0, t1, 0, PARAPET_H), L_BAL)

if rs.IsLayer("OASIS::preview"):
    rs.LayerVisible("OASIS::preview", False)
print("walls %d, openings cut %d, failed booleans %d" % (len(walls), len(cuts), failed))
