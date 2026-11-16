"""How far can the headline and the ranking of changes be trusted?

Two checks on the baseline flat (top floor, windows open day and night, cut 20-21 h):

1. Model error. In the 12 Dhaka calibration homes the model's mean error differs
   from home to home (calibrate_homes.py --airflow afn, adopted settings). This part
   prints that spread (the source of metrics.TEMP_ERROR_C) and scores the baseline and
   every single change with the room that much warmer and cooler.

2. Other heatwaves. Everything else uses one week, 1-7 May 2024. This part builds the
   hottest recorded week of every year 2016-2025 (get_heatwave.py's ranking: station
   air + ERA5 sunlight, 7 spin-up days) and runs the baseline and every single change
   on each, to see whether the ranking of changes is the same in other heatwaves.

    python check_robustness.py        (after calibrate_homes.py --airflow afn; needs the
                                       internet once for the ERA5 sunlight of each year)
Outputs: outputs/robustness/summary.json, weeks.csv, gains_by_year.png
"""
import json
import shutil
from concurrent.futures import ThreadPoolExecutor

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

import config
import get_heatwave as hw
from oasis.assess import single_changes
from oasis.build_idf import build_idf
from oasis.metrics import TEMP_ERROR_C, safe_hours
from oasis.params import BASELINE
from oasis.simulate import run
from oasis.weather_file import make_epw

OUT = config.OUT / "robustness"
RUNS = OUT / "runs"                     # temporary, removed at the end
GRID = config.OUT / "calibration" / "homes" / "afn" / "grid_results_air.csv"
CAL = config.OUT / "calibration" / "homes" / "afn" / "summary.json"
WEEK_H = 7 * 24


def home_errors():
    """Mean error of the adopted model in each calibration home (check period)."""
    adopted = json.loads(CAL.read_text())["adopted"]
    g = pd.read_csv(GRID)
    for key, value in adopted.items():
        g = g[g[key] == value]
    bias = g["check_bias"]
    return {"homes": int(len(g)), "mean_c": round(float(bias.mean()), 2), "sd_c": round(float(bias.std()), 2),
            "min_c": round(float(bias.min()), 2), "max_c": round(float(bias.max()), 2),
            "hourly_rmse_c": round(float(g["check_rmse"].mean()), 2), "band_used_c": TEMP_ERROR_C}


def week_files(w, ranking):
    """One weather file per year's hottest week. Returns [(row, epw, hours from the station)]."""
    files = []
    for row in sorted(ranking, key=lambda r: r["year"]):
        start, end = pd.Timestamp(row["start"]), pd.Timestamp(row["end"])
        run_start = start - pd.Timedelta(days=hw.SPINUP_DAYS)
        span = w.loc[run_start: end + pd.Timedelta(hours=23)].copy()
        e = hw.era5_sunlight(str(run_start.date()), str((end + pd.Timedelta(days=1)).date()))
        span["ghi_wm2"] = e["shortwave_radiation"].reindex(span.index)
        epw = RUNS / f"week_{row['year']}.epw"
        make_epw("Chennai", span, epw, source=f"Meenambakkam WMO 43279 + ERA5 sunlight, {row['start']}")
        files.append((row, epw, int(span["temp_c"].notna().sum())))
    return files


def score(csv):
    """Keep the 7 scored days (the spin-up is first), then the usual metrics."""
    scored = csv.parent / "scored.csv"
    pd.read_csv(csv).tail(WEEK_H).to_csv(scored, index=False)
    return safe_hours(scored)[0]


def main():
    shutil.rmtree(RUNS, ignore_errors=True)
    RUNS.mkdir(parents=True, exist_ok=True)
    errors = home_errors()
    print(f"Model mean error over {errors['homes']} homes: {errors['mean_c']:+.2f} C, home to home sd {errors['sd_c']} C "
          f"({errors['min_c']:+.2f} to {errors['max_c']:+.2f}); band used +/- {TEMP_ERROR_C} C\n")

    w = hw.station()
    files = week_files(w, hw.pick_week(w))
    options = single_changes(BASELINE)
    names = ["baseline"] + [f"{key}={level}" for key, level in options]

    # Model files one by one (eppy is not thread-safe), then EnergyPlus side by side.
    jobs = []
    for row, epw, _ in files:
        start = pd.Timestamp(row["start"]) - pd.Timedelta(days=hw.SPINUP_DAYS)
        end = pd.Timestamp(row["end"])
        dates = {"run_start": (start.month, start.day), "run_end": (end.month, end.day)}
        for i, change in enumerate([{}] + [{key: level} for key, level in options]):
            tag = f"{row['year']}_{i}"
            idf = build_idf(dict(BASELINE, **change, **dates, name=tag), RUNS / f"{tag}.idf")
            jobs.append((row["year"], names[i], idf, RUNS / tag, epw))
    with ThreadPoolExecutor(max_workers=8) as pool:
        summaries = list(pool.map(lambda j: score(run(j[2], j[3], j[4])), jobs))

    rows = []
    for (year, name, *_), s in zip(jobs, summaries):
        rows.append({"year": year, "design": name, "safe_hours": s["safe_hours"],
                     "safe_hours_low": s["safe_hours_low"], "safe_hours_high": s["safe_hours_high"],
                     "max_heat_index_c": s["max_heat_index_c"], "hazard_hours_ch": s["hazard_hours_ch"]})
    d = pd.DataFrame(rows)
    base = d[d["design"] == "baseline"].set_index("year")
    for col, ref in (("gain", "safe_hours"), ("gain_if_warmer", "safe_hours_low"), ("gain_if_cooler", "safe_hours_high")):
        d[col] = d[ref] - d["year"].map(base[ref])
    d.to_csv(OUT / "weeks.csv", index=False)

    gains = d[d["design"] != "baseline"].pivot(index="design", columns="year", values="gain")
    ref_year = 2024 if 2024 in gains.columns else gains.columns[-1]
    gains = gains.sort_values(ref_year, ascending=False)
    rank_match = {int(y): round(float(gains[y].corr(gains[ref_year], method="spearman")), 2) for y in gains.columns}
    weeks = [{"year": r["year"], "start": r["start"], "end": r["end"], "mean_outdoor_heat_index_c": r["mean_heat_index_c"],
              "hours_from_station": n, "baseline_safe_hours": int(base.loc[r["year"], "safe_hours"]),
              "baseline_low": int(base.loc[r["year"], "safe_hours_low"]), "baseline_high": int(base.loc[r["year"], "safe_hours_high"]),
              "best_change": gains[r["year"]].idxmax(), "best_gain_h": int(gains[r["year"]].max()),
              "rank_match_with_2024": rank_match[r["year"]]} for r, _, n in files]
    this = d[d["year"] == ref_year].set_index("design")
    band = [{"design": n, "safe_hours": int(this.loc[n, "safe_hours"]), "gain": int(this.loc[n, "gain"]),
             "gain_if_warmer": int(this.loc[n, "gain_if_warmer"]), "gain_if_cooler": int(this.loc[n, "gain_if_cooler"])}
            for n in ["baseline"] + list(gains.index)]
    summary = {"model_error": errors, "weeks": weeks, "error_band_2024": band,
               "gains_by_year": {n: {int(y): int(v) for y, v in gains.loc[n].items()} for n in gains.index},
               "note": "Baseline flat, top floor, windows open day and night, cut 20-21 h. Gains are safe hours against "
                       "the baseline of the same week. rank_match = Spearman correlation of the gains with the 2024 week."}
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))

    print(pd.DataFrame(weeks).drop(columns=["end"]).to_string(index=False))
    print("\nGain in safe hours by year:\n" + gains.to_string())
    print(f"\n{ref_year} week within the model error band:\n" + pd.DataFrame(band).to_string(index=False))
    plot(gains, base)
    shutil.rmtree(RUNS, ignore_errors=True)


def plot(gains, base):
    fig, (a, b) = plt.subplots(1, 2, figsize=(11, 4.2), gridspec_kw={"width_ratios": [1, 1.6]})
    years = list(base.index)
    a.bar(years, base["safe_hours"], color="0.6")
    a.errorbar(years, base["safe_hours"], yerr=[base["safe_hours"] - base["safe_hours_low"], base["safe_hours_high"] - base["safe_hours"]],
               fmt="none", ecolor="black", capsize=3)
    a.set_title("Baseline safe hours, hottest week of each year")
    a.set_ylabel("Safe hours of 168 (bars: model error band)")
    a.set_xticks(years)
    a.tick_params(axis="x", labelrotation=45)
    for name in gains.index:
        b.plot(gains.columns, gains.loc[name], marker="o", ms=3, lw=1.2, label=name)
    b.axhline(0, color="0.6", lw=0.8)
    b.set_title("Safe hours gained by each single change")
    b.set_xticks(list(gains.columns))
    b.tick_params(axis="x", labelrotation=45)
    b.legend(frameon=False, fontsize=7, ncol=2)
    fig.tight_layout()
    fig.savefig(OUT / "gains_by_year.png", dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    main()
