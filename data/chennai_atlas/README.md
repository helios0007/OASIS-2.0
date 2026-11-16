# Chennai urban atlas, 100 m grid

One table of Chennai's built form, trees, sky view, land cover and surface temperature,
made from open data so that others can reuse it without repeating the downloads.
Built by `make_chennai_atlas.py` (OASIS 2.0, thesis project, IAAC 2026/27).

## Files

| File | What it is |
|---|---|
| `chennai_atlas_100m.tif` | GeoTIFF, one band per column below, 100 m cells, UTM zone 44N (EPSG:32644), no-data = NaN |
| `chennai_atlas_100m.csv` | The same cells as rows: cell centre in UTM and in latitude / longitude, then the columns |
| `atlas.json` | Date made, grid corner, settings, the Landsat scene used, and the mean of every column |

Extent: longitude 80.13 to 80.34 °E, latitude 12.83 to 13.25 °N (Greater Chennai Corporation and its edge; the east side is sea).

## Columns

| Column | Unit | Source | How it is made |
|---|---|---|---|
| `built_share` | 0-1 | Google Open Buildings 2.5D Temporal, 2023 layer | Share of the cell covered by building (pixels with building presence ≥ 0.5) |
| `building_height_m` | m | same | Mean building height over the built part of the cell (NaN where nothing is built) |
| `facade_to_site` | m²/m² | same | Wall area ÷ ground area: height steps between neighbouring 4 m cells |
| `tree_cover` | 0-1 | Meta / WRI global canopy height map, 1 m | Share of the cell under canopy 3 m or taller |
| `tree_height_m` | m | same | Mean canopy height over that tree-covered part |
| `sky_view` | 0-1 | computed | Mean sky view factor of the open ground (not roofs), buildings and trees as obstacles |
| `sun_hours` | h | computed | Mean hours of direct sun on the open ground on 4 May (12 h of daylight) |
| `sky_view_no_trees`, `sun_hours_no_trees` | | computed | The same with buildings only |
| `cover_tree`, `cover_low_green`, `cover_water`, `cover_built`, `cover_bare` | 0-1 | ESA WorldCover 2021, 10 m | Share of the cell's 10 m squares in each group (low green = shrubs, grass, crops, wetland plants) |
| `surface_temp_c` | °C | Landsat 8/9 Collection 2 Level 2, band 10 | Mean land surface temperature of the clear 30 m pixels, clearest pass of April-May 2024 (scene and time in `atlas.json`) |

## What is measured, what is estimated, what is assumed

- **Model estimates from satellite images, not surveys.** Building presence and height (Google) and canopy height (Meta / WRI) come from machine-learning models. The canopy authors report a mean height error of about 2.8 m; its images date from 2009 to 2020. Low buildings can read too low.
- **Measured by a satellite sensor.** Surface temperature is a Landsat measurement of roofs, roads and tree tops seen from above at about 10:30 local time. It is not air temperature and not the afternoon peak. Published checks of this product against ground stations give errors of roughly 2 °C in dry cool weather and up to about 6 °C in humid summer weather. The sensor resolves about 100 m.
- **Computed.** Sky view and sun hours follow from the building and tree heights on a 4 m grid: 16 directions, looking 60 m around each point, flat ground, tree crowns taken as solid.
- **Chosen settings.** A pixel is "built" at presence ≥ 0.5; "tree" means canopy ≥ 3 m; buildings are read at the dataset's 2 m overview (the Neighbourhood tab of the tool reads single places at 0.5 m, so its numbers for one place can differ slightly).
- **Not validated on the ground.** No street-level sky-view photographs or air-temperature loggers have been compared with this table yet. `tree_cover` (1 m) is the better tree figure; `cover_tree` (10 m) misses street trees and is kept for comparison.

## Sources and licences

- Google Open Buildings 2.5D Temporal: CC BY 4.0. Sirko et al. (2023), *High-resolution building and road detection from Sentinel-2*.
- Meta / World Resources Institute canopy height: CC BY 4.0. Tolan et al. (2024), *Very high resolution canopy height maps from RGB imagery using self-supervised vision transformer and convolutional decoder trained on aerial lidar*, Remote Sensing of Environment 300.
- ESA WorldCover 2021 v200: CC BY 4.0. Zanaga et al. (2022).
- Landsat Collection 2 Level 2: U.S. Geological Survey, public domain; read through the Microsoft Planetary Computer.

This table is a derived product; please credit the sources above when you use it.

## Rebuild

```
python make_chennai_atlas.py            # whole extent, about 30 minutes, needs internet
python make_chennai_atlas.py --rows 1   # a 2 km band as a quick test
```
