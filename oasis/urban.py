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
  - UWG's buildings are US reference mid-rise flats (DOE, post-1980, zone 1A), with air
    conditioning; traffic heat SENS_ANTH_W_M2; tree and grass cover are typed in;
  - UWG knows nothing of the sea breeze, and leaves wind speed as at the airport;
  - not checked against any Chennai street measurement.
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
OVERPASS = ["https://overpass-api.de/api/interpreter"] * 4 + ["https://overpass.kumi.systems/api/interpreter"]
BACKOFF_S = 6             # s; wait 0, 6, 12, 18, 24 s before the successive tries
FLOOR_M = 3.0             # m per storey, to turn storeys into height (assumed)
SENS_ANTH_W_M2 = 20       # W/m2 traffic and other street heat: the UWG default (assumed)
UWG_ZONE = "1A"           # ASHRAE very hot, humid
UWG_BUILDINGS = (("midriseapartment", "pst80", 1.0),)
DRY_BULB, DEW_POINT, RH, IR_SKY, TOTAL_COVER, OPAQUE_COVER = 6, 7, 8, 12, 22, 23   # EPW columns
SIGMA = 5.6697e-8         # W/m2K4

# Starting points on the map. Coordinates are approximate: check them against the site.
PLACES = [
    {"name": "Nungambakkam (weather station area)", "lat": 13.0678, "lon": 80.2472},
    {"name": "T. Nagar", "lat": 13.0418, "lon": 80.2341},
    {"name": "George Town", "lat": 13.0945, "lon": 80.2866},
    {"name": "Kannagi Nagar tenements", "lat": 12.9365, "lon": 80.2370},
    {"name": "Perumbakkam tenements", "lat": 12.9050, "lon": 80.1960},
]


# ---------- map -> buildings ----------

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


def urban_air(form, tree_cover, grass_cover, epw_out):
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
            sensanth=SENS_ANTH_W_M2, month=config.SPINUP_START[0], day=config.SPINUP_START[1], nday=rows // 24,
            epw_path=str(filled), new_epw_dir=str(work), new_epw_name="urban.epw")
        model.generate()
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


def make_site(name, lat, lon, radius_m, form, tree_cover, grass_cover, default_storeys, surroundings=None):
    """Urban air for one place, saved as the current site (the "site" weather case).
    surroundings: urban_heights.obstructions(...) for neighbour shading, or None."""
    inputs = {"name": name, "lat": lat, "lon": lon, "radius_m": radius_m, "form": form,
              "tree_cover": tree_cover, "grass_cover": grass_cover, "default_storeys": default_storeys}
    tag = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()[:8]
    epw = config.OUT / "weather_cases" / f"chennai_heatwave_site_{tag}.epw"
    delta = urban_air(form, tree_cover, grass_cover, epw)
    night = [delta[h] for h in (20, 21, 22, 23, 0, 1, 2, 3, 4, 5)]
    day = [delta[h] for h in range(10, 17)]
    site = {**inputs, "epw": epw.name,
            "d_temp_c": delta,                                   # by hour of the day, 0 = 00:00-01:00
            "night_c": round(sum(night) / len(night), 2),        # 20:00-06:00
            "day_c": round(sum(day) / len(day), 2),              # 10:00-17:00
            "max_c": max(delta), "max_hour": delta.index(max(delta)),
            "surroundings": surroundings,
            "roughness": urban_heights.roughness(form),
            "assumptions": assumptions(form, default_storeys, tree_cover, grass_cover)}
    SITE.write_text(json.dumps(site, indent=2))
    for old in epw.parent.glob("chennai_heatwave_site_*.epw"):     # keep only the current site's file
        if old != epw:
            old.unlink(missing_ok=True)
    return site


def assumptions(form, default_storeys, tree_cover, grass_cover):
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
    return shape + [
        {"status": "Typed in", "text": f"Tree cover {tree_cover:.0%}, grass cover {grass_cover:.0%}."},
        {"status": "Assumed", "text": f"The city's buildings are UWG's US reference mid-rise flats (post-1980, air-conditioned); street heat {SENS_ANTH_W_M2} W/m²."},
        {"status": "Assumed", "text": "No sea breeze. Wind speed stays as at the airport: the home model's airflow was already fitted to homes in dense streets, so the roof-level wind shown here is for information only."},
        {"status": "Assumed", "text": "Not checked against a Chennai street measurement."},
    ]


def surroundings_for_home():
    """What the single-room model needs for neighbour shading (build_idf.add_neighbours):
    the sight lines around the site and the height of the building the flat is in
    (the one at the site centre; on open ground, the typed storeys). None if no site."""
    s = site()
    if not s or not s.get("surroundings"):
        return None
    around = s["surroundings"]
    return {"rays": around["rays"], "building_m": around.get("own_height_m") or s["default_storeys"] * FLOOR_M}


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
