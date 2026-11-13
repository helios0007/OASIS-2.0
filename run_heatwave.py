"""MVP headline: safe hours in the baseline flat during a recorded heatwave.

Runs the calibrated baseline flat with its windows open day and night, as in
every calibration home (top floor, and a middle floor for contrast), plus the
OASIS baseline's night-shut windows as an unvalidated case, on two weeks,
scored the same way:

    typical year   TMYx week 10-16 May (data/weather/chennai.epw), the
                   week the sweep, surrogate and tools use
    recorded       hottest measured week, from get_heatwave.py
                   (data/weather/chennai_heatwave.epw, 1-7 May 2024)

Each run starts SPINUP_DAYS before the scored week, so the concrete carries
the heat of the days before; only the 7 scored days count. Safe hours,
power-cut hours in danger and the worst hour for a cut come from
oasis/metrics.py (heat index < 41 C, fan credit except 20-21 h).

    python get_heatwave.py      (once)
    python run_heatwave.py
Outputs: outputs/heatwave/summary.json, results.csv, hourly.csv, heat_index_weeks.png
"""
import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

import config
from oasis.build_idf import build_idf
from oasis.metrics import SAFE_LIMIT_C, heat_index_c, peaks, safe_hours
from oasis.params import BASELINE
from oasis.simulate import run

OUT = config.OUT / "heatwave"
INFO = config.ROOT / "data" / "weather" / "chennai_heatwave.json"
SPINUP_DAYS = config.SPINUP_DAYS
# Windows: the calibration homes (Dhaka) all had windows open day and night,
# so that is the validated case. The OASIS baseline shuts them 22:00-06:00;
# that case was never checked against measured homes and is shown apart.
DESIGNS = {
    "top floor": {"floor": "top"},          # BASELINE: windows open day and night
    "middle floor": {"floor": "middle"},
    "top floor, windows shut at night (not validated)": {"floor": "top", "night_vent": False},
}


def weeks():
    info = json.loads(INFO.read_text())
    rec = date.fromisoformat(info["week"]["start"])
    typ = date(2001, *config.TMYX_WEEK[0])
    return {
        "typical year (TMYx 10-16 May)": (config.TMYX_EPW, typ),
        f"recorded ({info['week']['start']} to {info['week']['end']})":
            (config.ROOT / "data" / "weather" / "chennai_heatwave.epw", rec),
    }, info


def score(csv, run_dir):
    """Drop the spin-up days, then the usual OASIS metrics."""
    df = pd.read_csv(csv).tail(7 * 24).reset_index(drop=True)   # simulate.run may already have dropped the spin-up
    scored = run_dir / "scored.csv"
    df.to_csv(scored, index=False)
    return safe_hours(scored)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    wk, info = weeks()
    jobs = []
    for wname, (epw, first) in wk.items():
        start = first - timedelta(days=SPINUP_DAYS)
        end = first + timedelta(days=6)
        for dname, change in DESIGNS.items():
            p = dict(BASELINE, **change, name=f"run {len(jobs)}",
                     run_start=(start.month, start.day), run_end=(end.month, end.day))
            tag = f"{len(jobs)}"
            jobs.append((wname, dname, epw, build_idf(p, OUT / "runs" / f"{tag}.idf"), OUT / "runs" / tag))
    with ThreadPoolExecutor(max_workers=4) as pool:
        csvs = list(pool.map(lambda j: run(j[3], j[4], j[2]), jobs))

    rows, hourly = [], []
    for (wname, dname, *_), csv in zip(jobs, csvs):
        s, h = score(csv, csv.parent)
        pk = peaks(h)
        out_hi = heat_index_c(h["t_out"], h["rh_out"])
        rows.append({"weather": wname, "design": dname, **s,
                     "nights_cut_in_danger": pk["cut"]["nights_in_danger"],
                     "cut_max_heat_index_c": pk["cut"]["max_heat_index_c"],
                     "worst_hour_for_cut": pk["worst_cut_hour"],
                     "typical_peak_hour": pk["normal"]["typical_hour"],
                     "outdoor_hours_over_limit": int((out_hi >= SAFE_LIMIT_C).sum()),
                     "outdoor_mean_heat_index_c": round(float(out_hi.mean()), 1)})
        hourly.append(h.assign(weather=wname, design=dname, out_heat_index=out_hi))
    shutil.rmtree(OUT / "runs", ignore_errors=True)

    table = pd.DataFrame(rows)
    table.to_csv(OUT / "results.csv", index=False)
    hourly = pd.concat(hourly)
    hourly.round(2).to_csv(OUT / "hourly.csv", index=False)
    (OUT / "summary.json").write_text(json.dumps(
        {"limit_c": SAFE_LIMIT_C, "spinup_days": SPINUP_DAYS, "weather_source": info["sources"],
         "recorded_week": info["week_stats"], "typical_year_week": info["typical_year_week"],
         "results": rows}, indent=2))
    plot(hourly, OUT / "heat_index_weeks.png")
    pd.set_option("display.width", 250)
    print(table[["weather", "design", "safe_hours", "danger_hours", "nights_cut_in_danger",
                 "cut_max_heat_index_c", "max_heat_index_c", "worst_hour_for_cut",
                 "outdoor_hours_over_limit", "outdoor_mean_heat_index_c"]].to_string(index=False))


def plot(hourly, png):
    names = list(hourly["weather"].unique())
    fig, axes = plt.subplots(len(names), 1, figsize=(12, 3.6 * len(names)), sharey=True)
    for ax, wname in zip(axes, names):
        d = hourly[hourly["weather"] == wname]
        top = d[d["design"] == "top floor"].reset_index(drop=True)
        for i in top.index[top["cut"]]:
            ax.axvspan(i, i + 1, color="orange", alpha=0.35, lw=0)
        ax.plot(top["out_heat_index"], color="black", ls="--", lw=1, label="Outdoor (measured weather)")
        for dname, colour, ls in (("top floor", "#c0392b", "-"), ("middle floor", "#2980b9", "-"),
                                  (list(DESIGNS)[2], "#c0392b", ":")):
            g = d[d["design"] == dname].reset_index(drop=True)
            ax.plot(g["heat_index"], color=colour, lw=1.4, ls=ls, label=f"Indoor, {dname}")
        ax.axhline(SAFE_LIMIT_C, color="red", ls=":", lw=1, label=f"Limit {SAFE_LIMIT_C:.0f} °C")
        safe = int((~top["danger"]).sum())
        ax.set_title(f"{wname}: top floor, windows open, {safe} of {len(top)} hours safe")
        ax.set_xlim(0, len(top))
        ax.set_xticks(range(0, len(top) + 1, 24))
        ax.set_xticklabels([f"day {k + 1}" for k in range(len(top) // 24 + 1)])
        ax.set_ylabel("Heat index (°C)")
        ax.grid(alpha=0.3)
    axes[0].legend(fontsize=8, ncol=4, loc="upper left")
    axes[-1].set_xlabel("Orange = power cut 20:00-21:00 (fan off)")
    fig.tight_layout()
    fig.savefig(png, dpi=200)
    plt.close(fig)


if __name__ == "__main__":
    main()
