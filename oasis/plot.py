"""Chart: indoor heat index over the heatwave week, one line per design."""
import matplotlib
matplotlib.use("Agg")   # write files, no window
import matplotlib.pyplot as plt

from oasis.metrics import SAFE_LIMIT_C


def week_figure(series: dict):
    """Figure with one heat-index line per design.
    series: {name: hourly DataFrame from metrics.safe_hours}."""
    fig, ax = plt.subplots(figsize=(12, 4))
    first = next(iter(series.values()))
    for i, is_cut in enumerate(first["cut"]):
        if is_cut:
            ax.axvspan(i, i + 1, color="orange", alpha=0.25, lw=0)
    for name, df in series.items():
        ax.plot(df["heat_index"].values, label=name, lw=1.5)
    ax.axhline(SAFE_LIMIT_C, color="red", ls="--", lw=1,
               label=f"Danger ({SAFE_LIMIT_C:.0f} °C)")
    ax.set_xlabel("Hour of heatwave week (orange = power cut)")
    ax.set_ylabel("Indoor heat index (°C)")
    ax.set_xlim(0, len(first))
    ax.legend(ncol=5, fontsize=8)
    fig.tight_layout()
    return fig


def plot_runs(series: dict, out_png):
    """Save the week chart as a PNG."""
    fig = week_figure(series)
    fig.savefig(out_png, dpi=200)
    plt.close(fig)
