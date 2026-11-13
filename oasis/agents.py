"""Household body model: how each person's body copes with the simulated week.

This is the CHECK measure of OASIS. The MAIN measure is the heat index safe
hours in oasis/metrics.py, which is used to rank design changes.

For each person we run JOS-3 (Takahashi et al. 2021, the multi-node
thermoregulation model in the pythermalcomfort package) hour by hour through
the 168-hour week. Its inputs come straight from EnergyPlus:
    air temperature, mean radiant temperature, relative humidity (room)
plus air speed (fan on / power cut), activity, posture and clothing (below).
JOS-3 takes age, sex, height and weight, so the same room is felt differently
by a grandmother and a young father. JOS-3 is an adult model, so children are
listed but not simulated (see MIN_AGE).

A person-hour is unsafe when the core temperature reaches 38.0 C, the core
(rectal) temperature limit used by ISO 7933:2023 (Predicted Heat Strain) and
the WHO (1969). ISO 7933's own PHS model is NOT run hour by hour: it is a
workplace standard (sitting/standing workers, met 0.96-4.3, radiant temperature
above air temperature), so sleeping at night falls outside its scope.

All assumptions (air speeds, activities, thresholds) are module constants so
they are visible and easy to test.
"""
import numpy as np
from pythermalcomfort.models import JOS3

# --- Thresholds --------------------------------------------------------------
CORE_LIMIT_C = 38.0      # ISO 7933:2023 rectal temperature limit; WHO (1969)
CORE_CRITICAL_C = 38.5   # ACGIH upper limit for fit, acclimatised workers
CORE_CAUTION_C = 37.5    # OASIS display band only (not a health limit)
MIN_AGE = 18             # JOS-3 is an adult model: a child-sized body (1.32 m, 28 kg)
                         # reads 38.4 C core even in a 25 C room, so children are not modelled

# --- Air speed at the person (m/s), assumptions ------------------------------
V_UNDER_FAN = 0.8        # directly under a running ceiling fan
V_IN_ROOM = 0.4          # elsewhere in the room with the fan running
V_STILL = 0.1            # power cut: fan off, still indoor air
V_OUTDOORS = 0.5         # away from home (commute / workplace)

STEP_S = 600             # JOS-3 time step; 10 min gives the same core temp as 1 min

# Default PMAY household of four (Chennai). May is school holiday in Tamil Nadu,
# so the child stays at home.
DEFAULT_AGENTS = [
    {"id": "paatti", "name": "Paatti (Kamala)", "age": 68, "sex": "female",
     "height_cm": 152.0, "weight_kg": 54.0, "clothing_clo": 0.40, "role": "elderly"},
    {"id": "lakshmi", "name": "Lakshmi (Mother)", "age": 35, "sex": "female",
     "height_cm": 158.0, "weight_kg": 60.0, "clothing_clo": 0.45, "role": "homemaker"},
    {"id": "karthik", "name": "Karthik (Father)", "age": 38, "sex": "male",
     "height_cm": 171.0, "weight_kg": 72.0, "clothing_clo": 0.35, "role": "worker"},
    {"id": "aarav", "name": "Aarav (Child)", "age": 9, "sex": "male",
     "height_cm": 132.0, "weight_kg": 28.0, "clothing_clo": 0.30, "role": "child"},
]

# --- Daily routine -----------------------------------------------------------
# Activity level as a physical activity ratio (PAR = metabolic rate / basal),
# approximate values from FAO/WHO/UNU (2004) Human energy requirements.
SLEEP, SIT, EAT, COOK, CHORES, PLAY = 1.0, 1.2, 1.5, 2.1, 2.8, 2.5

# Zones are only used to place people on the room map and pick the air speed.
ZONES = {"sleep_area": V_IN_ROOM, "fan_center": V_UNDER_FAN,
         "window_side": V_IN_ROOM, "kitchen_corner": V_IN_ROOM, "away_work": V_OUTDOORS}


def routine(role, h):
    """(PAR, posture, zone, activity label, map position) for one hour of the day.
    Map position: normalised room coordinates in [-0.85, 0.85]."""
    if h >= 22 or h < 6:
        pos = {"elderly": (-0.42, 0.35), "homemaker": (0.15, -0.35),
               "worker": (-0.15, -0.35), "child": (0.42, 0.30)}.get(role, (0.0, 0.0))
        return SLEEP, "lying", "sleep_area", "Sleeping", pos

    if role == "elderly":
        if h in (7, 13, 19):
            return EAT, "sitting", "fan_center", "Eating", (-0.18, 0.08)
        if 14 <= h <= 17:
            return SIT, "lying", "window_side", "Afternoon rest", (-0.38, 0.42)
        return SIT, "sitting", "fan_center", "Resting under the fan", (-0.22, 0.12)

    if role == "homemaker":
        if h in (6, 7, 18, 19):
            return COOK, "standing", "kitchen_corner", "Cooking", (0.48, -0.42)
        if 8 <= h <= 11:
            return CHORES, "standing", "fan_center", "Household chores", (0.18, -0.10)
        if 14 <= h <= 16:
            return SIT, "lying", "fan_center", "Afternoon rest", (0.10, 0.05)
        return SIT, "sitting", "fan_center", "Seated, family time", (0.15, 0.15)

    if role == "worker":
        if 9 <= h <= 17:
            return CHORES, "standing", "away_work", "Away at work", (0.0, -0.82)
        if h in (7, 8, 18):
            return EAT, "standing", "window_side", "Getting ready / back home", (-0.30, -0.25)
        return SIT, "sitting", "fan_center", "Evening rest", (-0.08, -0.12)

    if role == "child":
        if 9 <= h <= 15:
            return SIT, "sitting", "window_side", "Studying by the window", (0.35, 0.40)
        if 16 <= h <= 18:
            return PLAY, "standing", "fan_center", "Playing indoors", (0.28, 0.18)
        return SIT, "sitting", "fan_center", "Homework, family time", (0.25, -0.05)

    return SIT, "sitting", "fan_center", "Seated indoors", (0.0, 0.0)


def anthropometrics(agent):
    """Body surface area (DuBois & DuBois 1916) and BMI."""
    h_m = float(agent["height_cm"]) / 100.0
    w_kg = float(agent["weight_kg"])
    return {"bsa_m2": round(0.202 * w_kg ** 0.425 * h_m ** 0.725, 2),
            "bmi": round(w_kg / h_m ** 2, 1)}


def status_of(t_core, at_home):
    if not at_home:
        return "away"
    if t_core >= CORE_CRITICAL_C:
        return "critical"
    if t_core >= CORE_LIMIT_C:
        return "danger"
    if t_core >= CORE_CAUTION_C:
        return "caution"
    return "safe"


def feedback(status, t_core, wet_pct, t_air, cut, activity):
    """A short first-person line that only restates the model's numbers."""
    if status == "away":
        return "Out of the flat."
    fan = "The fan is off (power cut). " if cut else ""
    if status in ("critical", "danger"):
        return (f"{fan}Room air {t_air:.1f} °C. My core is at {t_core:.2f} °C, "
                f"at or above the {CORE_LIMIT_C:.0f} °C limit.")
    if status == "caution":
        return (f"{fan}Room air {t_air:.1f} °C. My core is rising ({t_core:.2f} °C) "
                f"and {wet_pct:.0f}% of my skin is wet.")
    return f"{fan}{activity}. Core {t_core:.2f} °C, skin {wet_pct:.0f}% wet."


def not_modelled(agent, n_hours):
    """A child: JOS-3 cannot represent the body, so no numbers are invented."""
    return {
        **{k: agent.get(k) for k in ("id", "name", "age", "sex", "height_cm",
                                     "weight_kg", "clothing_clo", "role")},
        "modelled": False,
        "note": (f"Not modelled: JOS-3 is an adult model (age {MIN_AGE}+), and no validated "
                 "child heat model exists. Covered by the heat-index safe hours above."),
        "anthropometrics": anthropometrics(agent),
        "summary": None,
        "hourly": None,
    }


def simulate_agent(agent, hourly):
    """Run JOS-3 for one person through the week.
    hourly: DataFrame from metrics.safe_hours (t_in, t_mrt, rh_in, t_out, rh_out, cut)."""
    if int(agent["age"]) < MIN_AGE:
        return not_modelled(agent, len(hourly))
    role = agent.get("role", "elderly")
    clo = float(agent.get("clothing_clo", 0.4))
    body = JOS3(height=float(agent["height_cm"]) / 100.0, weight=float(agent["weight_kg"]),
                age=int(agent["age"]), sex=str(agent["sex"]).lower())
    body.clo = clo

    rows = {k: [] for k in ("t_core", "t_skin", "wettedness_pct", "sweat_gh",
                            "zone", "activity", "pos", "status", "feedback",
                            "posture", "v", "t_air", "cardiac_lh")}
    sweat_today, sweat_days = 0.0, []

    for i, r in enumerate(hourly.itertuples(index=False)):
        h = i % 24
        par, posture, zone, activity, pos = routine(role, h)
        at_home = zone != "away_work"
        if at_home:
            tdb, tr, rh = r.t_in, r.t_mrt, r.rh_in
            v = V_STILL if r.cut else ZONES[zone]
        else:
            tdb, tr, rh, v = r.t_out, r.t_out, r.rh_out, V_OUTDOORS

        body.tdb, body.tr, body.rh, body.v = tdb, tr, rh, v
        body.par, body.posture = par, posture
        body.simulate(times=3600 // STEP_S, dtime=STEP_S, output=True)
        last = body.dict_results()
        t_core = float(last["t_core_pelvis"][-1])          # pelvis core ~ rectal
        t_skin = float(last["t_skin_mean"][-1])
        wet = 100.0 * float(last["w_mean"][-1])
        sweat_gh = 3600.0 * float(last["weight_loss_by_evap_and_res"][-1])
        body._history = []                                   # keep memory flat

        sweat_today += sweat_gh
        if h == 23:
            sweat_days.append(sweat_today)
            sweat_today = 0.0

        status = status_of(t_core, at_home)
        rows["t_core"].append(round(t_core, 2))
        rows["t_skin"].append(round(t_skin, 1))
        rows["wettedness_pct"].append(round(wet))
        rows["sweat_gh"].append(round(sweat_gh))
        rows["zone"].append(zone)
        rows["activity"].append(activity)
        rows["pos"].append([round(pos[0], 2), round(pos[1], 2)])
        rows["status"].append(status)
        rows["feedback"].append(feedback(status, t_core, wet, tdb, bool(r.cut), activity))
        rows["posture"].append(posture)
        rows["v"].append(v)
        rows["t_air"].append(round(float(tdb), 1))
        rows["cardiac_lh"].append(round(float(last["cardiac_output"][-1])))

    status = np.array(rows["status"])
    home = status != "away"
    unsafe = np.isin(status, ("danger", "critical"))
    cut = hourly["cut"].to_numpy(bool)
    worst_day_l = max(sweat_days or [sweat_today]) / 1000.0
    return {
        **{k: agent.get(k) for k in ("id", "name", "age", "sex", "height_cm",
                                     "weight_kg", "clothing_clo", "role")},
        "modelled": True,
        "anthropometrics": anthropometrics(agent),
        "summary": {
            "hours_at_home": int(home.sum()),
            "safe_hours": int((home & ~unsafe).sum()),
            "danger_hours": int(unsafe.sum()),
            "cut_hours_in_danger": int((unsafe & cut).sum()),
            "max_core_temp_c": round(max(rows["t_core"]), 2),
            "max_skin_temp_c": round(max(rows["t_skin"]), 1),
            "total_sweat_liters": round(sum(rows["sweat_gh"]) / 1000.0, 1),
            "worst_day_sweat_liters": round(worst_day_l, 1),
        },
        "hourly": rows,
    }


def simulate_household(agents, hourly, building_p=None):
    """JOS-3 for every person. building_p is unused (kept for the old call signature):
    the building only reaches the body through EnergyPlus's hourly results."""
    return [simulate_agent(a, hourly) for a in (agents or DEFAULT_AGENTS)]


def compare_with_heat_index(people, hourly):
    """The check: hour by hour, does the main measure (heat index) agree with
    the bodies? Counts hours where somebody at home is over the core limit."""
    people = [p for p in people if p["modelled"]]
    if not people:
        return None
    hi_safe = ~hourly["danger"].to_numpy(bool)
    anyone = np.zeros(len(hourly), bool)
    for p in people:
        anyone |= np.isin(p["hourly"]["status"], ("danger", "critical"))
    worst = max(people, key=lambda p: p["summary"]["danger_hours"])
    return {
        "people_modelled": len(people),
        "core_limit_c": CORE_LIMIT_C,
        "hours_agree": int((hi_safe == ~anyone).sum()),
        "hi_safe_but_body_over_limit": int((hi_safe & anyone).sum()),
        "hi_danger_but_bodies_ok": int((~hi_safe & ~anyone).sum()),
        "household_safe_hours": int((~anyone).sum()),
        "most_affected": worst["name"],
    }
