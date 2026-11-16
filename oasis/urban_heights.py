"""Building heights around a place, from Google Open Buildings 2.5D Temporal
(Sirko et al. 2023; satellite-derived, 2023 layer, 0.5 m rasters with about 4 m
real detail). Only the window around the site is read from the public
cloud-optimised GeoTIFFs; nothing else is downloaded.

Gives the urban layer three things the street map cannot:
    form          site coverage, mean height, facade-to-site ratio (for UWG)
    obstructions  for 16 compass bearings from the site: gap to the next
                  building and its height (neighbour shading in the home model)
    roughness     Macdonald et al. (1998) displacement height and roughness
                  length from the form (reported, not passed to the home model)

Heights are model estimates from satellite images, not surveyed.
"""
import json
import math

import numpy as np
import requests

import config

OUT = config.OUT / "urban"
BUCKET = "https://storage.googleapis.com/open-buildings-temporal-data/v1/"
MANIFEST = "manifests/3b_EPSG_32644_2023_06_30.json"   # the S2 cell and UTM zone (44N) that hold Chennai
YEAR = 2023
PIXEL_M = 0.5
CELL_M = 4.0              # working grid: the dataset's real level of detail
PRESENCE_MIN = 0.5        # a pixel counts as built at or above this model confidence (chosen)
MARGIN_M = 60.0           # read this far beyond the circle, for the obstruction rays
RAY_M = 60.0              # look this far for a neighbour
RAY_STEP_M = 2.0
BEARINGS = [i * 22.5 for i in range(16)]


def utm44(lat, lon):
    """WGS84 -> UTM zone 44N (EPSG:32644), metres."""
    from rasterio.warp import transform
    x, y = transform("EPSG:4326", "EPSG:32644", [lon], [lat])
    return x[0], y[0]


def manifest():
    """Tile list of the 2023 layer (cached)."""
    OUT.mkdir(parents=True, exist_ok=True)
    cache = OUT / f"open_buildings_manifest_{YEAR}.json"
    if not cache.exists():
        reply = requests.get(BUCKET + MANIFEST, timeout=120, headers={"User-Agent": "urban-form-research-client"})
        reply.raise_for_status()
        cache.write_text(reply.text)
    m = json.loads(cache.read_text())
    prefix = m["uriPrefix"].replace("gs://open-buildings-temporal-data/v1/", "")
    return [{"url": BUCKET + prefix + s["uris"][0], "x0": s["affineTransform"]["translateX"],
             "y1": s["affineTransform"]["translateY"], "w": s["dimensions"]["width"], "h": s["dimensions"]["height"]}
            for t in m["tilesets"] for s in t["sources"]]


def read_window(lat, lon, half_m):
    """Presence and height (0.5 m pixels) for the square of half-side half_m around the point.
    Returns (presence, height) arrays, north at the top; pixels no tile covers stay 0."""
    import rasterio
    from rasterio.windows import Window

    cx, cy = utm44(lat, lon)
    n = int(round(2 * half_m / PIXEL_M))
    left, top = cx - half_m, cy + half_m
    presence, height = np.zeros((n, n), np.float32), np.zeros((n, n), np.float32)
    found = False
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
                      GDAL_HTTP_USERAGENT="urban-form-research-client"):
        for t in manifest():
            # overlap of the wanted square with this tile, in tile pixels
            c0 = max(0, int(round((left - t["x0"]) / PIXEL_M)))
            r0 = max(0, int(round((t["y1"] - top) / PIXEL_M)))
            c1 = min(t["w"], int(round((left - t["x0"]) / PIXEL_M)) + n)
            r1 = min(t["h"], int(round((t["y1"] - top) / PIXEL_M)) + n)
            if c1 <= c0 or r1 <= r0:
                continue
            with rasterio.open("/vsicurl/" + t["url"]) as src:
                data = src.read([2, 3], window=Window(c0, r0, c1 - c0, r1 - r0))   # height, presence
            oc = c0 - int(round((left - t["x0"]) / PIXEL_M))
            orow = r0 - int(round((t["y1"] - top) / PIXEL_M))
            data = np.where(data < 0, 0, data)                                      # -99 = no data
            height[orow:orow + data.shape[1], oc:oc + data.shape[2]] = data[0]
            presence[orow:orow + data.shape[1], oc:oc + data.shape[2]] = data[1]
            found = True
    if not found:
        raise ValueError("The building-height data has no tile for this place.")
    return presence, height


def height_grid(lat, lon, radius_m):
    """4 m grid around the site: built share of each cell and its mean building height (m).
    Cached per place. Returns (built_share, height), square arrays, north at the top."""
    half = radius_m + MARGIN_M
    cache = OUT / f"heights_{lat:.5f}_{lon:.5f}_{int(radius_m)}.npz"
    if cache.exists():
        z = np.load(cache)
        return z["share"], z["height"]
    presence, height = read_window(lat, lon, half)
    k = int(CELL_M / PIXEL_M)
    n = presence.shape[0] // k
    built = (presence[:n * k, :n * k] >= PRESENCE_MIN).reshape(n, k, n, k)
    h = height[:n * k, :n * k].reshape(n, k, n, k)
    count = built.sum(axis=(1, 3))
    share = count / (k * k)
    mean_h = np.where(count > 0, (h * built).sum(axis=(1, 3)) / np.maximum(count, 1), 0.0)
    np.savez_compressed(cache, share=share.astype(np.float32), height=mean_h.astype(np.float32))
    return share.astype(np.float32), mean_h.astype(np.float32)


def solid(share, height):
    """Height of each cell that is mostly building, 0 elsewhere."""
    return np.where(share >= 0.5, height, 0.0)


def form(share, height, radius_m):
    """Urban form inside the circle (same keys as urban.morphology)."""
    n = share.shape[0]
    c = (n - 1) / 2
    yy, xx = np.mgrid[0:n, 0:n]
    inside = np.hypot(xx - c, yy - c) * CELL_M <= radius_m
    cells = int(inside.sum())
    built_area = float(share[inside].sum())
    if built_area < 1:
        raise ValueError("The satellite data shows no buildings inside this circle.")
    h = solid(share, height)
    # wall area = height steps between neighbouring cells (shared walls drop out by themselves)
    steps = (np.abs(np.diff(h, axis=0)) * (inside[1:, :] & inside[:-1, :])).sum() \
          + (np.abs(np.diff(h, axis=1)) * (inside[:, 1:] & inside[:, :-1])).sum()
    return {
        "source": "satellite",
        "site_area_m2": round(cells * CELL_M ** 2),
        "site_coverage": round(built_area / cells, 3),
        "mean_height_m": round(float((share * height)[inside].sum() / built_area), 1),
        "facade_to_site": round(float(steps) * CELL_M / (cells * CELL_M ** 2), 3),
        "height_tagged_share": 1.0,
    }


def obstructions(share, height, x_m=0.0, y_m=0.0):
    """What stands around a point (x_m east, y_m north of the site centre; the centre by
    default). For each of 16 bearings (degrees clockwise from north): gap_m to the next
    building beyond the point's own, its height_m (None if nothing within RAY_M) and
    edge_m, the distance from the point to its own building's edge. Also the height of
    the building at the point, if any."""
    h = solid(share, height)
    n = h.shape[0]
    c = (n - 1) / 2

    def at(s, b):
        i = int(round(c - (y_m + s * math.cos(math.radians(b))) / CELL_M))
        j = int(round(c + (x_m + s * math.sin(math.radians(b))) / CELL_M))
        return h[i, j] if 0 <= i < n and 0 <= j < n else 0.0        # beyond the grid: nothing known
    own = float(at(0, 0))                                    # 0 = the centre is open ground
    rays = []
    for b in BEARINGS:
        s = 0.0
        while own > 0 and s <= RAY_M and at(s, b) > 0:      # leave the site's own building
            s += RAY_STEP_M
        edge = s
        while s <= RAY_M and at(s, b) == 0:                  # cross the open ground
            s += RAY_STEP_M
        if s > RAY_M:
            rays.append({"bearing": b, "gap_m": None, "height_m": None, "edge_m": round(edge, 1)})
            continue
        ahead = [at(s + d, b) for d in np.arange(0, 12, RAY_STEP_M) if s + d <= RAY_M]
        rays.append({"bearing": b, "gap_m": round(max(s - edge, RAY_STEP_M), 1), "height_m": round(float(max(ahead)), 1),
                     "edge_m": round(edge, 1)})
    return {"own_height_m": round(own, 1) if own > 0 else None, "rays": rays}


def on_footprints(buildings, share, height):
    """For the drawing: the satellite height of each street-map building (mean of the
    built cells inside its outline, None if it has none), and the built cells that no
    outline covers (the street map misses many buildings). buildings: urban.fetch_buildings."""
    from matplotlib.path import Path

    h = solid(share, height)
    n = h.shape[0]
    half = n * CELL_M / 2
    xs = -half + (np.arange(n) + 0.5) * CELL_M           # cell centres, x east
    ys = half - (np.arange(n) + 0.5) * CELL_M            # row 0 = north edge
    loose, heights = h.copy(), []
    for b in buildings:
        xy = np.asarray(b["xy"], float)
        cols = np.where((xs >= xy[:, 0].min()) & (xs <= xy[:, 0].max()))[0]
        rows = np.where((ys >= xy[:, 1].min()) & (ys <= xy[:, 1].max()))[0]
        if not len(cols) or not len(rows):
            heights.append(None)
            continue
        X, Y = np.meshgrid(xs[cols], ys[rows])
        inside = Path(xy).contains_points(np.column_stack([X.ravel(), Y.ravel()])).reshape(X.shape)
        block = h[np.ix_(rows, cols)]
        built = inside & (block > 0)
        heights.append(round(float(block[built].mean()), 1) if built.any() else None)
        loose[np.ix_(rows, cols)] = np.where(inside, 0.0, loose[np.ix_(rows, cols)])
    return heights, loose


def roughness(f):
    """Macdonald, Griffiths & Hall (1998): displacement height d and roughness length z0
    from the built share (lambda_p) and the frontal area share (lambda_f, taken as a
    quarter of the facade ratio: walls face four ways). Also the wind at 2 m above the
    mean roof as a share of the airport's 10 m wind (log law, open-country z0 0.03 m,
    matched at 200 m). Reported only: the home model's airflow is already calibrated."""
    H, lp, lf = f["mean_height_m"], f["site_coverage"], f["facade_to_site"] / 4
    d = H * (1 + 4.43 ** (-lp) * (lp - 1))
    z0 = H * (1 - d / H) * math.exp(-(0.5 * 1.2 / 0.4 ** 2 * (1 - d / H) * lf) ** -0.5)
    z = H + 2
    ratio = (math.log(200 / 0.03) / math.log(10 / 0.03)) * math.log((z - d) / z0) / math.log((200 - d) / z0)
    return {"displacement_m": round(d, 1), "roughness_m": round(z0, 2), "roof_wind_ratio": round(ratio, 2)}
