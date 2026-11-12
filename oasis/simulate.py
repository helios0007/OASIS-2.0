"""Run EnergyPlus on one IDF and return the hourly results CSV."""
import subprocess
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
    return run_dir / "eplusout.csv"


def check_errors(run_dir: Path) -> None:
    """Fail on any severe error in eplusout.err."""
    err = (run_dir / "eplusout.err").read_text(errors="ignore")
    severe = [line for line in err.splitlines() if "** Severe" in line]
    if severe:
        raise RuntimeError("EnergyPlus severe errors:\n" + "\n".join(severe))
