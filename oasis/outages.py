"""Measured power cuts: turn minute-by-minute voltage records into an outage
profile (how often, at what hour, for how long).

Source format: Prayas ESMI (Electricity Supply Monitoring Initiative), Harvard
Dataverse doi:10.7910/DVN/CLLZZM, Nov 2014 - Dec 2018. Files are wide: one row
per location and hour, `Location name, Date, Hour, Min 0 ... Min 59`, volts.
The location file lists the monitors; chennai_monitors() picks those in the
Chennai urban area (most of them were only monitored in 2018).

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
CHENNAI_DISTRICTS = ("Chennai", "Kancheepuram", "Thiruvallur")   # the city and its two suburban districts
SUMMARY = config.OUT / "outages" / "summary.json"
MINUTES = [f"Min {i}" for i in range(60)]


def chennai_monitors(location_file):
    """Names of the monitors in the Chennai urban area: Tamil Nadu, one of the three
    districts, and either classed "State Capital" or named after Chennai (this
    leaves out Thiruvallur town, 40 km away)."""
    loc = pd.read_csv(location_file, encoding_errors="replace")
    loc.columns = [c.strip() for c in loc.columns]
    name = loc["Location name"].astype(str).str.strip()
    pick = ((loc["State"].str.strip() == "Tamil Nadu") & loc["District"].str.strip().isin(CHENNAI_DISTRICTS)
            & ((loc["Category"].str.strip() == "State Capital") | name.str.contains("Chennai", case=False)))
    return sorted(name[pick])


def read_rows(path, keep):
    """Rows of one ESMI file whose (trimmed) location name passes keep(names) -> mask.
    Reads in chunks: the files are about 200 MB each."""
    with open(path, encoding="utf-8", errors="replace") as f:
        sep = "\t" if "\t" in f.readline() else ","
    out = []
    for chunk in pd.read_csv(path, sep=sep, chunksize=50_000, encoding_errors="replace"):
        chunk.columns = [str(c).strip() for c in chunk.columns]
        chunk["Location name"] = chunk["Location name"].astype(str).str.strip()
        out.append(chunk[keep(chunk["Location name"])])
    return pd.concat(out, ignore_index=True)


def read_locations(path, names):
    """Rows for the named monitors (exact names)."""
    return read_rows(path, lambda col: col.isin(names))


def read_location(path, name):
    """Rows whose location name contains `name` (any case)."""
    return read_rows(path, lambda col: col.str.contains(name, case=False, regex=False))


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
    return pd.DataFrame({"start": pd.to_datetime([s for s, _ in out]), "minutes": [m for _, m in out]})


def cut_days(ev):
    """Number of monitor-days with at least one interruption."""
    return len(ev.assign(day=ev["start"].dt.normalize())[["monitor", "day"]].drop_duplicates())


def off_by_hour(ev, days):
    """Share of monitor-days on which the power was off at some point in each hour
    of the day (0-23). A cut covers every hour it touches, so a 90-minute cut from
    19:50 counts in 19, 20 and 21 h. This is what the hourly model can use: a cut
    in an hour means no fan in that hour."""
    if not len(ev):
        return [0.0] * 24
    end = ev["start"] + pd.to_timedelta(ev["minutes"] - 1, unit="m")
    hours = [pd.date_range(s.floor("h"), e.floor("h"), freq="h") for s, e in zip(ev["start"], end)]
    touched = pd.DataFrame({"monitor": ev["monitor"].repeat([len(h) for h in hours]).to_numpy(),
                            "t": np.concatenate([h.to_numpy() for h in hours])})
    touched = touched.drop_duplicates()                     # one count per monitor and clock hour
    counts = touched["t"].dt.hour.value_counts().reindex(range(24), fill_value=0)
    return [round(float(n) / days, 4) for n in counts]


def profile(series, months=HOT_MONTHS):
    """Outage statistics for the given months (None = the whole record).
    series: one minute series, or a list of them (one per monitor). With several
    monitors a "day" is one monitor-day, so the figures are per home."""
    series = series if isinstance(series, list) else [series]
    if months:
        series = [v[v.index.month.isin(months)] for v in series]
    series = [v for v in series if len(v)]
    days = sum(v.index.normalize().nunique() for v in series)
    if days == 0:
        return {"days_monitored": 0}
    ev = pd.concat([events(v).assign(monitor=i) for i, v in enumerate(series)], ignore_index=True)
    start_hour = ev["start"].dt.hour
    evening = ev[start_hour.isin(EVENING)]
    by_hour = start_hour.value_counts().reindex(range(24), fill_value=0)
    return {
        "monitors": len(series),
        "days_monitored": int(days),
        "first_day": str(min(v.index[0] for v in series).date()),
        "last_day": str(max(v.index[-1] for v in series).date()),
        "interruptions": int(len(ev)),
        "interruptions_per_week": round(len(ev) / days * 7, 2),
        "share_of_days_with_cut": round(cut_days(ev) / days, 3),
        "share_of_days_with_evening_cut": round(cut_days(evening) / days, 3),
        "share_of_cuts_over_1h": round(float((ev["minutes"] > 60).mean()), 3) if len(ev) else None,
        "minutes_without_power_per_day": round(sum(float((v <= NO_SUPPLY_V).sum()) for v in series) / days, 1),
        "duration_min_median": float(ev["minutes"].median()) if len(ev) else None,
        "duration_min_p90": float(ev["minutes"].quantile(0.9)) if len(ev) else None,
        "duration_min_max": int(ev["minutes"].max()) if len(ev) else None,
        "evening_duration_min_median": float(evening["minutes"].median()) if len(evening) else None,
        "evening_duration_min_p90": float(evening["minutes"].quantile(0.9)) if len(evening) else None,
        "starts_by_hour": [int(n) for n in by_hour],
        "share_of_days_off_by_hour": off_by_hour(ev, days),
        "most_common_start_hour": int(by_hour.idxmax()) if len(ev) else None,
    }


def measured():
    """The saved outage profile (get_outages.py), or None if it has not been made."""
    return json.loads(SUMMARY.read_text()) if SUMMARY.exists() else None
