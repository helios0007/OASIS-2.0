"""Neighbours' air conditioners: waste heat that warms the outdoor air.

Most Chennai homes around a free-running flat have split ACs. Each outdoor
unit dumps the room's heat (plus its own electricity) into the street, which
warms the air the free-running flat breathes in through open windows. The
literature puts the effect at:

    Salamanca et al. 2014, JGR Atmospheres, doi:10.1002/2013JD021225
        Phoenix heatwave (WRF + building energy model): negligible by day,
        > 1 C on the mean 2 m air temperature at night (stable boundary layer).
    de Munck et al. 2013, Int. J. Climatology 33:210-227, doi:10.1002/joc.3415
        Paris: +0.5 C street air with today's AC, +1 C if all units are dry
        (sensible heat only, like split ACs), +2 C if AC heat doubles; the
        rise is larger at night than by day.
    Ohashi et al. 2007, J. Appl. Meteor. Climatol. 46:66-81, doi:10.1175/JAM2441.1
        Tokyo office districts: +1-2 C on weekdays.

When the ACs run (Indian homes): mostly the sleep window, 22:00-06:00
(CEEW smart-meter and monitoring studies; 5-7 h a day on average), with
use rising through the evening.

So the warming here is an hourly profile added to the measured outdoor air:
NIGHT_C during 22:00-06:00, half of it in the shoulder hours, none by day.
Split ACs condense moisture indoors, so the outdoor air gets no extra
water: the dew point is kept and the relative humidity recomputed.

This is a literature range, not measured in Chennai. The airport station
(Meenambakkam, at the city edge) already includes whatever AC heat reaches
it, so adding this stands for a denser neighbourhood than the airport.
"""
import numpy as np

CURRENT_NIGHT_C = 1.0   # de Munck "dry" case; Salamanca > 1 C at night
DOUBLED_NIGHT_C = 2.0   # de Munck: AC waste heat doubled (more ACs by 2030s)
NIGHT_HOURS = set(range(22, 24)) | set(range(0, 6))   # sleep window, ACs on
SHOULDER_HOURS = {18, 19, 20, 21, 6, 7}               # use rising / tailing off


def warming_profile(night_c):
    """Extra outdoor air temperature (C) for each hour of the day (hour starting)."""
    return np.array([night_c if h in NIGHT_HOURS else night_c / 2 if h in SHOULDER_HOURS else 0.0
                     for h in range(24)])


def rh_from_dewpoint(t_c, td_c):
    """Relative humidity (%) from air temperature and dew point (Magnus formula)."""
    es = lambda x: np.exp(17.625 * x / (243.04 + x))
    return 100.0 * es(td_c) / es(t_c)


def add_ac_heat(epw_in, epw_out, night_c):
    """Copy an EPW, adding the AC warming to dry-bulb (field 7) and
    recomputing relative humidity (field 9) with the dew point (field 8) kept."""
    lines = epw_in.read_text().splitlines()
    dt = warming_profile(night_c)
    out = []
    for i, line in enumerate(lines):
        f = line.split(",")
        if i < 8 or len(f) < 10:
            if i == 5 and line.endswith('"'):          # COMMENTS 1: say what was added
                line = line[:-1] + f' + neighbours AC waste heat {night_c} C at night (oasis/ac_heat.py)"'
            out.append(line)
            continue
        hour = int(f[3]) - 1                     # EPW hour 1 = 00:00-01:00
        t = float(f[6]) + dt[hour]
        td = min(float(f[7]), t)
        f[6] = f"{t:.2f}"
        f[8] = str(int(round(min(100.0, rh_from_dewpoint(t, td)))))
        out.append(",".join(f))
    epw_out.write_text("\n".join(out) + "\n")
    return epw_out
