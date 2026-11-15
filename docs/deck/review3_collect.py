"""Numbers for the Review 3 deck that deck_data.json does not hold: the mean daily
profile (measured, model, outdoor) of the Dhaka calibration homes. Run after check_evening.py."""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
hourly = pd.read_csv(ROOT / "outputs" / "evidence" / "model_evening_hourly.csv", index_col=0, parse_dates=True)
dhaka = hourly[hourly["city"] == "Dhaka"]
profile = dhaka.groupby(dhaka.index.hour)[["t_meas", "t_sim", "t_out"]].mean().round(2)
data = {
    "dhaka_homes": int(dhaka["logger"].nunique()),
    "dhaka_days": int(dhaka.index.normalize().nunique()),
    "dhaka_profile": {c: profile[c].tolist() for c in profile.columns},
    "measured_peak_hour": int(profile["t_meas"].idxmax()),
    "outdoor_peak_hour": int(profile["t_out"].idxmax()),
    "excess_at_20h_c": round(float(profile["t_meas"][20] - profile["t_out"][20]), 1),
}
(Path(__file__).parent / "review3_data.json").write_text(json.dumps(data, indent=1))
print({k: v for k, v in data.items() if k != "dhaka_profile"})

# ---- What the key papers changed in the tool (baseline room, recorded week) ----
import sys
sys.path.insert(0, str(ROOT))
import numpy as np

from oasis import scenario
from oasis.assess import assess, assess_packages, simulate_many
from oasis.labels import LABELS
from oasis.metrics import CAUTION_C, DOSE_LIMIT_ELDERLY_CH, DOSE_LIMIT_YOUNG_CH, cut_hours_list, safe_hours
from oasis.params import BASELINE, INTERVENTIONS

# Outage length and heat dose: the baseline run of run_mvp.py, re-scored (the cut only removes the fan)
csv = ROOT / "outputs" / "baseline" / "eplusout.csv"
data["outage"] = []
for c in scenario.CUT_LENGTHS:
    s, _ = safe_hours(csv, cut_hours_list(20, c["hours"]))
    data["outage"].append({"hours": c["hours"], "label": c["label"], "note": c["note"],
                           **{k: s[k] for k in ("safe_hours", "max_heat_index_c", "hazard_hours_ch")}})
s, h = safe_hours(csv)
data["dose"] = {"running_ch": np.cumsum((h["heat_index"] - CAUTION_C).clip(lower=0)).round(0).tolist(),
                "caution_c": CAUTION_C, "elderly_ch": DOSE_LIMIT_ELDERLY_CH, "young_ch": DOSE_LIMIT_YOUNG_CH,
                **{k: s[k] for k in ("hazard_hours_ch", "hours_to_elderly_limit", "hours_to_young_limit", "safe_hours")}}

# Packages: single changes, the greedy packages, and the two best singles simply combined
name = lambda c: LABELS[c["parameter"]][1][c["value"]]
p = dict(BASELINE, name="baseline")
summary, _, changes = assess(p)
packs = assess_packages(p, summary, changes)
naive = dict(p, **INTERVENTIONS["cool_roof"], **INTERVENTIONS["roof_insul"])
(naive_s, _), = simulate_many([naive])
data["packages"] = {
    "baseline": summary["safe_hours"],
    "singles": [{"label": name(c), "safe_hours": c["safe_hours"], "gain": c["safe_hours_gained"]} for c in changes[:2]],
    "naive": {"label": "White coating + insulation", "safe_hours": naive_s["safe_hours"],
              "gain": naive_s["safe_hours"] - summary["safe_hours"]},
    "greedy": [{"label": " + ".join(name(c) for c in k["changes"]), "safe_hours": k["safe_hours"],
                "gain": k["safe_hours_gained"], "hazard_hours_ch": k["hazard_hours_ch"]} for k in packs],
}
(Path(__file__).parent / "review3_data.json").write_text(json.dumps(data, indent=1))
print(data["outage"], {k: v for k, v in data["dose"].items() if k != "running_ch"}, data["packages"], sep="\n")
