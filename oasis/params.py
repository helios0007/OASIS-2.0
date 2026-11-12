"""Building parameters and interventions for the OASIS MVP.

A PMAY-style one-bedroom flat on the top floor (worst case: exposed roof),
modelled as a single room box.
"""

BASELINE = {
    "name": "baseline",
    "length_m": 6.0,           # 6 x 5 m = 30 m2
    "width_m": 5.0,
    "height_m": 3.0,
    "orientation_deg": 0,      # 0 = long side faces north
    "floor": "top",            # "top" (roof exposed) or "middle" (flat above)
    "wall": "brick_230",       # 230 mm brick + plaster
    "roof": "rcc_150",         # 150 mm concrete slab, exposed
    "roof_solar_absorptance": 0.7,   # grey concrete
    "wwr": 0.15,               # window-to-wall ratio
    "shading_depth_m": 0.0,    # window overhang
    "night_vent": False,       # windows open at night?
    "occupants": 4,
}

INTERVENTIONS = {
    "cool_roof":       {"roof_solar_absorptance": 0.2},  # white reflective coating
    "roof_insul":      {"roof": "rcc_150_insul_50"},     # + 50 mm insulation
    "shade_nightvent": {"shading_depth_m": 0.6, "night_vent": True},
}


# Levels for the parameter sweep (run_sweep.py). Every combination is
# simulated, so the tool can look up any design made from these choices.
SWEEP_LEVELS = {
    "orientation_deg": [0, 90],
    "floor": ["top", "middle"],
    "wall": ["brick_230", "brick_115", "aac_200"],
    "roof": ["rcc_150", "rcc_150_insul_50"],
    "roof_solar_absorptance": [0.7, 0.4, 0.2],
    "wwr": [0.10, 0.15, 0.25],
    "shading_depth_m": [0.0, 0.6],
    "night_vent": [False, True],
    "occupants": [2, 4, 6],
}
# On a middle floor the roof belongs to the flat above, so these have no effect.
ROOF_ONLY = ("roof", "roof_solar_absorptance")


def variant(name):
    """Baseline with one intervention applied."""
    p = dict(BASELINE)
    p.update(INTERVENTIONS[name])
    p["name"] = name
    return p
