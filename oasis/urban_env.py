"""Environment layers for the Neighbourhood tab: what the place is like outdoors.

Four readings of the same square the building heights cover (radius + margin):

0. canopy        Tree canopy height: Meta / WRI global canopy height map, 1 m (model
                 estimate from Maxar satellite images, open data on AWS, no key).
                 Gives tree cover for the urban weather model and the trees for 1.
1. sky_and_sun   Sky view factor and hours of direct sun on the ground, worked out
                 from the satellite building heights (urban_heights) and the trees. Computed.
2. land_cover    Trees, grass, water, built: ESA WorldCover 2021, 10 m (Sentinel-1/2
                 classification, open data, no key). Fills tree and grass cover for
                 the urban weather model.
3. surface_temp  Land surface temperature measured by Landsat 8/9 (Collection 2
                 Level 2, band 10) on the clearest pass of April-May 2024, read
                 from the Microsoft Planetary Computer (no key). Shown only.

Every reading is cached in outputs/urban. Grids have north at the top.
"""
import json
import math

import numpy as np
import requests

import config
from oasis import urban_heights
from oasis.urban_heights import CELL_M

OUT = config.OUT / "urban"
AGENT = "urban-form-research-client"

# --- 0. tree canopy ----------------------------------------------------------
CANOPY = "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/{quadkey}.tif"
CANOPY_ZOOM = 9               # the files are web-mercator tiles of this zoom, named by quadkey
TREE_MIN_M = 3.0              # canopy at or above this height counts as tree (chosen; 2 and 5 m are reported beside it)
CANOPY_MAE_M = 2.8            # mean absolute error of the height reported by its authors (Tolan et al. 2024)

# --- 1. sky view and sun -----------------------------------------------------
LOOK_M = 60.0                 # m; how far a ground cell looks for buildings (= urban_heights.MARGIN_M, so the circle is fully served)
SUN_DAY = 125                 # day of the year: 4 May, middle of the recorded heatwave week
SUN_STEP_H = 0.25             # h
SUN_MIN_ELEV = 2.0            # degrees; below this the sun is taken as down

# --- 2. land cover -----------------------------------------------------------
WORLDCOVER = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
WORLDCOVER_YEAR = 2021
COVER_GROUPS = {              # WorldCover class -> the group shown and counted
    10: "tree", 95: "tree",                         # tree cover, mangroves
    20: "grass", 30: "grass", 40: "grass", 90: "grass",   # shrubs, grass, crops, wetland plants: low green (chosen)
    50: "built", 60: "bare", 80: "water",
}

# --- 3. surface temperature --------------------------------------------------
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
SIGN = "https://planetarycomputer.microsoft.com/api/sas/v1/sign"
LST_DATES = "2024-04-01/2024-05-31"      # the season of the recorded heatwave (1-7 May 2024)
LST_MAX_CLOUD = 20                       # % of the whole scene
LST_SCALE, LST_OFFSET = 0.00341802, 149.0        # Landsat C2 L2 ST_B10 digital number -> kelvin
QA_BAD = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4)   # dilated cloud, cirrus, cloud, cloud shadow
IST_H = 5.5


def cached(name, make):
    """Read outputs/urban/<name>.json, or make it and save it."""
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.json"
    if path.exists():
        return json.loads(path.read_text())
    data = make()
    path.write_text(json.dumps(data))
    return data


def box(lat, lon, half_m):
    """(west, south, east, north) in degrees of the square of half-side half_m around the point."""
    dlat, dlon = half_m / 110540, half_m / (111320 * math.cos(math.radians(lat)))
    return lon - dlon, lat - dlat, lon + dlon, lat + dlat


def inside_circle(n, cell_m, radius_m):
    """Cells of an n x n grid (centred on the site) whose centre is inside the circle."""
    c = (n - 1) / 2
    yy, xx = np.mgrid[0:n, 0:n]
    return np.hypot(xx - c, yy - c) * cell_m <= radius_m


# ---------------------------------------------------------------------------
# 0. Tree canopy
# ---------------------------------------------------------------------------
def quadkey(lat, lon, zoom=CANOPY_ZOOM):
    """Name of the web-mercator tile that holds the point."""
    x = int((lon + 180) / 360 * 2 ** zoom)
    y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2 ** zoom)
    return "".join(str(((x >> i) & 1) + 2 * ((y >> i) & 1)) for i in range(zoom - 1, -1, -1))


def canopy_metres(lat, lon, half_m):
    """Canopy height (m) on a 1 m grid in UTM 44N for the square around the point, north at the top.
    The same square and the same projection as urban_heights.read_window, so the two line up."""
    import rasterio
    from rasterio.transform import from_origin
    from rasterio.warp import Resampling, reproject

    cx, cy = urban_heights.utm44(lat, lon)
    n = int(round(2 * half_m))
    out = np.zeros((n, n), np.float32)
    west, south, east, north = box(lat, lon, half_m)
    keys = {quadkey(la, lo) for la in (south, north) for lo in (west, east)}
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_USERAGENT=AGENT):
        for key in sorted(keys):                      # a square on a tile edge needs both tiles
            part = np.zeros((n, n), np.float32)
            with rasterio.open(CANOPY.format(quadkey=key)) as src:
                reproject(rasterio.band(src, 1), part, dst_transform=from_origin(cx - half_m, cy + half_m, 1, 1),
                          dst_crs="EPSG:32644", resampling=Resampling.nearest)
            out = np.maximum(out, part)
    return out


def canopy(lat, lon, radius_m):
    """Trees on the 4 m grid of urban_heights: share of each cell under canopy and the canopy
    height there, and the tree cover inside the circle (also for 2 m and 5 m cut-offs)."""
    def make():
        half = radius_m + urban_heights.MARGIN_M
        h = canopy_metres(lat, lon, half)
        k = int(CELL_M)
        n = h.shape[0] // k
        blocks = h[:n * k, :n * k].reshape(n, k, n, k)
        tree = blocks >= TREE_MIN_M
        count = tree.sum(axis=(1, 3))
        share = count / (k * k)
        height = np.where(count > 0, (blocks * tree).sum(axis=(1, 3)) / np.maximum(count, 1), 0.0)
        c = (h.shape[0] - 1) / 2
        yy, xx = np.mgrid[0:h.shape[0], 0:h.shape[0]]
        inside = np.hypot(xx - c, yy - c) <= radius_m
        cover = lambda cut: round(float((h[inside] >= cut).mean()), 3)
        return {"cell_m": CELL_M, "half_m": half,
                "share_pct": np.round(share * 100).astype(int).tolist(),
                "height_m": np.round(height, 1).tolist(),
                "tree_cover": cover(TREE_MIN_M), "tree_cover_2m": cover(2.0), "tree_cover_5m": cover(5.0),
                "mean_tree_height_m": round(float(h[inside & (h >= TREE_MIN_M)].mean()), 1) if (h[inside] >= TREE_MIN_M).any() else 0.0,
                "tree_min_m": TREE_MIN_M, "height_error_m": CANOPY_MAE_M}
    return cached(f"canopy_{lat:.5f}_{lon:.5f}_{int(radius_m)}", make)


# ---------------------------------------------------------------------------
# 1. Sky view factor and sun hours on the ground
# ---------------------------------------------------------------------------
def look(h, bearing_deg, dist_m):
    """The building height each cell sees dist_m away along the bearing (0 beyond the grid)."""
    di = -int(round(dist_m * math.cos(math.radians(bearing_deg)) / CELL_M))     # rows grow southwards
    dj = int(round(dist_m * math.sin(math.radians(bearing_deg)) / CELL_M))
    n, m = h.shape
    out = np.zeros_like(h)
    rows = slice(max(0, -di), min(n, n - di))
    cols = slice(max(0, -dj), min(m, m - dj))
    out[rows, cols] = h[rows.start + di:rows.stop + di, cols.start + dj:cols.stop + dj]
    return out


def horizon_tan(h, bearing_deg):
    """Tangent of the angle the buildings along one bearing rise to, seen from the ground."""
    steps = np.arange(CELL_M, LOOK_M + 0.1, CELL_M)
    return np.max([look(h, bearing_deg, d) / d for d in steps], axis=0)


def sun_positions(lat):
    """(elevation, azimuth from north) in degrees through SUN_DAY, every SUN_STEP_H of solar time."""
    decl = math.radians(23.45 * math.sin(math.radians(360 * (284 + SUN_DAY) / 365)))    # Cooper (1969)
    phi = math.radians(lat)
    out = []
    for t in np.arange(-12 + SUN_STEP_H / 2, 12, SUN_STEP_H):       # hours from solar noon
        w = math.radians(15 * t)
        elev = math.asin(math.sin(phi) * math.sin(decl) + math.cos(phi) * math.cos(decl) * math.cos(w))
        if math.degrees(elev) < SUN_MIN_ELEV:
            continue
        azim = math.degrees(math.atan2(math.sin(w), math.cos(w) * math.sin(phi) - math.tan(decl) * math.cos(phi))) + 180
        out.append((math.degrees(elev), azim % 360))
    return out


def sky_grids(h, lat, own_cover=None):
    """(sky view factor 0-1, sun hours, hours of daylight) for every cell of the obstacle height grid h.
    own_cover: share of each cell under tree canopy; that part of the cell sees no sky and no sun."""
    # sky view: 1 - mean of sin^2(horizon angle) over 16 bearings (isotropic sky, flat ground)
    sin2 = [t ** 2 / (1 + t ** 2) for t in (horizon_tan(h, b) for b in urban_heights.BEARINGS)]
    svf = 1 - np.mean(sin2, axis=0)
    sun = np.zeros_like(h)
    positions = sun_positions(lat)
    for elev, azim in positions:
        sun += (horizon_tan(h, azim) < math.tan(math.radians(elev))) * SUN_STEP_H
    if own_cover is not None:
        svf, sun = svf * (1 - own_cover), sun * (1 - own_cover)
    return svf, sun, len(positions) * SUN_STEP_H


def sky_and_sun(lat, lon, radius_m):
    """Open ground only (building cells are -1): sky view factor in % and hours of direct
    sun on 4 May, on the 4 m grid of urban_heights. Buildings and trees both block the sky
    (tree crowns taken as solid); the means with buildings alone are given beside them.
    Means are over the open ground inside the circle."""
    def make():
        share, height = urban_heights.height_grid(lat, lon, radius_m)
        h = urban_heights.solid(share, height)
        ground = h == 0
        open_in = ground & inside_circle(h.shape[0], CELL_M, radius_m)
        if not open_in.any():
            raise ValueError("No open ground inside this circle.")
        svf0, sun0, day = sky_grids(h, lat)                       # buildings alone
        try:
            trees = canopy(lat, lon, radius_m)
            cover = np.array(trees["share_pct"], np.float32) / 100 * ground
            tall = np.where(cover >= 0.5, np.array(trees["height_m"], np.float32), 0.0)     # cells that are mostly crown
            svf, sun, day = sky_grids(np.maximum(h, tall), lat, cover)
        except Exception:
            trees, svf, sun = None, svf0, sun0
        mean = lambda a: float(a[open_in].mean())
        return {
            "cell_m": CELL_M, "half_m": radius_m + urban_heights.MARGIN_M,
            "sky_view_pct": np.where(ground, np.round(svf * 100), -1).astype(int).tolist(),
            "sun_hours": np.where(ground, np.round(sun, 1), -1).tolist(),
            "mean_sky_view": round(mean(svf), 2), "mean_sun_hours": round(mean(sun), 1),
            "mean_sky_view_no_trees": round(mean(svf0), 2), "mean_sun_hours_no_trees": round(mean(sun0), 1),
            "trees": trees is not None,
            "day_hours": round(day, 1),
            "shaded_share": round(float((sun[open_in] < 0.5 * day).mean()), 2),   # open ground in sun for less than half the day
            "look_m": LOOK_M,
        }
    return cached(f"sky2_{lat:.5f}_{lon:.5f}_{int(radius_m)}", make)


# ---------------------------------------------------------------------------
# 2. Land cover
# ---------------------------------------------------------------------------
def worldcover_tile(lat, lon):
    """Name of the 3 x 3 degree WorldCover tile that holds the point, e.g. N12E078."""
    la, lo = math.floor(lat / 3) * 3, math.floor(lon / 3) * 3
    return f"{'N' if la >= 0 else 'S'}{abs(la):02d}{'E' if lo >= 0 else 'W'}{abs(lo):03d}"


def land_cover(lat, lon, radius_m):
    """WorldCover classes on their own 10 m grid (degrees), with its bounds, and the share
    of each group inside the circle."""
    def make():
        import rasterio
        from rasterio.windows import from_bounds

        half = radius_m + urban_heights.MARGIN_M
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_USERAGENT=AGENT):
            with rasterio.open(WORLDCOVER.format(tile=worldcover_tile(lat, lon))) as src:
                window = from_bounds(*box(lat, lon, half), src.transform).round_offsets().round_lengths()
                classes = src.read(1, window=window)
                west, south, east, north = src.window_bounds(window)
        rows, cols = classes.shape
        lats = north - (np.arange(rows) + 0.5) * (north - south) / rows
        lons = west + (np.arange(cols) + 0.5) * (east - west) / cols
        dy = (lats[:, None] - lat) * 110540
        dx = (lons[None, :] - lon) * 111320 * math.cos(math.radians(lat))
        inside = np.hypot(dx, dy) <= radius_m
        groups = np.vectorize(lambda c: COVER_GROUPS.get(int(c), "other"))(classes)
        shares = {g: round(float((groups[inside] == g).mean()), 3) for g in ("tree", "grass", "water", "built", "bare")}
        return {"bounds": [west, south, east, north], "classes": classes.astype(int).tolist(),
                "shares": shares, "year": WORLDCOVER_YEAR, "pixel_m": 10}
    return cached(f"cover_{lat:.5f}_{lon:.5f}_{int(radius_m)}", make)


# ---------------------------------------------------------------------------
# 3. Land surface temperature (Landsat)
# ---------------------------------------------------------------------------
def clearest_scene(bounds):
    """The Landsat 8/9 scene over the box with the least cloud in LST_DATES."""
    reply = requests.post(STAC, timeout=60, headers={"User-Agent": AGENT}, json={
        "collections": ["landsat-c2-l2"], "bbox": list(bounds), "datetime": LST_DATES, "limit": 50,
        "query": {"eo:cloud_cover": {"lt": LST_MAX_CLOUD}, "platform": {"in": ["landsat-8", "landsat-9"]}}})
    reply.raise_for_status()
    scenes = [s for s in reply.json()["features"] if "lwir11" in s["assets"]]
    if not scenes:
        raise ValueError("No clear Landsat pass over this place in April-May 2024.")
    return min(scenes, key=lambda s: s["properties"]["eo:cloud_cover"])


def signed(href):
    """A short-lived readable link to a Planetary Computer file."""
    reply = requests.get(SIGN, params={"href": href}, timeout=60, headers={"User-Agent": AGENT})
    reply.raise_for_status()
    return reply.json()["href"]


def surface_temp(lat, lon, radius_m):
    """Surface temperature (deg C, None under cloud) on Landsat's 30 m grid, the four corners
    of that grid in degrees (NW, NE, SE, SW), and the mean, lowest and highest inside the circle."""
    def make():
        import rasterio
        from rasterio.warp import transform, transform_bounds
        from rasterio.windows import from_bounds

        half = radius_m + urban_heights.MARGIN_M
        bounds = box(lat, lon, half)
        scene = clearest_scene(bounds)
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
            with rasterio.open(signed(scene["assets"]["lwir11"]["href"])) as src:
                window = from_bounds(*transform_bounds("EPSG:4326", src.crs, *bounds), src.transform).round_offsets().round_lengths()
                dn = src.read(1, window=window)
                left, bottom, right, top = src.window_bounds(window)
                crs, pixel = src.crs, abs(src.transform.a)
            with rasterio.open(signed(scene["assets"]["qa_pixel"]["href"])) as src:
                qa = src.read(1, window=window)
        temp = dn * LST_SCALE + LST_OFFSET - 273.15
        clear = (dn > 0) & ((qa & QA_BAD) == 0)
        cx, cy = transform("EPSG:4326", crs, [lon], [lat])
        rows, cols = temp.shape
        ys = top - (np.arange(rows) + 0.5) * pixel
        xs = left + (np.arange(cols) + 0.5) * pixel
        inside = (np.hypot(xs[None, :] - cx[0], ys[:, None] - cy[0]) <= radius_m) & clear
        if not inside.any():
            raise ValueError("The clearest Landsat pass has cloud over this place.")
        lons, lats = transform(crs, "EPSG:4326", [left, right, right, left], [top, top, bottom, bottom])
        when = scene["properties"]["datetime"]
        utc_h = int(when[11:13]) + int(when[14:16]) / 60
        return {
            "corners": [[lo, la] for lo, la in zip(lons, lats)],
            "temp_c": [[round(float(t), 1) if ok else None for t, ok in zip(tr, cr)] for tr, cr in zip(temp, clear)],
            "mean_c": round(float(temp[inside].mean()), 1),
            "min_c": round(float(temp[inside].min()), 1), "max_c": round(float(temp[inside].max()), 1),
            "low_c": round(float(temp[clear].min()), 1), "high_c": round(float(temp[clear].max()), 1),   # whole square, for the colour scale
            "scene": scene["id"], "date": when[:10],
            "local_time": f"{int((utc_h + IST_H) % 24):02d}:{int(round(((utc_h + IST_H) % 1) * 60)) % 60:02d}",
            "scene_cloud_pct": round(scene["properties"]["eo:cloud_cover"], 1), "pixel_m": pixel,
        }
    return cached(f"lst_{lat:.5f}_{lon:.5f}_{int(radius_m)}", make)


def read_all(lat, lon, radius_m):
    """All three layers; one that fails is left out and its reason noted."""
    out, notes = {}, []
    for key, label, reader in (("canopy", "Tree canopy", canopy),
                               ("sky", "Sky view and sun hours", sky_and_sun),
                               ("cover", "Land cover", land_cover),
                               ("surface", "Surface temperature", surface_temp)):
        try:
            out[key] = reader(lat, lon, radius_m)
        except Exception as error:
            out[key] = None
            notes.append(f"{label} not available ({str(error).splitlines()[0]}).")
    return out, notes
