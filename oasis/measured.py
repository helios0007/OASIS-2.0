"""Measured homes: the Tasgaonkar et al. (2022) South Asia indoor heat dataset.

Source: https://doi.org/10.6084/m9.figshare.12546368.v1 (CC0)
Files in data/measured/: "<City> Indoor Data.csv" (10-minute indoor
temperature, some loggers also humidity), "<City> AWS Data.csv" (hourly
weather station) and "<City> Housing Structure Data.csv" (one row per logger).

The date column mixes formats (M/D/Y, D-M-Y, M-D-YY, cut-off years), so each
row's date is read as whichever format lands closest to the row before it.
"""
import re
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

import config

DATA = config.ROOT / "data" / "measured"

def _date_options(s, prev):
    """Every date the string could be: month/day in either order. A year
    that is cut off or broken ('201', '201 6') is taken from the row before."""
    parts = re.split(r"[-/]", re.sub(r"\s+", "", str(s)))
    if len(parts) != 3 or not (parts[0].isdigit() and parts[1].isdigit()):
        return []
    a, b, y = int(parts[0]), int(parts[1]), parts[2]
    if y.isdigit() and len(y) == 4:
        year = int(y)
    elif y.isdigit() and len(y) == 2:
        year = 2000 + int(y)
    elif prev is not None:
        year = prev.year
    else:
        return []
    options = []
    for month, day in ((a, b), (b, a)):
        try:
            options.append(datetime(year, month, day))
        except ValueError:
            pass
    return options


def _dates(raw, step):
    """Day of each row. raw: date strings; step: expected time between rows.
    Each row takes the reading whose date is closest to the previous day."""
    out = []
    prev = None
    for s in raw:
        options = _date_options(s, prev)
        if prev is None:
            # First row: month first, as in most rows of these files
            day = options[0] if options else None
        elif options:
            day = min(options, key=lambda d: abs(d - prev))
            if abs(day - prev) > timedelta(days=3):
                day = prev     # unreadable or wrong: keep counting from the last row
        else:
            day = prev
        out.append(day)
        if day is not None:
            prev = day
    return out


def _timestamps(df, step):
    days = _dates(df["DD/MM/YYYY"], step)
    # Some rows have the year's last digit in the time column ("6  1:00:00 AM")
    # and a few use a 24-hour clock ("6 0:00").
    clock = df["Time"].astype(str).str.extract(
        r"(?P<h>\d{1,2}):(?P<m>\d{2})(?::\d{2})?\s*(?P<ampm>[AP]M)?")
    hour = pd.to_numeric(clock["h"], errors="coerce")
    minute = pd.to_numeric(clock["m"], errors="coerce")
    pm = clock["ampm"] == "PM"
    am = clock["ampm"] == "AM"
    hour = hour.where(~(am & (hour == 12)), 0)            # 12 AM = 00
    hour = hour.where(~(pm & (hour != 12)), hour + 12)    # 1 PM = 13
    stamps = [pd.Timestamp(d) + pd.Timedelta(hours=h, minutes=mi)
              if d is not None and not (pd.isna(h) or pd.isna(mi)) else pd.NaT
              for d, h, mi in zip(days, hour, minute)]
    return pd.DatetimeIndex(stamps)


def housing(city):
    h = pd.read_csv(DATA / f"{city} Housing Structure Data.csv")
    h.columns = [c.strip() for c in h.columns]
    h = h.rename(columns={"Floor on top": "Floor above"})
    h["Logger ID"] = h["Logger ID"].astype(str).str.strip()
    for col in h.columns:
        if h[col].dtype == object:
            h[col] = h[col].astype(str).str.strip()
    return h


def indoor(city):
    """Hourly mean indoor air temperature, one column per logger ID, and
    humidity columns named '<ID> (RH)'. Index: local time, hour starting."""
    df = pd.read_csv(DATA / f"{city} Indoor Data.csv", na_values=["NA", ""],
                     low_memory=False)
    df.index = _timestamps(df, timedelta(minutes=10))
    df = df[df.index.notna()]
    loggers = df.columns[7:]
    values = df[loggers].apply(pd.to_numeric, errors="coerce")
    values.columns = [str(c).strip() for c in values.columns]
    values = values.T.groupby(level=0).first().T   # duplicate column names
    # An hour needs at least 4 of its 6 ten-minute readings
    hourly = values.resample("1h").mean()
    enough = values.resample("1h").count() >= 4
    return hourly.where(enough)


def weather(city):
    """Hourly station weather. Columns: temp_c, rh, dewpoint_c, wind_ms,
    wind_dir_deg, ghi_wm2, pressure_pa. Index: local time, hour starting
    (the station logs the hour just ended)."""
    a = pd.read_csv(DATA / f"{city} AWS Data.csv", low_memory=False)
    a.index = _timestamps(a, timedelta(hours=1)) - pd.Timedelta(hours=1)
    a = a[a.index.notna()]
    a.columns = [c.strip() for c in a.columns]
    compass = {d: i * 22.5 for i, d in enumerate(
        "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split())}
    w = pd.DataFrame({
        "temp_c": pd.to_numeric(a["Temp Out"], errors="coerce"),
        "rh": pd.to_numeric(a["Out Hum"], errors="coerce"),
        "dewpoint_c": pd.to_numeric(a["Dew Pt."], errors="coerce"),
        "wind_ms": pd.to_numeric(a["Wind Speed"], errors="coerce"),
        "wind_dir_deg": a["Wind Dir"].astype(str).str.strip().map(compass),
        "ghi_wm2": pd.to_numeric(a["Solar Rad."], errors="coerce"),
        "pressure_pa": pd.to_numeric(a["Bar"], errors="coerce") * 100,
    }, index=a.index)
    w = w[~w.index.duplicated()].sort_index()
    return w.asfreq("1h")
