"""Build and run the baseline flat, then print a quick look at the results.

Use after every change to build_idf.py (guide steps 3-5).
"""
import pandas as pd

import config
from oasis.build_idf import build_idf
from oasis.params import BASELINE
from oasis.simulate import run


def main():
    idf = build_idf(BASELINE, config.OUT / "baseline.idf")
    csv = run(idf, config.OUT / "baseline")

    df = pd.read_csv(csv)
    df.columns = [c.strip() for c in df.columns]
    print(f"{len(df)} hourly rows from {csv}")
    print(df.drop(columns="Date/Time").describe().loc[["min", "mean", "max"]].round(1).T)

    # Hour of day when the indoor temperature peaks, on average
    t_in = df[[c for c in df.columns if "Zone Mean Air Temperature" in c][0]]
    by_hour = t_in.groupby(df.index % 24).mean()
    print(f"Indoor peak, on average: hour ending {by_hour.idxmax() + 1}:00")

    err = (config.OUT / "baseline" / "eplusout.err").read_text(errors="ignore")
    print(err.strip().splitlines()[-1].strip())


if __name__ == "__main__":
    main()
