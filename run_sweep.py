"""Parameter sweep: simulate every combination of the levels in
params.SWEEP_LEVELS and save the safe-hours results.

Writes outputs/sweep.csv        one row per design (parameters + results)
       outputs/sweep_hourly.csv hourly indoor heat index per design
Run:   python run_sweep.py                      airport air (the default weather)
       python run_sweep.py --weather city       another weather case of
       python run_sweep.py --weather street_ac  oasis/scenario.py; writes
                                                sweep_<case>.csv, sweep_hourly_<case>.csv
"""
import argparse
import itertools
import os
import shutil
import time
from concurrent.futures import ProcessPoolExecutor

import pandas as pd

import config
from oasis.params import BASELINE, ROOF_ONLY, SWEEP_LEVELS

SWEEP_DIR = config.OUT / "sweep_runs"   # temporary, deleted at the end


def all_designs():
    """Every combination of the sweep levels, as parameter dictionaries.
    On a middle floor the roof choices do nothing, so they are kept at
    their first level only (no duplicate runs)."""
    names = list(SWEEP_LEVELS)
    designs = []
    for values in itertools.product(*SWEEP_LEVELS.values()):
        p = dict(BASELINE, **dict(zip(names, values)))
        if p["floor"] == "middle" and any(
                p[k] != SWEEP_LEVELS[k][0] for k in ROOF_ONLY):
            continue
        p["name"] = f"d{len(designs):04d}"
        designs.append(p)
    return designs


def run_one(job):
    """Build, simulate and rate one design. Runs in a worker process."""
    p, epw = job
    from oasis.build_idf import build_idf
    from oasis.metrics import safe_hours
    from oasis.simulate import run

    run_dir = SWEEP_DIR / p["name"]
    idf = build_idf(p, SWEEP_DIR / f"{p['name']}.idf")
    summary, hourly = safe_hours(run(idf, run_dir, epw))
    shutil.rmtree(run_dir, ignore_errors=True)      # keep the disk clean
    idf.unlink(missing_ok=True)
    row = {k: p[k] for k in ["name", *SWEEP_LEVELS]}
    return {**row, **summary}, hourly["heat_index"].round(1).tolist()


def main():
    from oasis import scenario
    parser = argparse.ArgumentParser()
    parser.add_argument("--weather", default=scenario.DEFAULT_WEATHER, choices=list(scenario.WEATHERS) + ["site"])
    weather = parser.parse_args().weather
    epw = scenario.weather_file(weather)
    tag = "" if weather == scenario.DEFAULT_WEATHER else f"_{weather}"

    designs = all_designs()
    print(f"{len(designs)} designs to simulate ({weather} air)")
    SWEEP_DIR.mkdir(parents=True, exist_ok=True)
    start = time.time()

    # Each worker loads scipy/pythermalcomfort; one per CPU (24) exhausted the
    # Windows paging file, so cap it (OASIS_WORKERS overrides).
    workers = int(os.environ.get("OASIS_WORKERS", min(os.cpu_count(), 8)))
    with ProcessPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(run_one, [(p, epw) for p in designs], chunksize=8))

    rows = [r for r, _ in results]
    pd.DataFrame(rows).to_csv(config.OUT / f"sweep{tag}.csv", index=False)
    hourly = pd.DataFrame([h for _, h in results], index=[r["name"] for r in rows])
    hourly.to_csv(config.OUT / f"sweep_hourly{tag}.csv", index_label="name")
    shutil.rmtree(SWEEP_DIR, ignore_errors=True)
    print(f"Done in {time.time() - start:.0f} s -> {config.OUT / f'sweep{tag}.csv'}")


if __name__ == "__main__":
    main()
