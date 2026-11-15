"""Heat index and safe hours from an EnergyPlus hourly results CSV."""
import numpy as np
import pandas as pd

from pythermalcomfort.models import cooling_effect, heat_index_lu

import config

SAFE_LIMIT_C = 41.0  # heat index "Danger" band (NWS / Steadman chart, 105 F); a chosen limit, not fitted

# Ceiling fan: ASHRAE 55-2023 cooling effect (SET method, pythermalcomfort),
# worked out every hour from the room's air and radiant temperature and humidity.
FAN_AIR_SPEED_MS = 0.4   # room-average air speed with the fan on (same as agents.V_IN_ROOM)
FAN_MET = 1.1            # seated, light activity (ASHRAE 55)
FAN_CLO = 0.5            # light summer clothing (ASHRAE 55)
FAN_CREDIT_C = 2.0       # display only: the cooling effect at 32 C / 70 % RH

# Heat dose (Chen et al. 2024, Building and Environment 266:112089): heat-index
# hazard hours = the sum over the hours of (heat index - 27 C) where it is above
# the NWS "Caution" level. Heat illness is likely above these totals (their
# 7-day outage in Guangzhou, body water loss from JOS-3 with 80 % rehydration),
# or when the maximum heat index nears 55 C (core temperature 38 C).
CAUTION_C = 27.0
DOSE_LIMIT_ELDERLY_CH = 850.0
DOSE_LIMIT_YOUNG_CH = 1174.0
HI_MAX_LIMIT_C = 55.0
# NWS heat index bands (lower edge, C). "Danger" starts at SAFE_LIMIT_C.
BANDS = (("below_caution", -np.inf), ("caution", CAUTION_C), ("extreme_caution", 32.0),
         ("danger", SAFE_LIMIT_C), ("extreme_danger", 54.0))


def fan_credit_c(t, mrt, rh):
    """Cooling effect (C) of the fan at each hour, vs still air (0.1 m/s)."""
    t, mrt, rh = (np.asarray(x, dtype=float) for x in (t, mrt, rh))
    n = t.shape
    ce = cooling_effect(tdb=t, tr=mrt, vr=np.full(n, FAN_AIR_SPEED_MS), rh=rh,
                        met=np.full(n, FAN_MET), clo=np.full(n, FAN_CLO)).ce
    return np.nan_to_num(np.asarray(ce, dtype=float), nan=0.0)


def heat_index_c(t_c, rh):
    """Heat index in C from air temperature (C) and relative humidity (%).
    US National Weather Service formula (works internally in F)."""
    t = np.asarray(t_c, dtype=float) * 9 / 5 + 32
    rh = np.asarray(rh, dtype=float)
    simple = 0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094)
    full = (-42.379 + 2.04901523 * t + 10.14333127 * rh
            - 0.22475541 * t * rh - 0.00683783 * t**2
            - 0.05481717 * rh**2 + 0.00122874 * t**2 * rh
            + 0.00085282 * t * rh**2 - 0.00000199 * t**2 * rh**2)
    adj_low = ((13 - rh) / 4) * np.sqrt(np.clip((17 - np.abs(t - 95)) / 17, 0, None))
    full = np.where((rh < 13) & (t > 80) & (t < 112), full - adj_low, full)
    adj_high = ((rh - 85) / 10) * ((87 - t) / 5)
    full = np.where((rh > 85) & (t > 80) & (t < 87), full + adj_high, full)
    hi_f = np.where((simple + t) / 2 >= 80, full, simple)
    return (hi_f - 32) * 5 / 9


def heat_index_ext_c(t_c, rh):
    """Extended heat index (Lu & Romps 2022, J. Appl. Meteor. Climatol. 61:1367,
    doi:10.1175/JAMC-D-22-0021.1; pythermalcomfort). The NWS formula is a fit
    to Steadman's table and drifts in very hot, humid air (the hours that
    matter here); the extended index solves Steadman's body model for any
    temperature and humidity. Used as the cross-check of every verdict."""
    t, rh = np.atleast_1d(np.asarray(t_c, dtype=float)), np.atleast_1d(np.asarray(rh, dtype=float))
    return np.asarray(heat_index_lu(t, np.clip(rh, 0, 100), round_output=False).hi, dtype=float)


def first_hour_over(running, limit):
    """Hours into the week when a running total first passes `limit` (None: never)."""
    over = np.nonzero(np.asarray(running) > limit)[0]
    return int(over[0]) + 1 if len(over) else None


def heat_dose(hi):
    """Heat-dose numbers for an hourly felt heat index series (see CAUTION_C):
    hazard hours above caution, when the Chen et al. limits are passed, and
    the hours spent in each NWS band (band_<name>_h)."""
    hi = np.asarray(hi, dtype=float)
    running = np.cumsum(np.clip(hi - CAUTION_C, 0, None))
    edges = [lo for _, lo in BANDS] + [np.inf]
    return {
        "hazard_hours_ch": round(float(running[-1]), 0),
        "hours_to_elderly_limit": first_hour_over(running, DOSE_LIMIT_ELDERLY_CH),
        "hours_to_young_limit": first_hour_over(running, DOSE_LIMIT_YOUNG_CH),
        "max_hi_over_limit": bool(hi.max() >= HI_MAX_LIMIT_C),
        **{f"band_{name}_h": int(((hi >= edges[i]) & (hi < edges[i + 1])).sum())
           for i, (name, _) in enumerate(BANDS)},
    }


def cut_hours_list(start_hour, length_h=1):
    """Hours of the day with no power: `length_h` hours from `start_hour`
    (wraps past midnight; 24 = no power all week). None start = no cut."""
    if start_hour is None:
        return []
    return sorted({(int(start_hour) + i) % 24 for i in range(max(1, min(24, int(length_h))))})


def column(df, text):
    """The first column whose name contains `text`."""
    return df[[c for c in df.columns if text in c][0]]


def safe_hours(csv_path, cut_hours=None):
    """Summary numbers and the hourly series for one run.
    cut_hours: hours of the day with no fan (power cut); default config's
    20:00-21:00, () for no cut."""
    df = pd.read_csv(csv_path)
    t = column(df, "Zone Mean Air Temperature")
    rh = column(df, "Zone Air Relative Humidity")
    t_out = column(df, "Site Outdoor Air Drybulb Temperature")
    # Used by the household body model (oasis/agents.py)
    t_mrt = column(df, "Zone Mean Radiant Temperature")
    rh_out = column(df, "Site Outdoor Air Relative Humidity")

    # Row 0 is 00:00-01:00, so row 20 is the 20:00-21:00 power cut.
    hour = pd.Series(range(len(df))) % 24
    if cut_hours is None:
        cut_hours = range(config.CUT_START_HOUR, config.CUT_END_HOUR)
    cut = hour.isin(list(cut_hours))

    # Fan on: the person feels cooler. During the cut: no fan, no credit.
    t_felt = t - np.where(cut, 0.0, fan_credit_c(t, t_mrt, rh))
    hi = pd.Series(heat_index_c(t_felt, rh))
    danger = hi >= SAFE_LIMIT_C
    hi_ext = pd.Series(heat_index_ext_c(t_felt, rh))        # cross-check, same limit

    summary = {
        "hours_total": len(df),
        "safe_hours": int((~danger).sum()),
        "danger_hours": int(danger.sum()),
        "cut_hours_in_danger": int((danger & cut).sum()),
        "degree_hours_over_limit": round(float((hi - SAFE_LIMIT_C).clip(lower=0).sum()), 1),
        "max_heat_index_c": round(float(hi.max()), 1),
        "max_indoor_temp_c": round(float(t.max()), 1),
        "mean_indoor_temp_c": round(float(t.mean()), 1),
        "safe_hours_extended_hi": int((hi_ext < SAFE_LIMIT_C).sum()),
        "max_extended_hi_c": round(float(hi_ext.max()), 1),
        **heat_dose(hi),
    }
    hourly = pd.DataFrame({"hour": hour, "t_out": t_out, "rh_out": rh_out,
                           "t_in": t, "t_mrt": t_mrt, "rh_in": rh,
                           "heat_index": hi, "heat_index_ext": hi_ext, "danger": danger, "cut": cut})
    return summary, hourly


def peaks(hourly):
    """Two peaks, both from the same simulation:
    - the normal daily peak (the room's hottest hour, fan on), and
    - the peak during the power cut (fan off).
    EnergyPlus doesn't model the fan; the cut only removes the fan credit here.
    So `by_hour` also shows what a one-hour cut would do at every hour of the
    day, without re-running EnergyPlus."""
    h = hourly.assign(day=np.arange(len(hourly)) // 24)
    h["hi_no_fan"] = heat_index_c(h["t_in"], h["rh_in"])  # fan off at that hour
    days = int(h["day"].nunique())

    # Normal peak: the hottest indoor hour of each day.
    daily_max = h.loc[h.groupby("day")["t_in"].idxmax()]
    normal = {
        "typical_hour": int(daily_max["hour"].mode().iloc[0]),
        "max_indoor_temp_c": round(float(h["t_in"].max()), 1),
        "max_heat_index_c": round(float(h["heat_index"].max()), 1),  # as felt (fan on)
    }

    # Peak during the actual power cut (None when the scenario has no cut).
    c = h[h["cut"]]
    cut = None
    if len(c):
        hours = set(int(x) for x in c["hour"])
        # First hour of the cut: the one whose previous hour has power (0 when it never has).
        start = next((x for x in sorted(hours) if (x - 1) % 24 not in hours), 0)
        cut = {
            "start_hour": start, "end_hour": (start + len(hours)) % 24, "length_h": len(hours),
            "max_indoor_temp_c": round(float(c["t_in"].max()), 1),
            "max_heat_index_c": round(float(c["heat_index"].max()), 1),
            "nights_in_danger": int(c.groupby("day")["danger"].any().sum()),
            "days": days,
        }

    # If a one-hour cut fell at each hour of the day instead.
    by_hour = []
    for hr, g in h.groupby("hour"):
        by_hour.append({
            "hour": int(hr),
            "mean_indoor_temp_c": round(float(g["t_in"].mean()), 1),
            "max_heat_index_no_fan_c": round(float(g["hi_no_fan"].max()), 1),
            "days_in_danger": int((g["hi_no_fan"] >= SAFE_LIMIT_C).sum()),
        })
    worst = max(by_hour, key=lambda r: (r["days_in_danger"], r["max_heat_index_no_fan_c"]))
    return {"normal": normal, "cut": cut, "days": days, "by_hour": by_hour, "worst_cut_hour": worst["hour"]}
