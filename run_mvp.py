"""The OASIS loop: build -> simulate -> safe hours -> intervene -> compare."""
import pandas as pd

import config
from oasis.build_idf import build_idf
from oasis.metrics import safe_hours
from oasis.params import BASELINE, INTERVENTIONS, variant
from oasis.plot import plot_runs
from oasis.simulate import run


def main():
    config.OUT.mkdir(exist_ok=True)
    designs = [BASELINE] + [variant(n) for n in INTERVENTIONS]

    rows, series = [], {}
    for p in designs:
        idf = build_idf(p, config.OUT / f"{p['name']}.idf")   # 1. build
        csv = run(idf, config.OUT / p["name"])                # 2. simulate
        summary, hourly = safe_hours(csv)                     # 3. reassess
        rows.append({"design": p["name"], **summary})
        series[p["name"]] = hourly

    table = pd.DataFrame(rows)
    base = table.loc[table.design == "baseline", "safe_hours"].iloc[0]
    table["safe_hours_gained"] = table["safe_hours"] - base
    table.to_csv(config.OUT / "results.csv", index=False)
    print(table.to_string(index=False))

    # One long table with every hour of every design (for charts / dashboard)
    hourly_all = pd.concat(
        [df.assign(design=name) for name, df in series.items()])
    hourly_all.round(2).to_csv(config.OUT / "hourly.csv", index=False)

    plot_runs(series, config.OUT / "heat_index_week.png")     # 4. compare


if __name__ == "__main__":
    main()
