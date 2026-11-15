"""Measured power cuts in Chennai homes, from the Prayas ESMI voltage records.

    python get_outages.py                       # all Chennai-area monitors in data/outages/
    python get_outages.py --location Gopalapuram
    python get_outages.py --test                # made-up file, checks the reader only

The files are not downloaded here: Harvard Dataverse asks each user to sign a
guestbook form. Download the "ESMI minute-wise voltage data ..." files and the
location file from
https://dataverse.harvard.edu/dataset.xhtml?persistentId=doi:10.7910/DVN/CLLZZM
and put them in data/outages/ (not in git: 2.4 GB). Output: outputs/outages/summary.json.
"""
import argparse
import json
import shutil

import numpy as np
import pandas as pd

import config
from oasis import outages

DATA = config.ROOT / "data" / "outages"
LOCATIONS = DATA / "ESMI location information.csv"


def synthetic(path):
    """A made-up week in the ESMI layout with three known cuts:
    2 May 20:10 for 45 min, 4 May 21:00 for 130 min, 5 May 03:00 for 1 min (too short to count).
    3 May 10:00-11:59 is left out (missing data, not an outage)."""
    rows = []
    for day in range(1, 8):
        for hour in range(24):
            if day == 3 and hour in (10, 11):
                continue
            v = np.full(60, 230)
            if day == 2 and hour == 20:
                v[10:55] = 0
            if day == 4 and hour in (21, 22):
                v[:] = 0
            if day == 4 and hour == 23:
                v[:10] = 101          # some monitors report a floor value instead of 0
            if day == 5 and hour == 3:
                v[0] = 0
            rows.append(["Testpuram- Chennai", f"{day:02d}-05-2030", hour, *v])
    pd.DataFrame(rows, columns=["Location name", "Date", "Hour", *outages.MINUTES]).to_csv(path, index=False)


def check_reader():
    tmp = config.OUT / "outages" / "_test"
    tmp.mkdir(parents=True, exist_ok=True)
    try:
        synthetic(tmp / "synthetic.csv")
        volts = outages.minute_series(outages.read_location(tmp / "synthetic.csv", "chennai"))
        ev = outages.events(volts)
        p = outages.profile(volts)
        got = [(str(s), m) for s, m in zip(ev["start"], ev["minutes"])]
        want = [("2030-05-02 20:10:00", 45), ("2030-05-04 21:00:00", 130)]
        assert got == want, got
        assert p["days_monitored"] == 7 and p["interruptions"] == 2, p
        assert p["share_of_days_with_evening_cut"] == round(2 / 7, 3), p
        assert p["most_common_start_hour"] in (20, 21), p
        print("Reader check passed on the made-up file:", got)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--location", default=None, help="name contains this; default: all Chennai-area monitors")
    ap.add_argument("--test", action="store_true")
    a = ap.parse_args()
    if a.test:
        return check_reader()

    # The 2019 files are left out: one lost its hour column, the other drops all-zero hours.
    files = sorted(f for f in DATA.glob("*") if f.suffix.lower() in (".tab", ".csv", ".tsv")
                   and "location information" not in f.name.lower() and "2019" not in f.name) if DATA.exists() else []
    if not files:
        raise SystemExit(f"No ESMI files in {DATA}. See the top of this script for the download page.")
    if a.location:
        rows = pd.concat([outages.read_location(f, a.location) for f in files], ignore_index=True)
    else:
        names = outages.chennai_monitors(LOCATIONS)
        rows = pd.concat([outages.read_locations(f, names) for f in files], ignore_index=True)
    if rows.empty:
        raise SystemExit(f"No matching monitor in {len(files)} file(s).")
    series = {name: outages.minute_series(g) for name, g in rows.groupby("Location name")}
    pooled = list(series.values())
    summary = {
        "source": "Prayas ESMI minute-wise voltage data, Harvard Dataverse doi:10.7910/DVN/CLLZZM",
        "area": a.location or "Chennai urban area (districts Chennai, Kancheepuram, Thiruvallur)",
        "locations": sorted(series),
        "files": [f.name for f in files],
        "rules": {"no_supply_v": outages.NO_SUPPLY_V, "min_outage_min": outages.MIN_OUTAGE_MIN,
                  "missing_data": "not counted as an outage",
                  "left_out": "2019 files (hour column lost / all-zero hours dropped)"},
        "hot_season": outages.profile(pooled),               # April-June, all monitors pooled
        "all_year": outages.profile(pooled, months=None),
        "by_location_hot_season": {name: outages.profile(v) for name, v in series.items()},
    }
    outages.SUMMARY.parent.mkdir(parents=True, exist_ok=True)
    outages.SUMMARY.write_text(json.dumps(summary, indent=2))
    hot = summary["hot_season"]
    print(f"{len(series)} monitors, April-June: {hot['days_monitored']} monitor-days")
    if hot["days_monitored"]:
        print(f"  cuts per week {hot['interruptions_per_week']}, days with a cut {hot['share_of_days_with_cut']:.0%}, "
              f"days with an evening cut {hot['share_of_days_with_evening_cut']:.0%}, median {hot['duration_min_median']} min, "
              f"90th percentile {hot['duration_min_p90']} min, longest {hot['duration_min_max']} min, "
              f"most common start hour {hot['most_common_start_hour']}")
    print("Saved", outages.SUMMARY)


if __name__ == "__main__":
    main()
