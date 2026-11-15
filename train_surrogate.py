"""Train the AI surrogate: predict safe hours and heat dose from the design.

Training data
    outputs/sweep.csv, sweep_city.csv, sweep_street_ac.csv   the 1,512-design grid in each
                                                             outdoor-air case (6 x 5 x 3 m room)
    outputs/sample.csv                                       random rooms (run_sample.py): size,
                                                             orientation, continuous choices
80 % of the designs train the models, 20 % are held back to test them against
the simulation. The test error is reported for the grid and the random rooms
separately: the random rooms are the honest number for a new building.

Writes outputs/surrogate.json             XGBoost model, safe hours
       outputs/surrogate_hazard.json      XGBoost model, heat dose (hazard hours, C.h)
       outputs/surrogate_metrics.json     test accuracy, what drives the result, valid ranges
       outputs/surrogate_check.png        predicted vs simulated
       outputs/surrogate_importance.png   what drives safe hours
Run:   python train_surrogate.py   (after run_sweep.py for each weather case and run_sample.py)
"""
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split
from xgboost import XGBRegressor

import config
from oasis import scenario
from oasis.labels import LABELS
from oasis.metrics import CAUTION_C
from oasis.params import BASELINE
from oasis.surrogate import CHOICES, MODELS, NUMBERS, PARAMETERS, features

GEOMETRY = ("length_m", "width_m", "height_m")
NAMES = {"length_m": "Room length", "width_m": "Room width", "height_m": "Ceiling height",
         "orientation_deg": "Orientation", "wwr": "Window size", "weather": "Outdoor air",
         **{k: title for k, (title, _) in LABELS.items()}}
# Envelope parts, to compare with Mehraban et al. (2025): windows 74 %, roofs 1 % in US timber homes
ENVELOPE = {"Roof": ("roof", "roof_solar_absorptance"), "Windows": ("wwr", "shading_depth_m"), "Walls": ("wall",)}


def load_grid(weather):
    """One sweep, with its weather case, the fixed room size and the heat dose
    (worked out from the stored hourly heat index: older sweeps lack the column)."""
    tag = "" if weather == scenario.DEFAULT_WEATHER else f"_{weather}"
    path = config.OUT / f"sweep{tag}.csv"
    if not path.exists():
        return None
    df = pd.read_csv(path)
    hourly = pd.read_csv(config.OUT / f"sweep_hourly{tag}.csv", index_col="name")
    df["hazard_hours_ch"] = (hourly.loc[df["name"]].to_numpy() - CAUTION_C).clip(min=0).sum(axis=1)
    return df.assign(weather=weather, source="grid", **{k: BASELINE[k] for k in GEOMETRY})


def load_data():
    parts = [d for d in (load_grid(w) for w in CHOICES["weather"]) if d is not None]
    sample = config.OUT / "sample.csv"
    if sample.exists():
        parts.append(pd.read_csv(sample).assign(source="random rooms"))
    else:
        print("No outputs/sample.csv (python run_sample.py): the surrogate will only know the 6 x 5 x 3 m room.")
    return pd.concat(parts, ignore_index=True)


def fit(x, y):
    model = XGBRegressor(n_estimators=600, max_depth=6, learning_rate=0.05, subsample=0.9, random_state=0)
    return model.fit(x, y)


def scores(y, pred, unit):
    return {"designs": len(y), "r2": round(float(r2_score(y, pred)), 3),
            f"mae_{unit}": round(float(mean_absolute_error(y, pred)), 2),
            f"max_error_{unit}": round(float(np.abs(y - pred).max()), 1)}


def importance(model, test, y):
    """How much the safe-hours error grows (h) when one input is shuffled
    among the test designs: what the result depends on, input by input."""
    rng = np.random.default_rng(0)
    base = mean_absolute_error(y, model.predict(features(test)))
    out = {}
    for key in PARAMETERS:
        rises = []
        for _ in range(5):
            shuffled = test.assign(**{key: rng.permutation(test[key].to_numpy())})
            rises.append(mean_absolute_error(y, model.predict(features(shuffled))) - base)
        out[key] = round(float(np.mean(rises)), 2)
    return dict(sorted(out.items(), key=lambda kv: -kv[1]))


def main():
    df = load_data()
    train, test = train_test_split(df, test_size=0.2, random_state=0, stratify=df["source"])
    x_train, x_test = features(train), features(test)

    models, preds = {}, {}
    for target in MODELS:
        models[target] = fit(x_train, train[target])
        models[target].save_model(MODELS[target])
        preds[target] = models[target].predict(x_test)

    safe, pred = test["safe_hours"], preds["safe_hours"]
    all_scores = scores(safe, pred, "hours")
    imp = importance(models["safe_hours"], test, safe)
    envelope = {part: sum(imp[k] for k in keys) for part, keys in ENVELOPE.items()}
    total = sum(envelope.values())
    random_rooms = df[df["source"] == "random rooms"]
    metrics = {
        "designs_total": len(df), "designs_train": len(train), "designs_test": len(test),
        "r2": all_scores["r2"], "mae_hours": all_scores["mae_hours"], "max_error_hours": all_scores["max_error_hours"],
        "by_source": {s: scores(safe[test["source"] == s], pred[test["source"] == s], "hours")
                      for s in test["source"].unique()},
        "hazard": scores(test["hazard_hours_ch"], preds["hazard_hours_ch"], "ch"),
        "weathers": sorted(df["weather"].unique()),
        # The models are only valid inside the sampled ranges
        "ranges": {k: [float(random_rooms[k].min()), float(random_rooms[k].max())]
                   for k in NUMBERS if k != "night_vent"} if len(random_rooms) else {},
        "importance_mae_rise_h": imp,
        "envelope_share_pct": {part: round(100 * v / total, 1) for part, v in envelope.items()},
    }
    print(json.dumps(metrics, indent=2))
    (config.OUT / "surrogate_metrics.json").write_text(json.dumps(metrics, indent=2))

    fig, ax = plt.subplots(figsize=(5, 5))
    for source, colour in (("grid", "tab:blue"), ("random rooms", "tab:orange")):
        pick = (test["source"] == source).to_numpy()
        ax.scatter(safe[pick], pred[pick], s=8, alpha=0.5, color=colour, label=source)
    ax.plot([0, 168], [0, 168], color="red", lw=1)
    ax.set_xlabel("Simulated safe hours (EnergyPlus)")
    ax.set_ylabel("Predicted safe hours (surrogate)")
    ax.set_title(f"R² = {metrics['r2']}, mean error = {metrics['mae_hours']} h")
    ax.legend()
    fig.tight_layout()
    fig.savefig(config.OUT / "surrogate_check.png", dpi=200)

    fig, ax = plt.subplots(figsize=(6, 4.5))
    keys = list(imp)[::-1]
    ax.barh([NAMES.get(k, k) for k in keys], [imp[k] for k in keys], color="tab:orange")
    ax.set_xlabel("Rise in safe-hours error when the input is shuffled (h)")
    ax.set_title("What drives safe hours")
    fig.tight_layout()
    fig.savefig(config.OUT / "surrogate_importance.png", dpi=200)


if __name__ == "__main__":
    main()
