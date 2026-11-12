"""Smoke test (guide step 2): run a stock EnergyPlus example with the Chennai EPW.

Done when outputs/test_run/eplusout.csv appears and eplusout.err has no severe errors.
"""
import shutil
import subprocess
import sys

import config

IDF = config.EXAMPLES / "1ZoneUncontrolled.idf"
RUN_DIR = config.OUT / "test_run"


def main():
    if not config.EPW.exists():
        sys.exit(f"Weather file missing: {config.EPW}")

    RUN_DIR.mkdir(parents=True, exist_ok=True)
    # Run a copy: the example's sidecar .rvi file next to the original
    # stops ReadVarsESO from writing eplusout.csv.
    idf = config.OUT / "test_run.idf"
    shutil.copy(IDF, idf)
    subprocess.run(
        [config.ENERGYPLUS,
         "-w", str(config.EPW),
         "-d", str(RUN_DIR),
         "-r",                 # also write eplusout.csv
         str(idf)],
        check=True,
    )

    # Treat any severe error as a failure
    err = (RUN_DIR / "eplusout.err").read_text(errors="ignore")
    severe = [line for line in err.splitlines() if "** Severe" in line]
    if severe:
        sys.exit("Severe errors:\n" + "\n".join(severe))

    csv = RUN_DIR / "eplusout.csv"
    print("OK:" if csv.exists() else "MISSING:", csv)


if __name__ == "__main__":
    main()
