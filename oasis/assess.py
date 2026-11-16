"""Assess one building live: simulate it, then re-simulate it with each
single design change and rank the changes by safe hours gained. The best
changes are then simulated together as packages (assess_packages).

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
# Packages: changes applied together, up to this many
# (Wu et al. 2025: single measures gain little, packages remove the danger hours).
PACKAGE_MAX = 3


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


def result_row(s, h, summary):
    """The numbers kept for a changed design, against the design as drawn."""
    return {
        "safe_hours": s["safe_hours"],
        "safe_hours_gained": s["safe_hours"] - summary["safe_hours"],
        # the same gain with the room at the two ends of the model error band (metrics.TEMP_ERROR_C);
        # the error belongs to the home, so both designs are shifted together
        "safe_hours_low": s["safe_hours_low"], "safe_hours_high": s["safe_hours_high"],
        "gain_if_warmer": s["safe_hours_low"] - summary["safe_hours_low"],
        "gain_if_cooler": s["safe_hours_high"] - summary["safe_hours_high"],
        "cut_hours_in_danger": s["cut_hours_in_danger"],
        "max_heat_index_c": s["max_heat_index_c"],
        "degree_hours_over_limit": s["degree_hours_over_limit"],
        "hazard_hours_ch": s["hazard_hours_ch"],
        "hourly": h,
    }


def assess(p, epw=None, cut_hours=None):
    """Returns (summary, hourly, changes) for one building.
    changes: one row per single design change, best first."""
    options = single_changes(p)

    designs = [dict(p, name="design")] + [
        dict(p, **{key: level}, name=f"{key}={level}") for key, level in options]
    results = simulate_many(designs, epw, cut_hours)
    summary, hourly = results[0]

    changes = [{"parameter": key, "value": level, **result_row(s, h, summary)}
               for (key, level), (s, h) in zip(options, results[1:])]
    changes.sort(key=lambda c: (-c["safe_hours_gained"], c["degree_hours_over_limit"]))
    return summary, hourly, changes


def package_row(parts, s, h, summary):
    """One package: its changes, its result, and the sum of its single gains
    (a package usually gains less than that sum: the changes overlap)."""
    return {"changes": [{"parameter": c["parameter"], "value": c["value"],
                         "safe_hours_gained": c["safe_hours_gained"]} for c in parts],
            "sum_of_single_gains": sum(c["safe_hours_gained"] for c in parts),
            **result_row(s, h, summary)}


def greedy_packages(p, summary, changes, simulate):
    """Build packages step by step. Start from the best single change; at each
    step simulate it with every remaining single change added and keep the one
    that reaches the most safe hours. Stops at PACKAGE_MAX changes, or when
    nothing adds safe hours (changes can cancel: insulation under a white roof
    holds the night heat in).
    simulate(designs) -> [(summary, hourly), ...]. Returns one row per step."""
    if not changes or changes[0]["safe_hours_gained"] <= 0:
        return []
    parts, best_safe, packages = [changes[0]], changes[0]["safe_hours"], []
    while len(parts) < PACKAGE_MAX:
        used = {c["parameter"] for c in parts}
        candidates = [c for c in changes if c["parameter"] not in used]
        if not candidates:
            break
        fixed = {c["parameter"]: c["value"] for c in parts}
        results = simulate([dict(p, **fixed, **{c["parameter"]: c["value"]}) for c in candidates])
        i = max(range(len(candidates)),
                key=lambda i: (results[i][0]["safe_hours"], -results[i][0]["degree_hours_over_limit"]))
        if results[i][0]["safe_hours"] <= best_safe:
            break
        parts, best_safe = parts + [candidates[i]], results[i][0]["safe_hours"]
        packages.append(package_row(parts, *results[i], summary))
    return packages


def assess_packages(p, summary, changes, epw=None, cut_hours=None):
    """The packages of greedy_packages for a single-room building p."""
    return greedy_packages(p, summary, changes, lambda designs: simulate_many(designs, epw, cut_hours))
