"""Assess one building live: simulate it, then re-simulate it with each
single design change and rank the changes by safe hours gained.

Used for buildings that are not in the stored sweep, e.g. a Rhino model.
"""
import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor

import config
from oasis.build_idf import build_idf
from oasis.metrics import safe_hours
from oasis.params import ROOF_ONLY, SWEEP_LEVELS
from oasis.simulate import run

WORK = config.OUT / "live_runs"   # temporary run folders, removed after use

# Design choices that can be tested on any geometry
CHOICES = ("wall", "roof", "roof_solar_absorptance", "shading_depth_m", "night_vent")


def simulate_many(designs, epw=None, cut_hours=None):
    """Simulate a list of parameter sets. Returns [(summary, hourly), ...].
    epw: weather file (default config.EPW); cut_hours: hours of the day with no fan."""
    batch = WORK / uuid.uuid4().hex[:8]
    # Model files are written one by one (eppy is not thread-safe) ...
    jobs = [(build_idf(p, batch / f"{i}.idf"), batch / str(i))
            for i, p in enumerate(designs)]
    # ... then EnergyPlus runs them side by side.
    with ThreadPoolExecutor(max_workers=8) as pool:
        csvs = list(pool.map(lambda job: run(*job, epw), jobs))
    results = [safe_hours(csv, cut_hours) for csv in csvs]
    shutil.rmtree(batch, ignore_errors=True)
    return results


def single_changes(p):
    """[(key, level)]: every design choice that differs from p by one setting."""
    options = []
    for key in CHOICES:
        if p.get("floor") == "middle" and key in ROOF_ONLY:
            continue      # the roof belongs to the flat above
        for level in SWEEP_LEVELS[key]:
            if level != p[key]:
                options.append((key, level))
    return options


def assess(p, epw=None, cut_hours=None):
    """Returns (summary, hourly, changes) for one building.
    changes: one row per single design change, best first."""
    options = single_changes(p)

    designs = [dict(p, name="design")] + [
        dict(p, **{key: level}, name=f"{key}={level}") for key, level in options]
    results = simulate_many(designs, epw, cut_hours)
    summary, hourly = results[0]

    changes = []
    for (key, level), (s, h) in zip(options, results[1:]):
        changes.append({
            "parameter": key, "value": level,
            "safe_hours": s["safe_hours"],
            "safe_hours_gained": s["safe_hours"] - summary["safe_hours"],
            "cut_hours_in_danger": s["cut_hours_in_danger"],
            "max_heat_index_c": s["max_heat_index_c"],
            "degree_hours_over_limit": s["degree_hours_over_limit"],
            "hourly": h,
        })
    changes.sort(key=lambda c: (-c["safe_hours_gained"], c["degree_hours_over_limit"]))
    return summary, hourly, changes
