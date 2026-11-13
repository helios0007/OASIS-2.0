"""The single-room model, in the form the 3D view draws (frontend/viewer3d.js).

Same shapes as oasis.unit for a room-by-room plan, so one viewer shows both:
the room box exactly as oasis/build_idf.py simulated it (one centred window
per glazed wall, sized by window_sizes; overhangs at their real depth), and
the household hour by hour from oasis/agents.py.
Plan coordinates: x east (length_m), y north (width_m), z up, in metres.
"""
import numpy as np

import config
from oasis.agents import CORE_CRITICAL_C, routine
from oasis.build_idf import window_sizes
from oasis.metrics import SAFE_LIMIT_C

ROOM = "room"


def geometry(p):
    L, W, H = p["length_m"], p["width_m"], p["height_m"]
    sizes = window_sizes(p)
    lines = {"south": (0.0, L), "north": (W, L), "west": (0.0, W), "east": (L, W)}   # side: (fixed, length)
    walls, shades = [], []
    for side, (fixed, length) in lines.items():
        holes = []
        if side in sizes:
            w, h = sizes[side]
            lo, hi, z0, z1 = (length - w) / 2, (length + w) / 2, (H - h) / 2, (H + h) / 2
            holes.append({"lo": round(lo, 3), "hi": round(hi, 3), "z0": round(z0, 3), "z1": round(z1, 3),
                          "kind": "window"})
            if p.get("shading_depth_m", 0) > 0:
                shades.append({"side": side, "fixed": fixed, "lo": round(lo, 3), "hi": round(hi, 3),
                               "z": round(z1, 3), "depth": p["shading_depth_m"]})
        walls.append({"room": ROOM, "other": None, "side": side, "fixed": fixed, "a0": 0.0, "a1": length,
                      "kind": "exterior", "holes": holes})
    return {
        "name": "single room", "height_m": H, "orientation_deg": p.get("orientation_deg", 0.0),
        "rooms": {ROOM: {"type": "living", "fan": True, "rects": [[0.0, 0.0, L, W]]}},
        "walls": walls, "balconies": [], "shades": shades,
    }


def viewer_people(agents, hourly):
    """agents.simulate_household output -> the per-hour fields the viewer reads."""
    n = len(hourly)
    hi = hourly["heat_index"].round(1).tolist()
    t_air = hourly["t_in"].round(1).tolist()
    people = []
    for a in agents:
        role = a.get("role", "elderly")
        if a["modelled"]:
            H = a["hourly"]
            away = [z == "away_work" for z in H["zone"]]
            cols = {**H, "room": [None if x else ROOM for x in away], "wet_pct": H["wettedness_pct"],
                    "hi": [None if x else v for x, v in zip(away, hi)]}
            summary = a["summary"]
        else:   # a child: the room's felt heat only (no validated body model)
            steps = [routine(role, h % 24) for h in range(n)]
            status = ["danger" if v >= SAFE_LIMIT_C else "safe" for v in hi]
            cols = {"room": [ROOM] * n, "posture": [s[1] for s in steps], "activity": [s[3] for s in steps],
                    "status": status, "hi": hi, "t_air": t_air,
                    **{k: [None] * n for k in ("t_core", "t_skin", "wet_pct", "sweat_gh", "cardiac_lh", "v")}}
            unsafe = int(sum(s == "danger" for s in status))
            summary = {"hours_at_home": n, "safe_hours": n - unsafe, "danger_hours": unsafe}
        people.append({**{k: a.get(k) for k in ("id", "name", "age", "sex", "height_cm", "weight_kg", "role")},
                       "modelled": a["modelled"], "summary": summary, "hourly": cols})
    return people


def box_unit(p, hourly, agents):
    """What /api/assess returns as 'unit' for the single-room model."""
    room = {"t": hourly["t_in"].round(1).tolist(), "rh": hourly["rh_in"].round(1).tolist(),
            "mrt": hourly["t_mrt"].round(1).tolist(), "hi": hourly["heat_index"].round(1).tolist()}
    return {
        "geometry": geometry(p),
        "rooms": {ROOM: room},
        "people": viewer_people(agents, hourly),
        "cut": [bool(x) for x in hourly["cut"]],
        "outdoor": {"t": np.round(hourly["t_out"], 1).tolist()},
        "occupied_room": [ROOM] * len(hourly),
        "scenario": {"first_day": config.RUN_START[1], "month": "May", "safe_limit_c": SAFE_LIMIT_C,
                     "core_critical_c": CORE_CRITICAL_C, "party_walls": "none"},
        "single_room": True,
    }
