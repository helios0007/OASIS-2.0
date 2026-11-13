"""Assess a floor plan (data/layouts/*.json) room by room.

Each room is its own EnergyPlus zone with the AirflowNetwork. Prints safe
hours per room and for the household (the room people are in at each hour:
the living room by day, the bedrooms at night), then the same for a few
design changes.

    python run_layout.py data/layouts/amudha_1bhk.json
    python run_layout.py data/layouts/amudha_1bhk.3dm    (Rhino plan on the OASIS:: layers)
"""
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

import config
from oasis.build_layout import load_layout, build_layout_idf, zone_id
from oasis.metrics import SAFE_LIMIT_C, fan_credit_c, heat_index_c
from oasis.params import BASELINE
from oasis.simulate import run

CHANGES = {
    "as drawn": {},
    "white roof": {"roof_solar_absorptance": 0.2},
    "roof insulation": {"roof": "rcc_150_insul_50"},
    "windows shut at night": {"night_vent": False},
    "0.6 m overhangs": {"shading_depth_m": 0.6},
}


def room_results(csv, lay):
    df = pd.read_csv(csv)
    df.columns = df.columns.str.strip()   # EnergyPlus pads the last header
    hour = np.arange(len(df)) % 24
    cut = (hour >= config.CUT_START_HOUR) & (hour < config.CUT_END_HOUR)
    night = (hour >= 22) | (hour < 6)
    out, hi_by_room = {}, {}
    for name, room in lay["rooms"].items():
        z = zone_id(name)
        t = df[f"{z}:Zone Mean Air Temperature [C](Hourly)"].values
        rh = df[f"{z}:Zone Air Relative Humidity [%](Hourly)"].values
        mrt = df[f"{z}:Zone Mean Radiant Temperature [C](Hourly)"].values
        credit = np.where(cut | (not room["fan"]), 0.0, fan_credit_c(t, mrt, rh))
        hi = heat_index_c(t - credit, rh)
        hi_by_room[name] = hi
        out[name] = {"safe": int((hi < SAFE_LIMIT_C).sum()), "max_hi": round(float(hi.max()), 1),
                     "max_t": round(float(t.max()), 1)}
    # Household: the living room by day, the worst bedroom at night
    beds = [n for n, r in lay["rooms"].items() if r["type"] == "bedroom"]
    living = next(n for n, r in lay["rooms"].items() if r["type"] == "living")
    occupied = np.where(night, np.max([hi_by_room[n] for n in beds], axis=0), hi_by_room[living])
    out["_household"] = {"safe": int((occupied < SAFE_LIMIT_C).sum()),
                         "night_safe": int((occupied[night] < SAFE_LIMIT_C).sum()), "night_hours": int(night.sum()),
                         "cut_danger": int((occupied[cut] >= SAFE_LIMIT_C).sum())}
    return out


def main(path, extra=None):
    lay = load_layout(path)
    work = config.OUT / "layout_runs" / (lay["name"].split(" (")[0].replace(" ", "_")
                                         + ("_" + extra["party_walls"] if extra and "party_walls" in extra else ""))
    jobs = []
    for i, (label, change) in enumerate(CHANGES.items()):
        drawn = {"orientation_deg": lay["orientation_deg"]} if "orientation_deg" in lay else {}
        p = dict(BASELINE, **drawn, **(extra or {}), **change, airflow_model="afn")
        jobs.append((label, build_layout_idf(lay, p, work / f"{i}.idf"), work / str(i)))
    with ThreadPoolExecutor(max_workers=5) as pool:
        csvs = list(pool.map(lambda j: run(j[1], j[2], config.EPW), jobs))
    results = {label: room_results(csv, lay) for (label, _, _), csv in zip(jobs, csvs)}

    area = sum((r[2] - r[0]) * (r[3] - r[1]) for room in lay["rooms"].values() for r in room["rects"])
    print(f"\n{lay['name']}: {len(lay['rooms'])} rooms, {area:.1f} m² modelled floor area")
    base = results["as drawn"]
    print(f"\nAs drawn, safe hours of 168 (heat index < {SAFE_LIMIT_C:.0f} °C, fan credit in rooms with a fan):")
    for name in lay["rooms"]:
        r = base[name]
        print(f"  {name:10s} {r['safe']:4d}   max felt {r['max_hi']:5.1f} °C   max air {r['max_t']:4.1f} °C")
    h = base["_household"]
    print(f"  household  {h['safe']:4d}   (where people are; nights {h['night_safe']} of {h['night_hours']} safe, "
          f"{h['cut_danger']} of 7 cuts in danger)")
    print("\nDesign changes, household safe hours:")
    for label, r in results.items():
        g = r["_household"]["safe"] - h["safe"]
        print(f"  {label:22s} {r['_household']['safe']:4d}  ({g:+d})   nights {r['_household']['night_safe']}")
    return results


if __name__ == "__main__":
    # optional 2nd argument "windowless": every outside wall without a window is shared
    main(sys.argv[1], {"party_walls": sys.argv[2]} if len(sys.argv) > 2 else None)
