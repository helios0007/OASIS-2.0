"""Calibration round 3: one model per measured home, built from its survey.

Round 2 (calibrate.py) fitted 5 settings to the average of two groups of
homes. Here every home gets its own model, and what the survey records is
used directly instead of being fitted:

    wall build-up            "Wall material" (single / double brick)
    household size           "Total number of household members"
    neighbours (sun on walls) "Wall exposure": walls that get no direct sun
                             face a neighbouring building across a lane
    window layout            "Flowing ventilation day / night" codes
                             (Tasgaonkar et al. README): 1 = cross ventilation
                             (opposite walls), 0.5 = neighbouring walls,
                             0 = one side only, "-" = no ventilation
    windows open             day / night: open when that period has a code

Only settings no survey or standard gives are fitted, on all homes together:
    airflow_factor     wind actually reaching the windows (street shelter, mesh)
    internal_mass_m2   internal walls and furniture
    appliances_peak_w  heat from appliances, lights and cooking
    infiltration_ach   leaks (kept to two levels: with windows open day and
                       night it is hard to separate from airflow_factor)

With --airflow afn the EnergyPlus AirflowNetwork moves the air (wind
pressure on each wall, two-way flow through the windows), so
airflow_factor is not fitted at all; wall_leakage_cm2_per_m2 (leaks)
replaces infiltration_ach. Each home sits at its surveyed floor, which sets
the wind speed at its windows.

Each setting is scored by the mean of the homes' own RMSEs (simulated vs
logged hourly temperature) on 16 May - 30 June, then checked on July - August.

Round 4 also takes the roof from the survey ("concrete + cement" = a
cement screed on the slab; roof colour / tar coating = solar absorptance;
"low" / "high" ceiling = 2.7 / 3.3 m) and scores the model against both the
air temperature and the operative temperature (mean of air and radiant
temperature): most loggers hang on a wall, where they read part air, part
the surfaces around them.

    python calibrate_homes.py                 Dhaka, simple airflow model
    python calibrate_homes.py --airflow afn   Dhaka, AirflowNetwork
    python calibrate_homes.py --airflow afn --validate Delhi
                                              Delhi with Dhaka's best settings, no refit
"""
import argparse
import itertools
import json
import shutil
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

import config
from oasis import measured
from oasis.build_idf import build_idf
from oasis.params import BASELINE
from oasis.simulate import run
from oasis.weather_file import make_epw

OUT = config.OUT / "calibration" / "homes"
MIN_COVERAGE = 0.8      # share of hours a logger must have in the period

CITIES = {
    # year, run period, fit period, check period
    "Dhaka": (2016, (5, 13), (8, 31), ("2016-05-16", "2016-06-30"), ("2016-07-01", "2016-08-31")),
    # Delhi is used only to check: hot-dry pre-monsoon (May-June), monsoon (July-August)
    "Delhi": (2016, (4, 26), (8, 31), ("2016-05-01", "2016-06-30"), ("2016-07-01", "2016-08-31")),
}

# The two surveys name some columns differently
COLUMNS = {
    "Dhaka": {"floor_above": "Floor above", "exposure": "Wall exposure", "coating": "Coating out roof"},
    "Delhi": {"floor_above": "Floor above", "exposure": "Exposure walls", "coating": "Coating outside roof"},
}

GRID = {
    "airflow_factor": [0.2, 0.4, 0.8, 1.6, 3.2, 6.4],
    "internal_mass_m2": [0, 40, 80, 160, 320],
    "appliances_peak_w": [100, 200, 400, 600],
    "infiltration_ach": [1.0, 4.0],
}

GRID_AFN = {     # round 3 found the best at the top / bottom of each range, so round 4 extends them
    "internal_mass_m2": [0, 40, 80, 160, 320, 640],
    "appliances_peak_w": [25, 50, 100, 200],
    "wall_leakage_cm2_per_m2": [2.0, 4.0, 8.0, 16.0, 32.0],
}
TARGETS = ("air", "operative")   # what the logger is compared with
STOREY_M = 3.0          # floor-to-floor height, to place each home above the ground

WALLS = {"single brick": "brick_115", "double brick": "brick_230",
         # Delhi: thickness not recorded; one-brick (230 mm) walls are the norm there
         "bricks": "brick_230", "bricks + cement": "brick_230", "double bricks": "brick_230"}

# Roof colour -> solar absorptance (typical values for weathered concrete
# finishes; ASHRAE Fundamentals Ch. 4 / CIBSE Guide A ranges)
ROOF_ABSORPTANCE = {"white": 0.3, "light grey": 0.6, "grey": 0.7, "grey-brown": 0.75,
                    "metallic grey": 0.7, "dark grey": 0.8, "brown": 0.8, "black": 0.9}
TAR_ABSORPTANCE = 0.9
CEILING_M = {"low": 2.7, "normal": 3.0, "high": 3.3}

# "Wall exposure" -> walls that get direct sun. The homes' orientation is not
# recorded, so the model keeps orientation 0 (long walls facing north/south):
# morning sun lands on the east wall, afternoon and evening sun on the west.
SUNLIT = {
    "no": set(),
    "morning": {"east"},
    "afternoon": {"west"},
    "evening": {"west"},
    "afternoon/evening": {"west"},
    "morning/afternoon": {"east", "west"},
    "morning/evening": {"east", "west"},
    "whole day": {"north", "east", "south", "west"},
}
ALL_WALLS = {"north", "east", "south", "west"}

# Window layout per ventilation code, with the same total glass as the
# baseline flat (wwr on the north and south walls).
def window_layout(code, p):
    total = 2 * p["wwr"] * p["length_m"] * p["height_m"]
    if code == 1:
        return {"north": total / 2, "south": total / 2}
    if code == 0.5:
        return {"south": total / 2, "east": total / 2}
    return {"south": total}


def vent_code(v):
    """Survey ventilation code -> number, or None for '-' (no ventilation)."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def home_params(row, occupants_fallback, run_start, run_end, airflow="simple", city="Dhaka"):
    """The OASIS flat set up as one measured home."""
    col = COLUMNS[city]
    p = dict(BASELINE, wall=WALLS[row["Wall material"]], run_start=run_start, run_end=run_end)
    # Roof and room height from the survey
    structure = str(row["Roof structure"]).lower()
    p["roof"] = "rcc_150_screed" if "cement" in structure or str(row[col["coating"]]).lower() == "cement" else "rcc_150"
    colour = str(row["Roof colour"]).strip().lower()
    p["roof_solar_absorptance"] = (TAR_ABSORPTANCE if str(row[col["coating"]]).lower() == "tar"
                                   else ROOF_ABSORPTANCE.get(colour, BASELINE["roof_solar_absorptance"]))
    p["height_m"] = CEILING_M.get(str(row["Ceiling height"]).strip().lower(), 3.0)
    p["airflow_model"] = airflow
    if airflow == "afn":
        # Survey "Floor": ground floor = 1 (README); a few homes are coded 0
        floor = pd.to_numeric(row["Floor"], errors="coerce")
        p["height_above_ground_m"] = max((floor if pd.notna(floor) else 1) - 1, 0) * STOREY_M
    people = pd.to_numeric(row["Total number of household members"], errors="coerce")
    p["occupants"] = int(people) if pd.notna(people) else occupants_fallback

    sunlit = SUNLIT.get(str(row[col["exposure"]]).strip().lower(), ALL_WALLS)
    p["shaded_walls"] = sorted(ALL_WALLS - sunlit)

    day, night = vent_code(row["Flowing ventilation day"]), vent_code(row["Flowing ventilation night"])
    codes = [c for c in (day, night) if c is not None]
    p["window_area_m2"] = window_layout(max(codes) if codes else 0, p)
    p["night_vent"] = night is not None
    # Daytime windows: open 06:00-22:00 if the survey gives a day code, else shut
    if day is None:
        p["windows_open_hour"], p["windows_close_hour"] = 0, 0
    return p


def select_homes(city, period):
    """Concrete-roofed top-floor homes with brick walls and a logger that
    worked for most of the period."""
    h = measured.housing(city)
    ind = measured.indoor(city)
    concrete = h["Roof structure"].str.contains("concrete", case=False)
    top = h[COLUMNS[city]["floor_above"]].str.lower() == "no"
    h = h[concrete & top & h["Wall material"].isin(WALLS)].drop_duplicates("Logger ID")
    span = ind.loc[period[0]:period[1]]
    coverage = {lid: span[lid].notna().mean() if lid in span else 0 for lid in h["Logger ID"]}
    h = h.assign(coverage=h["Logger ID"].map(coverage))
    return h[h["coverage"] >= MIN_COVERAGE].reset_index(drop=True), ind


def read_run(csv, year, run_start):
    df = pd.read_csv(csv)
    col = lambda text: df[[c for c in df.columns if text in c][0]].values
    index = pd.date_range(f"{year}-{run_start[0]:02d}-{run_start[1]:02d}", periods=len(df), freq="1h")
    return pd.DataFrame({"t_in": col("Zone Mean Air Temperature"),
                         "t_op": (col("Zone Mean Air Temperature") + col("Zone Mean Radiant Temperature")) / 2,
                         "rh_in": col("Zone Air Relative Humidity")}, index=index)


def scores(sim, meas, period, column="t_in"):
    s = sim.loc[period[0]:period[1], column]
    m = meas.reindex(s.index)
    ok = m.notna()
    s, m = s[ok], m[ok]
    err = s - m
    swing = lambda x: x.groupby(x.index.date).agg(lambda v: v.max() - v.min()).mean()
    peak = lambda x: int(x.groupby(x.index.hour).mean().idxmax())
    return {"rmse": float(np.sqrt((err ** 2).mean())), "bias": float(err.mean()),
            "swing_sim": float(swing(s)), "swing_meas": float(swing(m)),
            "peak_sim": peak(s), "peak_meas": peak(m), "hours": int(ok.sum())}


def simulate(designs, work, epw, year, run_start):
    """Write IDFs one by one (eppy is not thread-safe), run EnergyPlus in parallel."""
    jobs = [(build_idf(p, work / f"{i}.idf"), work / str(i)) for i, p in enumerate(designs)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        csvs = list(pool.map(lambda job: run(job[0], job[1], epw), jobs))
    out = [read_run(c, year, run_start) for c in csvs]
    shutil.rmtree(work, ignore_errors=True)
    return out


def prepare(city, airflow="simple"):
    year, run_start, run_end, fit, check = CITIES[city]
    epw = config.ROOT / "data" / "weather" / f"{city.lower()}_{year}.epw"
    make_epw(city, measured.weather(city), epw)
    homes, ind = select_homes(city, (fit[0], check[1]))
    people = pd.to_numeric(homes["Total number of household members"], errors="coerce")
    fallback = int(round(people.median()))
    params = [home_params(r, fallback, run_start, run_end, airflow, city) for _, r in homes.iterrows()]
    return year, run_start, fit, check, epw, homes, ind, params


def score_rows(labels, sims, homes, ind, fit, check, target):
    column = "t_in" if target == "air" else "t_op"
    rows = []
    for (i, c), sim in zip(labels, sims):
        lid = homes.loc[i, "Logger ID"]
        f, k = scores(sim, ind[lid], fit, column), scores(sim, ind[lid], check, column)
        rows.append({"logger": lid, **c, **{f"fit_{a}": b for a, b in f.items()},
                     **{f"check_{a}": b for a, b in k.items()}})
    return pd.DataFrame(rows)


def describe(at, target):
    """Summary numbers for one setting (rows: one per home)."""
    return {
        "target": target,
        "fit_rmse_c": round(at["fit_rmse"].mean(), 2), "fit_bias_c": round(at["fit_bias"].mean(), 2),
        "check_rmse_c": round(at["check_rmse"].mean(), 2), "check_bias_c": round(at["check_bias"].mean(), 2),
        "swing_sim_c": round(at["fit_swing_sim"].mean(), 2), "swing_meas_c": round(at["fit_swing_meas"].mean(), 2),
        "peak_hour_sim": int(at["fit_peak_sim"].median()), "peak_hour_meas": int(at["fit_peak_meas"].median()),
        "per_home": at[["logger", "fit_rmse", "fit_bias", "check_rmse", "check_bias"]].round(2).to_dict("records"),
    }


def humidity(homes, ind, sims_by_home, period):
    rh = []
    for i, sim in sims_by_home.items():
        col = f"{homes.loc[i, 'Logger ID']} (RH)"
        if col in ind:
            r = scores(sim, ind[col], period, "rh_in")
            rh.append({"logger": homes.loc[i, "Logger ID"], "rh_rmse_pct": round(r["rmse"], 1),
                       "rh_bias_pct": round(r["bias"], 1), "hours": r["hours"]})
    return rh


def print_homes(city, homes, params):
    print(f"{city}: {len(homes)} homes")
    for (_, r), p in zip(homes.iterrows(), params):
        print(f"  {r['Logger ID']}  {p['wall']:9s} {p['roof']:15s} a={p['roof_solar_absorptance']:.2f} h={p['height_m']}"
              f" people {p['occupants']}  shaded {','.join(p['shaded_walls']) or '-':22s}"
              f" windows {','.join(p['window_area_m2'])}  night open {p['night_vent']}")


def validate(city, airflow):
    """Run another city's homes with the fitted settings, without refitting."""
    fitted = json.loads((OUT / airflow / "summary.json").read_text())
    best, target = fitted.get("adopted", fitted["best"]), fitted["target"]
    out = OUT / f"{airflow}_validate_{city.lower()}"
    out.mkdir(parents=True, exist_ok=True)
    year, run_start, fit, check, epw, homes, ind, params = prepare(city, airflow)
    print_homes(city, homes, params)
    designs = [dict(p, **best, name=f"home {i}") for i, p in enumerate(params)]
    labels = [(i, best) for i in range(len(params))]
    print(f"Simulating {len(designs)} runs with {best} ...")
    sims = simulate(designs, out / "runs", epw, year, run_start)
    table = score_rows(labels, sims, homes, ind, fit, check, target)
    table.to_csv(out / "results.csv", index=False)
    summary = {"city": city, "airflow": airflow, "settings_from": fitted["city"], "settings": best,
               "homes": len(homes), "periods": {"first": fit, "second": check}, **describe(table, target),
               "humidity": humidity(homes, ind, dict(enumerate(sims)), (fit[0], check[1]))}
    # The model has no evaporative cooler (rare and ineffective in humid Chennai),
    # so homes that run one are scored apart.
    cooler = set(homes.loc[homes["Evaporative cooler"].str.lower().str.startswith("yes"), "Logger ID"])
    for name, rows in (("with_evaporative_cooler", table[table["logger"].isin(cooler)]),
                       ("without_evaporative_cooler", table[~table["logger"].isin(cooler)])):
        if len(rows):
            summary[name] = {"homes": len(rows), **{k: v for k, v in describe(rows, target).items() if k != "per_home"}}
            g = summary[name]
            print(f"  {name}: {g['homes']} homes, May-June RMSE {g['fit_rmse_c']} (bias {g['fit_bias_c']:+}), "
                  f"July-Aug RMSE {g['check_rmse_c']} (bias {g['check_bias_c']:+})")
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    homes.to_csv(out / "homes_used.csv", index=False)
    print(f"{city} ({target}): May-June RMSE {summary['fit_rmse_c']} °C (bias {summary['fit_bias_c']:+}) | "
          f"July-Aug RMSE {summary['check_rmse_c']} °C (bias {summary['check_bias_c']:+}) | "
          f"swing {summary['swing_sim_c']} vs {summary['swing_meas_c']} | peak {summary['peak_hour_sim']}h vs {summary['peak_hour_meas']}h")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", default="Dhaka")
    ap.add_argument("--airflow", choices=["simple", "afn"], default="simple")
    ap.add_argument("--validate", metavar="CITY", help="check the fitted settings on another city")
    args = ap.parse_args()
    if args.validate:
        return validate(args.validate, args.airflow)
    city = args.city
    out = OUT / args.airflow
    out.mkdir(parents=True, exist_ok=True)
    grid = GRID_AFN if args.airflow == "afn" else GRID
    year, run_start, fit, check, epw, homes, ind, params = prepare(city, args.airflow)
    print_homes(city, homes, params)

    keys = list(grid)
    combos = [dict(zip(keys, v)) for v in itertools.product(*grid.values())]
    designs, labels = [], []
    for c in combos:
        for i, p in enumerate(params):
            designs.append(dict(p, **c, name=f"home {i}"))
            labels.append((i, c))
    print(f"Simulating {len(designs)} runs ...")
    sims = simulate(designs, out / "runs", epw, year, run_start)

    results = {}
    for target in TARGETS:
        table = score_rows(labels, sims, homes, ind, fit, check, target)
        table.to_csv(out / f"grid_results_{target}.csv", index=False)
        ranked = table.groupby(keys)[["fit_rmse", "check_rmse", "fit_bias", "check_bias"]].mean().sort_values("fit_rmse")
        best = {k: float(v) for k, v in zip(keys, ranked.index[0])}
        at_best = table[np.logical_and.reduce([table[k] == best[k] for k in keys])]
        results[target] = (best, at_best, ranked)
        print(f"\n[{target}] top 5:\n{ranked.head(5).round(2).to_string()}")

    # The target the loggers match best (fit period only) sets the settings
    target = min(TARGETS, key=lambda t: results[t][1]["fit_rmse"].mean())
    best, at_best, _ = results[target]
    best_sims = {i: sim for (i, c), sim in zip(labels, sims) if c == {k: type(c[k])(best[k]) for k in keys}}
    summary = {
        "city": city, "airflow": args.airflow, "homes": len(homes), "best": best, **describe(at_best, target),
        "other_target": {t: {"best": results[t][0], **{k: v for k, v in describe(results[t][1], t).items() if k != "per_home"}}
                         for t in TARGETS if t != target},
        "humidity": humidity(homes, ind, best_sims, (fit[0], check[1])),
        "at_grid_edge": [k for k in keys if best[k] in (min(grid[k]), max(grid[k]))],
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    homes.to_csv(out / "homes_used.csv", index=False)

    print(f"\nBest ({target}):", best)
    print(f"Fit RMSE {summary['fit_rmse_c']} °C (bias {summary['fit_bias_c']:+}) | check RMSE {summary['check_rmse_c']} °C "
          f"(bias {summary['check_bias_c']:+}) | daily swing {summary['swing_sim_c']} vs {summary['swing_meas_c']} | "
          f"peak {summary['peak_hour_sim']}h vs {summary['peak_hour_meas']}h")
    print("At the edge of the grid:", summary["at_grid_edge"] or "none")
    print("Humidity:", summary["humidity"])


if __name__ == "__main__":
    main()
