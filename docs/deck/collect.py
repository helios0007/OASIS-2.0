"""Collect every number the deck shows from the OASIS outputs (no hand-typed results)."""
import json
import sys
from pathlib import Path

ROOT = Path(r"D:\IAAC\OASIS 2.0")
sys.path.insert(0, str(ROOT))
import os
os.chdir(ROOT)

import pandas as pd

import config
from oasis.assess import assess
from oasis.metrics import heat_index_c
from oasis.params import BASELINE

OUT = ROOT / "outputs"
d = {}

# Baseline hourly heat index (7 x 24) for the heat strip
h = pd.read_csv(OUT / "hourly.csv")
base = h[h["design"] == "baseline"].reset_index(drop=True) if "design" in h else h.iloc[:168]
d["strip"] = [round(float(x), 1) for x in base["heat_index"]]
d["strip_out"] = [round(float(x), 1) for x in heat_index_c(base["t_out"], base["rh_out"])]

# Heatwave: typical vs recorded
hw = pd.read_csv(OUT / "heatwave" / "results.csv")
d["heatwave"] = hw.to_dict("records")
info = json.loads((ROOT / "data" / "weather" / "chennai_heatwave.json").read_text())
d["weather"] = {"week": info["week"], "recorded": info["week_stats"], "typical": info["typical_year_week"],
                "hours_from_station": info["hours_from_station"], "hours_needed": info["hours_needed"],
                "bias": info["station_minus_era5"], "ranking": info["ranking_by_year"]}

# Scenarios
sc = pd.read_csv(OUT / "scenarios" / "results.csv")
d["scenarios"] = sc.to_dict("records")
d["scenarios_meta"] = json.loads((OUT / "scenarios" / "summary.json").read_text())
d["scenarios_meta"].pop("results", None)

# MVP run
d["mvp"] = pd.read_csv(OUT / "results.csv").to_dict("records")

# Baseline single changes (live, recorded heatwave)
summary, _, changes = assess(dict(BASELINE, name="baseline"))
d["baseline"] = summary
d["changes"] = [{k: c[k] for k in ("parameter", "value", "safe_hours", "safe_hours_gained", "max_heat_index_c")}
                for c in changes]

# Sweep + surrogate
sw = pd.read_csv(OUT / "sweep.csv")
d["sweep"] = {"designs": len(sw), "min": int(sw.safe_hours.min()), "max": int(sw.safe_hours.max()),
              "median": float(sw.safe_hours.median()),
              "best": sw.sort_values(["safe_hours", "degree_hours_over_limit"], ascending=[False, True]).head(5).to_dict("records"),
              "by_floor": sw.groupby("floor").safe_hours.median().to_dict()}
d["surrogate"] = json.loads((OUT / "surrogate_metrics.json").read_text())

# Evidence + calibration
d["evidence"] = json.loads((OUT / "evidence" / "summary.json").read_text())
cal = OUT / "calibration" / "homes" / "afn" / "summary.json"
d["calibration"] = json.loads(cal.read_text()) if cal.exists() else None
mhi = OUT / "evidence" / "measured_heat_index.csv"
d["measured_hi"] = pd.read_csv(mhi).to_dict("records") if mhi.exists() else None

(Path(__file__).parent / "deck_data.json").write_text(json.dumps(d, indent=1, default=str).replace(": NaN", ": null"))
print("baseline", summary["safe_hours"], "sweep", d["sweep"]["min"], d["sweep"]["max"], d["surrogate"])
print([(c["parameter"], c["value"], c["safe_hours_gained"]) for c in d["changes"]])
