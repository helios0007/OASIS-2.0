"""Check the street map's building heights against the satellite heights, for all of Chennai.

The painted pixel map (and any map drawn from OpenStreetMap / Overture tags) shows a
building as tall as its tag says. Some tags are wrong: a whole compound outlined as one
"building" with a height of 99 m is painted as one giant block. This script finds them.

    1. OpenStreetMap: every building in the atlas box that has a height or a
       building:levels tag (Overpass, cached in outputs/urban).
    2. Shortlist: claimed height >= CLAIM_MIN_M and outline >= AREA_MIN_M2, or claimed
       height >= TOWER_M whatever the size (chosen: these are the ones that show).
    3. Satellite: Google Open Buildings 2.5D (2023) around each one (oasis/urban_heights.py):
       share of the outline that is built and the mean height of that built part.
    4. Flag where the tag is more than RATIO times the satellite height and at least
       GAP_M above it, or where less than BUILT_MIN of the outline is built at all.
       Outlines with nothing built in them (under ABSENT_MAX) get their own flag: a
       planned or unfinished project mapped as standing, or a building newer than the
       2023 satellite layer. These are only listed ("apply": false) until someone has
       looked at the satellite photo and added the id to SEEN_EMPTY.

Writes
    outputs/map_check/height_check.csv     every building checked
    frontend/px/fixes.json                 the flagged ones, with what the satellite
                                           shows inside each outline (blocks of equal
                                           storeys on the 4 m grid), for the map to draw

Both heights are estimates: the tag is typed by a mapper, the satellite height comes
from a model (low buildings can read too low). A flag means "these two disagree badly",
not "the satellite is right". Run: python check_map_heights.py  (needs internet).
"""
import csv
import json
import math
import sys
import time

import numpy as np
import requests

import config
from oasis import urban, urban_heights

BOX = (80.13, 12.83, 80.34, 13.25)      # west, south, east, north: the Chennai atlas box
CLAIM_MIN_M = 20.0        # chosen: tags below this cannot make a block that stands out
AREA_MIN_M2 = 1500.0      # chosen
TOWER_M = 60.0            # chosen: check every tag this tall
RATIO = 2.0               # chosen: tag more than twice the satellite height
GAP_M = 12.0              # chosen: and at least four storeys above it
BUILT_MIN = 0.35          # chosen: an outline less than this built is a compound, not a building
ABSENT_MAX = 0.05         # chosen: below this the satellite shows no building there at all
BEHIND = 2.5              # ground hidden behind a block on the pixel map, in block heights (its view is about 22 degrees above the ground)
REACH_MAX_M = 440.0       # the satellite reader takes at most a 500 m circle
STOREY_M = urban.FLOOR_M
# Empty outlines looked at on the satellite photo (Esri World Imagery in the tool) and seen to be
# open ground: these are covered on the map. Other empty outlines stay as painted until someone looks.
SEEN_EMPTY = {"way/1546302034"}        # cleared construction plot at 12.950 N, 80.244 E, checked 2026-11-16
OUT = config.OUT / "map_check"
FIXES = config.ROOT / "frontend" / "px" / "fixes.json"
CACHE = config.OUT / "urban" / "osm_tagged_chennai.json"


def tagged_buildings():
    """Every OSM building in the box with a height or levels tag (raw Overpass elements)."""
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    w, s, e, n = BOX
    box = f"({s},{w},{n},{e})"
    query = ("[out:json][timeout:180];(" + "".join(
        f'{kind}["building"]["{tag}"]{box};' for kind in ("way", "relation") for tag in ("height", "building:levels"))
        + ");out geom tags;")
    for attempt, server in enumerate(urban.OVERPASS):
        time.sleep(urban.BACKOFF_S * attempt)
        try:
            reply = requests.post(server, data={"data": query}, timeout=240, headers={"User-Agent": "urban-form-research-client"})
            reply.raise_for_status()
            elements = reply.json()["elements"]
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_text(json.dumps(elements))
            return elements
        except (requests.RequestException, ValueError, KeyError):
            continue
    raise SystemExit("The OpenStreetMap servers did not answer. Try again in a minute.")


def outlines(elements):
    """[{id, ring [(lon, lat)], claimed_m, area_m2, lat, lon, reach_m}] for each outer ring."""
    out = []
    for e in elements:
        claimed = urban.tagged_height(e.get("tags", {}))
        if not claimed:
            continue
        rings = [e["geometry"]] if e["type"] == "way" and "geometry" in e else \
                [m["geometry"] for m in e.get("members", []) if m.get("role") == "outer" and "geometry" in m]
        for k, ring in enumerate(rings):
            if len(ring) < 4:
                continue
            lons, lats = [p["lon"] for p in ring], [p["lat"] for p in ring]
            lat, lon = (min(lats) + max(lats)) / 2, (min(lons) + max(lons)) / 2
            kx = 111_320 * math.cos(math.radians(lat))
            xy = [((a - lon) * kx, (b - lat) * 110_540) for a, b in zip(lons, lats)]
            area = abs(sum(xy[i][0] * xy[i - 1][1] - xy[i - 1][0] * xy[i][1] for i in range(len(xy)))) / 2
            out.append({"id": f"{e['type']}/{e['id']}" + (f"#{k}" if k else ""), "ring": list(zip(lons, lats)), "xy": xy,
                        "claimed_m": claimed, "area_m2": area, "lat": round(lat, 5), "lon": round(lon, 5),
                        "reach_m": max(math.hypot(x, y) for x, y in xy), "name": e.get("tags", {}).get("name", "")})
    return out


def satellite(b):
    """What the satellite shows inside the outline: built share, mean and top height, and
    what stands in and around it as blocks of equal storeys (polygons in lon / lat with a
    height), out to the ground the wrongly tall block hides on the map."""
    from matplotlib.path import Path
    from rasterio.features import shapes
    from rasterio.transform import Affine

    pad = BEHIND * b["claimed_m"]            # the wrong block also hides this much ground behind it on the map
    radius = min(500, max(100, math.ceil((b["reach_m"] + pad) / 50) * 50))
    share, height = urban_heights.height_grid(b["lat"], b["lon"], radius)
    h = urban_heights.solid(share, height)
    n, c = h.shape[0], urban_heights.CELL_M
    half = n * c / 2
    ii, jj = np.mgrid[0:n, 0:n]
    x, y = -half + (jj + 0.5) * c, half - (ii + 0.5) * c
    inside = Path(b["xy"]).contains_points(np.column_stack([x.ravel(), y.ravel()])).reshape(n, n)
    if not inside.any():
        return None
    built = inside & (h > 0)
    xs, ys = [q[0] for q in b["xy"]], [q[1] for q in b["xy"]]
    near = (x >= min(xs) - pad) & (x <= max(xs) + pad) & (y >= min(ys) - pad) & (y <= max(ys) + pad) & (h > 0)
    storeys = np.where(near, np.maximum(1, np.round(h / STOREY_M)), 0).astype(np.int16)
    kx = 111_320 * math.cos(math.radians(b["lat"]))
    blocks = []
    for shape, value in shapes(storeys, mask=near, transform=Affine(c, 0, -half, 0, -c, half)):
        ring = shape["coordinates"][0]
        if len(ring) < 4 or (len(ring) == 5 and value <= 1):        # single 4 m cells of one storey: noise
            continue
        blocks.append({"h": float(value) * STOREY_M,
                       "ring": [[round(b["lon"] + px / kx, 6), round(b["lat"] + py / 110_540, 6)] for px, py in ring]})
    return {"built_share": float(built.sum() / inside.sum()),
            "sat_mean_m": float(h[built].mean()) if built.any() else 0.0,
            "sat_top_m": float(np.percentile(h[built], 98)) if built.any() else 0.0, "blocks": blocks}


def main():
    all_tagged = outlines(tagged_buildings())
    short = [b for b in all_tagged if b["reach_m"] <= REACH_MAX_M and
             ((b["claimed_m"] >= CLAIM_MIN_M and b["area_m2"] >= AREA_MIN_M2) or b["claimed_m"] >= TOWER_M)]
    short.sort(key=lambda b: -b["claimed_m"] * b["area_m2"])
    if "--count" in sys.argv:
        print(f"{len(all_tagged)} outlines with a height tag, {len(short)} on the shortlist")
        return
    rows, fixes = [], []
    for k, b in enumerate(short):
        try:
            s = satellite(b)
        except Exception as error:
            print(f"  {b['id']}: satellite not read ({str(error).splitlines()[0]})")
            continue
        if s is None:
            continue
        too_tall = b["claimed_m"] > RATIO * s["sat_top_m"] and b["claimed_m"] - s["sat_top_m"] >= GAP_M
        compound = s["built_share"] < BUILT_MIN
        absent = s["built_share"] < ABSENT_MAX
        flag = "nothing built here in the 2023 satellite data" if absent else "tag too tall" if too_tall else "outline is a compound" if compound else ""
        rows.append({"id": b["id"], "name": b["name"], "lat": b["lat"], "lon": b["lon"], "outline_m2": round(b["area_m2"]),
                     "tag_m": b["claimed_m"], "satellite_mean_m": round(s["sat_mean_m"], 1), "satellite_top_m": round(s["sat_top_m"], 1),
                     "built_share": round(s["built_share"], 2), "flag": flag})
        if flag:
            fixes.append({"id": b["id"], "name": b["name"], "lat": b["lat"], "lon": b["lon"], "tag_m": b["claimed_m"],
                          "satellite_top_m": round(s["sat_top_m"], 1), "built_share": round(s["built_share"], 2), "flag": flag,
                          "apply": not absent or b["id"] in SEEN_EMPTY,
                          "ring": [[round(lo, 6), round(la, 6)] for lo, la in b["ring"]],
                          "blocks": s["blocks"] if not absent or b["id"] in SEEN_EMPTY else []})
        print(f"{k + 1}/{len(short)} {b['id']}: tag {b['claimed_m']:.0f} m, satellite top {s['sat_top_m']:.0f} m, "
              f"{s['built_share']:.0%} built {('-> ' + flag) if flag else ''}", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / "height_check.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    FIXES.write_text(json.dumps({"made": time.strftime("%Y-%m-%d"), "checked": len(rows), "tagged": len(all_tagged),
                                 "rules": {"claim_min_m": CLAIM_MIN_M, "area_min_m2": AREA_MIN_M2, "tower_m": TOWER_M,
                                           "ratio": RATIO, "gap_m": GAP_M, "built_min": BUILT_MIN},
                                 "fixes": fixes}))
    print(f"{len(rows)} checked, {len(fixes)} flagged, {sum(f['apply'] for f in fixes)} corrected on the map -> {FIXES}")


if __name__ == "__main__":
    main()
