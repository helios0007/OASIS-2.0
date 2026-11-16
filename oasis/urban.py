"""Urban layer (Layer 0): from a place on the map to the outdoor air a home there gets.

    map      OpenStreetMap building footprints around a point (Overpass API)
    form     site coverage, mean building height, facade-to-site ratio
    air      Urban Weather Generator (UWG, Bueno et al. 2013; `uwg` package):
             the airport heatwave file -> street-canyon air temperature and humidity
    hand-on  the result is one more weather case ("site") for the home model

What is measured and what is assumed (also returned to the tool):
  - footprints: mapped (OpenStreetMap); unmapped buildings are simply missing;
  - heights: OSM `height` / `building:levels` where tagged, otherwise the storeys
    the user types in. In Chennai few buildings are tagged, so height is mostly assumed;
  - facade ratio counts every outside edge, so walls shared by row houses are overcounted;
  - the homes around the site are chosen in the tool (CITY_HOMES): flats with no air
    conditioning and OASIS's baseline brick wall and concrete roof (the default), or UWG's
    US reference mid-rise flats (DOE, post-1980, zone 1A) with air conditioning;
  - street heat is typed in (SENS_ANTH_W_M2 is UWG's default); tree and grass cover too;
  - UWG knows nothing of the sea breeze, and leaves wind speed as at the airport;
  - checked only against the Nungambakkam station (check_urban_station.py), which stands
    in an open compound, not in a street.
"""
import hashlib
import json
import math
import shutil
import time
from datetime import date

import requests

import config
from oasis import urban_heights

OUT = config.OUT / "urban"
SITE = OUT / "site.json"
CARTO_KEY_FILE = config.ROOT / "carto_key.txt"
OVERTURE_FALLBACK = "2026-10-21.0"
OVERPASS = ["https://overpass-api.de/api/interpreter"] * 4 + ["https://overpass.kumi.systems/api/interpreter"]
BACKOFF_S = 6             # s; wait 0, 6, 12, 18, 24 s before the successive tries
FLOOR_M = 3.0             # m per storey, to turn storeys into height (assumed)
SENS_ANTH_W_M2 = 20       # W/m2 traffic and other street heat: the UWG default (assumed)
UWG_ZONE = "1A"           # ASHRAE very hot, humid
UWG_BUILDINGS = (("midriseapartment", "pst80", 1.0),)
# The homes the urban model puts around the site. Both start from UWG's mid-rise flat.
CITY_HOMES = {
    "no_ac": "Flats with no air conditioning",       # cooling off, OASIS baseline wall and roof
    "us_ac": "Air-conditioned flats (US reference)",  # UWG as it comes: cooled to 24 °C, waste heat to the street
}
DEFAULT_HOMES = "no_ac"   # the study sites are tenements (assumed: no room air conditioners)
NO_COOLING_C = 60.0       # °C cooling set-point for "no_ac": the cooling never runs
HOME_WALL, HOME_ROOF = "brick_230", "rcc_150"       # OASIS baseline (build_idf.WALLS / ROOFS)
HOME_ALBEDO = 0.3         # wall and roof: 1 - the baseline solar absorptance of 0.7
CHECK = config.OUT / "urban_check" / "summary.json"   # written by check_urban_station.py
DRY_BULB, DEW_POINT, RH, IR_SKY, TOTAL_COVER, OPAQUE_COVER = 6, 7, 8, 12, 22, 23   # EPW columns
SIGMA = 5.6697e-8         # W/m2K4

# Starting points on the map. Coordinates point directly to the tenement blocks / stations.
PLACES = [
    {"name": "Kannagi Nagar TNUHDB tenements", "lat": 12.9312, "lon": 80.2328},
    {"name": "Perumbakkam TNUHDB tenements", "lat": 12.8972, "lon": 80.2035},
    {"name": "Perumbakkam Light House Project (PMAY)", "lat": 12.8938, "lon": 80.2012},
    {"name": "KP Park (Pulianthope TNUHDB)", "lat": 13.0992, "lon": 80.2647},
    {"name": "Nungambakkam (IMD weather station)", "lat": 13.0678, "lon": 80.2472},
    {"name": "T. Nagar (commercial & flats)", "lat": 13.0418, "lon": 80.2341},
    {"name": "Mylapore (Kapaleeshwarar area)", "lat": 13.0339, "lon": 80.2699},
    {"name": "George Town (historic dense core)", "lat": 13.0945, "lon": 80.2866},
    {"name": "Ennore / Ernavoor tenements", "lat": 13.2045, "lon": 80.3168},
]


# ---------- map -> buildings ----------

def carto_key():
    """The user's CARTO basemap key, or None: environment variable OASIS_CARTO_KEY, else the
    first line of carto_key.txt in the project folder (not in git). Without a key the map
    is drawn from OpenFreeMap alone."""
    import os
    key = os.environ.get("OASIS_CARTO_KEY", "").strip()
    if not key and CARTO_KEY_FILE.exists():
        lines = CARTO_KEY_FILE.read_text(encoding="utf-8").split()
        key = lines[0] if lines else ""
    return key or None


def overture_release():
    """Name of the newest Overture Maps release (its building tiles are the map's footprints).
    Asked once a day; the last known name is used if the catalogue cannot be reached."""
    OUT.mkdir(parents=True, exist_ok=True)
    cache = OUT / "overture_release.json"
    known = json.loads(cache.read_text()) if cache.exists() else {"release": OVERTURE_FALLBACK, "day": ""}
    if known["day"] != str(date.today()):
        try:
            reply = requests.get("https://stac.overturemaps.org/catalog.json", timeout=15,
                                 headers={"User-Agent": "urban-form-research-client"})
            reply.raise_for_status()
            known = {"release": reply.json()["latest"], "day": str(date.today())}
            cache.write_text(json.dumps(known))
        except (requests.RequestException, ValueError, KeyError):
            pass
    return known["release"]


def fetch_buildings(lat, lon, radius_m):
    """Building outlines within radius_m of the point, in metres east/north of it.
    Returns [{"xy": [(x, y), ...], "height_tag": m or None}, ...]; cached per request."""
    OUT.mkdir(parents=True, exist_ok=True)
    cache = OUT / f"osm_{lat:.5f}_{lon:.5f}_{int(radius_m)}.json"
    if cache.exists():
        elements = json.loads(cache.read_text())
    else:
        query = (f'[out:json][timeout:40];(way["building"](around:{radius_m},{lat},{lon});'
                 f'relation["building"](around:{radius_m},{lat},{lon}););out geom tags;')
        elements = None
        for attempt, server in enumerate(OVERPASS):  # the public server is often at capacity and asks
            time.sleep(BACKOFF_S * attempt)          # clients to wait longer before each retry
            try:
                reply = requests.post(server, data={"data": query}, timeout=60,
                                      headers={"User-Agent": "urban-form-research-client"})
                reply.raise_for_status()
                elements = reply.json()["elements"]
                break
            except (requests.RequestException, ValueError, KeyError):
                continue
        if elements is None:
            raise ValueError("The OpenStreetMap servers did not answer. Try again in a minute.")
        cache.write_text(json.dumps(elements))
    kx, ky = 111_320 * math.cos(math.radians(lat)), 110_540     # m per degree
    out = []
    for e in elements:
        rings = [e["geometry"]] if e["type"] == "way" and "geometry" in e else \
                [m["geometry"] for m in e.get("members", []) if m.get("role") == "outer" and "geometry" in m]
        for ring in rings:
            xy = [((pt["lon"] - lon) * kx, (pt["lat"] - lat) * ky) for pt in ring]
            if len(xy) >= 4:
                out.append({"xy": xy, "height_tag": tagged_height(e.get("tags", {}))})
    return out


def tagged_height(tags):
    """Height (m) from OSM tags, or None."""
    try:
        if "height" in tags:
            return float(str(tags["height"]).lower().replace("m", "").strip())
        if "building:levels" in tags:
            return float(tags["building:levels"]) * FLOOR_M
    except ValueError:
        pass
    return None


def area_perimeter_centre(xy):
    """Shoelace area (m2), perimeter (m) and centroid of a closed outline."""
    a = cx = cy = per = 0.0
    for (x0, y0), (x1, y1) in zip(xy, xy[1:] + xy[:1]):
        cross = x0 * y1 - x1 * y0
        a, cx, cy = a + cross, cx + (x0 + x1) * cross, cy + (y0 + y1) * cross
        per += math.hypot(x1 - x0, y1 - y0)
    a /= 2
    if abs(a) < 1e-6:
        return 0.0, per, xy[0]
    return abs(a), per, (cx / (6 * a), cy / (6 * a))


def morphology(buildings, radius_m, default_storeys):
    """Urban form of the circle: the three numbers UWG needs, and how well they are known."""
    site = math.pi * radius_m ** 2
    foot = facade = vol = tagged = 0.0
    n = 0
    for b in buildings:
        area, per, (cx, cy) = area_perimeter_centre(b["xy"])
        if area < 4 or math.hypot(cx, cy) > radius_m:     # a building counts if its centre is inside
            b["inside"] = False
            continue
        h = b["height_tag"] or default_storeys * FLOOR_M
        b.update(inside=True, height_m=h, area_m2=area)
        foot, facade, vol, n = foot + area, facade + per * h, vol + area * h, n + 1
        tagged += area if b["height_tag"] else 0
    if n == 0:
        raise ValueError("No mapped buildings inside this circle. Move the point or widen the radius.")
    return {
        "buildings": n,
        "site_area_m2": round(site),
        "site_coverage": round(foot / site, 3),            # UWG blddensity
        "mean_height_m": round(vol / foot, 1),             # UWG bldheight, weighted by footprint
        "facade_to_site": round(facade / site, 3),         # UWG vertohor
        "height_tagged_share": round(tagged / foot, 3),    # share of footprint with a mapped height
    }


# ---------- form -> air ----------

def sky_infrared(t_c, td_c, cover_tenths):
    """Sky long-wave radiation (W/m2) the way EnergyPlus fills a missing value
    (Clark & Allen 1978 clear-sky emissivity with Walton's cloud correction)."""
    n = cover_tenths
    emis = (0.787 + 0.764 * math.log((td_c + 273.15) / 273.0)) * (1 + 0.0224 * n - 0.0035 * n ** 2 + 0.00028 * n ** 3)
    return emis * SIGMA * (t_c + 273.15) ** 4


def fill_sky_infrared(epw_in, epw_out):
    """UWG reads the sky infrared column as it stands; the recorded weeks hold 9999
    (missing: EnergyPlus works it out). Fill those rows the EnergyPlus way."""
    lines = epw_in.read_text().splitlines()
    for i in range(8, len(lines)):
        f = lines[i].split(",")
        if float(f[IR_SKY]) >= 9999:
            cover = float(f[OPAQUE_COVER]) if float(f[OPAQUE_COVER]) <= 10 else float(f[TOTAL_COVER])
            f[IR_SKY] = f"{sky_infrared(float(f[DRY_BULB]), float(f[DEW_POINT]), cover if cover <= 10 else 5):.0f}"
            lines[i] = ",".join(f)
    epw_out.write_text("\n".join(lines) + "\n")
    return epw_out


def run_window():
    """(first row, number of rows) of the simulated days in the 8,760-row weather file."""
    first = (date(2023, *config.SPINUP_START) - date(2023, 1, 1)).days * 24
    days = (date(2023, *config.RUN_END) - date(2023, *config.SPINUP_START)).days + 1
    return first, days * 24


def chennai_element(layers, horizontal, name):
    """A wall or roof for UWG from OASIS's own materials (layers outside to inside),
    cut into the thin slices UWG's conduction needs."""
    from uwg import UWG
    from uwg.element import Element
    from uwg.material import Material
    from oasis.build_idf import MATERIALS

    thick = [MATERIALS[k][0] for k in layers]
    mats = [Material(MATERIALS[k][1], MATERIALS[k][2] * MATERIALS[k][3], k) for k in layers]   # W/m.K, J/m3.K
    whole = Element(HOME_ALBEDO, 0.9, thick, mats, 0.0, 303.0, horizontal, name)
    mats, thick = UWG._procmat(whole, UWG.MAXTHICKNESS, UWG.MINTHICKNESS)
    return Element(HOME_ALBEDO, 0.9, thick, mats, 0.0, 303.0, horizontal, name)


def free_running(model):
    """Turn UWG's reference flats into homes without air conditioning: the cooling never
    runs (so no waste heat goes to the street) and the wall and roof are OASIS's baseline.
    Glazing, people, appliances and air leakage stay as in UWG's flat. Call after generate()."""
    from oasis.build_idf import ROOFS, WALLS

    for sch in model.Sch:      # UWG re-reads the set-point from this schedule every hour
        sch.cool = [[NO_COOLING_C] * 24 for _ in range(3)]
    for bem in model.BEM:
        bem.building.cool_setpoint_day = bem.building.cool_setpoint_night = NO_COOLING_C + 273.15
        bem.wall = chennai_element(WALLS[HOME_WALL], False, "oasis_wall")
        bem.roof = chennai_element(ROOFS[HOME_ROOF], True, "oasis_roof")
    model.alb_wall_total = HOME_ALBEDO


def urban_air(form, tree_cover, grass_cover, epw_out, homes=DEFAULT_HOMES, street_heat=SENS_ANTH_W_M2):
    """Run UWG on the airport heatwave file for the spin-up + scored days and write
    epw_out: the airport file with street-canyon temperature and humidity in those days.
    Returns the mean urban minus airport air temperature for each hour of the day, 1-7 May."""
    from uwg import UWG      # imported here: only the urban tab needs it

    work = OUT / "_uwg"
    work.mkdir(parents=True, exist_ok=True)
    try:
        filled = fill_sky_infrared(config.EPW, work / "airport_filled.epw")
        first, rows = run_window()
        model = UWG.from_param_args(
            bldheight=form["mean_height_m"], blddensity=form["site_coverage"], vertohor=form["facade_to_site"],
            grasscover=grass_cover, treecover=tree_cover, zone=UWG_ZONE, bld=UWG_BUILDINGS,
            sensanth=street_heat, month=config.SPINUP_START[0], day=config.SPINUP_START[1], nday=rows // 24,
            epw_path=str(filled), new_epw_dir=str(work), new_epw_name="urban.epw")
        model.generate()
        if homes == "no_ac":
            free_running(model)
        model.simulate()
        model.write_epw()
        urban = (work / "urban.epw").read_text().splitlines()
        lines = config.EPW.read_text().splitlines()
        scored = (date(2023, *config.RUN_START) - date(2023, *config.SPINUP_START)).days * 24
        delta = [[] for _ in range(24)]
        for k in range(rows):
            i = 8 + first + k
            f, u = lines[i].split(","), urban[i].split(",")
            if k >= scored:
                delta[k % 24].append(float(u[DRY_BULB]) - float(f[DRY_BULB]))
            f[DRY_BULB], f[DEW_POINT], f[RH] = u[DRY_BULB], u[DEW_POINT], str(int(round(float(u[RH]))))
            lines[i] = ",".join(f)          # sky infrared stays 9999: EnergyPlus fills it as before
        epw_out.parent.mkdir(parents=True, exist_ok=True)
        epw_out.write_text("\n".join(lines) + "\n")
        return [round(sum(d) / len(d), 2) for d in delta]
    finally:
        shutil.rmtree(work, ignore_errors=True)


def make_site(name, lat, lon, radius_m, form, tree_cover, grass_cover, default_storeys, surroundings=None, green_source="typed",
              building=None, homes=DEFAULT_HOMES, street_heat=SENS_ANTH_W_M2):
    """Urban air for one place, saved as the current site (the "site" weather case).
    surroundings: urban_heights.obstructions(...) for neighbour shading, or None."""
    inputs = {"name": name, "lat": lat, "lon": lon, "radius_m": radius_m, "form": form,
              "tree_cover": tree_cover, "grass_cover": grass_cover, "default_storeys": default_storeys,
              "homes": homes, "street_heat_w_m2": street_heat}
    tag = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()[:8]
    epw = config.OUT / "weather_cases" / f"chennai_heatwave_site_{tag}.epw"
    delta = urban_air(form, tree_cover, grass_cover, epw, homes, street_heat)
    night = [delta[h] for h in (20, 21, 22, 23, 0, 1, 2, 3, 4, 5)]
    day = [delta[h] for h in range(10, 17)]
    site = {**inputs, "epw": epw.name,
            "d_temp_c": delta,                                   # by hour of the day, 0 = 00:00-01:00
            "night_c": round(sum(night) / len(night), 2),        # 20:00-06:00
            "day_c": round(sum(day) / len(day), 2),              # 10:00-17:00
            "max_c": max(delta), "max_hour": delta.index(max(delta)),
            "surroundings": surroundings,
            "roughness": urban_heights.roughness(form),
            "green_source": green_source,
            "building": building,          # the building picked on the map: {"x_m", "y_m", "height_m", "storeys"}, or None
            "assumptions": assumptions(form, default_storeys, tree_cover, grass_cover, green_source, homes, street_heat)}
    SITE.write_text(json.dumps(site, indent=2))
    for old in epw.parent.glob("chennai_heatwave_site_*.epw"):     # keep only the current site's file
        if old != epw:
            old.unlink(missing_ok=True)
    return site


def station_check(homes=DEFAULT_HOMES):
    """The line on how the model did at the Nungambakkam station, from check_urban_station.py."""
    if not CHECK.exists():
        return {"status": "Assumed", "text": "Not checked against a Chennai measurement (run check_urban_station.py)."}
    c = json.loads(CHECK.read_text())
    m, s = c["cases"][homes], c["station"]
    return {"status": "Checked", "text": f"Checked at the Nungambakkam weather station, 1–7 May 2024: with these homes the model gives "
            f"{m['night_c']:+.1f} °C at night and {m['day_c']:+.1f} °C by day against the airport; the station measured "
            f"{s['night_c']:+.1f} and {s['day_c']:+.1f} °C. The station stands in an open compound, not a street, "
            "and no Chennai street has been measured."}


def assumptions(form, default_storeys, tree_cover, grass_cover, green_source="typed", homes=DEFAULT_HOMES,
                street_heat=SENS_ANTH_W_M2):
    """What the urban result rests on, each tagged Mapped / Typed in / Assumed."""
    untagged = 1 - form.get("height_tagged_share", 0)
    if form.get("source") == "satellite":
        shape = [
            {"status": "Satellite", "text": f"Built area, building heights and facade area: Google Open Buildings 2.5D, {urban_heights.YEAR} layer. These are model estimates from satellite images (about 4 m detail), not a survey; low buildings can read too low."},
            {"status": "Satellite", "text": f"Neighbour shading in the Home tab: the gap to the next building and its height along each wall's direction, from the same data. One sight line per wall; single-room model only."},
        ]
    else:
        shape = [
            {"status": "Mapped", "text": f"Building footprints: OpenStreetMap, {form.get('buildings', '?')} buildings. Unmapped buildings are missing, so coverage can be too low."},
            {"status": "Typed in", "text": f"Building height: {untagged:.0%} of the built area has no height on the map and uses {default_storeys:g} storeys × {FLOOR_M:g} m."},
            {"status": "Assumed", "text": "Facade area counts every outside edge, so walls shared by row houses are overcounted."},
        ]
    green = ({"status": "Satellite", "text": f"Tree cover {tree_cover:.0%}: canopy 3 m or taller on the Meta / WRI canopy height map (1 m; a model estimate from satellite images taken between 2009 and 2020, height error about 2.8 m). Grass cover {grass_cover:.0%}: ESA WorldCover 2021 (10 m), which misses small lawns."}
             if green_source == "satellite" else
             {"status": "Typed in", "text": f"Tree cover {tree_cover:.0%}, grass cover {grass_cover:.0%}."})
    return shape + [
        green,
        ({"status": "Chosen", "text": "The homes around have no air conditioning, with 230 mm plastered brick walls and a 150 mm concrete roof (OASIS's baseline). "
                                      "Their windows, people, appliances and air leakage are still those of UWG's US reference mid-rise flat."}
         if homes == "no_ac" else
         {"status": "Chosen", "text": "The homes around are UWG's US reference mid-rise flats (post-1980), air-conditioned to 24 °C, with the waste heat going to the street."}),
        {"status": "Assumed" if street_heat == SENS_ANTH_W_M2 else "Typed in",
         "text": f"Street heat from traffic: {street_heat:g} W/m²" + (" (UWG's default, not a Chennai figure)." if street_heat == SENS_ANTH_W_M2 else ".")},
        {"status": "Assumed", "text": "No sea breeze. Wind speed stays as at the airport: the home model's airflow was already fitted to homes in dense streets, so the roof-level wind shown here is for information only."},
        station_check(homes),
    ]


def surroundings_for_home():
    """What the single-room model needs for neighbour shading (build_idf.add_neighbours):
    the sight lines around the site and the height of the building the flat is in
    (the one at the site centre; on open ground, the typed storeys). None if no site."""
    s = site()
    if not s or not s.get("surroundings"):
        return None
    around = s["surroundings"]
    picked = (s.get("building") or {}).get("height_m")
    return {"rays": around["rays"], "building_m": picked or around.get("own_height_m") or s["default_storeys"] * FLOOR_M}


def site():
    """The saved site, or None (also None if its weather file has been deleted)."""
    if not SITE.exists():
        return None
    s = json.loads(SITE.read_text())
    return s if (config.OUT / "weather_cases" / s["epw"]).exists() else None


def site_weather():
    """The site as a weather case for the tools (same fields as scenario.WEATHERS)."""
    s = site()
    if s is None:
        return None
    return {"label": "Site", "source": "Modelled",
            "note": f"{s['name']}: airport week passed through the urban weather model, "
                    f"{s['night_c']:+.1f} °C at night, {s['day_c']:+.1f} °C by day"
                    + (", plus shade from the neighbouring buildings (single room only)." if s.get("surroundings") else ".")
                    + " A model result, not a measurement."}
