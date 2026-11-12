"""Plain-language names for the building choices, shared by the front ends."""

# parameter: (title, {value: label})
LABELS = {
    "floor": ("Floor level", {"top": "Top floor", "middle": "Middle floor"}),
    "occupants": ("People living there", {2: "2", 4: "4", 6: "6"}),
    "wall": ("Walls", {"brick_230": "230 mm brick", "brick_115": "115 mm brick",
                       "aac_200": "200 mm AAC block"}),
    "roof": ("Roof build-up", {"rcc_150": "Bare concrete slab",
                               "rcc_150_insul_50": "Slab + 50 mm insulation"}),
    "roof_solar_absorptance": ("Roof colour", {0.7: "Grey concrete", 0.4: "Light grey",
                                               0.2: "White coating"}),
    "shading_depth_m": ("Window overhang", {0.0: "None", 0.6: "0.6 m"}),
    "night_vent": ("Windows at night", {False: "Shut 22:00-06:00", True: "Open all night"}),
}


def name_of(key, value):
    """E.g. ("roof_solar_absorptance", 0.2) -> "Roof colour: White coating"."""
    title, options = LABELS[key]
    return f"{title}: {options[value]}"
