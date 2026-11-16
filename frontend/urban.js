// OASIS 2.0 — Neighbourhood tab (urban layer, oasis/urban.py).
// Place on the map -> urban form -> street air -> handed to the Home tab as the
// outdoor air "Site". Uses the helpers and state of app.js ($, api, esc, pad, toast, OPT, state).

let urban = { places: [], buildings: [], form: null, grid: null, around: null, site: null, radius: 250,
              env: null, layer: "heights", green: null,
              footprints: null, picked: null };      // footprints: Overture outlines in the area by id; picked: the home's building      // green: tree and grass cover as read from the satellite, in %
const uNum = id => parseFloat($(id).value);
const uSigned = v => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
const NIGHT_HOURS = [20, 21, 22, 23, 0, 1, 2, 3, 4, 5], DAY_HOURS = [10, 11, 12, 13, 14, 15, 16];
const uMean = (list, hours) => hours.reduce((sum, h) => sum + list[h], 0) / hours.length;

function setMode(mode) {
  const isUrban = mode === "urban";
  $("app").classList.toggle("urban-mode", isUrban);
  $("urban").hidden = !isUrban;
  document.querySelector("#app > .workspace:not(#urban)").hidden = isUrban;
  document.querySelectorAll(".mode").forEach(b => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  if (!isUrban && typeof result !== "undefined" && result) { renderStrip(); renderChart(); setHour(hour); }   // sized while hidden
}

function place() {
  return { name: $("u-name").value.trim() || "Site", lat: uNum("u-lat"), lon: uNum("u-lon"),
           radius_m: uNum("u-radius"), default_storeys: uNum("u-storeys") };
}

function fillPlace(p) {
  $("u-name").value = p.name; $("u-lat").value = p.lat; $("u-lon").value = p.lon;
  if (p.radius_m) $("u-radius").value = p.radius_m;
  if (p.default_storeys) $("u-storeys").value = p.default_storeys;
}

function fillForm(form) {
  $("u-coverage").value = Math.round(form.site_coverage * 100);
  $("u-height").value = form.mean_height_m;
  $("u-facade").value = form.facade_to_site;
  $("u-run").disabled = false;
}

async function readMap() {
  const btn = $("u-read");
  btn.disabled = true; btn.textContent = "Reading the place…";
  try {
    const p = place();
    const data = await api("/api/urban/map", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) });
    Object.assign(urban, { buildings: data.buildings, form: data.form, grid: data.grid, around: data.surroundings, radius: p.radius_m,
                           env: data.env, green: null });
    fillForm(data.form);
    const e = data.env || {};
    if (e.canopy || e.cover) {             // measured green replaces the typed starting values: trees from the 1 m canopy map, grass from the land cover
      urban.green = { tree: Math.round((e.canopy ? e.canopy.tree_cover : e.cover.shares.tree) * 100),
                      grass: e.cover ? Math.round(e.cover.shares.grass * 100) : uNum("u-grass") };
      $("u-trees").value = urban.green.tree; $("u-grass").value = urban.green.grass;
    }
    drawWhenLoaded();
    drawTrees();
    showEnv();
    setLayer(urban.layer);
    const f = data.form, o = data.osm_form;
    const compare = o ? ` The street map alone shows ${Math.round(o.site_coverage * 100)}% built from ${o.buildings} outlines.` : "";
    $("u-form-note").innerHTML = f.source === "satellite"
      ? `<span class="tagline measured">Satellite</span>Google Open Buildings 2.5D, 2023: ${Math.round(f.site_coverage * 100)}% of the ground is built, mean height ${f.mean_height_m} m.${compare} These are estimates from satellite images, so correct them where you know the site.`
      : `<span class="tagline mapped">Mapped</span>${f.buildings} buildings on OpenStreetMap; heights use your storeys. The map often misses buildings in Chennai, so correct the numbers where you know the site.`;
    for (const note of data.notes) toast(note, { type: "error", duration: 8000 });
  } catch (err) {
    toast("The place could not be read", { type: "error", detail: err.message, duration: 8000 });
  }
  btn.disabled = false; btn.textContent = "Read the map";
}

// Top of the colour scale: the height 98% of the built cells stay under (one tower would wash out the rest)
function topHeight(grid) {
  const built = grid.heights.flat().filter(h => h > 0).sort((a, b) => a - b);
  return built.length ? built[Math.floor(0.98 * (built.length - 1))] : 0;
}

// ---------------------------------------------------------------------------
// Map (MapLibre GL, no access key): satellite or street tiles, the city's
// buildings in 3D for context (OpenFreeMap / OpenStreetMap), and inside the
// analysis area the satellite building heights (Google Open Buildings 2.5D),
// the street-map outlines and the sight lines used for neighbour shading.
// ---------------------------------------------------------------------------
const PIXEL_SIZE = 3;                 // screen pixels per map pixel in the pixel look
let uMap = null, mapReady = false;   // mapReady: our own layers exist (isStyleLoaded is false while tiles load)
const KY = 110540, kx = lat => 111320 * Math.cos(lat * Math.PI / 180);   // m per degree, as in oasis/urban.py
const HEIGHT_COLOURS = [0, "#fde0b0", 9, "#f39c4f", 18, "#d4541f", 36, "#7a2306"];
const EMPTY = { type: "FeatureCollection", features: [] };
const isDark = () => document.documentElement.dataset.theme === "dark"
  || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
const TILES = {
  sat: { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
         attribution: "Imagery © Esri, Maxar, Earthstar Geographics", maxzoom: 19 },
};
// Ground from CARTO, used only when the server has a key (carto_key.txt): Voyager in the light theme, Dark Matter in the dark one
const cartoTiles = key => [`https://basemaps.cartocdn.com/rastertiles/${isDark() ? "dark_nolabels" : "voyager_nolabels"}/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}`];
// Isometric view: the classic game angle, with a narrow lens so that far and near buildings look the same size
const ISO = { pitch: 54.7, bearing: 45, fov: 8 }, PLAN = { pitch: 0, bearing: 0, fov: 36.87 };
const TREE_COLOUR = () => isDark() ? "#2f6b3d" : "#5fa463";
// Minimal map: a few flat colours that follow the light / dark theme
const palette = () => isDark()
  ? { ground: "#15171b", water: "#0d2230", green: "#1a2620", road: "#2b3038", major: "#3a414b", city: "#3b424c", line: "#ffffff", label: "#7d8590", halo: "#15171b" }
  : { ground: "#f3f2ef", water: "#c9dde9", green: "#dfe8d8", road: "#ffffff", major: "#e2ddd3", city: "#cfd2d6", line: "#30343a", label: "#7a7f87", halo: "#f3f2ef" };
const MAJOR_ROADS = ["motorway", "trunk", "primary", "secondary"];
// [layer, paint property, palette key]: repainted when the theme changes
const THEMED = [["ground", "background-color", "ground"], ["water", "fill-color", "water"], ["green", "fill-color", "green"],
  ["park", "fill-color", "green"], ["roads", "line-color", "road"], ["roads-major", "line-color", "major"],
  ["places", "text-color", "label"], ["places", "text-halo-color", "halo"],
  ["outlines", "line-color", "line"]];

function setView(iso) {
  const v = iso ? ISO : PLAN;
  uMap.setVerticalFieldOfView(v.fov);
  uMap.easeTo({ pitch: v.pitch, bearing: v.bearing, duration: 700 });
}
function minimalLayers() {
  const c = palette(), width = (a, b) => ["interpolate", ["exponential", 1.6], ["zoom"], 11, a, 18, b];
  return [
    { id: "ground", type: "background", paint: { "background-color": c.ground } },
    { id: "green", type: "fill", source: "city", "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["wood", "grass", "wetland"]]], paint: { "fill-color": c.green } },
    { id: "park", type: "fill", source: "city", "source-layer": "park", paint: { "fill-color": c.green } },
    { id: "water", type: "fill", source: "city", "source-layer": "water", paint: { "fill-color": c.water } },
    { id: "roads", type: "line", source: "city", "source-layer": "transportation", minzoom: 12,
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["!", ["in", ["get", "class"], ["literal", [...MAJOR_ROADS, "rail", "transit", "ferry"]]]]],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": c.road, "line-width": width(0.4, 9) } },
    { id: "roads-major", type: "line", source: "city", "source-layer": "transportation",
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "class"], ["literal", MAJOR_ROADS]]],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": c.major, "line-width": width(1, 20) } },
  ];
}
const placeLabels = () => ({ id: "places", type: "symbol", source: "city", "source-layer": "place", minzoom: 11,
  filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood", "quarter", "town", "village"]]],
  layout: { "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": 11,
            "text-letter-spacing": 0.08, "text-transform": "uppercase" },
  paint: { "text-color": palette().label, "text-halo-color": palette().halo, "text-halo-width": 1.2 } });

// Local metres around the site (x east, y north) -> [lon, lat]
const toLngLat = (x, y, lat, lon) => [lon + x / kx(lat), lat + y / KY];
function ring(lat, lon, r, n = 96) {
  const pts = Array.from({ length: n + 1 }, (_, i) => {
    const a = 2 * Math.PI * i / n;
    return toLngLat(r * Math.sin(a), r * Math.cos(a), lat, lon);
  });
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [pts] }, properties: {} };
}

function initMap() {
  if (!window.maplibregl) {
    $("u-map-empty").textContent = "The map library did not load (no internet?). The urban model still runs from the numbers on the left.";
    return;
  }
  const p = place();
  const overture = !!window.pmtiles && !!urban.overtureRelease;          // footprints for every building; without the reader, OpenStreetMap's only
  if (overture) maplibregl.addProtocol("pmtiles", new pmtiles.Protocol().tile);
  uMap = new maplibregl.Map({
    container: "u-map-canvas",
    center: [p.lon || 80.24, p.lat || 13.06], zoom: 15.6, pitch: ISO.pitch, bearing: ISO.bearing, maxPitch: 75,
    attributionControl: { compact: true },
    style: {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      light: { anchor: "map", position: [1.4, 210, 35], intensity: 0.45 },     // sun from the south-west: each wall gets its own shade
      sources: {
        ...(urban.cartoKey ? { carto: { type: "raster", tileSize: 256, tiles: cartoTiles(urban.cartoKey), maxzoom: 17,
                                        attribution: "© OpenStreetMap contributors © CARTO" } } : {}),
        sat: { type: "raster", tileSize: 256, ...TILES.sat },
        city: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
        ...(overture ? { overture: { type: "vector", attribution: "Buildings © Overture Maps Foundation (OpenStreetMap, Google, Microsoft)",
          url: `pmtiles://https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/${urban.overtureRelease}/buildings.pmtiles` } } : {}),
      },
      layers: [
        ...minimalLayers(),
        ...(urban.cartoKey ? [{ id: "carto", type: "raster", source: "carto" }] : []),
        { id: "sat", type: "raster", source: "sat", layout: { visibility: "none" } },      // covers the minimal map when on
        overture
          ? { id: "city", type: "fill-extrusion", source: "overture", "source-layer": "building", minzoom: 13,
              paint: { "fill-extrusion-color": cityColour(), "fill-extrusion-opacity": 1,
                       // few buildings carry a height: the rest stand at two storeys (assumed, context only)
                       "fill-extrusion-height": ["coalesce", ["get", "height"], ["*", 3, ["coalesce", ["get", "num_floors"], 2]]] } }
          : { id: "city", type: "fill-extrusion", source: "city", "source-layer": "building", minzoom: 13,
              paint: { "fill-extrusion-color": palette().city, "fill-extrusion-opacity": 1,
                       "fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
                       "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0] } },
        placeLabels(),
      ],
    },
  });
  uMap.on("styleimagemissing", missingImage);
  uMap.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
  uMap.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
  uMap.on("load", () => {
    for (const id of ["area", "cells", "outlines", "rays", "centre"]) uMap.addSource(id, { type: "geojson", data: EMPTY });
    uMap.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": "#ff6a1a", "fill-opacity": 0.06 } });
    uMap.addLayer({ id: "area-line", type: "line", source: "area", paint: { "line-color": "#ff6a1a", "line-width": 2, "line-dasharray": [2, 1.5] } });
    uMap.addLayer({ id: "cells", type: "fill-extrusion", source: "cells",
      paint: { "fill-extrusion-color": areaColour(),
               "fill-extrusion-height": ["get", "h"], "fill-extrusion-opacity": 1 } });
    uMap.addSource("trees", { type: "geojson", data: EMPTY });
    uMap.addLayer({ id: "trees", type: "fill-extrusion", source: "trees",
      paint: { "fill-extrusion-color": TREE_COLOUR(), "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 1.5 } });
    uMap.addLayer({ id: "outlines", type: "line", source: "outlines", paint: { "line-color": palette().line, "line-opacity": 0.55, "line-width": 1 } });
    uMap.addLayer({ id: "rays", type: "line", source: "rays", paint: { "line-color": "#00d1ff", "line-width": 2.5 } });
    uMap.addLayer({ id: "centre", type: "circle", source: "centre",
      paint: { "circle-radius": 6, "circle-color": "#ff6a1a", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
    addDetail();
    mapReady = true;
    paintArea();
    uMap.setVerticalFieldOfView(ISO.fov);
    showArea();
    if (urban.grid || urban.buildings.length) drawMap();
  });
  // Click anywhere: that is the site. The data for the old place no longer applies.
  uMap.on("click", e => {
    if (urban.grid) {                        // the place is read: a click picks a building; move the site by clicking outside the circle
      const hit = uMap.queryRenderedFeatures(e.point, { layers: ["cells"] })[0];
      if (hit?.properties.bid) return pickBuilding(hit.properties.bid);
      const pl = place(), [x, y] = toLocal([e.lngLat.lng, e.lngLat.lat], pl);
      if (Math.hypot(x, y) <= pl.radius_m) return;
    }
    $("u-lat").value = e.lngLat.lat.toFixed(5); $("u-lon").value = e.lngLat.lng.toFixed(5);
    $("u-name").value = "Site"; $("u-place").value = "";
    placeMoved();
  });
  uMap.on("mousemove", "cells", e => { uMap.getCanvas().title = `${e.features[0].properties.h} m` + (e.features[0].properties.bid ? " · click to select this building" : ""); });
  uMap.on("mouseleave", "cells", () => { uMap.getCanvas().title = ""; });
  new ResizeObserver(() => uMap.resize()).observe($("u-map"));      // the tab starts hidden

  document.querySelectorAll(".u-tool[data-layer]").forEach(b => b.addEventListener("click", () => setLayer(b.dataset.layer)));
  showEnv();
  document.querySelectorAll(".u-tool[data-base]").forEach(b => b.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".u-tool[data-base]")) other.setAttribute("aria-pressed", String(other === b));
    uMap.setLayoutProperty("sat", "visibility", b.dataset.base === "sat" ? "visible" : "none");
  }));
  // light / dark switch: the minimal map and the lines drawn on it follow
  new MutationObserver(() => {
    const c = palette();
    for (const [layer, property, key] of THEMED) if (uMap.getLayer(layer)) uMap.setPaintProperty(layer, property, c[key]);
    if (uMap.getLayer("trees")) uMap.setPaintProperty("trees", "fill-extrusion-color", TREE_COLOUR());
    uMap.setPaintProperty("city", "fill-extrusion-color", uMap.getSource("overture") ? cityColour() : c.city);
    paintCity();
    if (uMap.getLayer("trees-top")) uMap.setPaintProperty("trees-top", "fill-extrusion-color", TREE_TOP());
    if (mapReady) { paintArea(); heightsKey(); }
    if (urban.cartoKey) uMap.getSource("carto").setTiles(cartoTiles(urban.cartoKey));
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  $("u-ctx").addEventListener("click", e => {
    const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
    e.currentTarget.setAttribute("aria-pressed", String(on));
    uMap.setLayoutProperty("city", "visibility", on ? "visible" : "none");
  });
  $("u-tilt").addEventListener("click", e => {
    const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
    e.currentTarget.setAttribute("aria-pressed", String(on));
    setView(on);                            // off = flat plan, north up
  });
  // Pixel look: the same map drawn on a coarse grid (one map pixel = PIXEL_SIZE screen pixels) with hard edges
  $("u-pixel").addEventListener("click", e => {
    const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
    e.currentTarget.setAttribute("aria-pressed", String(on));
    $("u-map").classList.toggle("pixel", on);
    uMap.setPixelRatio(on ? 1 / PIXEL_SIZE : window.devicePixelRatio);
  });
}

// The analysis area and the site marker follow the Where fields
function showArea(fly) {
  if (!mapReady) return;
  const p = place();
  if (!isFinite(p.lat) || !isFinite(p.lon)) return;
  uMap.getSource("area").setData(ring(p.lat, p.lon, p.radius_m || 250));
  uMap.getSource("centre").setData({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: {} });
  if (fly) uMap.flyTo({ center: [p.lon, p.lat], zoom: p.radius_m > 350 ? 15 : 15.6, speed: 1.4 });
}

function placeMoved(fly) {
  Object.assign(urban, { buildings: [], grid: null, around: null, form: null, env: null, green: null, footprints: null, picked: null });
  if (mapReady) {
    for (const id of ["cells", "outlines", "rays"]) uMap.getSource(id).setData(EMPTY);
    setCityFilter(null);
    paintArea();
  }
  renderPick();
  setLayer("heights"); showEnv(); drawTrees();
  $("u-run").disabled = true;
  $("u-map-empty").hidden = false;
  $("u-map-key").textContent = "";
  $("u-form-note").textContent = "Read the map to fill these in from satellite building heights, or type them.";
  showArea(fly);
}

// The data read for this place, drawn on the map
function drawMap() {
  if (!mapReady) return;
  const p = place(), g = urban.grid;
  const features = [];
  const outline = b => { const pts = b.xy.map(([x, y]) => toLngLat(x, y, p.lat, p.lon)); return [pts.concat([pts[0]])]; };
  const fp = g ? overtureFootprints() : null;
  urban.footprints = fp && fp.features.length ? fp.byId : null;
  if (urban.footprints) {
    features.push(...fp.features);            // every building on its own outline, at the satellite height
  } else if (g) {
    // no footprint tiles: street-map outlines where they exist, 4 m blocks elsewhere (row 0 = north edge)
    for (const b of urban.buildings.filter(b => b.inside && b.sat_height_m))
      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: outline(b) }, properties: { h: Math.round(b.sat_height_m) } });
    const c = g.cell_m, half = g.half_m;
    (g.loose || g.heights).forEach((row, i) => row.forEach((h, j) => {
      if (h <= 0) return;
      const x0 = -half + j * c, y0 = half - i * c;
      if (Math.hypot(x0 + c / 2, y0 - c / 2) > p.radius_m) return;      // inside the analysis area only
      const sq = [[x0, y0], [x0 + c, y0], [x0 + c, y0 - c], [x0, y0 - c], [x0, y0]].map(([x, y]) => toLngLat(x, y, p.lat, p.lon));
      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [sq] }, properties: { h } });
    }));
  } else {                                   // no satellite data: street-map outlines with their heights
    for (const b of urban.buildings.filter(b => b.inside && b.height_m))
      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: outline(b) }, properties: { h: Math.round(b.height_m) } });
  }
  if (urban.picked && !urban.footprints?.has(urban.picked.id)) urban.picked = null;
  uMap.getSource("cells").setData({ type: "FeatureCollection", features });
  paintArea();
  // the same buildings must not be drawn twice: take the area's own out of the city layer
  setCityFilter(urban.footprints ? ["!", ["in", ["get", "id"], ["literal", [...urban.footprints.keys()]]]] : null);
  uMap.getSource("outlines").setData({ type: "FeatureCollection", features: urban.footprints ? [] : urban.buildings.map(b => {
    const pts = b.xy.map(([x, y]) => toLngLat(x, y, p.lat, p.lon));
    return { type: "Feature", geometry: { type: "LineString", coordinates: pts.concat([pts[0]]) }, properties: {} };
  }) });
  drawRays();
  showArea();
  renderPick();
  $("u-map-empty").hidden = true;
  heightsKey();
}

// Bring the whole analysis area into view, wait for its footprint tiles, then draw
function drawWhenLoaded() {
  if (!mapReady) return;
  const p = place(), r = p.radius_m + 30;
  uMap.fitBounds([toLngLat(-r, -r, p.lat, p.lon), toLngLat(r, r, p.lat, p.lon)],
                 { padding: 30, duration: 500, pitch: uMap.getPitch(), bearing: uMap.getBearing(), maxZoom: 17.5 });
  drawMap();                                 // at once with what is loaded
  uMap.once("idle", drawMap);                // and again when the tiles of the whole area are in
}

function heightsKey() {
  const p = place(), g = urban.grid;
  if (!g && !urban.buildings.length) { $("u-map-key").textContent = ""; return; }
  const top = g ? Math.max(6, topHeight(g)) : 0;
  const greys = AREA_GREYS(), guessed = urban.footprints ? [...urban.footprints.values()].filter(b => b.guess).length : 0;
  const scale = `<span class="nb-scale"><span>0 m</span><i style="background:linear-gradient(90deg, ${greys[1]}, ${greys[3]}, ${greys[5]})"></i><span>36+ m</span></span>`;
  $("u-map-key").innerHTML = urban.footprints
    ? `${scale} Grey: the ${p.radius_m} m analysis area, ${urban.footprints.size} buildings on their real outlines (Overture Maps) at the satellite height (Google Open Buildings 2.5D; 98 % are under ${top.toFixed(0)} m)${guessed ? `; ${guessed} outlines where the satellite shows no building stand at ${GUESS_M} m (assumed)` : ""}. Coloured: the rest of the city, for context only, mostly at an assumed two storeys. Wall and roof colours, windows and lane markings are drawn for looks and carry no data. Green: tree canopy at its measured height. <b>Click a grey building</b> to make it the home's building.`
    : g ? `${scale} Grey: satellite building heights inside the ${p.radius_m} m analysis area, on street-map outlines where they exist and as 4 m blocks elsewhere (98 % are under ${top.toFixed(0)} m).`
    : `Grey: street-map buildings with their tagged or typed heights. Coloured: the rest of the city, for context only.`;
}

// ---------------------------------------------------------------------------
// Environment layers (oasis/urban_env.py): flat pictures laid on the map.
// Sky view and sun hours are worked out from the satellite building heights;
// land cover is ESA WorldCover; ground temperature is a Landsat measurement.
// ---------------------------------------------------------------------------
const RAMPS = {
  sky: [[0, [44, 18, 84]], [0.5, [176, 68, 120]], [1, [255, 236, 170]]],          // enclosed -> open
  sun: [[0, [28, 52, 110]], [0.5, [92, 160, 190]], [0.8, [250, 214, 110]], [1, [255, 140, 40]]],   // shade -> full sun
  surface: [[0, [255, 240, 170]], [0.5, [244, 130, 50]], [1, [120, 12, 20]]],     // cooler -> hotter
};
const COVER = {      // WorldCover class -> [label, colour]
  10: ["Trees", [27, 127, 59]], 95: ["Trees", [27, 127, 59]],
  20: ["Low green", [155, 211, 107]], 30: ["Low green", [155, 211, 107]], 40: ["Low green", [155, 211, 107]], 90: ["Low green", [155, 211, 107]],
  50: ["Built", [200, 194, 188]], 60: ["Bare ground", [222, 200, 140]], 80: ["Water", [59, 143, 217]],
};
const css = ([r, g, b]) => `rgb(${r},${g},${b})`;
const gradient = ramp => `linear-gradient(90deg, ${ramp.map(([t, c]) => `${css(c)} ${t * 100}%`).join(", ")})`;
const pct = v => `${Math.round(v * 100)} %`;
const legend = (lo, ramp, hi) => `<span class="nb-scale"><span>${lo}</span><i style="background:${gradient(ramp)}"></i><span>${hi}</span></span>`;

function rampColour(ramp, t) {
  t = Math.max(0, Math.min(1, t));
  const k = Math.max(1, ramp.findIndex(([at]) => at >= t));
  const [t0, a] = ramp[k - 1], [t1, b] = ramp[k];
  const f = (t - t0) / (t1 - t0 || 1);
  return a.map((v, i) => Math.round(v + f * (b[i] - v)));
}

// A grid of values as a picture, one pixel per cell; colour(v) -> [r, g, b] or null (see-through)
function gridImage(rows, colour) {
  const canvas = document.createElement("canvas");
  canvas.height = rows.length; canvas.width = rows[0].length;
  const ctx = canvas.getContext("2d"), img = ctx.createImageData(canvas.width, canvas.height);
  rows.forEach((row, y) => row.forEach((v, x) => {
    const c = colour(v), i = 4 * (y * canvas.width + x);
    if (c) { img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255; }
  }));
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

// Corners of a picture on the map: NW, NE, SE, SW as [lon, lat]
const squareCorners = (half, lat, lon) => [[-half, half], [half, half], [half, -half], [-half, -half]].map(([x, y]) => toLngLat(x, y, lat, lon));
const boundsCorners = ([w, s, e, n]) => [[w, n], [e, n], [e, s], [w, s]];

// What each layer draws and how its key reads. Returns null when the data was not read.
function layerPicture(name) {
  const p = place(), e = urban.env || {};
  if (name === "sky" && e.sky) return {
    url: gridImage(e.sky.sky_view_pct, v => v < 0 ? null : rampColour(RAMPS.sky, v / 100)),
    corners: squareCorners(e.sky.half_m, p.lat, p.lon),
    key: `${legend("0 %", RAMPS.sky, "100 %")} Sky view factor: how much of the sky a point on the ground can see, 4 m cells. Open ground inside the circle sees ${Math.round(e.sky.mean_sky_view * 100)} % on average. Low values trap heat at night. Worked out from the satellite building heights${e.sky.trees ? ` and the tree canopy map (crowns taken as solid; buildings alone give ${Math.round(e.sky.mean_sky_view_no_trees * 100)} %)` : "; trees are not counted"}, looking ${e.sky.look_m} m around each point.` };
  if (name === "sun" && e.sky) return {
    url: gridImage(e.sky.sun_hours, v => v < 0 ? null : rampColour(RAMPS.sun, v / e.sky.day_hours)),
    corners: squareCorners(e.sky.half_m, p.lat, p.lon),
    key: `${legend("0 h", RAMPS.sun, `${e.sky.day_hours} h`)} Hours of direct sun on the ground on 4 May, 4 m cells. Open ground inside the circle gets ${e.sky.mean_sun_hours} of ${e.sky.day_hours} h on average; ${Math.round(e.sky.shaded_share * 100)} % of it is in building shade for more than half the day. Worked out from the satellite building heights${e.sky.trees ? ` and the tree canopy map (crowns taken as solid; buildings alone give ${e.sky.mean_sun_hours_no_trees} h)` : "; tree shade is not counted"}.` };
  if (name === "cover" && e.cover) {
    const seen = [...new Set(e.cover.classes.flat())].filter(c => COVER[c]);
    const labels = [...new Map(seen.map(c => COVER[c])).entries()];
    return {
      url: gridImage(e.cover.classes, v => COVER[v]?.[1] || null),
      corners: boundsCorners(e.cover.bounds),
      key: `<span class="nb-scale">${labels.map(([label, c]) => `<span><i class="sw" style="background:${css(c)}"></i>${label}</span>`).join("")}</span> Land cover, ESA WorldCover ${e.cover.year}, 10 m squares. Inside the circle: ${pct(e.cover.shares.tree)} trees, ${pct(e.cover.shares.grass)} low green, ${pct(e.cover.shares.water)} water. A 10 m square gets one label, so street trees and small gardens inside built-up squares are missed: read the green shares as a lower bound.` };
  }
  if (name === "surface" && e.surface) {
    const s = e.surface, span = Math.max(0.5, s.high_c - s.low_c);
    return {
      url: gridImage(s.temp_c, v => v === null ? null : rampColour(RAMPS.surface, (v - s.low_c) / span)),
      corners: s.corners,
      key: `${legend(`${s.low_c} °C`, RAMPS.surface, `${s.high_c} °C`)} Ground and roof surface temperature measured by Landsat on ${s.date} at ${s.local_time}, two days before the heatwave week. Inside the circle: ${s.mean_c} °C on average (${s.min_c} to ${s.max_c} °C). This is the temperature of surfaces seen from above in mid-morning, not the air and not the afternoon peak. The sensor sees about 100 m, drawn here on 30 m squares.` };
  }
  return null;
}

function setLayer(name) {
  if (!mapReady) return;
  const pic = name === "heights" ? null : layerPicture(name);
  if (!pic) name = "heights";
  urban.layer = name;
  for (const b of document.querySelectorAll(".u-tool[data-layer]")) b.setAttribute("aria-pressed", String(b.dataset.layer === name));
  for (const id of ["cells", "cells-roof"]) uMap.setLayoutProperty(id, "visibility", pic ? "none" : "visible");
  if (uMap.getLayer("env")) uMap.setLayoutProperty("env", "visibility", pic ? "visible" : "none");
  if (!pic) { heightsKey(); return; }
  if (uMap.getSource("env")) uMap.getSource("env").updateImage({ url: pic.url, coordinates: pic.corners });
  else {
    uMap.addSource("env", { type: "image", url: pic.url, coordinates: pic.corners });
    uMap.addLayer({ id: "env", type: "raster", source: "env",
      paint: { "raster-opacity": 0.82, "raster-resampling": "nearest", "raster-fade-duration": 0 } }, "outlines");
  }
  $("u-map-key").innerHTML = pic.key;
}

// Trees: one crown per 8 m square that is mostly canopy, nudged off the lattice so it reads as trees, at the measured height
function drawTrees() {
  if (!mapReady) return;
  const c = urban.env?.canopy, p = place(), features = [];
  if (c) {
    const s = c.cell_m, half = c.half_m, n = c.share_pct.length;
    const nudge = k => ((Math.sin(k * 12.9898) * 43758.5453) % 1) * 2.4;          // up to 2.4 m, the same every time
    for (let i = 0; i + 1 < n; i += 2) for (let j = 0; j + 1 < n; j += 2) {
      const cells = [[i, j], [i, j + 1], [i + 1, j], [i + 1, j + 1]];
      if (cells.reduce((sum, [a, b]) => sum + c.share_pct[a][b], 0) / 4 < 50) continue;
      const h = Math.max(3, ...cells.map(([a, b]) => c.height_m[a][b]));
      const x = -half + (j + 1) * s + nudge(i * n + j), y = half - (i + 1) * s + nudge(j * n + i + 7), r = 3.4 + Math.abs(nudge(i + j)) * 0.5;
      const pts = Array.from({ length: 13 }, (_, k) => toLngLat(x + r * Math.sin(k * Math.PI / 6), y + r * Math.cos(k * Math.PI / 6), p.lat, p.lon));
      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [pts] }, properties: { h } });
    }
  }
  uMap.getSource("trees").setData({ type: "FeatureCollection", features });
}

// Which layers can be shown, and the short list of what was read
function showEnv() {
  const e = urban.env || {};
  const have = { heights: !!(urban.grid || urban.buildings.length), sky: !!e.sky, sun: !!e.sky, cover: !!e.cover, surface: !!e.surface };
  for (const b of document.querySelectorAll(".u-tool[data-layer]")) b.disabled = !have[b.dataset.layer];
  const rows = [];
  if (e.sky) rows.push(`<li><span class="tagline modelled">Computed</span><b>Sky and sun.</b> Open ground sees ${Math.round(e.sky.mean_sky_view * 100)} % of the sky and gets ${e.sky.mean_sun_hours} of ${e.sky.day_hours} h of direct sun on 4 May. From the satellite building heights${e.sky.trees ? ` and tree canopy (buildings alone: ${Math.round(e.sky.mean_sky_view_no_trees * 100)} %, ${e.sky.mean_sun_hours_no_trees} h)` : ""}. Shown only.</li>`);
  if (e.canopy) rows.push(`<li><span class="tagline measured">Satellite</span><b>Trees.</b> ${pct(e.canopy.tree_cover)} of the circle is under canopy ${e.canopy.tree_min_m} m or taller, mean height ${e.canopy.mean_tree_height_m} m (Meta / WRI canopy map, 1 m; ${pct(e.canopy.tree_cover_2m)} at 2 m, ${pct(e.canopy.tree_cover_5m)} at 5 m; height error about ${e.canopy.height_error_m} m). Filled into tree cover above.</li>`);
  if (e.cover) rows.push(`<li><span class="tagline measured">Satellite</span><b>Green and water.</b> ${pct(e.cover.shares.tree)} trees, ${pct(e.cover.shares.grass)} low green, ${pct(e.cover.shares.water)} water (ESA WorldCover ${e.cover.year}, 10 m: a lower bound). Low green is filled into grass cover above.</li>`);
  if (e.surface) rows.push(`<li><span class="tagline measured">Measured</span><b>Ground temperature.</b> ${e.surface.mean_c} °C on average (${e.surface.min_c} to ${e.surface.max_c} °C), Landsat, ${e.surface.date} at ${e.surface.local_time}. Shown only.</li>`);
  $("u-env").innerHTML = rows.length ? rows.join("") : `<li class="muted">Read the map to see sky view, sun hours, land cover and measured ground temperature here and as map layers.</li>`;
}

// ---------------------------------------------------------------------------
// Building footprints: Overture Maps (OpenStreetMap + Google + Microsoft outlines,
// so every building has its real shape and angle). The analysis area is drawn in
// grey at the satellite heights; the rest of the city keeps its colours.
// ---------------------------------------------------------------------------
const CITY_TONES = () => isDark() ? ["#7a6552", "#526878", "#5f7358", "#7a6477", "#77704f"] : ["#ecd2b6", "#c8d9e8", "#d3e2c2", "#e8d0de", "#eee3b4"];
const cityColour = () => { const t = CITY_TONES(); return ["match", ["%", ["coalesce", ["id"], 0], 5], 0, t[0], 1, t[1], 2, t[2], 3, t[3], t[4]]; };
const AREA_GREYS = () => isDark() ? [0, "#575c64", 12, "#8d939b", 36, "#d8dce1"] : [0, "#e6e6e3", 12, "#a3a5a8", 36, "#54575b"];
const PICK_COLOUR = "#ff6a1a";
const GUESS_M = 3;                    // drawn height of an outline the satellite shows no building in (assumed: one storey)
function areaColour() {
  const ramp = ["interpolate", ["linear"], ["get", "h"], ...AREA_GREYS()];
  return urban.picked ? ["case", ["==", ["get", "bid"], urban.picked.id], PICK_COLOUR, ramp] : ramp;
}
const toLocal = ([lon, lat], p) => [(lon - p.lon) * kx(p.lat), (lat - p.lat) * KY];
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Footprints inside the analysis area with the satellite height of the 4 m cells they cover.
// Returns { features, byId } or null when the footprint tiles are not there.
function overtureFootprints() {
  if (!uMap.getSource("overture")) return null;
  const p = place(), g = urban.grid, c = g.cell_m, half = g.half_m, n = g.heights.length;
  const byId = new Map();
  for (const f of uMap.querySourceFeatures("overture", { sourceLayer: "building" })) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [];
    for (const poly of polys) {
      const ring = poly[0].map(pt => toLocal(pt, p));
      const xs = ring.map(q => q[0]), ys = ring.map(q => q[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      if (Math.hypot((x0 + x1) / 2, (y0 + y1) / 2) > p.radius_m + 40) continue;
      const id = f.properties.id || String(f.id);
      const b = byId.get(id) || { id, pieces: [], seen: new Set(), sum: 0, built: 0, cells: 0, sx: 0, sy: 0 };
      const piece = `${ring.length}:${x0.toFixed(1)}:${y0.toFixed(1)}`;      // the same piece comes back from neighbouring tiles
      if (b.seen.has(piece)) continue;
      b.seen.add(piece); b.pieces.push(poly[0]);
      for (let i = Math.max(0, Math.floor((half - y1) / c)); i <= Math.min(n - 1, Math.floor((half - y0) / c)); i++)
        for (let j = Math.max(0, Math.floor((x0 + half) / c)); j <= Math.min(n - 1, Math.floor((x1 + half) / c)); j++) {
          const x = -half + (j + 0.5) * c, y = half - (i + 0.5) * c;
          if (!inRing(x, y, ring)) continue;
          b.cells++; b.sx += x; b.sy += y;
          if (g.heights[i][j] > 0) { b.sum += g.heights[i][j]; b.built++; }
        }
      if (!b.cells && !b.ring0) b.ring0 = [(x0 + x1) / 2, (y0 + y1) / 2];
      byId.set(id, b);
    }
  }
  const features = [];
  for (const b of byId.values()) {
    [b.x, b.y] = b.cells ? [b.sx / b.cells, b.sy / b.cells] : b.ring0;
    if (Math.hypot(b.x, b.y) > p.radius_m) { byId.delete(b.id); continue; }
    b.guess = !b.built;
    b.h = b.built ? Math.round(b.sum / b.built * 10) / 10 : GUESS_M;
    b.area = Math.max(1, b.cells) * c * c;
    for (const ring of b.pieces) features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { h: b.h, bid: b.id } });
  }
  return { features, byId };
}

// A building picked on the map becomes the home's building: its neighbours give the shading, its height the floors
function pickBuilding(id) {
  urban.picked = urban.footprints?.get(id) || null;
  paintArea();
  renderPick();
}

function renderPick() {
  const b = urban.picked, box = $("u-pick");
  box.hidden = !b;
  if (!b) return;
  const storeys = Math.max(1, Math.round(b.h / (urban.floor_m || 3)));
  box.innerHTML = `<h3>Selected building</h3>
    <div class="stats">
      <div class="stat"><span>Height</span><b>${b.h}<small> m</small></b><em>${b.guess ? "assumed: the satellite shows no building here" : "satellite"}</em></div>
      <div class="stat"><span>Storeys</span><b>${storeys}</b><em>height ÷ ${urban.floor_m || 3} m (assumed)</em></div>
    </div>
    <p class="sm muted" style="margin:8px 0 0">${storeys > 1 ? "A block of flats: you choose the top or a middle floor in the Home tab." : "A single-storey house: it is assessed as a top floor, under its own roof."} Its neighbours within 60 m give the shading, its street the outdoor air.</p>
    <button type="button" class="btn btn-primary u-wide" id="u-assess">Assess a home in this building</button>`;
  $("u-assess").addEventListener("click", async () => {
    const btn = $("u-assess");
    btn.disabled = true; btn.textContent = "Reading this building's surroundings…";
    if (await runUrban()) useInHome();
    else { btn.disabled = false; btn.textContent = "Assess a home in this building"; }
  });
}

// Sight lines to the neighbours: from the picked building (after a run for it) or from the site centre
function drawRays() {
  if (!mapReady) return;
  const p = place(), b = urban.site?.building, mine = b && urban.picked && Math.abs(b.x_m - urban.picked.x) < 0.1 && Math.abs(b.y_m - urban.picked.y) < 0.1;
  const rays = (mine ? urban.site.surroundings?.rays : urban.picked ? [] : urban.around?.rays) || [];
  const [ox, oy] = mine ? [b.x_m, b.y_m] : [0, 0];
  uMap.getSource("rays").setData({ type: "FeatureCollection", features: rays.filter(r => r.gap_m !== null && r.gap_m <= 30).map(r => {
    const a = r.bearing * Math.PI / 180, e = r.edge_m || 0;
    return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [
      toLngLat(ox + Math.sin(a) * e, oy + Math.cos(a) * e, p.lat, p.lon),
      toLngLat(ox + Math.sin(a) * (e + r.gap_m), oy + Math.cos(a) * (e + r.gap_m), p.lat, p.lon)] } };
  }) });
}

// ---------------------------------------------------------------------------
// Drawn detail (decoration only, nothing here is data): painted walls with rows
// of windows, roofs in their own colours, lighter tree tops, lane dashes.
// Wall and roof colours are dealt out by building number, they mean nothing.
// ---------------------------------------------------------------------------
const WALL_TONES = [[243, 217, 177], [246, 184, 154], [242, 167, 181], [169, 211, 238], [183, 224, 192], [247, 224, 138], [205, 184, 232]];
const ROOF_TONES = [[201, 105, 75], [217, 212, 199], [143, 183, 201], [233, 228, 214], [176, 132, 94]];
const GREY_WALLS = { g0: [226, 226, 222], g1: [176, 178, 181], g2: [120, 124, 130], pick: [255, 122, 40] };
const dim = rgb => rgb.map(v => Math.round(v * (isDark() ? 0.8 : 1)));
const themeTag = () => isDark() ? "d" : "l";
const tone = n => ["%", ["coalesce", ["id"], 0], n];

// One storey of wall, 3 m tall, two windows: 20 x 10 picture that repeats along and up the wall
function wallPicture(rgb) {
  const w = 20, h = 10, data = new Uint8ClampedArray(w * h * 4);
  const glass = isDark() ? [250, 214, 120] : [70, 92, 118], frame = rgb.map(v => Math.min(255, v + 22)), band = rgb.map(v => Math.round(v * 0.82));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const win = y >= 3 && y <= 7 && ((x >= 3 && x <= 7) || (x >= 12 && x <= 16));
    const edge = win && (y === 3 || x === 3 || x === 12);
    const c = y === 0 ? band : edge ? frame : win ? glass : rgb;
    data.set([c[0], c[1], c[2], 255], 4 * (y * w + x));
  }
  return { width: w, height: h, data };
}

// Pictures are made when the map first asks for them: "wall-<theme>-<name>"
function missingImage(e) {
  const [kind, , name] = e.id.split("-");
  if (kind !== "wall" || uMap.hasImage(e.id)) return;
  const rgb = GREY_WALLS[name] || WALL_TONES[+name];
  if (rgb) uMap.addImage(e.id, wallPicture(dim(rgb)));
}
const wallName = name => `wall-${themeTag()}-${name}`;
const cityWalls = () => ["match", tone(WALL_TONES.length), ...WALL_TONES.flatMap((_, i) => [i, wallName(i)]).slice(0, -2), wallName(WALL_TONES.length - 1)];
const cityRoofs = () => { const t = ROOF_TONES.map(c => css(dim(c))); return ["match", tone(ROOF_TONES.length), 0, t[0], 1, t[1], 2, t[2], 3, t[3], t[4]]; };
function areaWalls() {
  const byHeight = ["step", ["get", "h"], wallName("g0"), 9, wallName("g1"), 18, wallName("g2")];
  return urban.picked ? ["case", ["==", ["get", "bid"], urban.picked.id], wallName("pick"), byHeight] : byHeight;
}

// Walls and roofs of the analysis area (grey, the picked building orange)
function paintArea() {
  if (!mapReady) return;
  uMap.setPaintProperty("cells", "fill-extrusion-color", areaColour());
  uMap.setPaintProperty("cells", "fill-extrusion-pattern", areaWalls());
  uMap.setPaintProperty("cells-roof", "fill-extrusion-color", areaColour());
}
// Walls and roofs of the rest of the city (colourful)
function paintCity() {
  if (!uMap.getSource("overture")) return;
  uMap.setPaintProperty("city", "fill-extrusion-pattern", cityWalls());
  if (uMap.getLayer("city-roof")) uMap.setPaintProperty("city-roof", "fill-extrusion-color", cityRoofs());
}
function setCityFilter(filter) {
  uMap.setFilter("city", filter);
  if (uMap.getLayer("city-roof")) uMap.setFilter("city-roof", filter);
}

// Added once the map is up: roofs as thin caps on the walls, tree tops, lane dashes
function addDetail() {
  const cityHeight = ["coalesce", ["get", "height"], ["*", 3, ["coalesce", ["get", "num_floors"], 2]]];
  if (uMap.getSource("overture")) {
    uMap.addLayer({ id: "city-roof", type: "fill-extrusion", source: "overture", "source-layer": "building", minzoom: 13,
      paint: { "fill-extrusion-color": cityRoofs(), "fill-extrusion-base": cityHeight, "fill-extrusion-height": ["+", cityHeight, 0.5],
               "fill-extrusion-vertical-gradient": false } }, "places");
    paintCity();
  }
  uMap.addLayer({ id: "cells-roof", type: "fill-extrusion", source: "cells",
    paint: { "fill-extrusion-color": areaColour(), "fill-extrusion-base": ["get", "h"], "fill-extrusion-height": ["+", ["get", "h"], 0.5],
             "fill-extrusion-vertical-gradient": false } }, "outlines");
  uMap.addLayer({ id: "trees-top", type: "fill-extrusion", source: "trees",
    paint: { "fill-extrusion-color": TREE_TOP(), "fill-extrusion-base": ["get", "h"], "fill-extrusion-height": ["+", ["get", "h"], 1.4],
             "fill-extrusion-vertical-gradient": false } });
  uMap.addLayer({ id: "road-dash", type: "line", source: "city", "source-layer": "transportation", minzoom: 15,
    filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "class"], ["literal", MAJOR_ROADS]]],
    paint: { "line-color": "#ffffff", "line-opacity": 0.75, "line-width": ["interpolate", ["linear"], ["zoom"], 15, 0.6, 19, 2.4], "line-dasharray": [5, 5] } }, "city");
}
const TREE_TOP = () => isDark() ? "#4f9a5c" : "#8fce86";

async function runUrban() {
  const btn = $("u-run");
  btn.disabled = true; btn.textContent = "Running the urban model…";
  try {
    const body = { ...place(), site_coverage: uNum("u-coverage") / 100, mean_height_m: uNum("u-height"),
                   facade_to_site: uNum("u-facade"), tree_cover: uNum("u-trees") / 100, grass_cover: uNum("u-grass") / 100,
                   buildings: urban.form?.buildings ?? null, height_tagged_share: urban.form?.height_tagged_share ?? 0 };
    const f = urban.form;      // the form counts as read from the data only while the three numbers are untouched
    body.source = f && Math.round(f.site_coverage * 100) === uNum("u-coverage") && f.mean_height_m === uNum("u-height") && f.facade_to_site === uNum("u-facade")
      ? (f.source || "map") : "typed";
    const g = urban.green;     // the same for the green: satellite only while untouched
    body.green_source = g && g.tree === uNum("u-trees") && g.grass === uNum("u-grass") ? "satellite" : "typed";
    if (urban.picked) Object.assign(body, { focus_x_m: Math.round(urban.picked.x * 10) / 10, focus_y_m: Math.round(urban.picked.y * 10) / 10,
                                            building_height_m: Math.max(2, urban.picked.h) });
    const data = await api("/api/urban/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    urban.site = data.site;
    setSiteWeather(data.weather);
    renderUrban();
    drawRays();
    btn.disabled = false; btn.textContent = "Run urban model";
    return true;
  } catch (err) {
    toast("The urban model did not run", { type: "error", detail: err.message, duration: 8000 });
  }
  btn.disabled = false; btn.textContent = "Run urban model";
}

// Put the "Site" case among the Home tab's outdoor-air choices
function setSiteWeather(weather) {
  OPT.scenario.weathers = OPT.scenario.weathers.filter(w => w.key !== "site").concat(weather);
  const control = document.querySelector('#ctl-scenario .control[data-key="weather"]');
  if (control) control.outerHTML = controlHtml(["weather", "seg"]);
  syncForm();
}

function useInHome() {
  state.weather = "site";
  const b = urban.site?.building;
  if (b) {                                   // a picked building: a one-storey house sits under its own roof; flats leave the floor to the user
    if (b.storeys <= 1) state.floor = "top";
    toast(b.storeys <= 1 ? `Single-storey house, ${b.height_m} m: assessed under its own roof`
                         : `Building of about ${b.storeys} storeys (${b.height_m} m): choose Top floor or Middle floor under Geometry`, { duration: 9000 });
  }
  syncForm();
  setMode("home");
  simulate();
}

function deltaBars(delta) {
  const W = 340, H = 130, L = 30, T = 8, B = 20, plotW = W - L - 6, plotH = H - T - B;
  const span = Math.max(1, Math.ceil(Math.max(...delta.map(Math.abs)) * 2) / 2);
  const y = v => T + plotH / 2 - v / span * plotH / 2, bw = plotW / 24;
  const bars = delta.map((v, h) => `<rect x="${(L + h * bw + 1).toFixed(1)}" y="${Math.min(y(v), y(0)).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Math.max(1, Math.abs(y(v) - y(0))).toFixed(1)}" fill="${v >= 0 ? "var(--heat)" : "var(--gain)"}"><title>${pad(h)}:00 ${uSigned(v)} °C</title></rect>`).join("");
  const ticks = [span, 0, -span].map(v => `<text x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end">${uSigned(v)}</text><line x1="${L}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}" stroke="var(--border)"/>`).join("");
  const hours = [0, 6, 12, 18].map(h => `<text x="${L + h * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${pad(h)}:00</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Street air minus airport air for each hour of the day"><g font-family="var(--mono)" font-size="9.5" fill="var(--muted-fg)">${ticks}${hours}</g>${bars}</svg>`;
}

function renderUrban() {
  const s = urban.site;
  if (!s) return;
  const measured = OPT.evidence?.city?.profile_24h?.heatwave_week?.d_temp_c;
  const check = measured ? `<div class="u-warn"><b>Measured check.</b> At the Nungambakkam station, in the same week, the air was ${uSigned(uMean(measured, NIGHT_HOURS))} °C against the airport at night and ${uSigned(uMean(measured, DAY_HOURS))} °C by day: cooler, because of the sea breeze. The urban model has no sea breeze, so near the coast it can point the wrong way. Where a station exists, trust "City centre" (measured) over "Site" (modelled).</div>` : "";
  $("u-result").innerHTML = `
    <div><h3>${esc(s.name)} · street air minus airport air</h3>
      <div class="stats">
        <div class="stat"><span>Night, 20:00–06:00</span><b>${uSigned(s.night_c)}<small> °C</small></b></div>
        <div class="stat"><span>Day, 10:00–17:00</span><b>${uSigned(s.day_c)}<small> °C</small></b></div>
        <div class="stat"><span>Largest</span><b>${uSigned(s.max_c)}<small> °C</small></b><em>around ${pad(s.max_hour)}:00</em></div>
        <div class="stat"><span>Urban form</span><b>${Math.round(s.form.site_coverage * 100)}<small> % built</small></b><em>${s.form.mean_height_m} m mean height</em></div>
      </div></div>
    <div class="u-bars"><h3>By hour of the day, 1–7 May 2024</h3>${deltaBars(s.d_temp_c)}</div>
    ${check}
    <button type="button" class="btn btn-primary u-wide" id="u-use" style="margin-top:0">Use this place in the Home tab</button>
    ${neighbourHtml(s)}
    <div><h3>What this rests on</h3>
      <ul class="u-list">${s.assumptions.map(a => `<li><span class="tagline ${a.status === "Mapped" || a.status === "Satellite" ? "mapped" : a.status === "Assumed" ? "assumed" : "chosen"}">${esc(a.status)}</span>${esc(a.text)}</li>`).join("")}</ul></div>`;
  $("u-use").addEventListener("click", useInHome);
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
function neighbourHtml(s) {
  const near = (s.surroundings?.rays || []).filter(r => r.gap_m !== null && r.gap_m <= 30);
  const rough = s.roughness;
  const own = s.surroundings ? (s.surroundings.own_height_m ? `The building at the centre is ${s.surroundings.own_height_m} m tall.` : `The centre is open ground, so the home is taken as ${s.default_storeys} storeys.`) : "";
  const list = !s.surroundings ? "No satellite heights for this place, so no neighbour shading is passed on."
    : near.length ? `${own} Nearest buildings: ${near.filter((r, i) => i % 2 === 0 || near.length <= 8).map(r => `${COMPASS[Math.round(r.bearing / 22.5) % 16]} ${r.gap_m} m away, ${r.height_m} m tall`).join("; ")}.`
    : `${own} No building within 30 m of the centre.`;
  return `<div><h3>Also handed to the Home tab</h3>
    <ul class="u-list"><li><span class="tagline measured">Satellite</span><b>Neighbour shading.</b> ${esc(list)}</li>
    ${rough ? `<li><span class="tagline chosen">Not passed on</span><b>Wind.</b> At roof level about ${Math.round(rough.roof_wind_ratio * 100)}% of the airport wind (roughness length ${rough.roughness_m} m, Macdonald 1998). The measured city station had 70%. The home model's airflow is already fitted to homes in dense streets, so this is shown for information only.</li>` : ""}</ul></div>`;
}

async function startUrban() {
  document.querySelectorAll(".mode").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));
  setMode("urban");                          // the neighbourhood comes first; its air and shading feed the home
  for (const id of ["u-lat", "u-lon"]) $(id).addEventListener("change", () => { $("u-place").value = ""; placeMoved(true); });
  $("u-radius").addEventListener("change", () => placeMoved());
  $("u-read").addEventListener("click", readMap);
  $("u-run").addEventListener("click", runUrban);
  $("u-form").addEventListener("submit", e => e.preventDefault());
  for (const id of ["u-coverage", "u-height", "u-facade"]) $(id).addEventListener("input", () => {
    $("u-run").disabled = !(uNum("u-coverage") && uNum("u-height") && uNum("u-facade"));
  });
  try {
    const data = await api("/api/urban");
    urban.places = data.places;
    urban.cartoKey = data.carto_key || null;
    urban.overtureRelease = data.overture_release;
    urban.floor_m = data.floor_m;
    $("u-place").innerHTML = data.places.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
    $("u-place").addEventListener("change", e => { fillPlace(urban.places[+e.target.value]); placeMoved(true); });
    if (data.site) {                       // a neighbourhood saved earlier: show it again
      urban.site = data.site;
      fillPlace(data.site);
      const preset = data.places.findIndex(p => p.lat === data.site.lat && p.lon === data.site.lon);
      $("u-place").value = preset >= 0 ? preset : "";      // no preset shown for a typed-in place
      fillForm(data.site.form);
      $("u-trees").value = Math.round(data.site.tree_cover * 100);
      $("u-grass").value = Math.round(data.site.grass_cover * 100);
      const wait = setInterval(() => { if (OPT) { clearInterval(wait); renderUrban(); } }, 200);
    } else fillPlace(data.places[0]);
  } catch (err) { /* the Home tab already reports an unreachable server */ }
  initMap();
}

startUrban();
