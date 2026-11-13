"""Run EnergyPlus on one IDF and return the hourly results CSV."""
import subprocess

import pandas as pd
from pathlib import Path

import config


def run(idf_path: Path, run_dir: Path, epw: Path = None) -> Path:
    """epw: weather file; the Chennai file unless given."""
    run_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [config.ENERGYPLUS,
         "-w", str(epw or config.EPW),
         "-d", str(run_dir),
         "-r",                 # also write eplusout.csv
         str(idf_path)],
        check=True,
        cwd=run_dir,           # EnergyPlus writes scratch files here; needed for parallel runs
        capture_output=True,   # keep the terminal quiet; details are in eplusout.err
    )
    check_errors(run_dir)
    csv = run_dir / "eplusout.csv"
    drop_spinup(csv)
    return csv


def drop_spinup(csv: Path) -> None:
    """Default runs start config.SPINUP_DAYS before the scored week; keep
    only the scored week so every reader sees 7 x 24 rows from 00:00 on
    config.RUN_START. Runs with other dates are left alone."""
    df = pd.read_csv(csv)
    md = df["Date/Time"].str.strip().str.slice(0, 5)
    first = f"{config.SPINUP_START[0]:02d}/{config.SPINUP_START[1]:02d}"
    if md.iloc[0] != first:
        return
    keep_from = f"{config.RUN_START[0]:02d}/{config.RUN_START[1]:02d}"
    # Row stamped "05/01 01:00" is the hour 00:00-01:00 on 1 May.
    i = int(md.eq(keep_from).idxmax())
    df.iloc[i:].to_csv(csv, index=False)


def check_errors(run_dir: Path) -> None:
    """Fail on any severe error in eplusout.err."""
    err = (run_dir / "eplusout.err").read_text(errors="ignore")
    severe = [line for line in err.splitlines() if "** Severe" in line]
    if severe:
        raise RuntimeError("EnergyPlus severe errors:\n" + "\n".join(severe))
