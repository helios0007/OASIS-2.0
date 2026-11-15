"""What a design change costs (₹), so changes can be compared by safe hours
gained per ₹1,000 as well as by safe hours.

Design-stage costs for a new flat: the cost of a change is the cost of the new
choice minus the cost of the choice it replaces (so AAC blocks in place of
230 mm brick can cost less). Quantities come from the room's own geometry.

Only two rates are from a published source; the rest are estimates that still
have to be checked against the Tamil Nadu PWD Schedule of Rates. Every rate
carries its status, and the tools show it. Safe hours stay the ranking; cost
is a second column, not the verdict.
"""
from oasis.build_idf import window_sizes
from oasis.build_layout import OPENING_KINDS

SOURCED, ESTIMATE = "Published", "Estimate"

# key -> {level: (rate, unit, status, source)}; units: per m2 of roof, of net
# wall, of overhang projection, or of window.
RATES = {
    "roof_solar_absorptance": {
        0.7: (0, "roof_m2", SOURCED, "Bare concrete: no finish"),
        0.4: (50, "roof_m2", ESTIMATE, "Light-coloured roof finish, e.g. lime wash or cement paint (market rate, unchecked)"),
        0.2: (300, "roof_m2", SOURCED, "Cool roof coating or tiles, Telangana Cool Roof Policy 2023-28"),
    },
    "roof": {
        "rcc_150": (0, "roof_m2", SOURCED, "Bare slab: nothing added"),
        # CPWD lists the 50 mm board for cavity walls / under the slab (item 26.7 / 26.8),
        # not above the slab; the screed that protects it on a roof is an estimate.
        "rcc_150_insul_50": (1005 + 350, "roof_m2", ESTIMATE,
                             "50 mm extruded polystyrene board ₹1,005/m² (CPWD DSR 2023, item 26.7) + protective screed ₹350/m² (unchecked)"),
    },
    "wall": {
        "brick_230": (1480, "wall_m2", ESTIMATE, "230 mm brickwork in CM 1:6 (market rate, unchecked)"),
        "brick_115": (740, "wall_m2", ESTIMATE, "115 mm brickwork: half the 230 mm rate"),
        "aac_200": (1350, "wall_m2", ESTIMATE, "200 mm AAC blockwork in thin-bed mortar (market rate, unchecked)"),
    },
    "shading_depth_m": {
        0.0: (0, "overhang_m2", SOURCED, "No overhang"),
        0.6: (2100, "overhang_m2", ESTIMATE, "75 mm RCC sunshade, per m² of projection (market rate, unchecked)"),
    },
    "night_vent": {
        False: (0, "window_m2", SOURCED, "Windows shut at night: nothing added"),
        True: (650, "window_m2", ESTIMATE, "Mosquito mesh, so windows can stay open at night (market rate, unchecked)"),
    },
}


def quantities(p):
    """Areas (m2) the rates are multiplied by, for the single-room model."""
    L, W, H = p["length_m"], p["width_m"], p["height_m"]
    windows = window_sizes(p).values()            # (width, height) per wall
    window_m2 = sum(w * h for w, h in windows)
    return {
        "roof_m2": L * W,
        "wall_m2": 2 * (L + W) * H - window_m2,   # outside walls minus windows
        "window_m2": window_m2,
        # an overhang runs the width of each window; its depth is the level itself
        "overhang_m2": sum(w for w, h in windows),
    }


def plan_quantities(lay, segs):
    """The same areas for a room-by-room plan (oasis.build_layout): lay is the
    plan, segs its wall pieces (room, side, fixed, start, end, neighbour).
    Outside walls count in full; walls shared with a neighbour flat count half
    (the neighbour pays the other half); partitions between rooms are not priced
    (the wall choice does not change them). The entrance door is left out."""
    H = lay["height_m"]
    outside = sum((a1 - a0) * H for _, _, _, a0, a1, other in segs if other is None)
    shared = sum((a1 - a0) * H for _, _, _, a0, a1, other in segs if other == "party")
    openings = [(o["span"][1] - o["span"][0], OPENING_KINDS[o["kind"]]["height"], o["kind"])
                for o in lay["openings"] if o["kind"] != "entrance"]
    return {
        "roof_m2": sum((x1 - x0) * (y1 - y0) for room in lay["rooms"].values() for x0, y0, x1, y1 in room["rects"]),
        "wall_m2": outside + shared / 2 - sum(w * h for w, h, _ in openings),
        # mesh goes on windows and ventilators, not on the balcony door
        "window_m2": sum(w * h for w, h, kind in openings if kind != "balcony_door"),
        "overhang_m2": sum(w for w, _, _ in openings),
    }


def level_cost(q, key, level):
    """Cost (₹) of one choice for the areas q, or None if no rate is listed."""
    if level not in RATES.get(key, {}):
        return None
    rate, unit, _, _ = RATES[key][level]
    depth = level if key == "shading_depth_m" else 1
    return rate * q[unit] * depth


def change_cost(p, key, level, q=None):
    """Extra cost (₹, rounded to ₹100) of changing p[key] to level. Negative = cheaper.
    q: areas (default: the single room p; pass plan_quantities for a plan).
    None if either choice has no rate (e.g. a roof build-up outside the sweep)."""
    q = q or quantities(p)
    new, old = level_cost(q, key, level), level_cost(q, key, p[key])
    if new is None or old is None:
        return None
    return int(round((new - old) / 100.0)) * 100


def is_estimate(p, key, level):
    """True if either rate behind this change is an unchecked estimate."""
    return ESTIMATE in (RATES[key][level][2], RATES[key][p[key]][2])


def hours_per_1000(gain_h, cost):
    """Safe hours gained per ₹1,000. None when the change gains nothing, costs
    nothing extra, or has no cost."""
    if cost is None or cost <= 0 or gain_h <= 0:
        return None
    return round(gain_h / cost * 1000, 1)


def cost_fields(p, changes, gain_h, q=None):
    """Cost columns for one row: a single change or a package (list of changes).
    changes: [(key, level), ...]; q: areas, as in change_cost."""
    costs = [change_cost(p, key, level, q) for key, level in changes]
    total = None if None in costs else sum(costs)
    return {
        "cost_inr": total,
        "safe_hours_per_1000_inr": hours_per_1000(gain_h, total),
        "cost_is_estimate": total is not None and any(is_estimate(p, k, v) for k, v in changes),
    }


def basis():
    """The rate table, for the tools' "what this rests on" lists."""
    return [{"parameter": key, "value": level, "rate_inr": rate, "unit": unit.replace("_m2", ""),
             "status": status, "source": source}
            for key, levels in RATES.items() for level, (rate, unit, status, source) in levels.items()]
