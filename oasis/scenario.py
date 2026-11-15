"""The scenario a design is tested in: which outdoor air, and when the power cut falls.

Weather cases (all on the recorded heatwave, 1-7 May 2024):
    airport   Meenambakkam station as measured (config.EPW): the default
    city      + the measured city-centre offsets (Nungambakkam minus airport,
              same week; check_city_weather.py)
    street_ac + 1 C at night beside AC outdoor units: literature upper case,
              not measured in Chennai (oasis/ac_heat.py)

Power cut: a list of hours of the day with no fan ([] = no cut), made by
metrics.cut_hours_list from a start hour and a length (CUT_LENGTHS).
"""
import json

import config
from oasis.ac_heat import STREET_AC_NIGHT_C, add_ac_heat, city_centre

CASES = config.OUT / "weather_cases"
CITY = config.OUT / "city_weather" / "summary.json"
CITY_PROFILE = "heatwave_week"

WEATHERS = {
    "airport": {"label": "Airport", "source": "Measured",
                "note": "Meenambakkam station, 1-7 May 2024, as recorded (inland, the cautious case)."},
    "city": {"label": "City centre", "source": "Measured",
             "note": "Airport week shifted by the measured Nungambakkam minus airport difference "
                     "(cooler by day from the sea breeze, more humid, less wind)."},
    "street_ac": {"label": "Street AC heat", "source": "Literature",
                  "note": f"Airport week + {STREET_AC_NIGHT_C:g} °C at night beside AC outdoor units. "
                          "An upper case from Paris and Phoenix studies, not measured in Chennai."},
}
DEFAULT_WEATHER = "airport"
# How long the daily cut lasts. One hour is Chennai's evening load shedding; the
# long cases follow the outage studies (Chen 2024: days; Mehraban 2025: 72 h;
# Shi 2025: 7 days). The cut only removes the fan, so one simulation serves all.
CUT_LENGTHS = [
    {"hours": 1, "label": "1 hour", "note": "load shedding"},
    {"hours": 4, "label": "4 hours", "note": "evening outage"},
    {"hours": 10, "label": "10 hours", "note": "through the night"},
    {"hours": 24, "label": "All day", "note": "no power all week"},
]
DEFAULT_CUT_HOURS = list(range(config.CUT_START_HOUR, config.CUT_END_HOUR))


def city_summary():
    return json.loads(CITY.read_text()) if CITY.exists() else None


def available():
    """Weather keys that can be run now (the city case needs check_city_weather.py)."""
    return [k for k in WEATHERS if k != "city" or CITY.exists()]


def weather_file(key):
    """The .epw for a weather case, written once into outputs/weather_cases/."""
    if key == "airport":
        return config.EPW
    if key not in WEATHERS:
        raise ValueError(f"Unknown weather case '{key}'.")
    CASES.mkdir(parents=True, exist_ok=True)
    out = CASES / f"chennai_heatwave_{key}.epw"
    newest_input = max(config.EPW.stat().st_mtime, CITY.stat().st_mtime if CITY.exists() else 0)
    if out.exists() and out.stat().st_mtime >= newest_input:
        return out
    if key == "city":
        summary = city_summary()
        if summary is None:
            raise ValueError("Run check_city_weather.py first (measured city-centre offsets).")
        return city_centre(config.EPW, out, summary["profile_24h"][CITY_PROFILE])
    return add_ac_heat(config.EPW, out)
