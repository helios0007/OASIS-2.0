"""Calibrate the OASIS model on measured homes (Dhaka, Tasgaonkar et al. 2022).

Homes used: concrete roof, no flat above (top floor, like the OASIS flat),
logger working for most of the period. They are split by wall type into two
groups; each group is modelled as the OASIS flat with that wall and the
group's typical household, driven by the Dhaka weather station.

The uncertain settings are tried in every combination. Each one is scored
on 13 May - 30 June (fit) and then checked on July - August (not used for
fitting). Results go to outputs/calibration/.

    python calibrate.py
"""
import itertools
import json
import shutil
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

import config
from oasis import measured
from oasis.build_idf import DEFAULTS, build_idf
from oasis.params import BASELINE
from oasis.simulate import run
from oasis.weather_file import make_epw

CITY = "Dhaka"
YEAR = 2016
RUN_START, RUN_END = (5, 13), (8, 31)
FIT = ("2016-05-16", "2016-06-30")      # first 3 days left out: model settling
CHECK = ("2016-07-01", "2016-08-31")
MIN_COVERAGE = 0.8                      # share of hours a logger must have

# Round 1 (all four walls outside) tried airflow 0.1-1.6, leaks 0.5-8 ach,
# appliances 200-600 W, internal mass 0-80 m2: the best fit was at the edge
# of every range, and the day's swing stayed too large. Round 2 widens the
# ranges and lets the east and west walls be shared with neighbours.
# Results of round 1: outputs/calibration/round1_*.
GRID = {
    "shared_walls": ["", "east,west"],   # "" = all four walls outside
    "airflow_factor": [0.4, 0.8, 1.6, 3.2],
    "infiltration_ach": [2.0, 4.0, 8.0, 16.0],
    "appliances_peak_w": [200, 400],
    "internal_mass_m2": [40, 80, 160],
}
CURRENT = {"shared_walls": ""}           # + build_idf.DEFAULTS


def settings(c):
    """Grid values -> building parameters."""
    p = dict(c)
    p["shared_walls"] = [s for s in c["shared_walls"].split(",") if s]
    return p
WALLS = {"single brick": "brick_115", "double brick": "brick_230"}

OUT = config.OUT / "calibration"
EPW = config.ROOT / "data" / "weather" / "dhaka_2016.epw"


def select_homes():
    """Housing rows of the homes used, plus their hourly indoor data."""
    h = measured.housing(CITY)
    ind = measured.indoor(CITY)
    concrete = h["Roof structure"].str.contains("concrete", case=False)
    top = h["Floor above"].str.lower() == "no"
    h = h[concrete & top & h["Wall material"].isin(WALLS)].drop_duplicates("Logger ID")
    period = ind.loc[FIT[0]:CHECK[1]]
    coverage = {lid: period[lid].notna().mean() if lid in period else 0
                for lid in h["Logger ID"]}
    h = h.assign(coverage=h["Logger ID"].map(coverage))
    return h[h["coverage"] >= MIN_COVERAGE], ind


def group_params(rows, wall):
    """The OASIS flat, set up like the group's homes."""
    people = pd.to_numeric(rows["Total number of household members"], errors="coerce")
    night = pd.to_numeric(rows["Flowing ventilation night"], errors="coerce")
    return dict(BASELINE, airflow_model="simple",   # round 2 used the simple airflow model
                wall=wall,
                occupants=int(round(people.median())) if people.notna().any() else 4,
                night_vent=bool(night.median() >= 0.5) if night.notna().any() else False,
                run_start=RUN_START, run_end=RUN_END)


def read_run(csv):
    df = pd.read_csv(csv)
    col = lambda text: df[[c for c in df.columns if text in c][0]].values
    index = pd.date_range(f"{YEAR}-{RUN_START[0]:02d}-{RUN_START[1]:02d}",
                          periods=len(df), freq="1h")   # hour starting
    return pd.DataFrame({"t_in": col("Zone Mean Air Temperature"),
                         "rh_in": col("Zone Air Relative Humidity"),
                         "ach": col("Zone Ventilation Current Density Air Change Rate")
                                + col("Zone Infiltration Current Density Air Change Rate")},
                        index=index)


def simulate_all(designs, work):
    jobs = [(build_idf(p, work / f"{i}.idf"), work / str(i)) for i, p in enumerate(designs)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        csvs = list(pool.map(lambda job: run(job[0], job[1], EPW), jobs))
    return [read_run(c) for c in csvs]


def scores(sim, meas, period):
    """Fit of simulated vs measured hourly temperature over a period."""
    s = sim.loc[period[0]:period[1], "t_in"]
    m = meas.loc[period[0]:period[1]]
    ok = m.notna()
    s, m = s[ok], m[ok]
    err = s - m
    daily = lambda x: x.groupby(x.index.date).agg(lambda v: v.max() - v.min()).mean()
    peak = lambda x: int(x.groupby(x.index.hour).mean().idxmax())
    return {
        "rmse_c": round(float(np.sqrt((err**2).mean())), 2),
        "bias_c": round(float(err.mean()), 2),
        "daily_swing_sim_c": round(float(daily(s)), 2),
        "daily_swing_meas_c": round(float(daily(m)), 2),
        "peak_hour_sim": peak(s),
        "peak_hour_meas": peak(m),
        "hours": int(ok.sum()),
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    missing = make_epw(CITY, measured.weather(CITY), EPW)
    print(f"Weather file: {EPW.name} ({len(missing)} station hours missing overall)")

    homes, ind = select_homes()
    groups = {}
    for wall_name, wall in WALLS.items():
        rows = homes[homes["Wall material"] == wall_name]
        if len(rows):
            groups[wall_name] = {
                "rows": rows,
                "params": group_params(rows, wall),
                "measured": ind[rows["Logger ID"].tolist()].mean(axis=1),
            }
    for name, g in groups.items():
        p = g["params"]
        print(f"{name}: {len(g['rows'])} homes, occupants {p['occupants']}, "
              f"night vent {p['night_vent']}, loggers {', '.join(g['rows']['Logger ID'])}")
    homes.to_csv(OUT / "homes_used.csv", index=False)

    # Every combination of settings, plus the current settings for comparison
    keys = list(GRID)
    combos = [dict(zip(keys, values)) for values in itertools.product(*GRID.values())]
    current = {k: CURRENT[k] if k in CURRENT else DEFAULTS[k] for k in keys}
    if current not in combos:
        combos.append(current)

    designs, labels = [], []
    for name, g in groups.items():
        for c in combos:
            designs.append(dict(g["params"], **settings(c), name=f"calibration {len(designs)}"))
            labels.append((name, c))
    print(f"Simulating {len(designs)} runs ({RUN_START} to {RUN_END}) ...")
    work = OUT / "runs"
    sims = simulate_all(designs, work)

    rows = []
    for (name, c), sim in zip(labels, sims):
        fit = scores(sim, groups[name]["measured"], FIT)
        check = scores(sim, groups[name]["measured"], CHECK)
        rows.append({"group": name, **c,
                     "is_current": c == current,
                     "mean_ach": round(float(sim.loc[FIT[0]:FIT[1], "ach"].mean()), 1),
                     **{f"fit_{k}": v for k, v in fit.items()},
                     **{f"check_{k}": v for k, v in check.items()}})
    table = pd.DataFrame(rows)
    table.to_csv(OUT / "grid_results.csv", index=False)

    # One set of settings for all groups: lowest mean fit RMSE
    by_combo = table.groupby(keys)["fit_rmse_c"].mean().sort_values()
    best = dict(zip(keys, by_combo.index[0]))
    plain = lambda v: (v if isinstance(v, str) else
                       float(v) if isinstance(v, (float, np.floating)) else int(v))
    best = {k: plain(v) for k, v in best.items()}

    summary = {"best": best, "current": current, "groups": {}}
    for name, g in groups.items():
        t = table[table["group"] == name]
        pick = lambda c: t[np.logical_and.reduce([t[k] == c[k] for k in keys])].iloc[0]
        summary["groups"][name] = {
            "homes": int(len(g["rows"])),
            "current": pick(current).to_dict(),
            "calibrated": pick(best).to_dict(),
        }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2, default=str))

    # Hourly series of the calibrated runs, for plots
    hourly = []
    for (name, c), sim in zip(labels, sims):
        if c in (best, current):
            tag = "calibrated" if c == best else "current"
            hourly.append(pd.DataFrame({"group": name, "model": tag,
                                        "t_sim": sim["t_in"], "rh_sim": sim["rh_in"],
                                        "t_meas": groups[name]["measured"].reindex(sim.index)}))
    pd.concat(hourly).rename_axis("time").to_csv(OUT / "hourly.csv")
    shutil.rmtree(work, ignore_errors=True)

    print("\nBest settings (one set for both groups):", best)
    print("Current settings:", current)
    for name, s in summary["groups"].items():
        for tag in ("current", "calibrated"):
            r = s[tag]
            print(f"  {name:13s} {tag:10s} fit RMSE {r['fit_rmse_c']:.2f} bias {r['fit_bias_c']:+.2f} | "
                  f"check RMSE {r['check_rmse_c']:.2f} bias {r['check_bias_c']:+.2f} | "
                  f"swing {r['fit_daily_swing_sim_c']:.1f} vs {r['fit_daily_swing_meas_c']:.1f} | "
                  f"peak {r['fit_peak_hour_sim']}h vs {r['fit_peak_hour_meas']}h | ACH {r['mean_ach']}")
    print("\nTop 10 settings by fit RMSE:")
    print(by_combo.head(10).round(2).to_string())


if __name__ == "__main__":
    main()
