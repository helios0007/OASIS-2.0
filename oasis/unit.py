"""One flat, room by room, for the main tool (a Rhino plan on the OASIS:: layers).

assess_plan(p, path) simulates the plan with the tool's settings and with each
single design change (EnergyPlus, one zone per room, AirflowNetwork - the same
model as run_layout.py), then puts the household through it: each person is in
the room the daily routine sends them to, and JOS-3 runs on that room's air,
radiant temperature and humidity. It also returns the geometry the 3D tab draws
(frontend/viewer3d.js): walls with their openings, exactly what was simulated.
"""
import hashlib
import json
import shutil
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
from pythermalcomfort.models import JOS3

import config
from oasis.agents import (CORE_CAUTION_C, CORE_CRITICAL_C, CORE_LIMIT_C, DEFAULT_AGENTS, MIN_AGE,
                          STEP_S, V_OUTDOORS, V_STILL, ZONES, feedback, routine, status_of)
from oasis.build_layout import (DOOR_HEIGHT_M, OPENING_KINDS, OPPOSITE, build_layout_idf, load_layout,
                                split_party, wall_segments, windowless_party, zone_id)
from oasis.metrics import SAFE_LIMIT_C, fan_credit_c, heat_index_c, heat_index_ext_c
from oasis.params import BASELINE
from oasis.simulate import run



# --- Geometry for the viewer --------------------------------------------------
def geometry(lay, segs):
    """Walls (each partition once) with their holes, plus rooms and balconies, in metres."""
    walls, index = [], {}
    for room, side, fixed, a0, a1, other in segs:
        if other not in (None, "party") and room > other:
            continue
        kind = "exterior" if other is None else "party" if other == "party" else "partition"
        index[(room, side, round(a0, 4))] = len(walls)
        walls.append({"room": room, "other": other if kind == "partition" else None, "side": side,
                      "fixed": round(fixed, 4), "a0": round(a0, 4), "a1": round(a1, 4), "kind": kind, "holes": []})

    def host(room, side, lo, hi, want):
        for r, sd, f, a0, a1, other in segs:
            if r == room and sd == side and want(other) and a0 - 1e-6 <= lo and hi <= a1 + 1e-6:
                return (r, sd, round(a0, 4))
        return None

    for o in lay["openings"]:
        lo, hi = o["span"]
        k = host(o["room"], o["wall"], lo, hi, lambda other: other in (None, "party"))
        if k in index:
            kind = OPENING_KINDS[o["kind"]]
            walls[index[k]]["holes"].append({"lo": round(lo, 4), "hi": round(hi, 4), "z0": kind["sill"],
                                             "z1": kind["sill"] + kind["height"], "kind": o["kind"]})
    for d in lay["doors"]:
        a, c = d["rooms"]
        for r, sd, f, a0, a1, other in segs:
            if {r, other} == {a, c} and r < other:
                lo, hi = sorted(d["span_x"] if sd in ("north", "south") else d["span_y"])
                if a0 - 1e-6 <= lo and hi <= a1 + 1e-6:
                    walls[index[(r, sd, round(a0, 4))]]["holes"].append(
                        {"lo": round(lo, 4), "hi": round(hi, 4), "z0": 0.0, "z1": DOOR_HEIGHT_M,
                         "kind": d.get("kind", "door")})
                    break

    balconies = []
    for bal in lay.get("balconies", []):
        x0, y0, x1, y1 = lay["rooms"][bal["room"]]["rects"][0]
        fixed, a0, a1 = {"south": (y0, x0, x1), "north": (y1, x0, x1),
                         "west": (x0, y0, y1), "east": (x1, y0, y1)}[bal["wall"]]
        balconies.append({"room": bal["room"], "side": bal["wall"], "fixed": fixed, "a0": a0, "a1": a1,
                          "depth": round(bal["depth_m"], 3)})
    return {
        "name": lay["name"], "height_m": lay["height_m"], "orientation_deg": lay.get("orientation_deg", 0.0),
        "rooms": {n: {"type": r["type"], "fan": r["fan"], "rects": [[round(v, 4) for v in rect] for rect in r["rects"]]}
                  for n, r in lay["rooms"].items()},
        "walls": walls, "balconies": balconies,
    }


# --- Household in the rooms ---------------------------------------------------
def room_for(agent_i, role, zone, rooms):
    """The room a person is in, from the routine's zone (None = away from home)."""
    beds = sorted(n for n, r in rooms.items() if r["type"] == "bedroom") or [next(iter(rooms))]
    living = next((n for n, r in rooms.items() if r["type"] == "living"), beds[0])
    kitchen = next((n for n, r in rooms.items() if r["type"] == "kitchen"), living)
    if zone == "away_work":
        return None
    if zone == "sleep_area":   # couple share the first bedroom; others spread over the rest
        if role in ("homemaker", "worker"):
            return beds[0]
        return beds[(1 + agent_i) % len(beds)] if len(beds) > 1 else beds[0]
    if zone == "kitchen_corner":
        return kitchen
    return living


def run_people(agents, rooms, rh, cut):
    """rh: room -> DataFrame(t, mrt, rh, hi); also '_out' -> (t, rh). JOS-3 for adults;
    children get the felt heat of their room only (no validated child body model)."""
    people = []
    for i, agent in enumerate(agents):
        role = agent.get("role", "elderly")
        modelled = int(agent["age"]) >= MIN_AGE
        body = None
        if modelled:
            body = JOS3(height=float(agent["height_cm"]) / 100.0, weight=float(agent["weight_kg"]),
                        age=int(agent["age"]), sex=str(agent["sex"]).lower())
            body.clo = float(agent.get("clothing_clo", 0.4))
        cols = {k: [] for k in ("room", "posture", "activity", "status", "t_core", "t_skin", "wet_pct",
                                "sweat_gh", "cardiac_lh", "v", "t_air", "hi")}
        for h in range(len(cut)):
            par, posture, zone, activity, _ = routine(role, h % 24)
            room = room_for(i, role, zone, rooms)
            if room is None:
                tdb, tr, rhv, v, hi = rh["_out"]["t"][h], rh["_out"]["t"][h], rh["_out"]["rh"][h], V_OUTDOORS, None
            else:
                r = rh[room]
                tdb, tr, rhv, hi = r["t"][h], r["mrt"][h], r["rh"][h], r["hi"][h]
                v = ZONES[zone] if (rooms[room]["fan"] and not cut[h]) else V_STILL
            row = {"room": room, "posture": posture, "activity": activity, "v": v,
                   "t_air": round(float(tdb), 1), "hi": None if hi is None else round(float(hi), 1)}
            if body is not None:
                body.tdb, body.tr, body.rh, body.v = tdb, tr, rhv, v
                body.par, body.posture = par, posture
                body.simulate(times=3600 // STEP_S, dtime=STEP_S, output=True)
                last = body.dict_results()
                body._history = []
                t_core = float(last["t_core_pelvis"][-1])
                row.update(status=status_of(t_core, room is not None), t_core=round(t_core, 2),
                           t_skin=round(float(last["t_skin_mean"][-1]), 1),
                           wet_pct=round(100.0 * float(last["w_mean"][-1])),
                           sweat_gh=round(3600.0 * float(last["weight_loss_by_evap_and_res"][-1])),
                           cardiac_lh=round(float(last["cardiac_output"][-1])))
            else:
                row.update(status="away" if room is None else ("danger" if hi >= SAFE_LIMIT_C else "safe"),
                           t_core=None, t_skin=None, wet_pct=None, sweat_gh=None, cardiac_lh=None)
            for k in cols:
                cols[k].append(row[k])
        status = np.array(cols["status"])
        home = status != "away"
        unsafe = np.isin(status, ("danger", "critical"))
        cols["wettedness_pct"] = cols["wet_pct"]          # the names the tool's cards use
        cols["feedback"] = [feedback(st, tc, w, ta, bool(cut[h]), act) if tc is not None else ""
                            for h, (st, tc, w, ta, act) in enumerate(zip(cols["status"], cols["t_core"],
                                                                         cols["wet_pct"], cols["t_air"], cols["activity"]))]
        max_core = max((c for c in cols["t_core"] if c is not None), default=None)
        people.append({
            **{k: agent.get(k) for k in ("id", "name", "age", "sex", "height_cm", "weight_kg", "clothing_clo", "role")},
            "modelled": modelled,
            "note": None if modelled else (f"Not modelled: JOS-3 is an adult model (age {MIN_AGE}+), and no validated "
                                           "child heat model exists. Shown by the felt heat of the room they are in."),
            "summary": {"hours_at_home": int(home.sum()), "safe_hours": int((home & ~unsafe).sum()),
                        "danger_hours": int(unsafe.sum()), "max_core_c": max_core, "max_core_temp_c": max_core},
            "hourly": cols,
        })
    return people


# --- Simulation ---------------------------------------------------------------
def room_hourly(csv, lay, cut_hours=None):
    df = pd.read_csv(csv)
    df.columns = df.columns.str.strip()   # EnergyPlus pads the last header
    hour = np.arange(len(df)) % 24
    if cut_hours is None:
        cut_hours = range(config.CUT_START_HOUR, config.CUT_END_HOUR)
    cut = np.isin(hour, list(cut_hours))
    out = {"_out": {"t": df["Environment:Site Outdoor Air Drybulb Temperature [C](Hourly)"].to_numpy(),
                    "rh": df["Environment:Site Outdoor Air Relative Humidity [%](Hourly)"].to_numpy()}}
    for name, room in lay["rooms"].items():
        z = zone_id(name)
        t = df[f"{z}:Zone Mean Air Temperature [C](Hourly)"].to_numpy()
        rh = df[f"{z}:Zone Air Relative Humidity [%](Hourly)"].to_numpy()
        mrt = df[f"{z}:Zone Mean Radiant Temperature [C](Hourly)"].to_numpy()
        credit = np.where(cut | (not room["fan"]), 0.0, fan_credit_c(t, mrt, rh))
        out[name] = {"t": t, "rh": rh, "mrt": mrt, "hi": heat_index_c(t - credit, rh),
                     "hi_ext": heat_index_ext_c(t - credit, rh)}
    return out, cut


def household_measure(rooms_h, lay, cut):
    """Main measure: felt heat where people are (living by day, worst bedroom at night)."""
    hour = np.arange(len(cut)) % 24
    night = (hour >= 22) | (hour < 6)
    beds = [n for n, r in lay["rooms"].items() if r["type"] == "bedroom"]
    living = next(n for n, r in lay["rooms"].items() if r["type"] == "living")
    occ = np.where(night, np.max([rooms_h[n]["hi"] for n in beds], axis=0), rooms_h[living]["hi"])
    return {"safe": int((occ < SAFE_LIMIT_C).sum()), "night_safe": int((occ[night] < SAFE_LIMIT_C).sum()),
            "night_hours": int(night.sum()), "cut_danger": int((occ[cut] >= SAFE_LIMIT_C).sum()),
            "hi": np.round(occ, 1).tolist()}


def occupied_hourly(rooms_h, lay, cut):
    """One hourly series 'where the people are' (living room by day, the worst
    bedroom at night), in the columns oasis.metrics.peaks and the tool expect."""
    hour = np.arange(len(cut)) % 24
    night = (hour >= 22) | (hour < 6)
    beds = [n for n, r in lay["rooms"].items() if r["type"] == "bedroom"]
    living = next(n for n, r in lay["rooms"].items() if r["type"] == "living")
    bed_hi = np.array([rooms_h[n]["hi"] for n in beds])
    worst = np.array(beds)[bed_hi.argmax(axis=0)]
    room = np.where(night, worst, living)
    pick = lambda key: np.array([rooms_h[r][key][h] for h, r in enumerate(room)])
    hi = pick("hi")
    return pd.DataFrame({"hour": hour, "t_out": rooms_h["_out"]["t"], "rh_out": rooms_h["_out"]["rh"],
                         "t_in": pick("t"), "t_mrt": pick("mrt"), "rh_in": pick("rh"), "heat_index": hi,
                         "heat_index_ext": pick("hi_ext"),
                         "danger": hi >= SAFE_LIMIT_C, "cut": cut, "room": room})


def summary_of(h):
    hi, t = h["heat_index"], h["t_in"]
    return {"hours_total": len(h), "safe_hours": int((~h["danger"]).sum()), "danger_hours": int(h["danger"].sum()),
            "cut_hours_in_danger": int((h["danger"] & h["cut"]).sum()),
            "degree_hours_over_limit": round(float((hi - SAFE_LIMIT_C).clip(lower=0).sum()), 1),
            "max_heat_index_c": round(float(hi.max()), 1), "max_indoor_temp_c": round(float(t.max()), 1),
            "mean_indoor_temp_c": round(float(t.mean()), 1),
            "safe_hours_extended_hi": int((h["heat_index_ext"] < SAFE_LIMIT_C).sum()),
            "max_extended_hi_c": round(float(h["heat_index_ext"].max()), 1)}


def body_check(people, h):
    """As agents.compare_with_heat_index: does the heat index agree with the bodies?"""
    adults = [q for q in people if q["modelled"]]
    if not adults:
        return None
    hi_safe = ~h["danger"].to_numpy(bool)
    anyone = np.zeros(len(h), bool)
    for q in adults:
        anyone |= np.isin(q["hourly"]["status"], ("danger", "critical"))
    worst = max(adults, key=lambda q: q["summary"]["danger_hours"])
    return {"people_modelled": len(adults), "core_limit_c": CORE_LIMIT_C,
            "hours_agree": int((hi_safe == ~anyone).sum()),
            "hi_safe_but_body_over_limit": int((hi_safe & anyone).sum()),
            "hi_danger_but_bodies_ok": int((~hi_safe & ~anyone).sum()),
            "household_safe_hours": int((~anyone).sum()), "most_affected": worst["name"]}


def plan_geometry(path, party=None):
    lay = load_layout(path)
    segs = split_party(wall_segments(lay["rooms"]), lay.get("party_walls", []))
    if party == "windowless":
        segs = windowless_party(segs, lay["openings"])
    return lay, segs


def assess_plan(p, path, agents=None, party=None, lock=None, options=(), epw=None, cut_hours=None):
    """The main tool's assessment for a room-by-room plan: the design p (the
    tool's settings) and each single change in `options` [(key, value)], all on
    the multi-room AirflowNetwork model. Returns the same parts as
    oasis.assess for a single room, plus the people, the body check and the
    data for the 3D view."""
    lay, segs = plan_geometry(path, party)
    base = dict(BASELINE, **p, airflow_model="afn")
    if party:
        base["party_walls"] = party
    designs = [base] + [dict(base, **{k: v}) for k, v in options]
    tag = json.dumps([str(path), p, party, list(options), str(epw), cut_hours], sort_keys=True, default=str)
    work = config.OUT / "unit_runs" / hashlib.sha1(tag.encode()).hexdigest()[:12]
    if lock:
        lock.acquire()
    try:     # eppy is not thread-safe: write the models one by one
        jobs = [(build_layout_idf(lay, d, work / f"{i}.idf"), work / str(i)) for i, d in enumerate(designs)]
    finally:
        if lock:
            lock.release()
    with ThreadPoolExecutor(max_workers=8) as pool:
        csvs = list(pool.map(lambda j: run(j[0], j[1], epw or config.EPW), jobs))
    runs = [room_hourly(c, lay, cut_hours) for c in csvs]
    shutil.rmtree(work, ignore_errors=True)

    rooms_h, cut = runs[0]
    hourly = occupied_hourly(rooms_h, lay, cut)
    summary = summary_of(hourly)
    people = run_people(agents or DEFAULT_AGENTS, lay["rooms"], rooms_h, cut)
    changes = []
    for (key, value), (rh, c) in zip(options, runs[1:]):
        h = occupied_hourly(rh, lay, c)
        s = summary_of(h)
        changes.append({"parameter": key, "value": value, "safe_hours": s["safe_hours"],
                        "safe_hours_gained": s["safe_hours"] - summary["safe_hours"],
                        "cut_hours_in_danger": s["cut_hours_in_danger"], "max_heat_index_c": s["max_heat_index_c"],
                        "degree_hours_over_limit": s["degree_hours_over_limit"], "hourly": h})
    changes.sort(key=lambda c: (-c["safe_hours_gained"], c["degree_hours_over_limit"]))
    unit = {
        "geometry": geometry(lay, segs),
        "rooms": {n: {k: np.round(v, 1).tolist() for k, v in r.items() if k != "hi_ext"}
                  for n, r in rooms_h.items() if n != "_out"},
        "people": people, "cut": [bool(x) for x in cut],
        "outdoor": {"t": np.round(rooms_h["_out"]["t"], 1).tolist()},
        "occupied_room": hourly["room"].tolist(),
        "scenario": {"first_day": config.RUN_START[1], "month": "May", "safe_limit_c": SAFE_LIMIT_C,
                     "core_critical_c": CORE_CRITICAL_C,
                     "party_walls": party or ("drawn" if lay.get("party_walls") else "none")},
    }
    return summary, hourly, changes, people, body_check(people, hourly), unit
