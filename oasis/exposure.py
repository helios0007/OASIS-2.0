"""Heat exposure index: one 0-10 score per building in the analysis area.

This is the physical part of OASIS 1.0's Heat Vulnerability Index (HVRA,
github.com/helios0007/HVRA): the same 0-10 scale, colours, tiers and decision gate,
with the factors that can be measured for every Chennai building. It says how exposed
a building is to heat, NOT how vulnerable the people in it are: OASIS 1.0's social
factors (age, income, living alone, no air conditioning: 40 % of its index) and
building age (15 %) have no Chennai data at building scale and are left out.

Each factor is 0-1 (1 = most exposed). Weights are OASIS 1.0's own, for the factors kept:

    surface heat   0.15   Landsat surface temperature at the building: (T - 30) / 18      [1.0 rule]
    hotter than
    the city       0.05   building minus the city's mean land surface, same pass: / 5 C   [1.0 rule]
    few trees      0.10   1 - tree canopy within 50 m / 30 %                              [replaces NDVI + green distance]
    street canyon  0.05   height / width to the neighbours, in 1.0's five bands           [1.0 rule]
    roof           0.10   share of the building's floors that lie under the roof          [replaces roof type]

Two factors are OASIS 2.0's own (chosen, not from 1.0):
  - trees: the canopy map (Meta / WRI, 1 m) stands in for 1.0's NDVI and distance to green;
    30 % canopy = fully green follows the "3-30-300" rule (Konijnendijk 2022);
  - roof: Chennai roofs are almost all flat concrete, so roof type tells nothing. What
    differs is how much of a building sits under its roof: one storey = all of it, four
    storeys = a quarter. In the home model the top floor has 59 safe hours, a middle floor 95.

Not validated: no health or indoor data has been compared with this index.
"""
import csv
import json
import math

import numpy as np

import config
from oasis import urban, urban_env, urban_heights

WEIGHTS = {"surface": 0.15, "city_delta": 0.05, "trees": 0.10, "canyon": 0.05, "roof": 0.10}
LABELS = {"surface": "Hot surfaces", "city_delta": "Hotter than the city", "trees": "Few trees",
          "canyon": "Enclosed street", "roof": "Homes under the roof"}
LST_LOW_C, LST_SPAN_C = 30.0, 18.0     # surface temperature 30 C -> 0, 48 C -> 1 (OASIS 1.0)
CITY_DELTA_FULL_C = 5.0                # 5 C hotter than the city's land surface -> 1 (OASIS 1.0)
TREE_REACH_M = 50.0                    # trees this near the building count (inside the 60 m read margin)
TREE_FULL = 0.30                       # 30 % canopy cover = fully green (3-30-300 rule; chosen)
CANYON_BANDS = ((0.2, 0.1), (0.5, 0.3), (1.0, 0.5), (1.5, 0.7))   # height / width below -> score; above the last: 0.9 (OASIS 1.0)
CANYON_TOP = 0.9
# Tiers and the decision gate, as in OASIS 1.0 (hviColors.js). They were set for the full
# index with its social part, so on this physical index they are a first reading only.
TIERS = ((4.0, "Low", "No urban measure needed"), (5.5, "Moderate", "Street measures: trees and shade"),
         (7.0, "High", "Urban measures and a home assessment"), (10.01, "Critical", "Assess the homes first"))
SAFE_BELOW, GATE = 4.0, 5.5            # below SAFE_BELOW: fine as it is; GATE and above: assess the home (Home tab)
ATLAS = config.ROOT / "data" / "chennai_atlas"
_CITY = {}


def city_land_surface():
    """(mean land surface temperature of Chennai in C, Landsat scene), from the 100 m atlas
    (make_chennai_atlas.py); cells that are mostly water are left out. (None, None) without the atlas."""
    if not _CITY:
        try:
            scene = json.loads((ATLAS / "atlas.json").read_text())["landsat"]["scene"]
            with open(ATLAS / "chennai_atlas_100m.csv", newline="") as f:
                temps = [float(r["surface_temp_c"]) for r in csv.DictReader(f)
                         if r["surface_temp_c"] not in ("", "nan") and float(r["cover_water"] or 0) < 0.5]
            _CITY["v"] = (round(sum(temps) / len(temps), 2), scene)
        except Exception:
            _CITY["v"] = (None, None)
    return _CITY["v"]


def surface_at(surface, lat, lon, x_m, y_m):
    """Landsat surface temperature (C) of the pixel under a point; None under cloud or off the picture."""
    plat = lat + y_m / 110540
    plon = lon + x_m / (111320 * math.cos(math.radians(lat)))
    (w0, n0), (e0, n1), _, (w1, s0) = surface["corners"]             # NW, NE, SE, SW as [lon, lat]
    a = np.array([[e0 - w0, w1 - w0], [n1 - n0, s0 - n0]])          # picture axes in degrees
    u, v = np.linalg.solve(a, np.array([plon - w0, plat - n0]))
    grid = surface["temp_c"]
    i, j = int(v * len(grid)), int(u * len(grid[0]))
    return grid[i][j] if 0 <= i < len(grid) and 0 <= j < len(grid[0]) else None


def tree_cover_near(canopy, x_m, y_m):
    """Share of the ground within TREE_REACH_M of a point that is under tree canopy."""
    share = np.asarray(canopy["share_pct"], float) / 100
    n, c = share.shape[0], canopy["cell_m"]
    half = n * c / 2
    xs = -half + (np.arange(n) + 0.5) * c
    ys = half - (np.arange(n) + 0.5) * c
    near = np.hypot(xs[None, :] - x_m, ys[:, None] - y_m) <= TREE_REACH_M
    return float(share[near].mean()) if near.any() else 0.0


def canyon_ratio(rays, own_height_m):
    """Mean height / width over the 16 sight lines: (this building + the neighbour) / 2 over
    the gap between them. A direction with no neighbour within reach counts as open (0)."""
    ratios = [((own_height_m + r["height_m"]) / 2) / r["gap_m"] if r["gap_m"] else 0.0 for r in rays]
    return sum(ratios) / len(ratios)


def canyon_score(ratio):
    return next((score for limit, score in CANYON_BANDS if ratio < limit), CANYON_TOP)


def tier(score):
    return next(name for limit, name, _ in TIERS if score < limit)


def score_buildings(lat, lon, radius_m, zone, buildings):
    """buildings: [{"id", "x_m", "y_m", "height_m", "height_assumed"}] (metres east / north of the centre;
    height_assumed: the satellite shows no building in the outline, so its height is a guess and the roof
    factor is left out).
    Returns each building's score, tier and factors, and the area's summary. A factor
    whose data is missing (cloud, no canopy file) is left out and the other weights
    are scaled up, per building; `missing` lists them."""
    share, height = urban_heights.height_grid(lat, lon, radius_m)
    notes = []

    def read(label, reader):
        try:
            return reader(lat, lon, radius_m, zone)
        except Exception as error:
            notes.append(f"{label} not available ({str(error).splitlines()[0]}).")
            return None
    canopy = read("Tree canopy", urban_env.canopy)
    surface = read("Surface temperature", urban_env.surface_temp)
    city_c, city_scene = city_land_surface()
    same_pass = bool(surface) and city_scene == surface["scene"]
    if surface and not same_pass:
        notes.append("The city's mean surface temperature is from another satellite pass, so 'hotter than the city' is left out.")

    rows = []
    for b in buildings:
        x, y, h = b["x_m"], b["y_m"], max(float(b["height_m"]), 2.0)
        storeys = max(1, round(h / urban.FLOOR_M))
        temp = surface_at(surface, lat, lon, x, y) if surface else None
        trees = tree_cover_near(canopy, x, y) if canopy else None
        ratio = canyon_ratio(urban_heights.obstructions(share, height, x, y)["rays"], h)
        values = {   # factor: (score 0-1 or None, the measured value behind it)
            "surface": (None if temp is None else (temp - LST_LOW_C) / LST_SPAN_C, temp),
            "city_delta": (None if temp is None or not same_pass else (temp - city_c) / CITY_DELTA_FULL_C,
                           None if temp is None or not same_pass else round(temp - city_c, 1)),
            "trees": (None if trees is None else 1 - trees / TREE_FULL, None if trees is None else round(trees, 3)),
            "canyon": (canyon_score(ratio), round(ratio, 2)),
            "roof": (None, None) if b.get("height_assumed") else (1 / storeys, storeys),
        }
        have = {k: min(1.0, max(0.0, s)) for k, (s, _) in values.items() if s is not None}
        weight = sum(WEIGHTS[k] for k in have)
        score = 10 * sum(WEIGHTS[k] * s for k, s in have.items()) / weight
        rows.append({"id": b["id"], "score": round(score, 2), "tier": tier(score),
                     "factors": {k: {"score": round(have[k], 2), "value": values[k][1],
                                     "points": round(10 * WEIGHTS[k] * have[k] / weight, 2)} for k in have},
                     "missing": [k for k in WEIGHTS if k not in have]})

    scores = np.array([r["score"] for r in rows]) if rows else np.zeros(0)
    counts = {name: int(sum(r["tier"] == name for r in rows)) for _, name, _ in TIERS}
    drivers = sorted(({"factor": k, "label": LABELS[k],
                       "points": round(float(np.mean([r["factors"][k]["points"] for r in rows if k in r["factors"]] or [0])), 2),
                       "max_points": round(10 * WEIGHTS[k] / sum(WEIGHTS.values()), 2)} for k in WEIGHTS),
                     key=lambda d: -d["points"])
    summary = None if not rows else {
        "buildings": len(rows), "mean": round(float(scores.mean()), 2), "tier": tier(float(scores.mean())),
        "min": round(float(scores.min()), 2), "max": round(float(scores.max()), 2),
        "tiers": counts, "over_gate": int((scores >= GATE).sum()),
        "highest": max(rows, key=lambda r: r["score"])["id"], "drivers": drivers,
    }
    return {"buildings": rows, "summary": summary, "notes": notes, "basis": basis(surface, city_c, same_pass)}


def basis(surface, city_c, same_pass):
    """What the index rests on, for the tool: weights, rules, tiers, sources, what is left out."""
    total = sum(WEIGHTS.values())
    rules = {
        "surface": f"Landsat surface temperature at the building, {LST_LOW_C:g} °C = 0 and {LST_LOW_C + LST_SPAN_C:g} °C = 1 (OASIS 1.0)."
                   + (f" Pass of {surface['date']} at {surface['local_time']}: a morning reading of roofs and ground, not air." if surface else ""),
        "city_delta": f"Building minus Chennai's mean land surface in the same pass ({city_c} °C), {CITY_DELTA_FULL_C:g} °C hotter = 1 (OASIS 1.0)."
                      if same_pass else "Left out: no city mean from the same satellite pass.",
        "trees": f"Tree canopy within {TREE_REACH_M:g} m (Meta / WRI, 1 m); {TREE_FULL:.0%} cover or more = 0 (3-30-300 rule; chosen). Stands in for OASIS 1.0's NDVI and distance to green.",
        "canyon": "Height ÷ width to the neighbours on 16 sight lines (satellite heights), in OASIS 1.0's five bands: enclosed streets hold heat and block wind.",
        "roof": f"1 ÷ storeys (height ÷ {urban.FLOOR_M:g} m): the share of the building's floors under the roof. Chosen; replaces OASIS 1.0's roof type.",
    }
    return {"factors": [{"factor": k, "label": LABELS[k], "weight": round(WEIGHTS[k] / total, 3), "rule": rules[k]} for k in WEIGHTS],
            "tiers": [{"below": limit, "name": name, "action": action} for limit, name, action in TIERS],
            "safe_below": SAFE_BELOW, "gate": GATE,
            "left_out": "Exposure, not vulnerability: OASIS 1.0's social factors (age, income, living alone, no air conditioning; "
                        "40 % of its index) and building age (15 %) have no Chennai data at building scale. The tiers were set "
                        "for the full index. Not checked against health or indoor measurements."}
