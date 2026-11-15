"""The surrogate: instant safe hours and heat dose for a single room, from the
XGBoost models trained by train_surrogate.py on the sweeps (three outdoor-air
cases) and the random sample (run_sample.py: room size, orientation and the
continuous choices). An estimate only; the tools still run EnergyPlus for the result.
"""
import json
from functools import lru_cache

import pandas as pd

import config
from oasis.params import SWEEP_LEVELS

MODELS = {"safe_hours": config.OUT / "surrogate.json",            # target -> model file
          "hazard_hours_ch": config.OUT / "surrogate_hazard.json"}
METRICS = config.OUT / "surrogate_metrics.json"

NUMBERS = ("length_m", "width_m", "height_m", "orientation_deg", "roof_solar_absorptance",
           "wwr", "shading_depth_m", "night_vent", "occupants")
# Text choices become 0/1 columns, always in this order
CHOICES = {"floor": SWEEP_LEVELS["floor"], "wall": SWEEP_LEVELS["wall"], "roof": SWEEP_LEVELS["roof"],
           "weather": ["airport", "city", "street_ac"]}
PARAMETERS = (*NUMBERS, *CHOICES)       # the inputs as the user knows them


def features(df):
    """Design parameters (one row per design) as the numbers the model reads."""
    x = df[list(NUMBERS)].astype(float)
    for key, levels in CHOICES.items():
        for level in levels:
            x[f"{key}_{level}"] = (df[key] == level).astype(int)
    return x


def as_row(p, weather):
    """One building as a surrogate input. Glass given per wall (a Rhino model)
    becomes the window-to-wall ratio of the two long walls with the same area."""
    row = {k: p[k] for k in PARAMETERS if k != "weather"}
    if p.get("window_area_m2"):
        row["wwr"] = sum(p["window_area_m2"].values()) / (2 * p["length_m"] * p["height_m"])
    row["orientation_deg"] = row["orientation_deg"] % 360
    return pd.DataFrame([{**row, "weather": weather}])


@lru_cache(maxsize=1)
def load():
    """(models, metrics), or None when train_surrogate.py has not been run."""
    if not METRICS.exists() or not all(f.exists() for f in MODELS.values()):
        return None
    from xgboost import XGBRegressor
    models = {}
    for target, path in MODELS.items():
        models[target] = XGBRegressor()
        models[target].load_model(path)
    return models, json.loads(METRICS.read_text())


def predict(p, weather="airport"):
    """Estimate for one single-room building, or None without trained models.
    `outside` lists the inputs beyond what the models were trained on."""
    loaded = load()
    if loaded is None:
        return None
    models, metrics = loaded
    if "ranges" not in metrics or weather not in metrics.get("weathers", []):
        return None
    row = as_row(p, weather)
    x = features(row)
    outside = [k for k, (lo, hi) in metrics["ranges"].items()
               if not lo - 1e-9 <= float(row[k].iloc[0]) <= hi + 1e-9]
    outside += [k for k in ("floor", "wall", "roof") if p[k] not in CHOICES[k]]
    safe = float(models["safe_hours"].predict(x)[0])
    return {"safe_hours": int(round(min(max(safe, 0), 168))),
            "hazard_hours_ch": int(round(max(float(models["hazard_hours_ch"].predict(x)[0]), 0))),
            "mae_hours": metrics["by_source"]["random rooms"]["mae_hours"],
            "outside": outside}
