"""A recorded Chennai heatwave as an EnergyPlus weather file.

The default weather file (data/weather/chennai.epw) is a TMYx "typical
year": months stitched from different years, which smooths out humidity.
Its hottest week (10-16 May) has a mean outdoor heat index of 36.5 C. This
script uses what was actually measured instead:

    air temperature, humidity, wind, pressure
        Chennai Meenambakkam airport, WMO 43279, hourly observations
        (Meteostat bulk data, https://meteostat.net; times in UTC)
    sunlight (total on a flat surface)
        ERA5 reanalysis at the airport (Open-Meteo archive API); the station
        does not measure it. Open-Meteo gives the mean of the hour before
        each time stamp.

The heatwave is picked by the data, not by hand: the 7 days (April-June,
2016-2025) with the highest mean outdoor heat index. The run starts
SPINUP_DAYS earlier so the concrete carries the real heat of the days
before; only the 7 days are scored (run_heatwave.py).

All times are converted to local time (IST), "hour starting" (as in
oasis/measured.py): station readings taken at hh:30 IST stand for the hour
hh:00-hh+1:00.

    python get_heatwave.py            downloads once, then uses data/weather/raw/
Outputs: data/weather/chennai_heatwave.epw, data/weather/chennai_heatwave.json
"""
import json
import urllib.request

import numpy as np
import pandas as pd

import config
from oasis.metrics import heat_index_c
from oasis.weather_file import SITES, make_epw

RAW = config.ROOT / "data" / "weather" / "raw"
STATION_URL = "https://bulk.meteostat.net/v2/hourly/43279.csv.gz"
STATION_FILE = RAW / "meteostat_43279_hourly.csv.gz"
STATION_COLUMNS = "date hour temp dwpt rhum prcp snow wdir wspd wpgt pres tsun coco".split()
ERA5_URL = ("https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}"
            "&start_date={start}&end_date={end}&hourly=temperature_2m,relative_humidity_2m,"
            "shortwave_radiation&wind_speed_unit=ms&timezone=Asia%2FKolkata")
IST = pd.Timedelta(hours=5, minutes=30)
YEARS = range(2016, 2026)          # full hourly record starts in 2016
MONTHS = (4, 5, 6)                 # pre-monsoon heat
WEEK_DAYS = 7
SPINUP_DAYS = 7
MIN_HOURS_PER_DAY = 22
EPW_OUT = config.ROOT / "data" / "weather" / "chennai_heatwave.epw"
INFO_OUT = config.ROOT / "data" / "weather" / "chennai_heatwave.json"


def download(url, path):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": "oasis-research-script"})
        with urllib.request.urlopen(req, timeout=120) as r:
            path.write_bytes(r.read())
    return path


def station():
    """Hourly station weather, IST, hour starting, one row per hour."""
    d = pd.read_csv(download(STATION_URL, STATION_FILE), header=None, names=STATION_COLUMNS)
    d.index = pd.DatetimeIndex(pd.to_datetime(d["date"]) + pd.to_timedelta(d["hour"], unit="h") + IST).floor("h")
    d = d[d.index.year >= YEARS[0]]
    w = pd.DataFrame({"temp_c": d["temp"], "rh": d["rhum"], "dewpoint_c": d["dwpt"],
                      "wind_ms": d["wspd"] / 3.6, "wind_dir_deg": d["wdir"],
                      "pressure_pa": d["pres"] * 100})
    return w.groupby(level=0).mean()      # a few hours have two reports


def pick_week(w):
    """The 7-day window with the highest mean outdoor heat index, per year and overall."""
    hi = pd.Series(heat_index_c(w["temp_c"].values, w["rh"].values), index=w.index)
    day = pd.DataFrame({"hi": hi.resample("1D").mean(), "tmax": w["temp_c"].resample("1D").max(),
                        "t": w["temp_c"].resample("1D").mean(), "rh": w["rh"].resample("1D").mean(),
                        "n": w["temp_c"].resample("1D").count()})
    day = day[day.index.month.isin(MONTHS)]
    rows = []
    for y in YEARS:
        r = day[day.index.year == y].rolling(WEEK_DAYS)
        s = pd.DataFrame({"hi": r["hi"].mean(), "tmax": r["tmax"].mean(), "t": r["t"].mean(),
                          "rh": r["rh"].mean(), "n": r["n"].min()}).dropna()
        s = s[s["n"] >= MIN_HOURS_PER_DAY]
        if s.empty:
            continue
        end = s["hi"].idxmax()
        b = s.loc[end]
        rows.append({"year": y, "start": str((end - pd.Timedelta(days=WEEK_DAYS - 1)).date()),
                     "end": str(end.date()), "mean_heat_index_c": round(b["hi"], 1),
                     "mean_daily_max_c": round(b["tmax"], 1), "mean_temp_c": round(b["t"], 1),
                     "mean_rh_pct": round(b["rh"], 0)})
    return sorted(rows, key=lambda r: -r["mean_heat_index_c"])


def era5_sunlight(start, end):
    _, _, lat, lon, _, _ = SITES["Chennai"]
    path = RAW / f"era5_chennai_{start}_{end}.json"
    e = json.loads(download(ERA5_URL.format(lat=lat, lon=lon, start=start, end=end), path).read_text())
    e = pd.DataFrame(e["hourly"])
    # value at time t = mean of (t-1h, t]  ->  hour starting t-1h
    e.index = pd.to_datetime(e["time"]) - pd.Timedelta(hours=1)
    return e


def tmyx_week_stats():
    rows = [l.split(",") for l in config.TMYX_EPW.read_text().splitlines()[8:]]
    m = [(int(r[1]), int(r[2])) for r in rows]
    t = np.array([float(r[6]) for r in rows])
    rh = np.array([float(r[8]) for r in rows])
    keep = np.array([(mm, dd) >= config.TMYX_WEEK[0] and (mm, dd) <= config.TMYX_WEEK[1] for mm, dd in m])
    return {"start": f"{config.TMYX_WEEK[0][0]:02d}-{config.TMYX_WEEK[0][1]:02d}",
            "end": f"{config.TMYX_WEEK[1][0]:02d}-{config.TMYX_WEEK[1][1]:02d}",
            "mean_heat_index_c": round(float(heat_index_c(t[keep], rh[keep]).mean()), 1),
            "mean_temp_c": round(float(t[keep].mean()), 1), "mean_rh_pct": round(float(rh[keep].mean()), 0)}


def main():
    w = station()
    ranking = pick_week(w)
    best = ranking[0]
    week_start, week_end = pd.Timestamp(best["start"]), pd.Timestamp(best["end"])
    run_start = week_start - pd.Timedelta(days=SPINUP_DAYS)
    span = w.loc[run_start: week_end + pd.Timedelta(hours=23)].copy()

    e = era5_sunlight(str(run_start.date()), str((week_end + pd.Timedelta(days=1)).date()))
    span["ghi_wm2"] = e["shortwave_radiation"].reindex(span.index)
    station_vs_era5 = {
        "temp_bias_c": round(float((span["temp_c"] - e["temperature_2m"].reindex(span.index)).mean()), 2),
        "rh_bias_pct": round(float((span["rh"] - e["relative_humidity_2m"].reindex(span.index)).mean()), 1)}
    hours = int((week_end + pd.Timedelta(days=1) - run_start) / pd.Timedelta(hours=1))
    missing = make_epw("Chennai", span, EPW_OUT,
                       source="Chennai Meenambakkam WMO 43279 (Meteostat) + ERA5 sunlight (Open-Meteo)")

    info = {
        "week": {"start": best["start"], "end": best["end"]},
        "run": {"start": str(run_start.date()), "end": best["end"], "spinup_days": SPINUP_DAYS},
        "week_stats": best, "typical_year_week": tmyx_week_stats(),
        "hours_needed": hours, "hours_from_station": int(span["temp_c"].notna().sum()),
        "hours_still_missing": len(missing),
        "station_minus_era5": station_vs_era5,
        "sources": {"station": STATION_URL + " (WMO 43279, Meteostat)",
                    "sunlight": "ERA5 via https://archive-api.open-meteo.com (shortwave_radiation)"},
        "ranking_by_year": ranking,
    }
    INFO_OUT.write_text(json.dumps(info, indent=2))
    print(pd.DataFrame(ranking).to_string(index=False))
    print(f"\nHeatwave: {best['start']} to {best['end']} (run from {run_start.date()}), "
          f"mean heat index {best['mean_heat_index_c']} C vs typical-year week {info['typical_year_week']['mean_heat_index_c']} C")
    print(f"Hours: {info['hours_from_station']}/{hours} from the station, {len(missing)} still missing; "
          f"station - ERA5: {station_vs_era5}")
    print(f"Wrote {EPW_OUT.name}, {INFO_OUT.name}")


if __name__ == "__main__":
    main()
