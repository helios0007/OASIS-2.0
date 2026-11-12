"""Build the OASIS tool page from the sweep results.

Reads  outputs/sweep.csv, outputs/sweep_hourly.csv, outputs/hourly.csv,
       outputs/surrogate_metrics.json and tool/template.html
Writes outputs/oasis_tool.html  (one self-contained page)
Run:   python make_tool.py   (after run_mvp.py, run_sweep.py, train_surrogate.py)
"""
import base64
import json

import numpy as np
import pandas as pd

import config
from oasis.params import BASELINE, SWEEP_LEVELS

TEMPLATE = config.ROOT / "tool" / "template.html"
PAGE = config.OUT / "oasis_tool.html"


def level_index(key, value):
    """Position of a value in its list of sweep levels."""
    levels = SWEEP_LEVELS[key]
    if isinstance(levels[0], float):
        return min(range(len(levels)), key=lambda i: abs(levels[i] - float(value)))
    return levels.index(value)


def main():
    sweep = pd.read_csv(config.OUT / "sweep.csv")
    hourly = pd.read_csv(config.OUT / "sweep_hourly.csv", index_col="name")
    t_out = pd.read_csv(config.OUT / "hourly.csv").query("design == 'baseline'")["t_out"]

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

    data = {
        "n": len(sweep),
        "levels": SWEEP_LEVELS,
        "baseline": {k: BASELINE[k] for k in SWEEP_LEVELS},
        "runs": runs,
        "hi": hi,
        "ymin": float(hourly.to_numpy().min()),
        "ymax": float(hourly.to_numpy().max()),
        "t_out": t_out.round(1).tolist(),
        "surrogate": json.loads((config.OUT / "surrogate_metrics.json").read_text()),
    }
    page = TEMPLATE.read_text(encoding="utf-8").replace(
        "__DATA__", json.dumps(data, separators=(",", ":")))
    PAGE.write_text(page, encoding="utf-8")
    print(f"{len(runs)} designs -> {PAGE} ({PAGE.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
