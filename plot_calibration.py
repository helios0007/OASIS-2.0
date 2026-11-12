"""Plots for the calibration (run calibrate.py first).

outputs/calibration/calibration_daily_cycle.png: average day, measured vs model
outputs/calibration/calibration_timeseries.png: two weeks of hourly values

    python plot_calibration.py
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

import config
from calibrate import CHECK, FIT

OUT = config.OUT / "calibration"
COLOURS = {"measured": "#222222", "current": "#c0504d", "calibrated": "#2e75b6"}


def main():
    h = pd.read_csv(OUT / "hourly.csv", parse_dates=["time"]).set_index("time")
    groups = list(h["group"].unique())

    # Average day, fit and check periods side by side
    fig, axes = plt.subplots(len(groups), 2, figsize=(11, 3.6 * len(groups)),
                             sharey=True, squeeze=False)
    for r, g in enumerate(groups):
        for c, (label, (a, b)) in enumerate((("fit: 16 May - 30 Jun", FIT),
                                             ("check: Jul - Aug", CHECK))):
            ax = axes[r][c]
            for model in ("current", "calibrated"):
                d = h[(h.group == g) & (h.model == model)].loc[a:b]
                if model == "current":
                    meas = d["t_meas"].groupby(d.index.hour).mean()
                    ax.plot(meas.index, meas.values, color=COLOURS["measured"],
                            lw=2.2, label="measured (mean of homes)")
                sim = d["t_sim"].groupby(d.index.hour).mean()
                ax.plot(sim.index, sim.values, color=COLOURS[model], lw=1.6,
                        label=f"model, {model} settings")
            ax.set_title(f"Dhaka, {g} walls: {label}", fontsize=10)
            ax.set_xticks(range(0, 24, 3))
            ax.set_xlabel("hour of day")
            ax.grid(alpha=0.3)
            if c == 0:
                ax.set_ylabel("indoor air temperature (°C)")
    axes[0][0].legend(fontsize=8, loc="upper left")
    fig.tight_layout()
    fig.savefig(OUT / "calibration_daily_cycle.png", dpi=150)

    # Two weeks of hourly values (first group)
    g = groups[0]
    a, b = "2016-06-01", "2016-06-14"
    fig, ax = plt.subplots(figsize=(11, 3.6))
    first = True
    for model in ("current", "calibrated"):
        d = h[(h.group == g) & (h.model == model)].loc[a:b]
        if first:
            ax.plot(d.index, d["t_meas"], color=COLOURS["measured"], lw=2, label="measured")
            first = False
        ax.plot(d.index, d["t_sim"], color=COLOURS[model], lw=1.2, label=f"model, {model}")
    ax.set_title(f"Dhaka, {g} walls, 1-14 June 2016", fontsize=10)
    ax.set_ylabel("indoor air temperature (°C)")
    ax.grid(alpha=0.3)
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(OUT / "calibration_timeseries.png", dpi=150)
    print("Saved plots to", OUT)


if __name__ == "__main__":
    main()
