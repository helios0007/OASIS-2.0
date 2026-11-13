"""Recorded heatwave, with and without neighbours' AC heat, three power-cut cases.

The baseline flat (windows open day and night, no AC) on the recorded
Chennai heatwave (1-7 May 2024, get_heatwave.py; 7 spin-up days), with the
outdoor air as measured and with the waste heat of the neighbours' ACs
added (oasis/ac_heat.py: +1 C at night today, +2 C if AC heat doubles).

Each simulation is scored three ways. EnergyPlus does not model the fan,
so a power cut only removes the fan's cooling credit in that hour
(oasis/metrics.py); the three cases share one simulation:

    heatwave + power cut 20-21 h   the OASIS case (evening load shedding)
    heatwave alone                 fans work every hour
    power cut at peak heat         one-hour cut at the room's hottest hour
                                   (from the measured-weather top floor run)

    python run_scenarios.py
Outputs: outputs/scenarios/results.csv, hourly.csv, summary.json, safe_hours.png
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
from oasis.ac_heat import CURRENT_NIGHT_C, DOUBLED_NIGHT_C, add_ac_heat, warming_profile
from oasis.build_idf import build_idf
from oasis.metrics import SAFE_LIMIT_C, heat_index_c, safe_hours
from oasis.params import BASELINE
from oasis.simulate import run
from run_heatwave import INFO, SPINUP_DAYS

OUT = config.OUT / "scenarios"
EPW = config.ROOT / "data" / "weather" / "chennai_heatwave.epw"
WEATHER = {                                   # name: extra night-time warming (C)
    "measured outdoor air": 0.0,
    f"+ neighbours' AC heat (+{CURRENT_NIGHT_C:g} C at night)": CURRENT_NIGHT_C,
    f"+ AC heat doubled (+{DOUBLED_NIGHT_C:g} C at night)": DOUBLED_NIGHT_C,
}
DESIGNS = {"top floor": {"floor": "top"}, "middle floor": {"floor": "middle"}}
EVENING_CUT = list(range(config.CUT_START_HOUR, config.CUT_END_HOUR))


def weather_files():
    files = {}
    for name, dt in WEATHER.items():
        files[name] = EPW if dt == 0 else add_ac_heat(EPW, OUT / f"chennai_heatwave_ac{dt:g}.epw", dt)
    return files


def simulate(files, first):
    start, end = first - timedelta(days=SPINUP_DAYS), first + timedelta(days=6)
    jobs = []
    for wname, epw in files.items():
        for dname, change in DESIGNS.items():
            tag = str(len(jobs))
            p = dict(BASELINE, **change, name=f"run {tag}",
                     run_start=(start.month, start.day), run_end=(end.month, end.day))
            jobs.append((wname, dname, epw, build_idf(p, OUT / "runs" / f"{tag}.idf"), OUT / "runs" / tag))
    with ThreadPoolExecutor(max_workers=4) as pool:
        csvs = list(pool.map(lambda j: run(j[3], j[4], j[2]), jobs))
    scored = []
    for (wname, dname, *_), csv in zip(jobs, csvs):
        df = pd.read_csv(csv).tail(7 * 24).reset_index(drop=True)   # simulate.run may already have dropped the spin-up
        path = OUT / f"scored_{len(scored)}.csv"
        df.to_csv(path, index=False)
        scored.append((wname, dname, path))
    shutil.rmtree(OUT / "runs", ignore_errors=True)
    return scored


def score(wname, dname, csv, cname, cut_hours):
    s, h = safe_hours(csv, cut_hours)
    out_hi = heat_index_c(h["t_out"], h["rh_out"])
    c = h[h["cut"]]
    row = {"weather": wname, "design": dname, "power_cut": cname, **s,
           "nights_cut_in_danger": int(c.assign(day=c.index // 24).groupby("day")["danger"].any().sum()) if len(c) else 0,
           "cut_max_heat_index_c": round(float(c["heat_index"].max()), 1) if len(c) else None,
           "night_safe_hours_22_06": int((~h["danger"] & h["hour"].isin([22, 23, 0, 1, 2, 3, 4, 5])).sum()),
           "mean_outdoor_temp_c": round(float(h["t_out"].mean()), 2),
           "outdoor_mean_heat_index_c": round(float(out_hi.mean()), 1)}
    return row, h.assign(weather=wname, design=dname, power_cut=cname)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    info = json.loads(INFO.read_text())
    scored = simulate(weather_files(), date.fromisoformat(info["week"]["start"]))

    # The room's hottest hour of the day: measured weather, top floor.
    _, h0 = safe_hours(scored[0][2], ())
    peak_hour = int(h0.groupby("hour")["t_in"].mean().idxmax())
    cuts = {"heatwave + power cut 20-21 h": EVENING_CUT,
            "heatwave alone (no power cut)": [],
            f"power cut at peak heat ({peak_hour:02d}-{peak_hour + 1:02d} h)": [peak_hour]}

    rows, hourly = [], []
    for wname, dname, csv in scored:
        for cname, hours in cuts.items():
            r, h = score(wname, dname, csv, cname, hours)
            rows.append(r)
            hourly.append(h)
        csv.unlink()
    table = pd.DataFrame(rows)
    table.to_csv(OUT / "results.csv", index=False)
    pd.concat(hourly).round(2).to_csv(OUT / "hourly.csv", index=False)
    (OUT / "summary.json").write_text(json.dumps({
        "limit_c": SAFE_LIMIT_C, "week": info["week"], "spinup_days": SPINUP_DAYS,
        "peak_heat_hour": peak_hour,
        "ac_warming_profile_c": {w: list(warming_profile(dt)) for w, dt in WEATHER.items()},
        "results": rows}, indent=2, default=str))
    plot(table, OUT / "safe_hours.png")
    pd.set_option("display.width", 250)
    print(f"Room's hottest hour: {peak_hour:02d}:00")
    print(table[["weather", "design", "power_cut", "safe_hours", "danger_hours", "nights_cut_in_danger",
                 "cut_max_heat_index_c", "max_heat_index_c", "night_safe_hours_22_06",
                 "mean_indoor_temp_c", "mean_outdoor_temp_c"]].to_string(index=False))


def plot(table, png):
    cuts = list(table["power_cut"].unique())
    weathers = list(table["weather"].unique())
    colours = ["#7f8c8d", "#e67e22", "#c0392b"]
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.6), sharey=True)
    for ax, dname in zip(axes, DESIGNS):
        d = table[table["design"] == dname]
        width = 0.8 / len(weathers)
        for k, (wname, colour) in enumerate(zip(weathers, colours)):
            vals = [int(d[(d["weather"] == wname) & (d["power_cut"] == c)]["safe_hours"].iloc[0]) for c in cuts]
            xs = [i + (k - 1) * width for i in range(len(cuts))]
            ax.bar(xs, vals, width, color=colour, label=wname)
            for x, v in zip(xs, vals):
                ax.text(x, v + 2, str(v), ha="center", fontsize=8)
        ax.set_xticks(range(len(cuts)))
        ax.set_xticklabels([c.replace(" (", "\n(").replace(" + ", "\n+ ") for c in cuts], fontsize=8)
        ax.set_title(f"{dname}, windows open, recorded heatwave 1-7 May 2024")
        ax.axhline(168, color="black", lw=0.8, ls=":")
        ax.grid(axis="y", alpha=0.3)
    axes[0].set_ylabel(f"Safe hours of 168 (heat index < {SAFE_LIMIT_C:.0f} °C)")
    axes[0].legend(fontsize=8, loc="upper left")
    fig.tight_layout()
    fig.savefig(png, dpi=200)
    plt.close(fig)


if __name__ == "__main__":
    main()
