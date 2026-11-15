"""Random sample of designs for the surrogate: room size, orientation and the
continuous choices vary freely, in all three outdoor-air cases.

The sweep (run_sweep.py) only covers the 6 x 5 x 3 m room on fixed levels, so a
surrogate trained on it cannot rate another room. This sample fills the space
in between: every design is drawn at random inside RANGES.

Writes outputs/sample.csv   one row per design (parameters, weather, results)
Run:   python run_sample.py           1,500 designs (about 5 minutes)
       python run_sample.py 300       another size
"""
import os
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

import config
from oasis.params import BASELINE, SWEEP_LEVELS

SAMPLE_DIR = config.OUT / "sample_runs"   # temporary, deleted at the end
SEED = 0

# Continuous inputs: (low, high). The surrogate is only valid inside these.
RANGES = {
    "length_m": (3.0, 9.0),
    "width_m": (2.5, 7.0),
    "height_m": (2.6, 3.6),
    "roof_solar_absorptance": (0.2, 0.8),
    "wwr": (0.05, 0.40),
    "shading_depth_m": (0.0, 1.0),
}
ORIENTATIONS = list(range(0, 360, 15))
OCCUPANTS = list(range(1, 9))
CATEGORIES = ("floor", "wall", "roof", "night_vent")      # drawn from the sweep levels
GEOMETRY = ("length_m", "width_m", "height_m")


def random_designs(n, weathers):
    """n parameter dictionaries (+ their weather case), drawn at random."""
    rng = np.random.default_rng(SEED)
    designs = []
    for i in range(n):
        p = dict(BASELINE, name=f"s{i:04d}")
        for key, (lo, hi) in RANGES.items():
            p[key] = round(float(rng.uniform(lo, hi)), 2)
        p["orientation_deg"] = int(rng.choice(ORIENTATIONS))
        p["occupants"] = int(rng.choice(OCCUPANTS))
        for key in CATEGORIES:
            p[key] = SWEEP_LEVELS[key][int(rng.integers(len(SWEEP_LEVELS[key])))]
        designs.append((p, weathers[int(rng.integers(len(weathers)))]))
    return designs


def run_one(job):
    """Build, simulate and rate one design. Runs in a worker process."""
    p, weather, epw = job
    from oasis.build_idf import build_idf
    from oasis.metrics import safe_hours
    from oasis.simulate import run

    run_dir = SAMPLE_DIR / p["name"]
    idf = build_idf(p, SAMPLE_DIR / f"{p['name']}.idf")
    summary, _ = safe_hours(run(idf, run_dir, epw))
    shutil.rmtree(run_dir, ignore_errors=True)
    idf.unlink(missing_ok=True)
    row = {k: p[k] for k in ["name", *GEOMETRY, *SWEEP_LEVELS]}
    return {**row, "weather": weather, **summary}


def main():
    from oasis import scenario
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1500
    weathers = scenario.available()
    epws = {w: scenario.weather_file(w) for w in weathers}      # written once, before the workers start
    jobs = [(p, w, epws[w]) for p, w in random_designs(n, weathers)]
    print(f"{n} random designs to simulate ({', '.join(weathers)} air)")
    SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
    start = time.time()

    workers = int(os.environ.get("OASIS_WORKERS", min(os.cpu_count(), 8)))   # as run_sweep.py
    with ProcessPoolExecutor(max_workers=workers) as pool:
        rows = list(pool.map(run_one, jobs, chunksize=8))

    pd.DataFrame(rows).to_csv(config.OUT / "sample.csv", index=False)
    shutil.rmtree(SAMPLE_DIR, ignore_errors=True)
    print(f"Done in {time.time() - start:.0f} s -> {config.OUT / 'sample.csv'}")


if __name__ == "__main__":
    main()
