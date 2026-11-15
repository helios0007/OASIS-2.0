"""Measured power cuts: turn minute-by-minute voltage records into an outage
profile (how often, at what hour, for how long).

Source format: Prayas ESMI (Electricity Supply Monitoring Initiative), Harvard
Dataverse doi:10.7910/DVN/CLLZZM, Nov 2014 - Dec 2018. Files are wide: one row
per location and hour, `Location name, Date, Hour, Min 0 ... Min 59`, volts.
One Chennai monitor is listed on the ESMI site: "Gopalapuram- Chennai".

Rules (Prayas's own definitions):
  - a minute at or below NO_SUPPLY_V counts as no supply;
  - missing data is unavailable data, never an outage;
  - an interruption is a run of at least MIN_OUTAGE_MIN no-supply minutes.
"""
import json

import numpy as np
import pandas as pd

import config

NO_SUPPLY_V = 130        # V; Prayas: "voltage below 131 is considered as no supply"
MIN_OUTAGE_MIN = 2       # min; Prayas's shortest interruption class is 2-15 min
HOT_MONTHS = (4, 5, 6)   # April-June: the Chennai heat season
EVENING = range(18, 24)  # start hours counted as an evening outage
ESMI_2019_JAN_JUN = "2019 Jan-June"   # file known to drop all-zero hours: outages undercounted
SUMMARY = config.OUT / "outages" / "summary.json"
MINUTES = [f"Min {i}" for i in range(60)]


def read_location(path, name):
    """Rows of one ESMI file whose location name contains `name` (any case).
    Reads in chunks: the files are about 200 MB each."""
    with open(path, encoding="utf-8", errors="replace") as f:
        sep = "\t" if "\t" in f.readline() else ","
    keep = []
    for chunk in pd.read_csv(path, sep=sep, chunksize=50_000, encoding_errors="replace"):
        chunk.columns = [str(c).strip() for c in chunk.columns]
        keep.append(chunk[chunk["Location name"].astype(str).str.contains(name, case=False, regex=False)])
    return pd.concat(keep, ignore_index=True)


def minute_series(rows):
    """Wide rows -> one voltage per minute (pandas Series indexed by time).
    Dates are DD-MM-YYYY (2014-18 files) or M/D/YYYY (2019 files)."""
    date = rows["Date"].astype(str).str.strip()
    slash = date.str.contains("/")
    day = pd.to_datetime(date.where(~slash), format="%d-%m-%Y", errors="coerce")
    day = day.fillna(pd.to_datetime(date.where(slash), format="%m/%d/%Y", errors="coerce"))
    hour = pd.to_numeric(rows["Hour"], errors="coerce")
    ok = day.notna() & hour.between(0, 23)
    start = (day[ok] + pd.to_timedelta(hour[ok], unit="h")).to_numpy()
    volts = rows.loc[ok, MINUTES].apply(pd.to_numeric, errors="coerce").to_numpy()
    times = (start[:, None] + np.arange(60) * np.timedelta64(1, "m")).ravel()
    s = pd.Series(volts.ravel(), index=pd.DatetimeIndex(times)).dropna()
    return s[~s.index.duplicated()].sort_index()   # a repeated hour is counted once


def events(volts):
    """Interruptions in a minute series: DataFrame of start time and minutes.
    A gap in the record ends an interruption (missing data is not an outage)."""
    off = volts <= NO_SUPPLY_V
    gap = volts.index.to_series().diff() != pd.Timedelta(minutes=1)
    run = ((off != off.shift()) | gap).cumsum()
    out = [(g.index[0], len(g)) for _, g in off[off].groupby(run[off]) if len(g) >= MIN_OUTAGE_MIN]
    return pd.DataFrame(out, columns=["start", "minutes"])


def profile(volts, months=HOT_MONTHS):
    """Outage statistics for the given months (None = the whole record)."""
    if months:
        volts = volts[volts.index.month.isin(months)]
    ev = events(volts)
    days = volts.index.normalize().nunique()
    if days == 0:
        return {"days_monitored": 0}
    start_hour = ev["start"].dt.hour
    evening = ev[start_hour.isin(EVENING)]
    by_hour = start_hour.value_counts().reindex(range(24), fill_value=0)
    return {
        "days_monitored": int(days),
        "first_day": str(volts.index[0].date()), "last_day": str(volts.index[-1].date()),
        "interruptions": int(len(ev)),
        "interruptions_per_week": round(len(ev) / days * 7, 2),
        "share_of_days_with_cut": round(ev["start"].dt.normalize().nunique() / days, 3),
        "share_of_days_with_evening_cut": round(evening["start"].dt.normalize().nunique() / days, 3),
        "minutes_without_power_per_day": round(float((volts <= NO_SUPPLY_V).sum()) / days, 1),
        "duration_min_median": float(ev["minutes"].median()) if len(ev) else None,
        "duration_min_p90": float(ev["minutes"].quantile(0.9)) if len(ev) else None,
        "duration_min_max": int(ev["minutes"].max()) if len(ev) else None,
        "evening_duration_min_median": float(evening["minutes"].median()) if len(evening) else None,
        "starts_by_hour": [int(n) for n in by_hour],
        "most_common_start_hour": int(by_hour.idxmax()) if len(ev) else None,
    }


def measured():
    """The saved outage profile (get_outages.py), or None if it has not been made."""
    return json.loads(SUMMARY.read_text()) if SUMMARY.exists() else None
