"""Recorded heatwave: airport vs city-centre air (measured), three power-cut cases.

The baseline flat (windows open day and night, no AC) on the recorded
Chennai heatwave (1-7 May 2024, get_heatwave.py; 7 spin-up days), with four
versions of the outdoor air (oasis/ac_heat.py):

    airport (measured)           Meenambakkam, the default weather file
    city-centre wind (measured)  airport air, wind x Nungambakkam/airport ratio
    city centre (measured)       + Nungambakkam minus airport air temperature
                                 and dew point, same week (check_city_weather.py)
    street beside AC units       airport + 1 C at night: literature upper case,
                                 not measured in Chennai (2027 street logger)

Each simulation is scored five ways. EnergyPlus does not model the fan,
so a power cut only removes the fan's cooling credit in that hour
(oasis/metrics.py); the five cases share one simulation:

    heatwave + power cut 20-21 h   the OASIS case (evening load shedding)
    heatwave alone                 fans work every hour
    power cut at peak heat         one-hour cut at the room's hottest hour
                                   (from the airport-weather top floor run)
    power cut 20-06 h              no fan through the night
    no power all week              the long outage of the outage studies
                                   (Chen 2024, Shi 2025)

Every result is also scored with the extended heat index (Lu & Romps 2022)
as a cross-check of the NWS formula.

    python check_city_weather.py   (once, for the measured offsets)
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
from oasis.ac_heat import STREET_AC_NIGHT_C, add_ac_heat, city_centre, warming_profile
from oasis.build_idf import build_idf
from oasis.metrics import SAFE_LIMIT_C, cut_hours_list, heat_index_c, safe_hours
from oasis.params import BASELINE
from oasis.simulate import run
from run_heatwave import INFO, SPINUP_DAYS

OUT = config.OUT / "scenarios"
EPW = config.ROOT / "data" / "weather" / "chennai_heatwave.epw"
CITY = config.OUT / "city_weather" / "summary.json"     # check_city_weather.py
PROFILE = "heatwave_week"                                 # offsets measured in the same week
WEATHER = ["airport (measured)", "city-centre wind (measured)", "city centre (measured)",
           f"street beside AC units (+{STREET_AC_NIGHT_C:g} C at night, literature)"]
DESIGNS = {"top floor": {"floor": "top"}, "middle floor": {"floor": "middle"}}
EVENING_CUT = list(range(config.CUT_START_HOUR, config.CUT_END_HOUR))


def weather_files(profile):
    return dict(zip(WEATHER, [
        EPW,
        city_centre(EPW, OUT / "chennai_heatwave_city_wind.epw", profile, wind_only=True),
        city_centre(EPW, OUT / "chennai_heatwave_city.epw", profile),
        add_ac_heat(EPW, OUT / "chennai_heatwave_street_ac.epw"),
    ]))


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
    if not CITY.exists():
        raise SystemExit("Run python check_city_weather.py first (measured city-centre offsets).")
    profile = json.loads(CITY.read_text())["profile_24h"][PROFILE]
    scored = simulate(weather_files(profile), date.fromisoformat(info["week"]["start"]))

    # The room's hottest hour of the day: airport weather, top floor.
    _, h0 = safe_hours(scored[0][2], ())
    peak_hour = int(h0.groupby("hour")["t_in"].mean().idxmax())
    cuts = {"heatwave + power cut 20-21 h": EVENING_CUT,
            "heatwave alone (no power cut)": [],
            f"power cut at peak heat ({peak_hour:02d}-{peak_hour + 1:02d} h)": [peak_hour],
            # Long outages, as in the outage studies (Chen 2024, Shi 2025): the fan is all that changes
            "power cut 20-06 h (through the night)": cut_hours_list(config.CUT_START_HOUR, 10),
            "no power all week": cut_hours_list(0, 24)}

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
        "city_profile": {"source": str(CITY.relative_to(config.ROOT)), "period": PROFILE, **profile},
        "street_ac_profile_c": list(warming_profile(STREET_AC_NIGHT_C)),
        "results": rows}, indent=2, default=str))
    plot(table, OUT / "safe_hours.png")
    pd.set_option("display.width", 250)
    print(f"Room's hottest hour: {peak_hour:02d}:00")
    print(table[["weather", "design", "power_cut", "safe_hours", "danger_hours", "hazard_hours_ch", "nights_cut_in_danger",
                 "cut_max_heat_index_c", "max_heat_index_c", "night_safe_hours_22_06", "safe_hours_extended_hi",
                 "mean_indoor_temp_c", "mean_outdoor_temp_c"]].to_string(index=False))


def plot(table, png):
    cuts = list(table["power_cut"].unique())
    weathers = list(table["weather"].unique())
    colours = ["#7f8c8d", "#2e86c1", "#16a085", "#c0392b"]
    fig, axes = plt.subplots(1, 2, figsize=(17, 4.6), sharey=True)
    for ax, dname in zip(axes, DESIGNS):
        d = table[table["design"] == dname]
        width = 0.8 / len(weathers)
        for k, (wname, colour) in enumerate(zip(weathers, colours)):
            vals = [int(d[(d["weather"] == wname) & (d["power_cut"] == c)]["safe_hours"].iloc[0]) for c in cuts]
            xs = [i + (k - (len(weathers) - 1) / 2) * width for i in range(len(cuts))]
            ax.bar(xs, vals, width, color=colour, label=wname)
            for x, v in zip(xs, vals):
                ax.text(x, v + 2, str(v), ha="center", fontsize=7)
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
