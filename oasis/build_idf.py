"""Parameters -> EnergyPlus model file (.idf).

Built from an empty IDF with eppy (no template file).
Step 4 state: room box + walls + roof + floor, windows (with optional
overhang), people and window ventilation. No HVAC: the flat is free-running.
"""
from io import StringIO
from pathlib import Path

from eppy.modeleditor import IDF

import config

IDF.setiddname(str(Path(config.ENERGYPLUS).parent / "Energy+.idd"))

ZONE = "ZONE ONE"

# Starting values; check against ENS 2024 or the ISHRAE handbook later.
# name: (thickness m, conductivity W/m.K, density kg/m3, specific heat J/kg.K)
MATERIALS = {
    "plaster": (0.015, 0.72, 1760, 840),    # cement plaster
    "brick":   (0.230, 0.81, 1820, 880),    # burnt clay brick
    "brick_115": (0.115, 0.81, 1820, 880),  # half-brick wall
    "aac":     (0.200, 0.184, 642, 794),    # autoclaved aerated concrete block
    "rcc":     (0.150, 1.58, 2288, 880),    # RCC slab
    "eps":     (0.050, 0.035, 24, 1340),    # EPS insulation
    # Roof finishes, values from SP 41 (BIS Handbook on functional requirements of buildings)
    "screed":  (0.040, 0.72, 1648, 840),    # cement mortar screed on the slab ("concrete + cement")
    "mortar":  (0.012, 0.72, 1648, 840),    # mortar bed under the tiles
    "coba":    (0.085, 0.73, 1646, 880),    # brick-bat coba (lime concrete with brick bats)
    "tile":    (0.020, 0.81, 1820, 880),    # pressed clay tile (burnt clay)
}

# Layers listed from OUTSIDE to INSIDE.
WALLS = {
    "brick_230": ["plaster", "brick", "plaster"],
    "brick_115": ["plaster", "brick_115", "plaster"],
    "aac_200": ["plaster", "aac", "plaster"],
}
ROOFS = {
    "rcc_150": ["rcc", "plaster"],
    "rcc_150_insul_50": ["eps", "rcc", "plaster"],   # insulation above the slab
    "rcc_150_screed": ["screed", "rcc", "plaster"],  # Dhaka survey "concrete + cement"
    # TNUHDB weathering course: 20 mm clay tile + 12 mm mortar + 85 mm brick-bat coba over the slab
    "rcc_150_coba": ["tile", "mortar", "coba", "rcc", "plaster"],
}
FLOOR = ["plaster", "rcc"]   # slab shared with the flat below

# Windows: single clear glass
GLASS_U = 5.8        # W/m2.K
GLASS_SHGC = 0.8

# Occupants and air. Values marked "calibrated" come from calibration round 4
# (calibrate_homes.py --airflow afn: 12 measured Dhaka homes, mean RMSE 1.1 C;
# outputs/calibration/homes/afn/summary.json). The rest are assumptions.
ACTIVITY_W = 100.0         # heat per person, resting / light activity
OPENABLE_FRACTION = 0.5    # sliding window: half the glass area opens
WINDOWS_OPEN_HOUR = 6      # windows open 06:00-22:00 unless night_vent
WINDOWS_CLOSE_HOUR = 22
INFILTRATION_ACH = 1.0     # leaks through gaps when windows are shut
# The weather file's wind is measured at an open airport. A flat in a dense
# street, with mosquito mesh and grilles, gets far less air through a window.
AIRFLOW_FACTOR = 0.2       # assumption, to be calibrated on measured homes

# Appliances, lights and cooking (heat released inside the flat)
APPLIANCES_PEAK_W = 100.0  # calibrated (weakly identified): evening appliances + cooking
APPLIANCES_LATENT = 0.2    # share released as moisture (cooking steam)

# Internal walls and furniture that store heat inside the flat, as exposed
# area of 115 mm plastered brick partition. Calibrated for the 30 m2 box.
INTERNAL_MASS_M2 = 320.0   # calibrated
BOX_FLOOR_M2 = 30.0        # floor area the calibrated mass belongs to (6 x 5 m)
AIRFLOW_MODEL = "afn"      # calibrated method: AirflowNetwork (wind pressure, two-way flow)

# Settings that calibration (calibrate.py) may change. A building's
# parameters can override any of them; otherwise these values are used.
DEFAULTS = {
    "airflow_factor": AIRFLOW_FACTOR,
    "infiltration_ach": INFILTRATION_ACH,
    "appliances_peak_w": APPLIANCES_PEAK_W,
    "internal_mass_m2": INTERNAL_MASS_M2,
    "windows_open_hour": WINDOWS_OPEN_HOUR,
    "windows_close_hour": WINDOWS_CLOSE_HOUR,
    "openable_fraction": OPENABLE_FRACTION,
}


def setting(p, key):
    return p.get(key, DEFAULTS[key])


def build_idf(p: dict, out_path: Path) -> Path:
    idf = IDF(StringIO("Version,26.2;"))

    add_settings(idf, p)
    add_constructions(idf, p)
    add_room(idf, p)
    add_windows(idf, p)
    add_neighbours(idf, p)
    add_people(idf, p)
    add_appliances(idf, p)
    add_internal_mass(idf, p)
    add_ventilation(idf, p)
    add_outputs(idf)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    idf.saveas(str(out_path))
    return out_path


def add_settings(idf, p):
    """Simulation settings and the heatwave week."""
    idf.newidfobject(
        "SIMULATIONCONTROL",
        Do_Zone_Sizing_Calculation="No",
        Do_System_Sizing_Calculation="No",
        Do_Plant_Sizing_Calculation="No",
        Run_Simulation_for_Sizing_Periods="No",
        Run_Simulation_for_Weather_File_Run_Periods="Yes",
    )
    idf.newidfobject(
        "BUILDING",
        Name=f"OASIS {p['name']}",
        North_Axis=p["orientation_deg"],
        Terrain="City",
        Solar_Distribution="FullExterior",
    )
    idf.newidfobject("TIMESTEP", Number_of_Timesteps_per_Hour=4)
    idf.newidfobject("SCHEDULETYPELIMITS", Name="any_number")   # used by all schedules
    # Default: the heatwave week plus spin-up days before it (dropped again
    # by simulate.run). Calibration runs set their own dates.
    start = p.get("run_start", config.SPINUP_START)
    end = p.get("run_end", config.RUN_END)
    idf.newidfobject(
        "RUNPERIOD",
        Name="Heatwave week",
        Begin_Month=start[0],
        Begin_Day_of_Month=start[1],
        End_Month=end[0],
        End_Day_of_Month=end[1],
    )
    idf.newidfobject(
        "GLOBALGEOMETRYRULES",
        Starting_Vertex_Position="UpperLeftCorner",
        Vertex_Entry_Direction="Counterclockwise",
        Coordinate_System="Relative",
    )


def add_material(idf, name, base, solar_absorptance=0.7):
    """One Material object from the MATERIALS table."""
    thickness, conductivity, density, specific_heat = MATERIALS[base]
    idf.newidfobject(
        "MATERIAL",
        Name=name,
        Roughness="MediumRough",
        Thickness=thickness,
        Conductivity=conductivity,
        Density=density,
        Specific_Heat=specific_heat,
        Solar_Absorptance=solar_absorptance,
    )


def add_construction(idf, name, layers):
    """One Construction; layers are material names, outside to inside."""
    c = idf.newidfobject("CONSTRUCTION", Name=name, Outside_Layer=layers[0])
    for i, layer in enumerate(layers[1:], start=2):
        setattr(c, f"Layer_{i}", layer)


def add_constructions(idf, p):
    for base in MATERIALS:
        add_material(idf, base, base)

    # The roof's top layer gets its own material so the roof colour
    # (solar absorptance) can change without touching the walls.
    roof_layers = list(ROOFS[p["roof"]])
    add_material(idf, "roof_top", roof_layers[0], p["roof_solar_absorptance"])
    roof_layers[0] = "roof_top"

    add_construction(idf, "wall", WALLS[p["wall"]])
    add_construction(idf, "floor", FLOOR)
    if p.get("floor", "top") == "top":
        add_construction(idf, "roof", roof_layers)
    else:
        add_construction(idf, "ceiling", ["rcc", "plaster"])   # slab under the flat above


def add_surface(idf, name, kind, construction, vertices, boundary="Outdoors"):
    """One BuildingSurface:Detailed. Vertices: upper-left first,
    counterclockwise when seen from outside."""
    exposed = boundary == "Outdoors"
    s = idf.newidfobject(
        "BUILDINGSURFACE:DETAILED",
        Name=name,
        Surface_Type=kind,
        Construction_Name=construction,
        Zone_Name=ZONE,
        Outside_Boundary_Condition=boundary,
        Sun_Exposure="SunExposed" if exposed else "NoSun",
        Wind_Exposure="WindExposed" if exposed else "NoWind",
        Number_of_Vertices=len(vertices),
    )
    for i, (x, y, z) in enumerate(vertices, start=1):
        setattr(s, f"Vertex_{i}_Xcoordinate", x)
        setattr(s, f"Vertex_{i}_Ycoordinate", y)
        setattr(s, f"Vertex_{i}_Zcoordinate", z)


def add_room(idf, p):
    """One zone: a box with the long side (length) running east-west,
    so the long walls face north and south at orientation 0."""
    L, W, H = p["length_m"], p["width_m"], p["height_m"]
    # Height of the flat's floor above the ground. It sets the wind speed at
    # the windows (EnergyPlus scales the weather-file wind with height).
    idf.newidfobject("ZONE", Name=ZONE, Z_Origin=p.get("height_above_ground_m", 0.0))

    # Walls shared with a neighbour (p["shared_walls"], e.g. ["east", "west"])
    # get no sun or wind: the room next door is at a similar temperature.
    # Default: none, all four walls face outside. Windows must not be on them.
    shared = set(p.get("shared_walls", ()))
    walls = {
        "south": [(0, 0, H), (0, 0, 0), (L, 0, 0), (L, 0, H)],
        "east":  [(L, 0, H), (L, 0, 0), (L, W, 0), (L, W, H)],
        "north": [(L, W, H), (L, W, 0), (0, W, 0), (0, W, H)],
        "west":  [(0, W, H), (0, W, 0), (0, 0, 0), (0, 0, H)],
    }
    for side, vertices in walls.items():
        add_surface(idf, f"wall_{side}", "Wall", "wall", vertices,
                    boundary="Adiabatic" if side in shared else "Outdoors")
    top = [(0, 0, H), (L, 0, H), (L, W, H), (0, W, H)]
    if p.get("floor", "top") == "top":
        add_surface(idf, "roof", "Roof", "roof", top)
    else:
        # Middle floor: a flat above at a similar temperature, no sun on the slab.
        add_surface(idf, "roof", "Ceiling", "ceiling", top, boundary="Adiabatic")
    # Floor is adiabatic: there is a flat below at a similar temperature.
    add_surface(idf, "floor", "Floor", "floor",
                [(0, W, 0), (L, W, 0), (L, 0, 0), (0, 0, 0)],
                boundary="Adiabatic")


# Neighbouring buildings across a lane (used when p["shaded_walls"] lists
# walls that get no direct sun, as recorded for the measured homes).
NEIGHBOUR_GAP_M = 2.0      # lane width between the wall and the neighbour
NEIGHBOUR_RISE_M = 1.0     # neighbour top above this flat's roof (parapet)
NEIGHBOUR_EXTRA_M = 5.0    # neighbour extends this far past each wall end


def add_neighbours(idf, p):
    """A neighbouring building facing each wall in p["shaded_walls"]: a
    vertical shading plane across a lane. It blocks direct sun and part of the
    sky, as for a flat in a dense street. EnergyPlus shades from both faces."""
    L, W, H = p["length_m"], p["width_m"], p["height_m"]
    g, e = p.get("neighbour_gap_m", NEIGHBOUR_GAP_M), NEIGHBOUR_EXTRA_M
    top = p.get("height_above_ground_m", 0.0) + H + NEIGHBOUR_RISE_M   # from the ground up
    planes = {
        "south": [(-e, -g, top), (-e, -g, 0), (L + e, -g, 0), (L + e, -g, top)],
        "north": [(L + e, W + g, top), (L + e, W + g, 0), (-e, W + g, 0), (-e, W + g, top)],
        "east":  [(L + g, -e, top), (L + g, -e, 0), (L + g, W + e, 0), (L + g, W + e, top)],
        "west":  [(-g, W + e, top), (-g, W + e, 0), (-g, -e, 0), (-g, -e, top)],
    }
    for side in p.get("shaded_walls", ()):
        s = idf.newidfobject("SHADING:BUILDING:DETAILED", Name=f"neighbour_{side}",
                             Number_of_Vertices=4)
        for i, (x, y, z) in enumerate(planes[side], start=1):
            setattr(s, f"Vertex_{i}_Xcoordinate", x)
            setattr(s, f"Vertex_{i}_Ycoordinate", y)
            setattr(s, f"Vertex_{i}_Zcoordinate", z)


# Direction each wall faces (degrees from north, clockwise) at orientation 0
FACING = {"north": 0, "east": 90, "south": 180, "west": 270}


def window_sizes(p):
    """Width and height (m) of the window on each wall that has one.

    Normal case: p["wwr"] puts a window on the north and south walls.
    From a Rhino model: p["window_area_m2"] gives the measured glass area
    per wall, e.g. {"south": 2.2, "west": 1.1}.
    Each window keeps its wall's proportions, so the area is exact."""
    L, W, H = p["length_m"], p["width_m"], p["height_m"]
    wall_length = {"north": L, "south": L, "east": W, "west": W}
    if "window_area_m2" in p:
        areas = p["window_area_m2"]
    else:
        areas = {side: p["wwr"] * L * H for side in ("north", "south")}

    sizes = {}
    for side, area in areas.items():
        if area > 0:
            scale = min((area / (wall_length[side] * H)) ** 0.5, 0.95)
            sizes[side] = (wall_length[side] * scale, H * scale)
    return sizes


def add_windows(idf, p):
    """One centred window on each wall that has glass, single clear glass,
    plus an overhang if shading_depth_m > 0."""
    L, W, H = p["length_m"], p["width_m"], p["height_m"]
    sizes = window_sizes(p)
    if not sizes:
        return

    def corners(side):
        """Window vertices: upper-left first, seen from outside (same rule
        as the walls)."""
        w, h = sizes[side]
        z0, z1 = (H - h) / 2, (H + h) / 2
        if side in ("north", "south"):
            a0, a1 = (L - w) / 2, (L + w) / 2
        else:
            a0, a1 = (W - w) / 2, (W + w) / 2
        return {
            "south": [(a0, 0, z1), (a0, 0, z0), (a1, 0, z0), (a1, 0, z1)],
            "east":  [(L, a0, z1), (L, a0, z0), (L, a1, z0), (L, a1, z1)],
            "north": [(a1, W, z1), (a1, W, z0), (a0, W, z0), (a0, W, z1)],
            "west":  [(0, a1, z1), (0, a1, z0), (0, a0, z0), (0, a0, z1)],
        }[side]

    idf.newidfobject(
        "WINDOWMATERIAL:SIMPLEGLAZINGSYSTEM",
        Name="single_glass",
        UFactor=GLASS_U,
        Solar_Heat_Gain_Coefficient=GLASS_SHGC,
    )
    add_construction(idf, "window", ["single_glass"])

    for side in sizes:
        vertices = corners(side)
        s = idf.newidfobject(
            "FENESTRATIONSURFACE:DETAILED",
            Name=f"window_{side}",
            Surface_Type="Window",
            Construction_Name="window",
            Building_Surface_Name=f"wall_{side}",
            Number_of_Vertices=4,
        )
        for i, (x, y, z) in enumerate(vertices, start=1):
            setattr(s, f"Vertex_{i}_Xcoordinate", x)
            setattr(s, f"Vertex_{i}_Ycoordinate", y)
            setattr(s, f"Vertex_{i}_Zcoordinate", z)

        if p["shading_depth_m"] > 0:
            idf.newidfobject(
                "SHADING:OVERHANG",
                Name=f"overhang_{side}",
                Window_or_Door_Name=f"window_{side}",
                Height_above_Window_or_Door=0.0,
                Tilt_Angle_from_WindowDoor=90,
                Left_extension_from_WindowDoor_Width=0.0,
                Right_extension_from_WindowDoor_Width=0.0,
                Depth=p["shading_depth_m"],
            )


def add_day_schedule(idf, name, steps):
    """A schedule that repeats every day.
    steps: [(until_hour, value), ...], e.g. [(6, 0), (22, 1), (24, 0)]."""
    s = idf.newidfobject("SCHEDULE:COMPACT", Name=name,
                         Schedule_Type_Limits_Name="any_number")
    fields = ["Through: 12/31", "For: AllDays"]
    for until_hour, value in steps:
        fields += [f"Until: {until_hour:02d}:00", value]
    for i, field in enumerate(fields, start=1):
        setattr(s, f"Field_{i}", field)


def add_people(idf, p):
    """Occupants: everyone home in the evening and at night, half of them
    out during the day."""
    add_day_schedule(idf, "occupancy", [(8, 1.0), (18, 0.5), (24, 1.0)])
    idf.newidfobject("SCHEDULE:CONSTANT", Name="activity_w",
                     Schedule_Type_Limits_Name="any_number",
                     Hourly_Value=ACTIVITY_W)
    idf.newidfobject(
        "PEOPLE",
        Name="family",
        Zone_or_ZoneList_or_Space_or_SpaceList_Name=ZONE,
        Number_of_People_Schedule_Name="occupancy",
        Number_of_People_Calculation_Method="People",
        Number_of_People=p["occupants"],
        Fraction_Radiant=0.3,
        Activity_Level_Schedule_Name="activity_w",
    )


def add_appliances(idf, p):
    """Heat from appliances, lights and cooking: low all day (fridge, fans),
    a morning bump and a strong evening peak."""
    add_day_schedule(idf, "appliance_use",
                     [(6, 0.15), (8, 0.5), (18, 0.2), (22, 1.0), (24, 0.15)])
    idf.newidfobject(
        "ELECTRICEQUIPMENT",
        Name="appliances",
        Zone_or_ZoneList_or_Space_or_SpaceList_Name=ZONE,
        Schedule_Name="appliance_use",
        Design_Level_Calculation_Method="EquipmentLevel",
        Design_Level=setting(p, "appliances_peak_w"),
        Fraction_Latent=APPLIANCES_LATENT,
        Fraction_Radiant=0.3,
    )


def add_internal_mass(idf, p):
    """Internal walls and furniture: heat stored inside the flat, which
    slows down how fast the room warms up and cools down."""
    area = setting(p, "internal_mass_m2")
    if area <= 0:
        return
    add_construction(idf, "partition", ["plaster", "brick_115", "plaster"])
    idf.newidfobject(
        "INTERNALMASS",
        Name="internal_walls",
        Construction_Name="partition",
        Zone_or_ZoneList_Name=ZONE,
        Surface_Area=area,
    )


def add_ventilation(idf, p):
    """Fresh air. Windows are open in the daytime, and also at night if
    night_vent is on. A small constant leak (infiltration) covers the hours
    when the windows are shut.

    p["airflow_model"]: "afn" (default, calibrated) uses the AirflowNetwork
    (add_airflow_network), which needs no airflow_factor; "simple" uses
    EnergyPlus's wind-and-stack opening model scaled by airflow_factor."""
    if p.get("windows_open_steps"):          # explicit daily pattern (checks only)
        add_day_schedule(idf, "windows_open", p["windows_open_steps"])
    elif p["night_vent"]:
        add_day_schedule(idf, "windows_open", [(24, 1.0)])
    else:
        add_day_schedule(idf, "windows_open",
                         [(setting(p, "windows_open_hour"), 0.0),
                          (setting(p, "windows_close_hour"), 1.0), (24, 0.0)])
    if p.get("airflow_model", AIRFLOW_MODEL) == "afn":
        add_airflow_network(idf, p)
        return

    for side, (w, h) in window_sizes(p).items():
        idf.newidfobject(
            "ZONEVENTILATION:WINDANDSTACKOPENAREA",
            Name=f"vent_{side}",
            Zone_or_Space_Name=ZONE,
            Opening_Area=w * h * setting(p, "openable_fraction") * setting(p, "airflow_factor"),
            Opening_Area_Fraction_Schedule_Name="windows_open",
            Effective_Angle=(FACING[side] + p["orientation_deg"]) % 360,
            Height_Difference=0.0,   # one storey: wind-driven only
        )

    idf.newidfobject("SCHEDULE:CONSTANT", Name="always_on",
                     Schedule_Type_Limits_Name="any_number", Hourly_Value=1.0)
    idf.newidfobject(
        "ZONEINFILTRATION:DESIGNFLOWRATE",
        Name="leaks",
        Zone_or_ZoneList_or_Space_or_SpaceList_Name=ZONE,
        Schedule_Name="always_on",
        Design_Flow_Rate_Calculation_Method="AirChanges/Hour",
        Air_Changes_per_Hour=setting(p, "infiltration_ach"),
    )


# AirflowNetwork settings (standard values, not fitted)
DISCHARGE_COEFF = 0.6        # sharp-edged opening (ASHRAE Fundamentals, Ch. 16)
FLOW_EXPONENT = 0.65         # cracks: between laminar (1.0) and turbulent (0.5)
CLOSED_WINDOW_COEFF = 0.001  # kg/s per m of crack, window shut (EnergyPlus example value)
WALL_LEAKAGE_CM2_PER_M2 = 8.0  # wall effective leakage area at 4 Pa; calibrated (weakly identified)
DEFAULTS["wall_leakage_cm2_per_m2"] = WALL_LEAKAGE_CM2_PER_M2


def add_obj(idf, key, *values):
    """An IDF object filled field by field, in IDD order."""
    obj = idf.newidfobject(key)
    for name, value in zip(obj.fieldnames[1:], values):
        obj[name] = value
    return obj


def add_airflow_network(idf, p):
    """Air through each window and wall crack from wind pressure and the
    indoor-outdoor temperature difference, solved every time step.

    Wind pressure on each wall: EnergyPlus's surface-average correlation for
    low-rise buildings (Swami & Chandra 1988), from wind direction and the
    room's proportions. Later this can be replaced by CFD pressure values.
    Windows are simple openings with two-way flow, so a window on one wall
    alone still exchanges air (single-sided ventilation)."""
    L, W, H = p["length_m"], p["width_m"], p["height_m"]
    # Long axis: x (length) at orientation 0 points east, azimuth 90
    long_axis = (p["orientation_deg"] + (90 if L >= W else 0)) % 180
    add_obj(idf, "AIRFLOWNETWORK:SIMULATIONCONTROL", "afn",
            "MultizoneWithoutDistribution", "SurfaceAverageCalculation",
            "OpeningHeight", "LowRise", 500, "ZeroNodePressures", 1e-4, 1e-6, -0.5,
            long_axis, min(L, W) / max(L, W))
    # Windows open whenever the windows_open schedule says so
    add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:ZONE", ZONE, "Constant", "", 1.0,
            0.0, 100.0, 0.0, 300000.0, "windows_open")
    add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:REFERENCECRACKCONDITIONS", "ref_crack",
            20.0, 101325, 0.0)

    add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:COMPONENT:SIMPLEOPENING", "window_opening",
            CLOSED_WINDOW_COEFF, FLOW_EXPONENT, 0.0001, DISCHARGE_COEFF)
    for side in window_sizes(p):
        add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:SURFACE", f"window_{side}",
                "window_opening", "", setting(p, "openable_fraction"), "ZoneLevel")

    # Leaks through each outside wall, in proportion to its area
    shared = set(p.get("shared_walls", ()))
    wall_length = {"north": L, "south": L, "east": W, "west": W}
    for side, length in wall_length.items():
        if side in shared:
            continue
        ela = setting(p, "wall_leakage_cm2_per_m2") * 1e-4 * length * H
        add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:SURFACE:EFFECTIVELEAKAGEAREA", f"leak_{side}",
                ela, 1.0, 4.0, FLOW_EXPONENT)
        add_obj(idf, "AIRFLOWNETWORK:MULTIZONE:SURFACE", f"wall_{side}", f"leak_{side}", "", 1.0)


def add_outputs(idf):
    """Hourly outputs used by metrics.py."""
    for variable in ("Zone Mean Air Temperature",
                     "Zone Mean Radiant Temperature",
                     "Zone Air Relative Humidity",
                     "Site Outdoor Air Drybulb Temperature",
                     "Site Outdoor Air Relative Humidity",
                     "Zone Ventilation Current Density Air Change Rate",
                     "Zone Infiltration Current Density Air Change Rate",
                     "AFN Zone Ventilation Air Change Rate",
                     "AFN Zone Infiltration Air Change Rate"):
        idf.newidfobject(
            "OUTPUT:VARIABLE",
            Key_Value="*",
            Variable_Name=variable,
            Reporting_Frequency="Hourly",
        )
