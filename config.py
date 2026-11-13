from pathlib import Path

ROOT = Path(__file__).parent
# Weather: the recorded Chennai heatwave (get_heatwave.py: Meenambakkam
# station + ERA5 sunlight, hottest 7 days Apr-Jun 2016-2025). The TMYx
# "typical year" file stays as the template for station files and for
# comparison (run_heatwave.py).
TMYX_EPW = ROOT / "data" / "weather" / "chennai.epw"
TMYX_WEEK = ((5, 10), (5, 16))   # hottest week in the TMYx file (old default)
EPW = ROOT / "data" / "weather" / "chennai_heatwave.epw"
OUT = ROOT / "outputs"

# EnergyPlus 26.2 (note the space in the path: always pass it as a list item)
ENERGYPLUS = r"D:\IAAC\ENERGY PLUS\energyplus.exe"
EXAMPLES = Path(ENERGYPLUS).parent / "ExampleFiles"

# Heatwave week to score: 1-7 May 2024, mean outdoor heat index 45.1 C.
# Each default run starts SPINUP_DAYS earlier so the concrete carries the
# heat of the days before; simulate.run drops those days from eplusout.csv.
RUN_START = (5, 1)    # (month, day)
RUN_END = (5, 7)
SPINUP_DAYS = 7
SPINUP_START = (4, 24)   # RUN_START - SPINUP_DAYS

# Nightly power cut (24 h clock): fans stop 20:00-21:00
CUT_START_HOUR = 20
CUT_END_HOUR = 21
