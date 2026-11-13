"""Outdoor air around the flat: city centre (measured) and AC waste heat.

The heatwave weather file is the airport (Meenambakkam, 12 km inland, open
runway). Two ways the air at a city flat can differ from that:

1. City centre, measured (check_city_weather.py). Chennai's in-city IMD
   station, Nungambakkam, minus the airport at the same synoptic reports:
   air temperature, dew point and wind, per report time, interpolated to 24
   hours. In Apr-Jun 2016-2025 the city centre is +0.3 C at 05:30 (the
   night's heat, AC heat included, at the daily minimum), -0.9 C at 14:30
   (sea breeze), more humid by day, and its wind is ~0.7 x the airport's.
   This is the city-scale effect; both stations are open met enclosures.

2. A street beside AC outdoor units (literature upper case, not measured in
   Chennai). Split ACs dump the room's heat into the street, mostly in the
   sleep window 22:00-06:00 (CEEW monitoring of Indian homes):
       Salamanca et al. 2014, JGR Atmospheres, doi:10.1002/2013JD021225
           Phoenix: > 1 C on the 2 m night air temperature.
       de Munck et al. 2013, Int. J. Climatol. 33:210-227, doi:10.1002/joc.3415
           Paris: +0.5 C today, +1 C if all units are dry (sensible only).
   Kept as an upper case until the 2027 street logger measures it: the
   Chennai station data show only +0.3 C at dawn at city scale.

Dew point: the measured case shifts it by the measured offset; the AC case
keeps it (split ACs condense moisture indoors). Relative humidity is then
recomputed from temperature and dew point (Magnus formula).
"""
import numpy as np

STREET_AC_NIGHT_C = 1.0   # de Munck "dry" case; Salamanca > 1 C at night
NIGHT_HOURS = set(range(22, 24)) | set(range(0, 6))   # sleep window, ACs on
SHOULDER_HOURS = {18, 19, 20, 21, 6, 7}               # use rising / tailing off

# EPW columns (0-based)
DRY_BULB, DEW_POINT, RH, WIND_SPEED = 6, 7, 8, 21


def warming_profile(night_c):
    """Street AC case: extra air temperature (C) for each hour of the day (hour starting)."""
    return np.array([night_c if h in NIGHT_HOURS else night_c / 2 if h in SHOULDER_HOURS else 0.0
                     for h in range(24)])


def rh_from_dewpoint(t_c, td_c):
    """Relative humidity (%) from air temperature and dew point (Magnus formula)."""
    es = lambda x: np.exp(17.625 * x / (243.04 + x))
    return 100.0 * es(td_c) / es(t_c)


def shift_epw(epw_in, epw_out, d_temp, d_dew=None, wind_ratio=None, note=""):
    """Copy an EPW with hourly offsets (24 values, hour of day, hour starting):
    d_temp added to dry bulb, d_dew to dew point (None: dew point kept),
    wind speed multiplied by wind_ratio (None: kept). RH recomputed."""
    lines = epw_in.read_text().splitlines()
    out = []
    for i, line in enumerate(lines):
        f = line.split(",")
        if i < 8 or len(f) < 22:
            if i == 5 and line.endswith('"') and note:      # COMMENTS 1: say what was changed
                line = line[:-1] + f' + {note} (oasis/ac_heat.py)"'
            out.append(line)
            continue
        hour = int(f[3]) - 1                     # EPW hour 1 = 00:00-01:00
        t = float(f[DRY_BULB]) + d_temp[hour]
        td = float(f[DEW_POINT]) + (0.0 if d_dew is None else d_dew[hour])
        td = min(td, t)
        f[DRY_BULB], f[DEW_POINT] = f"{t:.2f}", f"{td:.2f}"
        f[RH] = str(int(round(min(100.0, rh_from_dewpoint(t, td)))))
        if wind_ratio is not None:
            f[WIND_SPEED] = f"{float(f[WIND_SPEED]) * wind_ratio[hour]:.2f}"
        out.append(",".join(f))
    epw_out.write_text("\n".join(out) + "\n")
    return epw_out


def add_ac_heat(epw_in, epw_out, night_c=STREET_AC_NIGHT_C):
    """Street AC case: literature warming profile, dew point kept."""
    return shift_epw(epw_in, epw_out, warming_profile(night_c),
                     note=f"street AC waste heat {night_c} C at night (literature)")


def city_centre(epw_in, epw_out, profile, wind_only=False):
    """Measured city-centre offsets (check_city_weather.py profile_24h entry)."""
    if wind_only:
        return shift_epw(epw_in, epw_out, np.zeros(24), wind_ratio=np.array(profile["wind_ratio"]),
                         note="city-centre wind ratio (Nungambakkam/airport, measured)")
    return shift_epw(epw_in, epw_out, np.array(profile["d_temp_c"]), np.array(profile["d_dewpoint_c"]),
                     np.array(profile["wind_ratio"]),
                     note="city-centre offsets (Nungambakkam minus airport, measured)")
