"""Build the OASIS tool page from the sweep results.

Reads  outputs/sweep.csv, outputs/sweep_hourly.csv (airport air) and, when they
       exist, sweep_<case>.csv / sweep_hourly_<case>.csv for the other weather
       cases of oasis/scenario.py; the weather files (outdoor air);
       outputs/surrogate_metrics.json and tool/template.html
Writes outputs/oasis_tool.html  (one self-contained page)
Run:   python make_tool.py   (after run_sweep.py [--weather city | street_ac], train_surrogate.py)
"""
import base64
import json

import numpy as np
import pandas as pd

import config
from oasis import scenario
from oasis.params import BASELINE, SWEEP_LEVELS

TEMPLATE = config.ROOT / "tool" / "template.html"
PAGE = config.OUT / "oasis_tool.html"


def level_index(key, value):
    """Position of a value in its list of sweep levels."""
    levels = SWEEP_LEVELS[key]
    if isinstance(levels[0], float):
        return min(range(len(levels)), key=lambda i: abs(levels[i] - float(value)))
    return levels.index(value)


def outdoor_temp(epw):
    """Outdoor air temperature (C) for each hour of the scored week, from the weather file."""
    (m0, d0), (m1, d1) = config.RUN_START, config.RUN_END
    temps = []
    for line in epw.read_text().splitlines()[8:]:      # 8 header lines, then one row per hour
        cells = line.split(",")
        if (m0, d0) <= (int(cells[1]), int(cells[2])) <= (m1, d1):
            temps.append(round(float(cells[6]), 1))
    return temps


def pack(weather):
    """Lookup tables for one weather case, or None when its sweep has not been run."""
    tag = "" if weather == scenario.DEFAULT_WEATHER else f"_{weather}"
    sweep_csv, hourly_csv = config.OUT / f"sweep{tag}.csv", config.OUT / f"sweep_hourly{tag}.csv"
    if not sweep_csv.exists() or not hourly_csv.exists():
        print(f"  {weather}: no sweep yet (python run_sweep.py --weather {weather}); left out")
        return None
    sweep = pd.read_csv(sweep_csv)
    hourly = pd.read_csv(hourly_csv, index_col="name")
    runs, hi = {}, {}
    for row in sweep.to_dict("records"):
        # Lookup key: one digit per parameter = the index of its level
        key = "".join(str(level_index(k, row[k])) for k in SWEEP_LEVELS)
        runs[key] = [row["safe_hours"], row["cut_hours_in_danger"],
                     row["max_heat_index_c"], row["degree_hours_over_limit"],
                     row["mean_indoor_temp_c"], row["max_indoor_temp_c"]]
        # Hourly heat index, stored compactly: tenths of a degree, 2 bytes each
        tenths = np.round(hourly.loc[row["name"]].to_numpy() * 10).astype("<u2")
        hi[key] = base64.b64encode(tenths.tobytes()).decode()
    return {"runs": runs, "hi": hi, "t_out": outdoor_temp(scenario.weather_file(weather)),
            "ymin": float(hourly.to_numpy().min()), "ymax": float(hourly.to_numpy().max())}


def main():
    cases = {w: pack(w) for w in scenario.available()}
    cases = {w: c for w, c in cases.items() if c}
    n = len(cases[scenario.DEFAULT_WEATHER]["runs"])
    data = {
        "n": n,
        "levels": SWEEP_LEVELS,
        "baseline": {k: BASELINE[k] for k in SWEEP_LEVELS},
        "first_day": config.RUN_START[1],
        "cut_hour": config.CUT_START_HOUR,
        "default_weather": scenario.DEFAULT_WEATHER,
        "weathers": [{"key": w, **scenario.WEATHERS[w]} for w in cases],
        "cases": {w: {"runs": c["runs"], "hi": c["hi"], "t_out": c["t_out"]} for w, c in cases.items()},
        "ymin": min(c["ymin"] for c in cases.values()),
        "ymax": max(c["ymax"] for c in cases.values()),
        "surrogate": json.loads((config.OUT / "surrogate_metrics.json").read_text()),
    }
    page = TEMPLATE.read_text(encoding="utf-8").replace(
        "__DATA__", json.dumps(data, separators=(",", ":")))
    PAGE.write_text(page, encoding="utf-8")
    print(f"{n} designs x {len(cases)} weather cases -> {PAGE} ({PAGE.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
