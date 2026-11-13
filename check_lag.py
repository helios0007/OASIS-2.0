"""Why does the model peak ~2 h early? One input changed at a time.

check_evening.py showed the model's room warms with the outdoor air from
06:00 while the measured homes start ~08:00 and peak at 17:00, not 14:00.
Every calibration home has a night ventilation code, so the model keeps
its windows open 24 h: the room is tightly coupled to the outdoor air.
How far the windows are actually open (curtains, half-shut shutters,
security grilles) and when, is not in the survey. This script tests that
coupling, not a new fitted number:

    as calibrated        windows open 24 h, half the glass opens (0.5)
    opening 0.25 / 0.1   less of the window open
    shut 10-17 h         open evening and night, shut in the hot hours

Each variant is scored on the calibration homes (Dhaka 12, Delhi 3 without
an evaporative cooler), fit period, like check_evening.py, plus
morning error (06-10 h) and the air changes per hour (AFN, day and night).

    python check_lag.py
"""
import json
import shutil
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

import calibrate_homes as ch
import check_evening as ce
from oasis import measured
from oasis.build_idf import build_idf
from oasis.simulate import run

VARIANTS = {
    "as calibrated": {},
    "opening 0.25": {"openable_fraction": 0.25},
    "opening 0.1": {"openable_fraction": 0.1},
    "shut 10-17 h": {"windows_open_steps": [(10, 1.0), (17, 0.0), (24, 1.0)]},
}
MORNING = (6, 7, 8, 9)


def read(csv, year, run_start):
    df = pd.read_csv(csv)
    col = lambda text: df[[c for c in df.columns if text in c][0]].values
    index = pd.date_range(f"{year}-{run_start[0]:02d}-{run_start[1]:02d}", periods=len(df), freq="1h")
    return pd.DataFrame({"t_in": col("Zone Mean Air Temperature"),
                         "ach": col("AFN Zone Ventilation Air Change Rate")
                         + col("AFN Zone Infiltration Air Change Rate")}, index=index)


def run_city(city, adopted):
    year, run_start, fit, _, epw, homes, ind, params = ch.prepare(city, "afn")
    cooler = homes["Evaporative cooler"].astype(str).str.lower().str.startswith("yes")
    keep = [i for i in range(len(homes)) if not cooler[i]]
    work = ce.OUT / f"lag_runs_{city.lower()}"
    jobs, labels = [], []
    for name, change in VARIANTS.items():
        for i in keep:
            p = dict(params[i], **adopted, **change, name=f"home {i}")
            jobs.append((build_idf(p, work / f"{len(jobs)}.idf"), work / str(len(jobs))))
            labels.append((name, i))
    print(f"{city}: {len(jobs)} runs ...")
    with ThreadPoolExecutor(max_workers=8) as pool:
        csvs = list(pool.map(lambda j: run(j[0], j[1], epw), jobs))
    sims = [read(c, year, run_start) for c in csvs]
    shutil.rmtree(work, ignore_errors=True)

    outdoor = measured.weather(city)["temp_c"]
    rows = []
    for (name, i), sim in zip(labels, sims):
        lid = homes.loc[i, "Logger ID"]
        sc = ce.evening_scores(sim, ind[lid], outdoor, fit)
        s = sim.loc[fit[0]:fit[1]]
        m = ind[lid].reindex(s.index)
        err = (s["t_in"] - m).dropna()
        day = s.index.hour.isin(range(10, 17))
        rows.append({"city": city, "variant": name, "logger": lid, **sc,
                     "morning_err_c": float(err[err.index.hour.isin(MORNING)].mean()),
                     "ach_day": float(s["ach"][day].mean()), "ach_night": float(s["ach"][~day].mean())})
    return pd.DataFrame(rows)


def main():
    adopted = json.loads((ch.OUT / "afn" / "summary.json").read_text())["adopted"]
    table = pd.concat([run_city(c, adopted) for c in ("Dhaka", "Delhi")])
    table.round(2).to_csv(ce.OUT / "lag_variants_per_home.csv", index=False)
    table["lag_h"] = table["peak_meas"] - table["peak_sim"]
    summary = (table.groupby(["city", "variant"], sort=False)
               .agg(homes=("logger", "size"), peak_sim=("peak_sim", "median"), peak_meas=("peak_meas", "median"),
                    lag_h=("lag_h", "mean"), rmse_all_c=("rmse_all_c", "mean"),
                    morning_err_c=("morning_err_c", "mean"), evening_err_c=("evening_err_c", "mean"),
                    evening_rmse_c=("evening_rmse_c", "mean"),
                    excess_cut_sim_c=("excess_cut_sim_c", "mean"), excess_cut_meas_c=("excess_cut_meas_c", "mean"),
                    ach_day=("ach_day", "mean"), ach_night=("ach_night", "mean"))
               .round(2).reset_index())
    summary.to_csv(ce.OUT / "lag_variants.csv", index=False)
    pd.set_option("display.width", 250)
    print(summary.to_string(index=False))


if __name__ == "__main__":
    main()
