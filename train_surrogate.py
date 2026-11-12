"""Train the AI surrogate: predict safe hours from building parameters.

Uses the sweep results (outputs/sweep.csv). 80 % of the designs train the
model, 20 % are held back to test it against the simulation.
Writes outputs/surrogate.json           the trained XGBoost model
       outputs/surrogate_metrics.json   test accuracy
       outputs/surrogate_check.png      predicted vs simulated
Run:   python train_surrogate.py   (after run_sweep.py)
"""
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split
from xgboost import XGBRegressor

import config
from oasis.params import SWEEP_LEVELS

TARGET = "safe_hours"


def features(df):
    """Parameters as numbers: text choices become 0/1 columns."""
    x = df[list(SWEEP_LEVELS)].copy()
    x["night_vent"] = x["night_vent"].astype(int)
    return pd.get_dummies(x, columns=["floor", "wall", "roof"], dtype=int)


def main():
    df = pd.read_csv(config.OUT / "sweep.csv")
    x, y = features(df), df[TARGET]
    x_train, x_test, y_train, y_test = train_test_split(
        x, y, test_size=0.2, random_state=0)

    model = XGBRegressor(n_estimators=400, max_depth=5, learning_rate=0.05,
                         subsample=0.9, random_state=0)
    model.fit(x_train, y_train)
    pred = model.predict(x_test)

    metrics = {
        "designs_total": len(df),
        "designs_train": len(x_train),
        "designs_test": len(x_test),
        "r2": round(float(r2_score(y_test, pred)), 3),
        "mae_hours": round(float(mean_absolute_error(y_test, pred)), 2),
        "max_error_hours": round(float(abs(y_test - pred).max()), 1),
    }
    print(metrics)
    model.save_model(config.OUT / "surrogate.json")
    (config.OUT / "surrogate_metrics.json").write_text(json.dumps(metrics, indent=2))

    fig, ax = plt.subplots(figsize=(5, 5))
    ax.scatter(y_test, pred, s=10, alpha=0.6)
    lo, hi = y.min(), y.max()
    ax.plot([lo, hi], [lo, hi], color="red", lw=1)
    ax.set_xlabel("Simulated safe hours (EnergyPlus)")
    ax.set_ylabel("Predicted safe hours (surrogate)")
    ax.set_title(f"R² = {metrics['r2']}, mean error = {metrics['mae_hours']} h")
    fig.tight_layout()
    fig.savefig(config.OUT / "surrogate_check.png", dpi=200)


if __name__ == "__main__":
    main()
