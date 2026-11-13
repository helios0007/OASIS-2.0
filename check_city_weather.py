"""Chennai city centre vs the airport: measured air temperature, humidity, wind.

The heatwave weather file uses the airport (Meenambakkam, WMO 43279, 12 km
inland, open runway). The flats stand in the city. Chennai has a second
IMD station inside the city: Nungambakkam (WMO 43278, Regional
Meteorological Centre, ~4 km from the sea). Both are in Meteostat's bulk
hourly data. This script measures how the city centre differs from the
airport, so the urban-heat / AC-heat and wind cases are grounded in Chennai
data instead of numbers from Phoenix, Paris or Tokyo.

Only the 3-hourly synoptic reports are observations at Nungambakkam
(00, 03, 06, 09, 12, 15 UTC = 05:30, 08:30, 11:30, 14:30, 17:30, 20:30 IST);
the other hours in the bulk file are model fill (wind jumps to ~30 km/h),
so they are dropped. The airport is compared at the same synoptic reports
(the same instruments practice: tenths of a degree, 10-min mean wind).

Both stations sit in open, fenced met enclosures: the difference is the
city-scale effect (urban heat, AC heat, sea breeze together), not the air in
a street beside AC outdoor units. That last part is the 2027 street logger.

    python check_city_weather.py
Outputs: outputs/city_weather/summary.json, offsets.csv, city_vs_airport.png
"""
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import config
from get_heatwave import RAW, STATION_COLUMNS, download

OUT = config.OUT / "city_weather"
AIRPORT = ("43279", "Meenambakkam airport")
CITY = ("43278", "Nungambakkam city centre")
URL = "https://bulk.meteostat.net/v2/hourly/{}.csv.gz"
SYNOP_UTC = (0, 3, 6, 9, 12, 15)          # observed at Nungambakkam
IST = pd.Timedelta(hours=5, minutes=30)
YEARS = range(2016, 2026)
MONTHS = (4, 5, 6)
WEEK = ("2024-05-01", "2024-05-07")       # the recorded heatwave (get_heatwave.py)


def synop(wmo):
    """Synoptic reports, indexed by IST hour starting (05:30 IST -> hour 5)."""
    d = pd.read_csv(download(URL.format(wmo), RAW / f"meteostat_{wmo}_hourly.csv.gz"),
                    header=None, names=STATION_COLUMNS)
    d = d[d["hour"].isin(SYNOP_UTC)]
    t = pd.to_datetime(d["date"]) + pd.to_timedelta(d["hour"], unit="h") + IST
    d.index = pd.DatetimeIndex(t).floor("h")
    w = pd.DataFrame({"temp_c": d["temp"], "dewpoint_c": d["dwpt"], "wind_ms": d["wspd"] / 3.6})
    return w.groupby(level=0).mean()


def compare(air, city):
    j = air.merge(city, left_index=True, right_index=True, suffixes=("", "_city")).dropna()
    j = j.assign(d_temp_c=j["temp_c_city"] - j["temp_c"],
                 d_dewpoint_c=j["dewpoint_c_city"] - j["dewpoint_c"])
    g = j.groupby(j.index.hour)
    return pd.DataFrame({
        "reports": g.size(),
        "airport_temp_c": g["temp_c"].mean(), "city_temp_c": g["temp_c_city"].mean(),
        "d_temp_c": g["d_temp_c"].mean(), "d_temp_sd_c": g["d_temp_c"].std(),
        "d_dewpoint_c": g["d_dewpoint_c"].mean(),
        "airport_wind_ms": g["wind_ms"].mean(), "city_wind_ms": g["wind_ms_city"].mean(),
        "wind_ratio": g["wind_ms_city"].mean() / g["wind_ms"].mean(),
    }).round(2)


def to_24h(by_hour):
    """Synoptic offsets (6 hours of the day) -> 24 hourly values, periodic linear."""
    h = np.array(by_hour.index, dtype=float)
    v = by_hour.values
    x = np.r_[h - 24, h, h + 24]
    return np.interp(np.arange(24), x, np.r_[v, v, v])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    air, city = synop(AIRPORT[0]), synop(CITY[0])
    season = lambda w: w[w.index.year.isin(YEARS) & w.index.month.isin(MONTHS)]
    week = lambda w: w.loc[WEEK[0]: WEEK[1] + " 23:00"]
    clim, hw = compare(season(air), season(city)), compare(week(air), week(city))

    rows = []
    for name, t in (("Apr-Jun 2016-2025", clim), ("heatwave 1-7 May 2024", hw)):
        rows.append(t.reset_index(names="hour_ist").assign(period=name))
    pd.concat(rows).to_csv(OUT / "offsets.csv", index=False)

    profile = {name: {"d_temp_c": [round(x, 2) for x in to_24h(t["d_temp_c"])],
                      "d_dewpoint_c": [round(x, 2) for x in to_24h(t["d_dewpoint_c"])],
                      "wind_ratio": [round(x, 2) for x in to_24h(t["wind_ratio"])]}
               for name, t in (("season", clim), ("heatwave_week", hw))}
    summary = {
        "stations": {"airport": f"{AIRPORT[1]} WMO {AIRPORT[0]}", "city": f"{CITY[1]} WMO {CITY[0]}"},
        "source": "Meteostat bulk hourly, synoptic reports only (00-15 UTC, 3-hourly)",
        "season": {"period": "Apr-Jun 2016-2025", "reports_per_hour": int(clim["reports"].min()),
                   "dawn_0530_d_temp_c": float(clim.loc[5, "d_temp_c"]),
                   "evening_2030_d_temp_c": float(clim.loc[20, "d_temp_c"]),
                   "afternoon_1430_d_temp_c": float(clim.loc[14, "d_temp_c"]),
                   "wind_ratio_mean": round(float(clim["city_wind_ms"].mean() / clim["airport_wind_ms"].mean()), 2)},
        "heatwave_week": {"period": "1-7 May 2024",
                          "dawn_0530_d_temp_c": float(hw.loc[5, "d_temp_c"]),
                          "evening_2030_d_temp_c": float(hw.loc[20, "d_temp_c"]),
                          "afternoon_1430_d_temp_c": float(hw.loc[14, "d_temp_c"]),
                          "wind_ratio_mean": round(float(hw["city_wind_ms"].mean() / hw["airport_wind_ms"].mean()), 2)},
        "profile_24h": profile,
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))
    plot(clim, hw, OUT / "city_vs_airport.png")
    pd.set_option("display.width", 200)
    print("Apr-Jun 2016-2025\n", clim.to_string(), "\n\nheatwave 1-7 May 2024\n", hw.to_string())
    print(json.dumps({k: summary[k] for k in ("season", "heatwave_week")}, indent=1))


def plot(clim, hw, png):
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.2))
    labels = [f"{h:02d}:30" for h in clim.index]
    x = np.arange(len(labels))
    for t, name, off, col in ((clim, "Apr-Jun 2016-2025", -0.2, "#7f8c8d"), (hw, "heatwave 1-7 May 2024", 0.2, "#c0392b")):
        axes[0].bar(x + off, t["d_temp_c"], 0.4, color=col, label=name)
        axes[1].bar(x + off, t["wind_ratio"], 0.4, color=col, label=name)
    axes[0].axhline(0, color="black", lw=0.8)
    axes[0].set_ylabel("City centre minus airport, air temperature (°C)")
    axes[1].axhline(1, color="black", lw=0.8)
    axes[1].set_ylabel("City centre wind / airport wind")
    for ax in axes:
        ax.set_xticks(x)
        ax.set_xticklabels(labels)
        ax.set_xlabel("Report time (IST)")
        ax.grid(axis="y", alpha=0.3)
    axes[0].legend(fontsize=8)
    fig.suptitle("Chennai, measured: Nungambakkam (city centre) vs Meenambakkam (airport)")
    fig.tight_layout()
    fig.savefig(png, dpi=200)
    plt.close(fig)


if __name__ == "__main__":
    main()
