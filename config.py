from pathlib import Path

ROOT = Path(__file__).parent
EPW = ROOT / "data" / "weather" / "chennai.epw"
OUT = ROOT / "outputs"

# EnergyPlus 26.2 (note the space in the path: always pass it as a list item)
ENERGYPLUS = r"D:\IAAC\ENERGY PLUS\energyplus.exe"
EXAMPLES = Path(ENERGYPLUS).parent / "ExampleFiles"

# Heatwave week to simulate: the hottest 7 days in the Chennai weather file
# (mean 33.3 C, max 41.1 C)
RUN_START = (5, 10)   # (month, day)
RUN_END = (5, 16)

# Nightly power cut (24 h clock): fans stop 20:00-21:00
CUT_START_HOUR = 20
CUT_END_HOUR = 21
