"""Chennai urban atlas: one table of the city on a 100 m grid, from open data, for anyone to reuse.

    python make_chennai_atlas.py            # whole extent (about 20-40 min, needs internet)
    python make_chennai_atlas.py --rows 2   # a 4 km band through the middle, as a quick test

For every 100 m cell (UTM zone 44N, EPSG:32644):
  built_share, building_height_m, facade_to_site   Google Open Buildings 2.5D, 2023 layer
  tree_cover, tree_height_m                        Meta / WRI canopy height map, 1 m
  sky_view, sun_hours                              computed from the two above (oasis/urban_env.py)
  cover_tree ... cover_bare                        ESA WorldCover 2021, 10 m
  surface_temp_c                                   Landsat 8/9 Collection 2 Level 2, clearest pass of April-May 2024

Outputs in data/chennai_atlas/: chennai_atlas_100m.tif (one band per column), chennai_atlas_100m.csv,
atlas.json (sources, dates, settings). The methods are the ones the Neighbourhood tab uses for one
place, run over the whole city in bands. README.md in that folder explains every column.
"""
import argparse
import json
import math
import time

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject, transform

import config
from oasis import urban_env, urban_heights

OUT = config.ROOT / "data" / "chennai_atlas"
CRS = "EPSG:32644"
BOX = (80.13, 12.83, 80.34, 13.25)       # west, south, east, north: Greater Chennai Corporation and its edge
CELL = 100                                # m, the atlas cell
FINE = int(urban_heights.CELL_M)          # 4 m working grid, as in the tool
READ_M = 2.0                              # Open Buildings is read at its 2 m overview (0.5 m would be 16 x the download)
BAND_CELLS = 20                           # atlas rows worked on at a time (2 km)
HALO = int(urban_env.LOOK_M)              # m read beyond each band so sky view sees its neighbours
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
           GDAL_HTTP_USERAGENT="urban-form-research-client", GDAL_HTTP_MAX_RETRY="4", GDAL_HTTP_RETRY_DELAY="3")
COLUMNS = ["built_share", "building_height_m", "facade_to_site", "tree_cover", "tree_height_m", "sky_view", "sun_hours",
           "sky_view_no_trees", "sun_hours_no_trees", "cover_tree", "cover_low_green", "cover_water", "cover_built", "cover_bare",
           "surface_temp_c"]


def grid():
    """Left, top (m, UTM 44N) and the number of columns and rows of the 100 m grid over BOX."""
    xs, ys = transform("EPSG:4326", CRS, [BOX[0], BOX[2], BOX[0], BOX[2]], [BOX[1], BOX[1], BOX[3], BOX[3]])
    left, top = math.floor(min(xs) / CELL) * CELL, math.ceil(max(ys) / CELL) * CELL
    return left, top, math.ceil((max(xs) - left) / CELL), math.ceil((top - min(ys)) / CELL)


def blocks(a, k):
    """View of a 2D array as (rows/k, k, cols/k, k) for block statistics."""
    return a.reshape(a.shape[0] // k, k, a.shape[1] // k, k)


def read_buildings(left, top, width_m, height_m):
    """Open Buildings presence and height on a READ_M grid for the rectangle (north at the top)."""
    px = urban_heights.PIXEL_M
    step = int(READ_M / px)
    cols, rows = int(width_m / READ_M), int(height_m / READ_M)
    presence, height = np.zeros((rows, cols), np.float32), np.zeros((rows, cols), np.float32)
    for t in urban_heights.manifest():
        c0, r0 = int(round((left - t["x0"]) / px)), int(round((t["y1"] - top) / px))       # rectangle's corner in tile pixels
        a0, b0 = max(0, c0), max(0, r0)
        a1, b1 = min(t["w"], c0 + cols * step), min(t["h"], r0 + rows * step)
        a0 += (c0 - a0) % step; b0 += (r0 - b0) % step                                    # stay on the rectangle's 2 m lattice
        nc, nr = (a1 - a0) // step, (b1 - b0) // step
        if nc <= 0 or nr <= 0:
            continue
        with rasterio.open("/vsicurl/" + t["url"]) as src:
            data = src.read([2, 3], window=rasterio.windows.Window(a0, b0, nc * step, nr * step), out_shape=(2, nr, nc))
        data = np.where(data < 0, 0, data)
        oc, orow = (a0 - c0) // step, (b0 - r0) // step
        height[orow:orow + nr, oc:oc + nc] = data[0]
        presence[orow:orow + nr, oc:oc + nc] = data[1]
    return presence, height


def read_canopy(left, top, width_m, height_m, keys):
    """Canopy height (m) on a 1 m grid for the rectangle."""
    out = np.zeros((int(height_m), int(width_m)), np.float32)
    for key in keys:
        part = np.zeros_like(out)
        with rasterio.open(urban_env.CANOPY.format(quadkey=key)) as src:
            reproject(rasterio.band(src, 1), part, dst_transform=from_origin(left, top, 1, 1), dst_crs=CRS, resampling=Resampling.nearest)
        out = np.maximum(out, part)
    return out


def cell_mean(values, weights, k):
    """Weighted mean of each k x k block (NaN where the weights are all zero)."""
    w = blocks(weights, k).sum(axis=(1, 3))
    return np.where(w > 0, blocks(values * weights, k).sum(axis=(1, 3)) / np.maximum(w, 1e-9), np.nan)


def band(left, top, ncols, nrows, lat, keys):
    """All building, tree and sky columns for nrows atlas rows starting at `top`."""
    width, height = ncols * CELL + 2 * HALO, nrows * CELL + 2 * HALO
    presence, bh = read_buildings(left - HALO, top + HALO, width, height)
    k = int(FINE / READ_M)
    built = blocks((presence >= urban_heights.PRESENCE_MIN).astype(np.float32), k)
    count = built.sum(axis=(1, 3))
    share = count / (k * k)                                                    # built share of each 4 m cell
    h4 = np.where(count > 0, (blocks(bh, k) * built).sum(axis=(1, 3)) / np.maximum(count, 1), 0.0)
    solid = urban_heights.solid(share, h4)

    can = read_canopy(left - HALO, top + HALO, width, height, keys)
    tree = blocks((can >= urban_env.TREE_MIN_M).astype(np.float32), FINE)
    tcount = tree.sum(axis=(1, 3))
    tshare = tcount / FINE ** 2
    th4 = np.where(tcount > 0, (blocks(can, FINE) * tree).sum(axis=(1, 3)) / np.maximum(tcount, 1), 0.0)

    ground = (solid == 0).astype(np.float32)
    cover = tshare * ground
    svf0, sun0, _ = urban_env.sky_grids(solid, lat)
    svf, sun, _ = urban_env.sky_grids(np.maximum(solid, np.where(cover >= 0.5, th4, 0.0)), lat, cover)

    # wall area: height steps between neighbouring 4 m cells, given to the cell on their north / west side
    steps = np.zeros_like(solid)
    steps[:-1, :] += np.abs(np.diff(solid, axis=0))
    steps[:, :-1] += np.abs(np.diff(solid, axis=1))

    m = HALO // FINE                                   # drop the halo
    cut = lambda a: a[m:-m, m:-m]
    n = CELL // FINE
    share_c, h_c = cut(share), cut(h4)
    out = {
        "built_share": blocks(share_c, n).mean(axis=(1, 3)),
        "building_height_m": cell_mean(h_c, share_c, n),
        "facade_to_site": blocks(cut(steps), n).sum(axis=(1, 3)) * FINE / CELL ** 2,
        "tree_cover": blocks(cut(tshare), n).mean(axis=(1, 3)),
        "tree_height_m": cell_mean(cut(th4), cut(tshare), n),
        "sky_view": cell_mean(cut(svf), cut(ground), n), "sun_hours": cell_mean(cut(sun), cut(ground), n),
        "sky_view_no_trees": cell_mean(cut(svf0), cut(ground), n), "sun_hours_no_trees": cell_mean(cut(sun0), cut(ground), n),
    }
    return {key: v.astype(np.float32) for key, v in out.items()}


def land_cover(left, top, ncols, nrows):
    """WorldCover group shares per atlas cell."""
    classes = np.zeros((nrows * 10, ncols * 10), np.uint8)
    with rasterio.open(urban_env.WORLDCOVER.format(tile=urban_env.worldcover_tile((BOX[1] + BOX[3]) / 2, (BOX[0] + BOX[2]) / 2))) as src:
        reproject(rasterio.band(src, 1), classes, dst_transform=from_origin(left, top, 10, 10), dst_crs=CRS, resampling=Resampling.nearest)
    names = {"tree": "cover_tree", "grass": "cover_low_green", "water": "cover_water", "built": "cover_built", "bare": "cover_bare"}
    out = {}
    for group, column in names.items():
        codes = [c for c, g in urban_env.COVER_GROUPS.items() if g == group]
        out[column] = blocks(np.isin(classes, codes).astype(np.float32), 10).mean(axis=(1, 3))
    return out


def surface_temp(left, top, ncols, nrows):
    """Landsat surface temperature (deg C), mean of the clear 30 m pixels in each atlas cell; and the scene."""
    scene = urban_env.clearest_scene(BOX)
    shape, dst = (nrows, ncols), from_origin(left, top, CELL, CELL)
    with rasterio.open(urban_env.signed(scene["assets"]["lwir11"]["href"])) as src, \
         rasterio.open(urban_env.signed(scene["assets"]["qa_pixel"]["href"])) as qa_src:
        window = rasterio.windows.from_bounds(left - 300, top - nrows * CELL - 300, left + ncols * CELL + 300, top + 300, src.transform).round_offsets().round_lengths()
        dn, qa = src.read(1, window=window), qa_src.read(1, window=window)
        tr, crs = src.window_transform(window), src.crs
    temp = np.where((dn > 0) & ((qa & urban_env.QA_BAD) == 0), dn * urban_env.LST_SCALE + urban_env.LST_OFFSET - 273.15, np.nan).astype(np.float32)
    out = np.full(shape, np.nan, np.float32)
    reproject(temp, out, src_transform=tr, src_crs=crs, src_nodata=np.nan, dst_transform=dst, dst_crs=CRS, dst_nodata=np.nan, resampling=Resampling.average)
    return out, {"scene": scene["id"], "datetime_utc": scene["properties"]["datetime"], "scene_cloud_pct": scene["properties"]["eo:cloud_cover"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rows", type=int, default=0, help="only this many 2 km bands around the middle (test)")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    left, top, ncols, nrows = grid()
    lat = (BOX[1] + BOX[3]) / 2
    keys = sorted({urban_env.quadkey(la, lo) for la in (BOX[1], BOX[3]) for lo in (BOX[0], BOX[2])})
    data = {c: np.full((nrows, ncols), np.nan, np.float32) for c in COLUMNS}
    starts = list(range(0, nrows, BAND_CELLS))
    if args.rows:
        mid = len(starts) // 2
        starts = starts[mid:mid + args.rows]
    print(f"grid {ncols} x {nrows} cells of {CELL} m, {len(starts)} bands, canopy tiles {keys}", flush=True)
    with rasterio.Env(**ENV):
        for i, r0 in enumerate(starts):
            t0 = time.time()
            n = min(BAND_CELLS, nrows - r0)
            for c, v in band(left, top - r0 * CELL, ncols, n, lat, keys).items():
                data[c][r0:r0 + n] = v
            print(f"band {i + 1}/{len(starts)} rows {r0}-{r0 + n}: {time.time() - t0:.0f} s", flush=True)
        data.update(land_cover(left, top, ncols, nrows))
        data["surface_temp_c"], scene = surface_temp(left, top, ncols, nrows)

    suffix = "_test" if args.rows else ""
    profile = dict(driver="GTiff", height=nrows, width=ncols, count=len(COLUMNS), dtype="float32", crs=CRS,
                   transform=from_origin(left, top, CELL, CELL), nodata=np.nan, compress="deflate")
    with rasterio.open(OUT / f"chennai_atlas_100m{suffix}.tif", "w", **profile) as dst:
        for b, c in enumerate(COLUMNS, 1):
            dst.write(data[c], b)
            dst.set_band_description(b, c)

    rows, cols = np.mgrid[0:nrows, 0:ncols]
    x, y = left + (cols + 0.5) * CELL, top - (rows + 0.5) * CELL
    lon, la = transform(CRS, "EPSG:4326", x.ravel().tolist(), y.ravel().tolist())
    keep = ~np.isnan(data["built_share"]).ravel()
    with open(OUT / f"chennai_atlas_100m{suffix}.csv", "w", encoding="utf-8", newline="") as f:
        f.write("x_utm44n,y_utm44n,lat,lon," + ",".join(COLUMNS) + "\n")
        flat = {c: data[c].ravel() for c in COLUMNS}
        for i in np.flatnonzero(keep):
            values = ",".join("" if np.isnan(flat[c][i]) else f"{flat[c][i]:.3f}" for c in COLUMNS)
            f.write(f"{x.ravel()[i]:.0f},{y.ravel()[i]:.0f},{la[i]:.6f},{lon[i]:.6f},{values}\n")

    (OUT / f"atlas{suffix}.json").write_text(json.dumps({
        "made": time.strftime("%Y-%m-%d"), "crs": CRS, "cell_m": CELL, "box_wgs84": BOX, "left": left, "top": top, "columns": COLUMNS,
        "cells_with_data": int(keep.sum()),
        "settings": {"open_buildings_year": urban_heights.YEAR, "presence_min": urban_heights.PRESENCE_MIN, "buildings_read_at_m": READ_M,
                     "working_grid_m": FINE, "tree_min_m": urban_env.TREE_MIN_M, "look_m": urban_env.LOOK_M,
                     "sun_day_of_year": urban_env.SUN_DAY, "worldcover_year": urban_env.WORLDCOVER_YEAR},
        "landsat": scene,
        "means": {c: (None if np.all(np.isnan(data[c])) else round(float(np.nanmean(data[c])), 3)) for c in COLUMNS},
    }, indent=2))
    print("written to", OUT)


if __name__ == "__main__":
    main()
