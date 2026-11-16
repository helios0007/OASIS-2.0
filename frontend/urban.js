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
           radius_m: uNum("u-radius"), default_storeys: uNum("u-storeys"), zone: urban.zone || null };
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
                           env: data.env, green: null, exposure: null, exposureKey: null });
    renderExposure();
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
const PIXEL_SIZE = 2;                 // screen pixels per map pixel in the pixel look (crisp 16-bit SimCity grid)
let uMap = null, mapReady = false;   // mapReady: our own layers exist (isStyleLoaded is false while tiles load)
const KY = 110540, kx = lat => 111320 * Math.cos(lat * Math.PI / 180);   // m per degree, as in oasis/urban.py
const HEIGHT_COLOURS = [0, "#fde0b0", 9, "#f39c4f", 18, "#d4541f", 36, "#7a2306"];
const EMPTY = { type: "FeatureCollection", features: [] };
const appDark = () => document.documentElement.dataset.theme === "dark"
  || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
// The map's own colours. With the Pixel look on, our map is drawn in its bright palette whatever the
// workspace theme, so its 3D and top views sit beside the painted map (sand ground, blue water, coloured roofs).
const pixelLook = () => $("u-pixel")?.getAttribute("aria-pressed") === "true";
const isDark = () => appDark() && !pixelLook();
const TILES = {
  sat: { tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
         attribution: "Imagery © Esri, Maxar, Earthstar Geographics", maxzoom: 19 },
};
// Ground from CARTO, used only when the server has a key (carto_key.txt): Voyager in the light theme, Dark Matter in the dark one
const cartoTiles = key => [`https://basemaps.cartocdn.com/rastertiles/${isDark() ? "dark_nolabels" : "voyager_nolabels"}/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}`];
// Isometric view: the classic game angle, with a narrow lens so that far and near buildings look the same size
const ISO = { pitch: 54.7, bearing: 45, fov: 8 }, PLAN = { pitch: 0, bearing: 0, fov: 36.87 };
const TREE_COLOUR = () => isDark() ? "#255e34" : "#4b9352";
// Minimal / Pixel Chennai map palette: SimCity 2000 warm sandstone ground, Bay of Bengal blues, and dark road kerbs
const palette = () => isDark()
  ? { ground: "#17191e", water: "#0c283d", green: "#182b20", sand: "#3d3522", road: "#2b303a", roadCase: "#101216", major: "#3d4552", rail: "#58606e", city: "#3b424c", line: "#ffffff", label: "#cbd5e1", halo: "#111318" }
  : { ground: "#ede6d6", water: "#4898c8", green: "#8cc47e", sand: "#f2dba0", road: "#aeaaa2", roadCase: "#8d8980", major: "#96928b", rail: "#7a7267", city: "#cfd2d6", line: "#2b2d30", label: "#2b2d32", halo: "#faf6ec" };
const AREA_GROUND = () => isDark() ? "#1c1f26" : "#e9e7e0";     // the veil under the analysis area's buildings
const MAJOR_ROADS = ["motorway", "trunk", "primary", "secondary"];
// [layer, paint property, palette key]: repainted when the theme changes
const THEMED = [["ground", "background-color", "ground"], ["water", "fill-color", "water"], ["green", "fill-color", "green"],
  ["park", "fill-color", "green"], ["sand", "fill-color", "sand"], ["roads-case", "line-color", "roadCase"],
  ["roads-major-case", "line-color", "roadCase"], ["roads", "line-color", "road"], ["roads-major", "line-color", "major"],
  ["rail-line", "line-color", "rail"], ["places", "text-color", "label"], ["places", "text-halo-color", "halo"],
  ["outlines", "line-color", "line"]];

// Bilingual English + Tamil landmarks across Greater Chennai (exact pixelchennai.com repertoire)
let tamilLabels = true; // show both English + Tamil by default, toggleable
const CHENNAI_LANDMARKS = {
  type: "FeatureCollection",
  features: [
    // TNUHDB / PMAY Housing Study Sites
    { type: "Feature", properties: { en: "Kannagi Nagar TNUHDB", ta: "கண்ணகி நகர்", name: "Kannagi Nagar · கண்ணகி நகர்", kind: "study", icon: "ico-study", lat: 12.9312, lon: 80.2328 }, geometry: { type: "Point", coordinates: [80.2328, 12.9312] } },
    { type: "Feature", properties: { en: "Perumbakkam TNUHDB", ta: "பெரும்பாக்கம்", name: "Perumbakkam · பெரும்பாக்கம்", kind: "study", icon: "ico-study", lat: 12.8972, lon: 80.2035 }, geometry: { type: "Point", coordinates: [80.2035, 12.8972] } },
    { type: "Feature", properties: { en: "LHP Chennai (PMAY)", ta: "கலங்கரை திட்டம்", name: "LHP Chennai · கலங்கரை திட்டம்", kind: "study", icon: "ico-study", lat: 12.8938, lon: 80.2012 }, geometry: { type: "Point", coordinates: [80.2012, 12.8938] } },
    { type: "Feature", properties: { en: "KP Park Pulianthope", ta: "புளியந்தோப்பு", name: "KP Park · புளியந்தோப்பு", kind: "study", icon: "ico-study", lat: 13.0992, lon: 80.2647 }, geometry: { type: "Point", coordinates: [80.2647, 13.0992] } },
    { type: "Feature", properties: { en: "Ennore / Ernavoor", ta: "எண்ணூர்", name: "Ennore · எண்ணூர்", kind: "study", icon: "ico-study", lat: 13.2045, lon: 80.3168 }, geometry: { type: "Point", coordinates: [80.3168, 13.2045] } },
    { type: "Feature", properties: { en: "Moolakothalam TNUHDB", ta: "மூலக்கொத்தளம்", name: "Moolakothalam · மூலக்கொத்தளம்", kind: "study", icon: "ico-study", lat: 13.1065, lon: 80.2785 }, geometry: { type: "Point", coordinates: [80.2785, 13.1065] } },

    // Temples & Cultural Icons
    { type: "Feature", properties: { en: "Kapaleeshwarar Temple", ta: "கபாலீஸ்வரர் கோவில்", name: "Kapaleeshwarar · கபாலீஸ்வரர் கோவில்", kind: "temple", icon: "ico-temple", lat: 13.0339, lon: 80.2699 }, geometry: { type: "Point", coordinates: [80.2699, 13.0339] } },
    { type: "Feature", properties: { en: "Parthasarathy Temple", ta: "பார்த்தசாரதி கோவில்", name: "Parthasarathy · பார்த்தசாரதி", kind: "temple", icon: "ico-temple", lat: 13.0540, lon: 80.2768 }, geometry: { type: "Point", coordinates: [80.2768, 13.0540] } },
    { type: "Feature", properties: { en: "Vadapalani Murugan", ta: "வடபழனி முருகன்", name: "Vadapalani · வடபழனி", kind: "temple", icon: "ico-temple", lat: 13.0524, lon: 80.2122 }, geometry: { type: "Point", coordinates: [80.2122, 13.0524] } },
    { type: "Feature", properties: { en: "Marundeeswarar Temple", ta: "மருந்தீஸ்வரர் கோவில்", name: "Thiruvanmiyur · திருவான்மியூர்", kind: "temple", icon: "ico-temple", lat: 12.9844, lon: 80.2608 }, geometry: { type: "Point", coordinates: [80.2608, 12.9844] } },
    { type: "Feature", properties: { en: "Shore Temple Mahabalipuram", ta: "மாமல்லபுரம் கடற்கரை கோவில்", name: "Mahabalipuram · மாமல்லபுரம்", kind: "temple", icon: "ico-temple", lat: 12.6162, lon: 80.1993 }, geometry: { type: "Point", coordinates: [80.1993, 12.6162] } },

    // Heritage, Civic & Coastal Landmarks
    { type: "Feature", properties: { en: "Chennai Central", ta: "சென்னை சென்ட்ரல்", name: "Chennai Central · சென்ட்ரல்", kind: "heritage", icon: "ico-heritage", lat: 13.0827, lon: 80.2750 }, geometry: { type: "Point", coordinates: [80.2750, 13.0827] } },
    { type: "Feature", properties: { en: "Ripon Building", ta: "ரிப்பன் மாளிகை", name: "Ripon Building · ரிப்பன் மாளிகை", kind: "heritage", icon: "ico-heritage", lat: 13.0818, lon: 80.2715 }, geometry: { type: "Point", coordinates: [80.2715, 13.0818] } },
    { type: "Feature", properties: { en: "Egmore Station", ta: "எழும்பூர்", name: "Egmore · எழும்பூர்", kind: "heritage", icon: "ico-heritage", lat: 13.0778, lon: 80.2606 }, geometry: { type: "Point", coordinates: [80.2606, 13.0778] } },
    { type: "Feature", properties: { en: "Fort St. George", ta: "புனித ஜார்ஜ் கோட்டை", name: "Fort St. George · கோட்டை", kind: "heritage", icon: "ico-heritage", lat: 13.0796, lon: 80.2874 }, geometry: { type: "Point", coordinates: [80.2874, 13.0796] } },
    { type: "Feature", properties: { en: "Valluvar Kottam", ta: "வள்ளுவர் கோட்டம்", name: "Valluvar Kottam · வள்ளுவர் கோட்டம்", kind: "heritage", icon: "ico-heritage", lat: 13.0543, lon: 80.2419 }, geometry: { type: "Point", coordinates: [80.2419, 13.0543] } },
    { type: "Feature", properties: { en: "Santhome Basilica", ta: "சாந்தோம் தேவாலயம்", name: "Santhome · சாந்தோம்", kind: "heritage", icon: "ico-heritage", lat: 13.0337, lon: 80.2778 }, geometry: { type: "Point", coordinates: [80.2778, 13.0337] } },
    { type: "Feature", properties: { en: "Marina Beach", ta: "மெரினா கடற்கரை", name: "Marina Beach · மெரினா கடற்கரை", kind: "coast", icon: "ico-lighthouse", lat: 13.0500, lon: 80.2824 }, geometry: { type: "Point", coordinates: [80.2824, 13.0500] } },
    { type: "Feature", properties: { en: "Marina Lighthouse", ta: "கலங்கரை விளக்கம்", name: "Lighthouse · கலங்கரை விளக்கம்", kind: "coast", icon: "ico-lighthouse", lat: 13.0397, lon: 80.2793 }, geometry: { type: "Point", coordinates: [80.2793, 13.0397] } },
    { type: "Feature", properties: { en: "Elliot's Beach Besant Nagar", ta: "பெசன்ட் நகர் கடற்கரை", name: "Besant Nagar · பெசன்ட் நகர்", kind: "coast", icon: "ico-lighthouse", lat: 12.9988, lon: 80.2718 }, geometry: { type: "Point", coordinates: [80.2718, 12.9988] } },
    { type: "Feature", properties: { en: "Kasimedu Fishing Harbour", ta: "காசிமேடு மீன்பிடி துறைமுகம்", name: "Kasimedu Harbour · காசிமேடு", kind: "coast", icon: "ico-ship", lat: 13.1265, lon: 80.2982 }, geometry: { type: "Point", coordinates: [80.2982, 13.1265] } },
    { type: "Feature", properties: { en: "Anna Nagar Tower", ta: "அண்ணா நகர் கோபுரம்", name: "Anna Nagar Tower · அண்ணா நகர்", kind: "landmark", icon: "ico-tower", lat: 13.0850, lon: 80.2101 }, geometry: { type: "Point", coordinates: [80.2101, 13.0850] } },

    // Urban Hubs, Weather Stations & IT Parks
    { type: "Feature", properties: { en: "Nungambakkam IMD", ta: "நுங்கம்பாக்கம் வானிலை", name: "Nungambakkam IMD · நுங்கம்பாக்கம்", kind: "landmark", icon: "ico-tech", lat: 13.0678, lon: 80.2472 }, geometry: { type: "Point", coordinates: [80.2472, 13.0678] } },
    { type: "Feature", properties: { en: "Meenambakkam Airport", ta: "சென்னை விமான நிலையம்", name: "Airport WMO · மீனம்பாக்கம்", kind: "landmark", icon: "ico-tech", lat: 12.9941, lon: 80.1709 }, geometry: { type: "Point", coordinates: [80.1709, 12.9941] } },
    { type: "Feature", properties: { en: "T. Nagar Panagal Park", ta: "தி. நகர் பனகல் பூங்கா", name: "T. Nagar · தி. நகர்", kind: "landmark", icon: "ico-tower", lat: 13.0418, lon: 80.2341 }, geometry: { type: "Point", coordinates: [80.2341, 13.0418] } },
    { type: "Feature", properties: { en: "George Town", ta: "ஜார்ஜ் டவுன்", name: "George Town · ஜார்ஜ் டவுன்", kind: "heritage", icon: "ico-heritage", lat: 13.0945, lon: 80.2866 }, geometry: { type: "Point", coordinates: [80.2866, 13.0945] } },
    { type: "Feature", properties: { en: "Guindy National Park", ta: "கிண்டி தேசிய பூங்கா", name: "Guindy Park · கிண்டி பூங்கா", kind: "landmark", icon: "ico-palm", lat: 13.0067, lon: 80.2346 }, geometry: { type: "Point", coordinates: [80.2346, 13.0067] } },
    { type: "Feature", properties: { en: "Tidel Park OMR", ta: "டைடல் பார்க்", name: "Tidel Park OMR · டைடல் பார்க்", kind: "landmark", icon: "ico-tech", lat: 12.9896, lon: 80.2486 }, geometry: { type: "Point", coordinates: [80.2486, 12.9896] } },
    { type: "Feature", properties: { en: "Koyambedu CMBT", ta: "கோயம்பேடு பேருந்து நிலையம்", name: "Koyambedu CMBT · கோயம்பேடு", kind: "landmark", icon: "ico-tech", lat: 13.0694, lon: 80.2056 }, geometry: { type: "Point", coordinates: [80.2056, 13.0694] } },
    { type: "Feature", properties: { en: "Velachery", ta: "வேளச்சேரி", name: "Velachery · வேளச்சேரி", kind: "landmark", icon: "ico-tech", lat: 12.9784, lon: 80.2180 }, geometry: { type: "Point", coordinates: [80.2180, 12.9784] } },
  ],
};

// Pixel-art ships, fishing boats, palms, trains & buses across Greater Chennai & Bay of Bengal
const CHENNAI_AMBIENT_SPRITES = {
  type: "FeatureCollection",
  features: [
    // Bay of Bengal Cargo Ships & Kasimedu/Marina Fishing Boats
    ...[
      [80.332, 13.218, "ico-ship"], [80.345, 13.195, "ico-ship"], [80.312, 13.142, "ico-boat"],
      [80.306, 13.128, "ico-boat"], [80.315, 13.118, "ico-boat"], [80.308, 13.095, "ico-ship"],
      [80.318, 13.082, "ico-ship"], [80.296, 13.062, "ico-boat"], [80.292, 13.048, "ico-boat"],
      [80.298, 13.035, "ico-boat"], [80.289, 13.015, "ico-boat"], [80.285, 12.995, "ico-boat"],
      [80.298, 12.975, "ico-ship"], [80.278, 12.952, "ico-boat"], [80.272, 12.925, "ico-boat"],
      [80.268, 12.885, "ico-boat"], [80.262, 12.825, "ico-ship"], [80.220, 12.615, "ico-boat"],
    ].map(([lon, lat, icon]) => ({ type: "Feature", properties: { icon }, geometry: { type: "Point", coordinates: [lon, lat] } })),
    // Coastal & Riverbank Coconut Palm Groves + Park Trees
    ...[
      [80.281, 13.058], [80.280, 13.052], [80.279, 13.044], [80.277, 13.036], [80.275, 13.022],
      [80.270, 13.012], [80.265, 13.008], [80.258, 13.014], [80.242, 13.011], [80.232, 13.005],
      [80.225, 13.009], [80.268, 13.068], [80.255, 13.069], [80.242, 13.066], [80.231, 12.933],
      [80.235, 12.929], [80.201, 12.899], [80.205, 12.895], [80.245, 12.965], [80.248, 12.945],
    ].map(([lon, lat]) => ({ type: "Feature", properties: { icon: "ico-palm" }, geometry: { type: "Point", coordinates: [lon, lat] } })),
    // Suburban / MRTS Trains & Arterial MTC Buses
    ...[
      [80.276, 13.084, "ico-train"], [80.262, 13.078, "ico-train"], [80.246, 13.061, "ico-train"],
      [80.231, 13.038, "ico-train"], [80.222, 13.012, "ico-train"], [80.278, 13.046, "ico-train"],
      [80.268, 13.026, "ico-train"], [80.252, 12.998, "ico-train"], [80.221, 12.976, "ico-train"],
      [80.258, 13.056, "ico-bus"],   [80.243, 13.042, "ico-bus"],   [80.248, 12.982, "ico-bus"],
      [80.246, 12.942, "ico-bus"],   [80.215, 13.084, "ico-bus"],   [80.265, 13.101, "ico-bus"],
    ].map(([lon, lat, icon]) => ({ type: "Feature", properties: { icon }, geometry: { type: "Point", coordinates: [lon, lat] } })),
  ],
};

// Which picture of the neighbourhood is on screen: "painted" (the isometric painting, which exists in
// that one view only), "model" (this map in 3D) or "top" (this map from straight above, north up).
let mapView = "painted";
function setMapView(view) {
  mapView = view;
  markMapView();
  window.pxOasis?.toggle3d(view !== "painted");     // hides or shows the painting
  if (view !== "painted" && uMap) { uMap.resize(); setView(view === "model"); }
}
function markMapView() {
  for (const b of document.querySelectorAll(".u-views [data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === mapView));
  $("u-map").dataset.view = mapView;
}
// The painted map's tiles failed, or its own toolbar switched: keep the buttons in step
window.mapViewChanged = painted => {
  if (painted === (mapView === "painted")) return;
  mapView = painted ? "painted" : (uMap && uMap.getPitch() < 1 ? "top" : "model");   // our map keeps the camera it had
  markMapView();
};

function setView(iso) {
  const v = iso ? ISO : PLAN;
  uMap.setVerticalFieldOfView(v.fov);
  uMap.easeTo({ pitch: v.pitch, bearing: v.bearing, duration: 700 });
}
function minimalLayers() {
  const c = palette(), width = (a, b) => ["interpolate", ["exponential", 1.6], ["zoom"], 11, a, 18, b];
  const t = isDark() ? "d" : "l";
  return [
    { id: "ground", type: "background", paint: { "background-color": c.ground, "background-pattern": `pat-${t}-ground` } },
    { id: "green", type: "fill", source: "city", "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["wood", "grass", "wetland"]]], paint: { "fill-color": c.green, "fill-pattern": `pat-${t}-green` } },
    { id: "park", type: "fill", source: "city", "source-layer": "park", paint: { "fill-color": c.green, "fill-pattern": `pat-${t}-green` } },
    { id: "sand", type: "fill", source: "city", "source-layer": "landcover", filter: ["in", ["get", "class"], ["literal", ["sand", "beach"]]], paint: { "fill-color": c.sand, "fill-pattern": `pat-${t}-sand` } },
    { id: "water", type: "fill", source: "city", "source-layer": "water", paint: { "fill-color": c.water, "fill-pattern": `pat-${t}-water` } },
    { id: "roads-case", type: "line", source: "city", "source-layer": "transportation", minzoom: 12,
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["!", ["in", ["get", "class"], ["literal", [...MAJOR_ROADS, "rail", "transit", "ferry"]]]]],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": c.roadCase, "line-width": width(0.9, 11.5) } },
    { id: "roads-major-case", type: "line", source: "city", "source-layer": "transportation",
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "class"], ["literal", MAJOR_ROADS]]],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": c.roadCase, "line-width": width(1.8, 23) } },
    { id: "roads", type: "line", source: "city", "source-layer": "transportation", minzoom: 12,
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["!", ["in", ["get", "class"], ["literal", [...MAJOR_ROADS, "rail", "transit", "ferry"]]]]],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": c.road, "line-width": width(0.5, 9) } },
    { id: "roads-major", type: "line", source: "city", "source-layer": "transportation",
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "class"], ["literal", MAJOR_ROADS]]],
      layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": c.major, "line-width": width(1.2, 20) } },
    { id: "rail-line", type: "line", source: "city", "source-layer": "transportation", minzoom: 11,
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "class"], ["literal", ["rail", "transit"]]]],
      paint: { "line-color": c.rail, "line-width": width(0.8, 3.5) } },
    { id: "rail-ties", type: "line", source: "city", "source-layer": "transportation", minzoom: 13,
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "class"], ["literal", ["rail", "transit"]]]],
      paint: { "line-color": c.roadCase, "line-width": width(2.0, 7.0), "line-dasharray": [1, 2.5] } },
  ];
}
const placeLabels = () => ({ id: "places", type: "symbol", source: "city", "source-layer": "place", minzoom: 11,
  filter: ["in", ["get", "class"], ["literal", ["suburb", "neighbourhood", "quarter", "town", "village"]]],
  layout: { "text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": 11,
            "text-letter-spacing": 0.08, "text-transform": "uppercase" },
  paint: { "text-color": palette().label, "text-halo-color": palette().halo, "text-halo-width": 1.4 } });

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
  const startPixel = $("u-pixel")?.getAttribute("aria-pressed") === "true";
  uMap = new maplibregl.Map({
    container: "u-map-canvas",
    pixelRatio: startPixel ? 1 / PIXEL_SIZE : window.devicePixelRatio,
    center: [p.lon || 80.2328, p.lat || 12.9312], zoom: 15.8, pitch: ISO.pitch, bearing: ISO.bearing, maxPitch: 75,
    attributionControl: { compact: true },
    style: {
      version: 8,
      glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
      light: { anchor: "map", position: [1.5, 215, 38], intensity: 0.52 },     // crisp SimCity directional sun from SW
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
        ...(urban.cartoKey ? [{ id: "carto", type: "raster", source: "carto", paint: { "raster-opacity": 0.42 } }] : []),
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
    // the ground pattern is never asked for by the map (a background layer raises no "image missing"), so make both now
    for (const tag of ["l", "d"]) if (!uMap.hasImage(`pat-${tag}-ground`)) uMap.addImage(`pat-${tag}-ground`, surfacePicture("ground", tag === "d"));
    uMap.setPaintProperty("ground", "background-pattern", `pat-${themeTag()}-ground`);
    for (const id of ["area", "cells", "outlines", "rays", "centre"]) uMap.addSource(id, { type: "geojson", data: EMPTY });
    uMap.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": AREA_GROUND(), "fill-opacity": 0.92 } });
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
  // Click anywhere: that is the site. Clicking a landmark pin flies to that neighbourhood; clicking a building in the circle picks it.
  uMap.on("click", e => {
    if (zoneClick(e.lngLat.lat, e.lngLat.lng)) return;
    const lm = uMap.queryRenderedFeatures(e.point, { layers: ["landmarks-pin", "landmarks-label"] })[0];
    if (lm?.properties?.lat) {
      $("u-lat").value = Number(lm.properties.lat).toFixed(4);
      $("u-lon").value = Number(lm.properties.lon).toFixed(4);
      $("u-name").value = lm.properties.name.split(" · ")[0];
      $("u-place").value = "";
      placeMoved(true);
      return;
    }
    if (urban.grid) {                        // the place is read: a click picks a building; move the site by clicking outside the circle
      const hit = uMap.queryRenderedFeatures(e.point, { layers: ["cells"] })[0];
      if (hit?.properties.bid) return pickBuilding(hit.properties.bid);
      const pl = place(), [x, y] = toLocal([e.lngLat.lng, e.lngLat.lat], pl);
      if (inArea(x, y, pl)) return;
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
  // light / dark switch: the minimal map, surface patterns, and the lines drawn on it follow
  const repaintMap = () => {
    const c = palette(), t = themeTag();
    if (uMap.getLayer("area-fill")) uMap.setPaintProperty("area-fill", "fill-color", AREA_GROUND());
    for (const [layer, property, key] of THEMED) if (uMap.getLayer(layer)) uMap.setPaintProperty(layer, property, c[key]);
    if (uMap.getLayer("ground")) uMap.setPaintProperty("ground", "background-pattern", `pat-${t}-ground`);
    for (const [layer, kind] of [["green", "green"], ["park", "green"], ["sand", "sand"], ["water", "water"]])
      if (uMap.getLayer(layer)) uMap.setPaintProperty(layer, "fill-pattern", `pat-${t}-${kind}`);
    if (uMap.getLayer("trees")) uMap.setPaintProperty("trees", "fill-extrusion-color", TREE_COLOUR());
    if (uMap.getLayer("trees-trunk")) uMap.setPaintProperty("trees-trunk", "fill-extrusion-color", isDark() ? "#4a3525" : "#6e4e34");
    uMap.setPaintProperty("city", "fill-extrusion-color", uMap.getSource("overture") ? cityColour() : c.city);
    paintCity();
    if (uMap.getLayer("trees-top")) uMap.setPaintProperty("trees-top", "fill-extrusion-color", TREE_TOP());
    if (uMap.getLayer("landmarks-label")) {
      uMap.setPaintProperty("landmarks-label", "text-color", isDark() ? "#fef08a" : "#1e1b18");
      uMap.setPaintProperty("landmarks-label", "text-halo-color", isDark() ? "#111318" : "#fffbeb");
    }
    if (mapReady) { paintArea(); heightsKey(); }
    if (urban.cartoKey) uMap.getSource("carto").setTiles(cartoTiles(urban.cartoKey));
    if (mapReady && exposureOn()) exposureKey();
  };
  new MutationObserver(repaintMap).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  $("u-ctx").addEventListener("click", e => {
    const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
    e.currentTarget.setAttribute("aria-pressed", String(on));
    for (const id of ["city", "city-roof", "city-mumty"])
      if (uMap.getLayer(id)) uMap.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  });
  // View switch (as in the Home viewport): Painted = the isometric picture, 3D / Top view = this map
  document.querySelectorAll(".u-views [data-view]").forEach(b => b.addEventListener("click", () => setMapView(b.dataset.view)));
  // Pixel look: the same map drawn on a coarse grid (one map pixel = PIXEL_SIZE screen pixels) with hard edges
  $("u-pixel").addEventListener("click", e => {
    const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
    e.currentTarget.setAttribute("aria-pressed", String(on));
    $("u-map").classList.toggle("pixel", on);
    uMap.setPixelRatio(on ? 1 / PIXEL_SIZE : window.devicePixelRatio);
    repaintMap();                           // the bright palette comes and goes with the Pixel look
  });
  // Tamil / Bilingual vs English-only label switch (like pixelchennai.com)
  if ($("u-lang")) {
    $("u-lang").addEventListener("click", e => {
      tamilLabels = e.currentTarget.getAttribute("aria-pressed") !== "true";
      e.currentTarget.setAttribute("aria-pressed", String(tamilLabels));
      if (uMap.getLayer("landmarks-label")) {
        uMap.setLayoutProperty("landmarks-label", "text-field", ["get", tamilLabels ? "name" : "en"]);
      }
      if (uMap.getLayer("places")) {
        uMap.setLayoutProperty("places", "text-field",
          tamilLabels ? ["coalesce", ["get", "name"], ["get", "name:latin"]] : ["coalesce", ["get", "name:en"], ["get", "name:latin"], ["get", "name"]]);
      }
    });
  }
  // Full Greater Chennai isometric overview (Ennore to OMR / Coast)
  if ($("u-overview")) {
    $("u-overview").addEventListener("click", () => {
      const v = mapView === "top" ? PLAN : ISO;
      uMap.flyTo({ center: [80.258, 13.028], zoom: 12.3, pitch: v.pitch, bearing: v.bearing, speed: 1.3 });
    });
  }
  window.uMap = uMap;
}

// The analysis area and the site marker follow the Where fields
function showArea(fly) {
  window.pxOasis?.syncArea(fly);
  if (!mapReady) return;
  const p = place();
  if (!isFinite(p.lat) || !isFinite(p.lon)) return;
  uMap.getSource("area").setData(areaFeature());
  uMap.getSource("centre").setData({ type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] }, properties: {} });
  if (fly) uMap.flyTo({ center: [p.lon, p.lat], zoom: p.radius_m > 350 ? 15 : 15.6, speed: 1.4 });
  else uMap.jumpTo({ center: [p.lon, p.lat], zoom: p.radius_m > 350 ? 15 : 15.6 });
}

let autoReadTimer = 0;
function placeMoved(fly, keepZone) {
  if (!keepZone) urban.zone = null;          // a new place or radius is a circle again
  urban.drawing = null;
  showDrawing();
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
  $("u-form-note").textContent = "Reading building heights and footprints for this zone…";
  showArea(fly);
  window.pxOasis?.drawUrban();
  clearTimeout(autoReadTimer);
  autoReadTimer = setTimeout(() => { readMap(); }, 120);
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
  } else if (urban.buildings.length) {
    // Build selectable 3D grey footprint volumes from OpenStreetMap outlines + satellite heights
    const osmMap = new Map();
    urban.buildings.filter(b => b.inside && b.xy && b.xy.length >= 3).forEach((b, idx) => {
      const id = `osm_${idx}`;
      const h = Math.round((b.sat_height_m || b.height_m || GUESS_M) * 10) / 10;
      const ring = outline(b)[0];
      const xs = b.xy.map(q => q[0]), ys = b.xy.map(q => q[1]);
      const cx = xs.reduce((a, v) => a + v, 0) / xs.length;
      const cy = ys.reduce((a, v) => a + v, 0) / ys.length;
      osmMap.set(id, { id, x: cx, y: cy, h, guess: !b.sat_height_m, area: b.area_m2 || 60, pieces: [ring] });
      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { h, bid: id } });
    });
    if (osmMap.size) urban.footprints = osmMap;
  } else if (g) {
    // no footprint outlines at all: 4 m satellite height cells inside the circle
    const c = g.cell_m, half = g.half_m;
    (g.loose || g.heights).forEach((row, i) => row.forEach((h, j) => {
      if (h <= 0) return;
      const x0 = -half + j * c, y0 = half - i * c;
      if (!inArea(x0 + c / 2, y0 - c / 2, p)) return;      // inside the analysis area only
      const sq = [[x0, y0], [x0 + c, y0], [x0 + c, y0 - c], [x0, y0 - c], [x0, y0]].map(([x, y]) => toLngLat(x, y, p.lat, p.lon));
      features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [sq] }, properties: { h } });
    }));
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
  if (exposureOn()) exposureKey(); else heightsKey();
  window.pxOasis?.drawUrban();
  readExposure();
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
    ? `${scale} Grey: the analysis area (${areaName(p)}), ${urban.footprints.size} buildings on their real outlines (Overture Maps) at the satellite height (Google Open Buildings 2.5D; 98 % are under ${top.toFixed(0)} m)${guessed ? `; ${guessed} outlines where the satellite shows no building stand at ${GUESS_M} m (assumed)` : ""}. Coloured: the rest of the city, for context only, mostly at an assumed two storeys. Wall and roof colours, windows and lane markings are drawn for looks and carry no data. Green: tree canopy at its measured height. <b>Click a grey building</b> to make it the home's building.`
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
  const onBuildings = name === "heights" || name === "exposure";
  const pic = onBuildings ? null : layerPicture(name);
  if (!pic) name = name === "exposure" && urban.exposure ? "exposure" : "heights";
  urban.layer = name;
  if (pic) window.pxOasis?.toggle3d(true);
  for (const b of document.querySelectorAll(".u-tool[data-layer]")) b.setAttribute("aria-pressed", String(b.dataset.layer === name));
  for (const id of ["cells", "cells-roof"]) uMap.setLayoutProperty(id, "visibility", pic ? "none" : "visible");
  if (uMap.getLayer("env")) uMap.setLayoutProperty("env", "visibility", pic ? "visible" : "none");
  if (!pic) { paintArea(); if (exposureOn()) exposureKey(); else heightsKey(); window.pxOasis?.drawUrban(); return; }
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
  const have = { exposure: !!urban.exposure, heights: !!(urban.grid || urban.buildings.length), sky: !!e.sky, sun: !!e.sky, cover: !!e.cover, surface: !!e.surface };
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
  let ramp = ["interpolate", ["linear"], ["get", "h"], ...AREA_GREYS()];
  if (exposureOn() && urban.exposure.buildings.length)       // each building in the colour of its score
    ramp = ["match", ["get", "bid"], ...urban.exposure.buildings.flatMap(b => [b.id, exposureColour(b.score)]), "#9aa0a6"];
  // the picked building: orange on the grey map, light blue on the exposure colours (orange would not show)
  return urban.picked ? ["case", ["==", ["get", "bid"], urban.picked.id], exposureOn() ? "#38bdf8" : PICK_COLOUR, ramp] : ramp;
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


// ---------------------------------------------------------------------------
// The analysis area: the circle (centre + radius), or a zone drawn on the map.
// urban.zone = corners in metres east / north of the centre; urban.drawing =
// corners clicked so far ([lon, lat]) while a zone is being drawn.
// ---------------------------------------------------------------------------
const ZONE_MAX_M = 500;               // a zone must fit in the largest circle the readers accept
const inArea = (x, y, p = place()) => urban.zone ? inRing(x, y, urban.zone) : Math.hypot(x, y) <= p.radius_m;
const areaName = p => urban.zone ? "drawn zone" : `${p.radius_m} m circle`;

// Outline of the area as [lon, lat] points (closed), or the corners clicked so far
function areaRing() {
  if (urban.drawing) return urban.drawing.slice();
  const p = place();
  if (!isFinite(p.lat) || !isFinite(p.lon)) return [];
  if (urban.zone) return [...urban.zone, urban.zone[0]].map(([x, y]) => toLngLat(x, y, p.lat, p.lon));
  return ring(p.lat, p.lon, p.radius_m || 250).geometry.coordinates[0];
}
function areaFeature() {
  const pts = areaRing();
  const geometry = urban.drawing ? (pts.length > 1 ? { type: "LineString", coordinates: pts } : { type: "Point", coordinates: pts[0] || [0, 0] })
                                 : { type: "Polygon", coordinates: [pts] };
  return { type: "Feature", geometry, properties: {} };
}
function showDrawing() {
  const b = $("u-draw"), n = urban.drawing ? urban.drawing.length : 0;
  b.textContent = urban.drawing ? (n < 3 ? `Click the corners on the map (${n} so far)` : `Finish zone (${n} corners)`) : urban.zone ? "Redraw the zone" : "Draw a zone instead";
  b.setAttribute("aria-pressed", String(!!urban.drawing));
  $("u-draw-note").textContent = urban.drawing ? "Click each corner of the zone on the map, then press Finish. Esc cancels."
    : urban.zone ? "The readings are for the drawn zone. Change the radius or click the map outside it to go back to a circle."
    : "";
  if (mapReady) uMap.getSource("area").setData(areaFeature());
  window.pxOasis?.drawUrban();
}
// A map click while drawing adds a corner (true = the click is used up)
function zoneClick(lat, lon) {
  if (!urban.drawing) return false;
  urban.drawing.push([lon, lat]);
  showDrawing();
  return true;
}
function finishZone() {
  const pts = urban.drawing;
  urban.drawing = null;
  if (!pts || pts.length < 3) { showDrawing(); return; }
  const lons = pts.map(q => q[0]), lats = pts.map(q => q[1]);
  const c = { lat: +((Math.min(...lats) + Math.max(...lats)) / 2).toFixed(5), lon: +((Math.min(...lons) + Math.max(...lons)) / 2).toFixed(5) };
  const local = pts.map(q => toLocal(q, c).map(v => Math.round(v * 10) / 10));
  const reach = Math.max(...local.map(([x, y]) => Math.hypot(x, y)));
  if (reach > ZONE_MAX_M) {
    toast("That zone is too large", { type: "error", detail: `Keep it within 1 km across (this one reaches ${Math.round(reach)} m from its middle).` });
    showDrawing();
    return;
  }
  $("u-lat").value = c.lat; $("u-lon").value = c.lon;
  $("u-radius").value = Math.min(ZONE_MAX_M, Math.max(100, Math.ceil(reach / 10) * 10));   // the square that is read reaches every corner
  $("u-name").value = "Drawn zone"; $("u-place").value = "";
  urban.zone = local;
  placeMoved(true, true);
}
function toggleDrawing() {
  if (urban.drawing) return urban.drawing.length >= 3 ? finishZone() : (urban.drawing = null, showDrawing());
  urban.drawing = [];
  showDrawing();
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
      const boxArea = (x1 - x0) * (y1 - y0);
      const id = f.properties.id || String(f.id);
      const prev = byId.get(id);
      // Keep only the single largest unclipped ring per building ID so tile-border fragments never stack or mix
      if (prev && prev.boxArea >= boxArea) continue;
      const b = { id, pieces: [poly[0]], boxArea, sum: 0, built: 0, cells: 0, sx: 0, sy: 0, ring0: [(x0 + x1) / 2, (y0 + y1) / 2] };
      for (let i = Math.max(0, Math.floor((half - y1) / c)); i <= Math.min(n - 1, Math.floor((half - y0) / c)); i++)
        for (let j = Math.max(0, Math.floor((x0 + half) / c)); j <= Math.min(n - 1, Math.floor((x1 + half) / c)); j++) {
          const x = -half + (j + 0.5) * c, y = half - (i + 0.5) * c;
          if (!inRing(x, y, ring)) continue;
          b.cells++; b.sx += x; b.sy += y;
          if (g.heights[i][j] > 0) { b.sum += g.heights[i][j]; b.built++; }
        }
      byId.set(id, b);
    }
  }
  const features = [];
  for (const b of byId.values()) {
    [b.x, b.y] = b.cells ? [b.sx / b.cells, b.sy / b.cells] : b.ring0;
    if (!inArea(b.x, b.y, p)) { byId.delete(b.id); continue; }
    b.guess = !b.built;
    b.h = b.built ? Math.round(b.sum / b.built * 10) / 10 : GUESS_M;
    b.area = Math.max(1, b.cells) * c * c;
    for (const ring of b.pieces) features.push({ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { h: b.h, bid: b.id } });
  }
  return { features, byId };
}


// ---------------------------------------------------------------------------
// Heat exposure index (oasis/exposure.py): the physical part of OASIS 1.0's index.
// One 0-10 score per building in the analysis area; the map colours them, the right
// panel gives the area's score, its drivers and the decision gate, as OASIS 1.0 did.
// ---------------------------------------------------------------------------
const EXPOSURE_STOPS = [[0, [255, 255, 204]], [3, [255, 237, 160]], [4, [254, 178, 76]], [5, [253, 141, 60]],
                        [6, [252, 78, 42]], [7, [227, 26, 28]], [8.5, [177, 0, 38]], [10, [128, 0, 38]]];   // OASIS 1.0's scale (ColorBrewer YlOrRd)
const EXPOSURE_GRADIENT = "linear-gradient(90deg, #ffffcc 0%, #ffeda0 30%, #feb24c 40%, #fd8d3c 50%, #fc4e2a 60%, #e31a1c 70%, #b10026 85%, #800026 100%)";
function exposureRgb(score) {
  const s = Math.max(0, Math.min(10, score));
  for (let i = 0; i < EXPOSURE_STOPS.length - 1; i++) {
    const [v0, c0] = EXPOSURE_STOPS[i], [v1, c1] = EXPOSURE_STOPS[i + 1];
    if (s <= v1) return c0.map((c, k) => Math.round(c + (c1[k] - c) * (s - v0) / (v1 - v0)));
  }
  return EXPOSURE_STOPS[EXPOSURE_STOPS.length - 1][1];
}
const exposureColour = score => `rgb(${exposureRgb(score).join(",")})`;
const exposureOn = () => urban.layer === "exposure" && !!urban.exposure;
const exposureOf = id => urban.exposure?.byId.get(id) || null;

// Ask the server for the scores of the buildings now drawn (once per set of buildings)
async function readExposure() {
  const fp = urban.footprints;
  if (!fp || !fp.size || !urban.grid) return;
  const p = place();
  const key = JSON.stringify([p.lat, p.lon, p.radius_m, p.zone, fp.size, [...fp.keys()].slice(0, 5)]);
  if (key === urban.exposureKey) return;
  urban.exposureKey = key;
  try {
    const buildings = [...fp.values()].map(b => ({ id: String(b.id), x_m: Math.round(b.x * 10) / 10, y_m: Math.round(b.y * 10) / 10, height_m: b.h, height_assumed: !!b.guess }));
    const data = await api("/api/urban/exposure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...p, buildings }) });
    if (key !== urban.exposureKey) return;                 // the place changed while we waited
    urban.exposure = { ...data, byId: new Map(data.buildings.map(b => [b.id, b])) };
    showEnv();
    if (!urban.exposureShown) { urban.exposureShown = true; setLayer("exposure"); }   // the first time, show it
    else { paintArea(); if (exposureOn()) exposureKey(); window.pxOasis?.drawUrban(); }
    renderExposure();
    renderPick();
  } catch (err) {
    urban.exposureKey = null;
    toast("The heat exposure index could not be read", { type: "error", detail: err.message, duration: 8000 });
  }
}

function exposureKey() {
  const s = urban.exposure.summary;
  $("u-map-key").innerHTML = `<span class="nb-scale"><span>0</span><i style="background:${EXPOSURE_GRADIENT}"></i><span>10</span></span>
    Heat exposure index of each building, 0 (least) to 10 (most exposed): surface temperature, trees within 50 m, how enclosed the street is, and how much of the building lies under its roof.
    Exposure of the building, not vulnerability of the people. ${s ? `${s.buildings} buildings, mean ${s.mean.toFixed(1)}.` : ""} <b>Click a building</b> for its factors.`;
}

// The area's score, its drivers and the decision gate (right panel)
function renderExposure() {
  const box = $("u-exposure"), x = urban.exposure, s = x?.summary;
  box.hidden = !s;
  if (!s) return;
  const b = x.basis, tier = b.tiers.find(t => s.mean < t.below);
  const verdict = s.mean < b.safe_below
    ? `Below ${b.safe_below}: the area is not heat-exposed as built. No urban measure is called for.`
    : s.mean < b.gate
      ? `Between ${b.safe_below} and ${b.gate}: street measures (trees, shade) are the first step. ${s.over_gate} building${s.over_gate === 1 ? "" : "s"} at ${b.gate} or more should still be assessed as homes.`
      : `At ${b.gate} or more: urban measures alone are unlikely to be enough. ${s.over_gate} of ${s.buildings} buildings are over the gate and should be assessed as homes.`;
  box.innerHTML = `
    <div><h3>Heat exposure of this area</h3>
      <div class="stats">
        <div class="stat"><span>Mean of ${s.buildings} buildings</span><b>${s.mean.toFixed(1)}<small> / 10</small></b><em><i class="x-dot" style="background:${exposureColour(s.mean)}"></i>${tier.name} · ${s.min.toFixed(1)} to ${s.max.toFixed(1)}</em></div>
        <div class="stat"><span>Over the gate (${b.gate})</span><b>${s.over_gate}<small> of ${s.buildings}</small></b><em>to assess as homes</em></div>
      </div>
      <div class="x-tiers">${b.tiers.map(t => `<span title="${esc(t.action)}"><i class="x-dot" style="background:${exposureColour(Math.min(9, t.below - 0.7))}"></i>${t.name} <b>${s.tiers[t.name]}</b></span>`).join("")}</div>
    </div>
    <div><h3>What drives it</h3>
      <ul class="x-drivers">${s.drivers.map(d => `<li title="${esc(b.factors.find(f => f.factor === d.factor).rule)}">
        <span>${esc(d.label)}</span><i><u style="width:${(d.points / d.max_points * 100).toFixed(0)}%"></u></i><b>${d.points.toFixed(1)}<small> of ${d.max_points.toFixed(1)}</small></b></li>`).join("")}</ul>
      <p class="sm muted" style="margin:6px 0 0">Points each factor adds to the mean score, against the most it can add.</p>
    </div>
    <div class="u-warn"><b>Decision gate.</b> ${verdict}</div>
    <button type="button" class="btn btn-outline u-wide" id="u-highest" style="margin-top:0">Select the most exposed building</button>
    <p class="sm muted" style="margin:0">${esc(b.left_out)}</p>`;
  $("u-highest").addEventListener("click", () => { pickBuilding(s.highest); if (uMap && urban.picked) uMap.easeTo({ center: toLngLat(urban.picked.x, urban.picked.y, place().lat, place().lon), duration: 600 }); });
}

// One building's score and factors (in the Selected building box)
function exposurePickHtml(id) {
  const e = exposureOf(id), b = urban.exposure?.basis;
  if (!e) return "";
  const value = { surface: v => `${v} °C surface`, city_delta: v => `${v > 0 ? "+" : ""}${v} °C vs the city`, trees: v => `${Math.round(v * 100)} % trees within 50 m`,
                  canyon: v => `height ÷ width ${v}`, roof: v => `${v} storey${v === 1 ? "" : "s"}` };
  return `<div class="x-score"><i class="x-dot" style="background:${exposureColour(e.score)}"></i><b>${e.score.toFixed(1)}</b><span> / 10 heat exposure · ${e.tier}</span></div>
    <ul class="x-drivers">${b.factors.filter(f => e.factors[f.factor]).map(f => { const v = e.factors[f.factor]; return `<li title="${esc(f.rule)}">
      <span>${esc(f.label)}<small>${value[f.factor](v.value)}</small></span><i><u style="width:${(v.score * 100).toFixed(0)}%"></u></i><b>${v.points.toFixed(1)}</b></li>`; }).join("")}</ul>
    ${e.missing.length ? `<p class="sm muted" style="margin:4px 0 0">No data here for: ${e.missing.map(k => b.factors.find(f => f.factor === k).label.toLowerCase()).join(", ")}; the other factors carry the score.</p>` : ""}
    <p class="sm muted" style="margin:6px 0 0">${e.score >= b.gate ? `At ${b.gate} or more: assess a home in this building.` : `Below the gate of ${b.gate}.`}</p>`;
}
window.exposureTint = id => { const e = exposureOn() ? exposureOf(id) : null; return e ? exposureRgb(e.score) : null; };

// A building picked on the map becomes the home's building: its neighbours give the shading, its height the floors
function pickBuilding(id) {
  urban.picked = urban.footprints?.get(id) || null;
  paintArea();
  renderPick();
  window.pxOasis?.drawUrban();
}

function renderPick() {
  const b = urban.picked, box = $("u-pick");
  box.hidden = !b;
  if (!b) return;
  const storeys = Math.max(1, Math.round(b.h / (urban.floor_m || 3)));
  box.innerHTML = `<h3>Selected building</h3>
    ${exposurePickHtml(b.id)}
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
  window.pxOasis?.drawUrban();
}

// ---------------------------------------------------------------------------
// Pixel Chennai (Option 5 Hybrid):
// - Outside the 250 m analysis circle: SimCity 2000 / pixelchennai.com style
//   with Bayer-dithered ground, water waves, sandy beaches, lush pixel parks,
//   7 Chennai architectural facade sprite styles (chajja overhangs, balconies,
//   shutters, AC units), stepped rooftop mumties, and bilingual Tamil+English pins.
// - Inside the 250 m analysis circle: Data-driven monochrome pixel facades where
//   grey tone strictly encodes Google Open Buildings 2.5D height, and the picked
//   building highlights in vibrant SimCity orange (#ff6a1a).
// ---------------------------------------------------------------------------
const WALL_TONES = [
  [244, 212, 168], // 0: Warm Chennai ochre / sandstone tenement
  [245, 178, 146], // 1: Terracotta / coral apartment block
  [242, 168, 184], // 2: Mylapore rose / pastel pink residential
  [164, 210, 238], // 3: Coastal sky-blue flat
  [180, 224, 190], // 4: Mint / pistachio plaster block
  [248, 224, 136], // 5: T. Nagar turmeric yellow commercial/housing
  [206, 186, 232], // 6: Lavender / colonial verandah block
];
const ROOF_TONES = [
  [196, 96, 66],   // Pressed clay tile / brick-jelly coba red
  [222, 216, 202], // Weathering course lime screed
  [136, 178, 198], // Blue-grey slate / water-tank deck
  [240, 236, 224], // High-albedo white cool roof
  [172, 126, 88],  // Aged terracotta terrace
];
const GREY_WALLS = { g0: [228, 228, 224], g1: [174, 178, 182], g2: [116, 120, 128], pick: [255, 114, 32] };
const dim = rgb => rgb.map(v => Math.round(v * (isDark() ? 0.78 : 1)));
const themeTag = () => isDark() ? "d" : "l";
const tone = n => ["%", ["coalesce", ["id"], 0], n];

// 4x4 Bayer ordered dithering matrix (normalized 0..15)
const BAYER4 = [
  [ 0,  8,  2, 10],
  [12,  4, 14,  6],
  [ 3, 11,  1,  9],
  [15,  7, 13,  5],
];

// Procedural 32x32 Bayer-dithered pixel-art surface tiles (ground, water, green, sand)
function surfacePicture(kind, dark = isDark()) {
  const w = 32, h = 32, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const b = BAYER4[y & 3][x & 3];
    let rgb;
    if (kind === "ground") {
      const base = dark ? [23, 25, 30] : [237, 230, 214];
      const alt  = dark ? [29, 32, 38] : [227, 218, 198];
      const grid = (x % 16 === 0 || y % 16 === 0) && ((x + y) % 4 === 0);
      rgb = grid ? (dark ? [35, 39, 46] : [214, 204, 182]) : (b < 5 ? alt : base);
    } else if (kind === "water") {
      const deep = dark ? [12, 40, 62] : [64, 144, 196];
      const mid  = dark ? [18, 54, 82] : [78, 160, 210];
      const crest = dark ? [42, 108, 148] : [156, 218, 246];
      const waveRow = (y % 8 === 2 && ((x + (y >> 3) * 5) % 12 < 5)) || (y % 8 === 6 && ((x + 6) % 14 < 4));
      rgb = waveRow ? crest : (b < 7 ? mid : deep);
    } else if (kind === "green") {
      const g1 = dark ? [24, 46, 33] : [132, 192, 116];
      const g2 = dark ? [32, 60, 42] : [112, 174, 98];
      const bush = dark ? [44, 82, 54] : [82, 144, 72];
      const hi = dark ? [56, 102, 66] : [158, 212, 134];
      const cx = (x + ((y >> 3) * 7)) & 7, cy = y & 7;
      const isBush = (cx >= 2 && cx <= 5 && cy >= 2 && cy <= 5);
      rgb = isBush ? (cy === 2 || cx === 2 ? hi : bush) : (b < 6 ? g2 : g1);
    } else { // sand (Marina Beach / Elliot's Beach / ECR)
      const s1 = dark ? [62, 54, 36] : [244, 222, 166];
      const s2 = dark ? [52, 45, 30] : [230, 204, 144];
      const ripple = (y % 6 === 0) && ((x + y) % 5 < 3);
      rgb = ripple ? (dark ? [74, 65, 44] : [252, 236, 188]) : (b < 6 ? s2 : s1);
    }
    data.set([rgb[0], rgb[1], rgb[2], 255], 4 * (y * w + x));
  }
  return { width: w, height: h, data };
}

// One storey of Chennai building facade: 32 x 16 pixel-art sprite with floor slab,
// concrete chajja sunshade overhang + shadow, multi-pane windows, and balcony/louver detail
function wallPicture(rgb, name) {
  const w = 32, h = 16, data = new Uint8ClampedArray(w * h * 4);
  const dark = isDark();
  const isPick = name === "pick";
  const isGrey = name === "g0" || name === "g1" || name === "g2";
  const styleIdx = isGrey || isPick ? 0 : (+name || 0);

  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  const shift = (c, d) => c.map(v => clamp(v + d));
  const mult  = (c, k) => c.map(v => clamp(v * k));

  const slabDark  = mult(rgb, 0.72);
  const slabLight = shift(rgb, 18);
  const chajjaTop = shift(rgb, 34);
  const shadow    = mult(rgb, 0.58);
  const frame     = shift(rgb, 26);
  const sill      = mult(rgb, 0.65);
  const glass     = isPick ? [255, 240, 150] : dark ? [246, 208, 112] : [54, 78, 104];
  const glassHi   = isPick ? [255, 252, 210] : dark ? [255, 234, 168] : [92, 128, 158];
  const loggia    = mult(rgb, 0.50);

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const b = BAYER4[y & 3][x & 3];
    // Subtle plaster texture via ordered Bayer dither
    let c = b < 3 ? shift(rgb, -5) : b > 13 ? shift(rgb, 4) : rgb;

    // Floor slab ledge at top of storey (y = 0, 1)
    if (y === 0) c = slabDark;
    else if (y === 1) c = slabLight;

    // Window 1 (x = 3..10) & Window 2 (x = 13..20)
    const w1 = x >= 3 && x <= 10;
    const w2 = x >= 13 && x <= 20;
    // Third bay (x = 23..29): recessed tenement balcony loggia on styles 0,1,5 or third window on others
    const w3 = x >= 23 && x <= 29;
    const hasLoggia = !isGrey && (styleIdx === 0 || styleIdx === 1 || styleIdx === 5);

    // Concrete chajja sunshade overhang (y = 3) & cast shadow (y = 4)
    if (y === 3 && ((x >= 2 && x <= 11) || (x >= 12 && x <= 21) || (x >= 22 && x <= 30))) {
      c = chajjaTop;
    } else if (y === 4 && (w1 || w2 || w3)) {
      c = shadow;
    } else if (y >= 5 && y <= 11 && (w1 || w2 || (!hasLoggia && w3))) {
      // Window opening with outer frame, center mullion, and glass reflection
      const isEdge = y === 5 || x === 3 || x === 10 || x === 13 || x === 20 || x === 23 || x === 29;
      const isMullion = x === 6 || x === 7 || x === 16 || x === 17 || x === 26;
      const isGlint = (y === 6 || y === 7) && (x === 4 || x === 14 || x === 24);
      c = isEdge ? frame : isMullion ? sill : isGlint ? glassHi : glass;
    } else if (y === 12 && (w1 || w2 || (!hasLoggia && w3))) {
      c = sill;
    } else if (hasLoggia && w3 && y >= 5 && y <= 14) {
      // Recessed balcony loggia with pixel iron railing at y = 11..14
      if (y === 11) c = chajjaTop;
      else if (y > 11 && (x % 2 === 0)) c = frame;
      else c = loggia;
    }

    // Vertical division line between tenement bays
    if (x === 0 && y >= 2) c = mult(rgb, 0.86);

    data.set([c[0], c[1], c[2], 255], 4 * (y * w + x));
  }
  return { width: w, height: h, data };
}

// 16x16 pixel-art roof texture: raised 2px concrete parapet border, pressed-clay tile grid,
// black cylindrical Sintex water tank + shadow, and staircase mumty / skylight hatch
function roofPicture(rgb, name) {
  const w = 16, h = 16, data = new Uint8ClampedArray(w * h * 4);
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  const shift = (c, d) => c.map(v => clamp(v + d));
  const mult  = (c, k) => c.map(v => clamp(v * k));

  const parapetSun  = shift(rgb, 34);
  const parapetShade = mult(rgb, 0.72);
  const innerShadow = mult(rgb, 0.56);
  const tileGroove  = mult(rgb, 0.88);
  const tankBody    = [28, 32, 38];
  const tankGlint   = [110, 124, 142];
  const mumtyTop    = shift(rgb, 42);
  const mumtySide   = mult(rgb, 0.76);
  const isGrey      = name === "g0" || name === "g1" || name === "g2" || name === "pick";
  const vIdx        = isGrey ? 0 : (+name || 0);

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const b = BAYER4[y & 3][x & 3];
    let c = b < 4 ? shift(rgb, -4) : b > 12 ? shift(rgb, 4) : rgb;

    // Pressed clay tile grid every 4 px
    if (x % 4 === 0 || y % 4 === 0) c = tileGroove;

    // Raised 2px perimeter parapet wall + inner cast shadow
    if (x === 0 || y === 0) c = parapetSun;
    else if (x === 15 || y === 15) c = parapetShade;
    else if (x === 1 || y === 1) c = shift(rgb, 18);
    else if (x === 14 || y === 14) c = mult(rgb, 0.80);
    else if (x === 2 || y === 2) c = innerShadow;

    // Black Sintex rooftop water tank at (4..6, 4..6) + cast shadow at (7, 5..6)
    if (x >= 4 && x <= 6 && y >= 4 && y <= 6) {
      c = (x === 4 && y === 4) ? tankGlint : tankBody;
    } else if (x === 7 && (y === 5 || y === 6)) {
      c = innerShadow;
    }

    // Staircase headroom (mumty) box at (9..12, 8..11) on city roofs
    if (!isGrey && vIdx % 2 === 0 && x >= 9 && x <= 12 && y >= 8 && y <= 11) {
      if (x === 12 || y === 11) c = mumtySide;
      else c = mumtyTop;
    } else if (!isGrey && vIdx % 2 === 0 && x === 13 && y >= 9 && y <= 12) {
      c = innerShadow;
    }

    data.set([c[0], c[1], c[2], 255], 4 * (y * w + x));
  }
  return { width: w, height: h, data };
}

// 24x24 pixel-art sprite generator for Chennai landmarks, ships, fishing boats, palms, trains & buses
function spriteIcon(kind) {
  const w = 24, h = 24, data = new Uint8ClampedArray(w * h * 4);
  const px = (x, y, rgb, a = 255) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = 4 * (y * w + x);
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = a;
  };
  const rect = (x0, y0, x1, y1, rgb, a = 255) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(x, y, rgb, a);
  };
  const BLK = [20, 22, 26], WHT = [250, 250, 246], GOLD = [250, 204, 21];

  if (kind === "ico-temple") {
    // Dravidian Gopuram stepped colourful temple tower with gold kalasams
    rect(5, 19, 18, 22, BLK); rect(6, 19, 17, 21, [217, 119, 6]);
    const tiers = [
      [16, 18, 6, 17, [220, 38, 38]],
      [13, 15, 7, 16, [14, 165, 233]],
      [10, 12, 8, 15, [234, 179, 8]],
      [7,  9,  9, 14, [168, 85, 247]],
      [4,  6, 10, 13, [22, 163, 74]],
    ];
    for (const [y0, y1, x0, x1, col] of tiers) {
      rect(x0 - 1, y0, x1 + 1, y1, BLK);
      rect(x0, y0, x1, y1, col);
      for (let x = x0 + 1; x < x1; x += 2) px(x, y0 + 1, GOLD);
    }
    px(10, 2, GOLD); px(12, 2, GOLD); px(13, 2, GOLD);
    px(11, 17, BLK); px(12, 17, BLK); px(11, 20, BLK); px(12, 20, BLK);
  } else if (kind === "ico-heritage") {
    // Chennai Central / Indo-Saracenic Red-Brick Clock Tower
    rect(3, 13, 20, 21, BLK);
    rect(4, 14, 19, 20, [185, 28, 28]);
    rect(9, 4, 14, 20, BLK);
    rect(10, 5, 13, 19, [220, 38, 38]);
    rect(10, 2, 13, 4, WHT); px(11, 1, GOLD); px(12, 1, GOLD);
    rect(10, 7, 13, 10, WHT); px(11, 8, BLK); px(12, 9, BLK); // clock face
    for (const x of [6, 11, 16]) { rect(x, 17, x + 1, 20, BLK); px(x, 15, WHT); }
  } else if (kind === "ico-lighthouse") {
    // Marina Beach Red & White Striped Lighthouse
    rect(7, 20, 16, 22, [234, 179, 8]);
    rect(8, 5, 15, 20, BLK);
    for (let y = 6; y <= 19; y++) {
      const col = Math.floor((y - 6) / 3) % 2 === 0 ? [220, 38, 38] : WHT;
      rect(9, y, 14, y, col);
    }
    rect(8, 3, 15, 5, GOLD); rect(9, 1, 14, 2, [220, 38, 38]);
  } else if (kind === "ico-tower") {
    // Anna Nagar Octagonal Tower + Green Park Base
    rect(4, 19, 19, 22, [22, 101, 52]);
    rect(9, 4, 14, 19, BLK);
    rect(10, 5, 13, 18, [229, 231, 235]);
    for (let y = 6; y <= 17; y += 3) rect(9, y, 14, y, [156, 163, 175]);
    rect(8, 2, 15, 4, [245, 158, 11]);
  } else if (kind === "ico-study") {
    // TNUHDB / PMAY Tenement Study Block (SimCity Orange/Gold Badge)
    rect(3, 5, 20, 21, BLK);
    rect(4, 6, 19, 8, WHT); // cool white roof
    rect(4, 9, 19, 20, [255, 106, 26]);
    for (const y of [11, 15, 18]) for (const x of [6, 11, 16]) rect(x, y, x + 1, y + 1, GOLD);
  } else if (kind === "ico-tech") {
    // Tidel Park / IT Glass High-Rise
    rect(4, 4, 19, 21, BLK);
    rect(5, 5, 18, 20, [14, 116, 144]);
    for (let y = 6; y <= 18; y += 3) for (let x = 6; x <= 16; x += 3) rect(x, y, x + 1, y + 1, [125, 211, 252]);
    rect(10, 2, 13, 4, [203, 213, 225]);
  } else if (kind === "ico-ship") {
    // Bay of Bengal Cargo Container Ship + White Wake
    rect(2, 16, 21, 17, [186, 230, 253], 200); // wake
    rect(4, 12, 19, 15, BLK);
    rect(5, 13, 18, 15, [185, 28, 28]);
    rect(6, 9, 9, 12, [234, 179, 8]);
    rect(10, 8, 13, 12, [37, 99, 235]);
    rect(15, 7, 18, 12, WHT); px(16, 8, BLK); px(17, 8, BLK);
  } else if (kind === "ico-boat") {
    // Kasimedu / Marina Blue Fishing Boat
    rect(5, 15, 18, 16, [224, 242, 254], 190);
    rect(7, 12, 16, 14, [29, 78, 216]);
    rect(10, 8, 13, 11, WHT);
    px(11, 7, [239, 68, 68]); px(12, 7, [239, 68, 68]);
  } else if (kind === "ico-palm") {
    // Chennai Coconut Palm Tree
    rect(11, 11, 12, 21, [110, 78, 52]);
    px(10, 14, [90, 62, 40]); px(10, 17, [90, 62, 40]);
    const green = [34, 139, 64], hi = [74, 182, 96];
    rect(6, 7, 17, 10, green);
    rect(4, 9, 7, 11, green); rect(16, 9, 19, 11, green);
    rect(8, 5, 15, 7, hi);
    px(10, 10, [120, 68, 32]); px(13, 10, [120, 68, 32]); // coconuts
  } else if (kind === "ico-train") {
    // Chennai Suburban / MRTS Rail Coach
    rect(2, 9, 21, 16, BLK);
    rect(3, 10, 20, 15, [37, 99, 235]);
    rect(3, 13, 20, 13, GOLD);
    for (let x = 5; x <= 18; x += 3) rect(x, 11, x + 1, 12, [224, 242, 254]);
  } else if (kind === "ico-bus") {
    // Yellow Auto-Rickshaw / MTC Bus Badge
    rect(5, 9, 18, 16, BLK);
    rect(6, 10, 17, 12, GOLD);
    rect(6, 13, 17, 15, [30, 41, 59]);
    rect(8, 11, 10, 12, [186, 230, 253]); rect(13, 11, 15, 12, [186, 230, 253]);
  }
  return { width: w, height: h, data };
}

// Pictures are made when the map first asks for them: "wall-<theme>-<name>", "roof-<theme>-<name>", "pat-<theme>-<kind>", or "ico-<kind>"
function missingImage(e) {
  if (uMap.hasImage(e.id)) return;
  if (e.id.startsWith("ico-")) {
    uMap.addImage(e.id, spriteIcon(e.id));
    return;
  }
  const [kind, tag, name] = e.id.split("-");
  if (kind === "pat") {
    uMap.addImage(e.id, surfacePicture(name, tag === "d"));
    return;
  }
  if (kind === "roof") {
    const rgb = GREY_WALLS[name] || ROOF_TONES[+name];
    if (rgb) uMap.addImage(e.id, roofPicture(dim(rgb), name));
    return;
  }
  if (kind !== "wall") return;
  const rgb = GREY_WALLS[name] || WALL_TONES[+name];
  if (rgb) uMap.addImage(e.id, wallPicture(dim(rgb), name));
}
const wallName = name => `wall-${themeTag()}-${name}`;
const roofName = name => `roof-${themeTag()}-${name}`;
const cityWalls = () => ["match", tone(WALL_TONES.length), ...WALL_TONES.flatMap((_, i) => [i, wallName(i)]).slice(0, -2), wallName(WALL_TONES.length - 1)];
const cityRoofs = () => { const t = ROOF_TONES.map(c => css(dim(c))); return ["match", tone(ROOF_TONES.length), 0, t[0], 1, t[1], 2, t[2], 3, t[3], t[4]]; };
const cityRoofPatterns = () => ["match", tone(ROOF_TONES.length), ...ROOF_TONES.flatMap((_, i) => [i, roofName(i)]).slice(0, -2), roofName(ROOF_TONES.length - 1)];
function areaWalls() {
  const byHeight = ["step", ["get", "h"], wallName("g0"), 9, wallName("g1"), 18, wallName("g2")];
  return urban.picked ? ["case", ["==", ["get", "bid"], urban.picked.id], wallName("pick"), byHeight] : byHeight;
}
function areaRoofPatterns() {
  const byHeight = ["step", ["get", "h"], roofName("g0"), 9, roofName("g1"), 18, roofName("g2")];
  return urban.picked ? ["case", ["==", ["get", "bid"], urban.picked.id], roofName("pick"), byHeight] : byHeight;
}

// Walls and roofs of the analysis area (pure grey 3D building volumes, the picked building orange)
function paintArea() {
  if (!mapReady) return;
  uMap.setPaintProperty("cells", "fill-extrusion-color", areaColour());
  if (uMap.getLayer("cells-roof")) uMap.setPaintProperty("cells-roof", "fill-extrusion-color", areaColour());
}
// Walls and roofs of the rest of the city (colourful with parapet + Sintex water tank roof textures)
function paintCity() {
  if (!uMap.getSource("overture")) return;
  uMap.setPaintProperty("city", "fill-extrusion-pattern", cityWalls());
  if (uMap.getLayer("city-roof")) {
    uMap.setPaintProperty("city-roof", "fill-extrusion-color", cityRoofs());
    uMap.setPaintProperty("city-roof", "fill-extrusion-pattern", cityRoofPatterns());
  }
}
function setCityFilter(filter) {
  uMap.setFilter("city", filter);
  if (uMap.getLayer("city-roof")) uMap.setFilter("city-roof", filter);
}

// Added once the map is up: textured roofs (parapets + Sintex tanks + mumties), 3-tier pixel trees,
// ambient ships/boats/palms/trains/buses, lane traffic dashes & bilingual Chennai landmark icons
function addDetail() {
  const cityHeight = ["coalesce", ["get", "height"], ["*", 3, ["coalesce", ["get", "num_floors"], 2]]];
  if (uMap.getSource("overture")) {
    uMap.addLayer({ id: "city-roof", type: "fill-extrusion", source: "overture", "source-layer": "building", minzoom: 13,
      paint: { "fill-extrusion-color": cityRoofs(), "fill-extrusion-pattern": cityRoofPatterns(),
               "fill-extrusion-base": cityHeight, "fill-extrusion-height": ["+", cityHeight, 0.55],
               "fill-extrusion-vertical-gradient": false } }, "places");
    paintCity();
  }
  uMap.addLayer({ id: "cells-roof", type: "fill-extrusion", source: "cells",
    paint: { "fill-extrusion-color": areaColour(),
             "fill-extrusion-base": ["get", "h"], "fill-extrusion-height": ["+", ["get", "h"], 0.35],
             "fill-extrusion-vertical-gradient": false } }, "outlines");
  // 3-tier pixel trees: brown trunk (0..1.8m) + main crown + bright sun-lit crown top
  uMap.addLayer({ id: "trees-trunk", type: "fill-extrusion", source: "trees",
    paint: { "fill-extrusion-color": isDark() ? "#4a3525" : "#6e4e34", "fill-extrusion-base": 0, "fill-extrusion-height": 1.8 } }, "trees");
  uMap.addLayer({ id: "trees-top", type: "fill-extrusion", source: "trees",
    paint: { "fill-extrusion-color": TREE_TOP(), "fill-extrusion-base": ["get", "h"], "fill-extrusion-height": ["+", ["get", "h"], 1.5],
             "fill-extrusion-vertical-gradient": false } });
  // Road centre markings & yellow pixel auto/bus streaks on major Chennai arteries
  uMap.addLayer({ id: "road-dash", type: "line", source: "city", "source-layer": "transportation", minzoom: 14,
    filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "class"], ["literal", MAJOR_ROADS]]],
    paint: { "line-color": "#ffffff", "line-opacity": 0.8, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.6, 19, 2.4], "line-dasharray": [4, 5] } }, "city");
  uMap.addLayer({ id: "road-autos", type: "line", source: "city", "source-layer": "transportation", minzoom: 14,
    filter: ["all", ["==", ["geometry-type"], "LineString"], ["in", ["get", "class"], ["literal", ["trunk", "primary"]]]],
    paint: { "line-color": "#facc15", "line-opacity": 0.9, "line-width": ["interpolate", ["linear"], ["zoom"], 14, 1.2, 19, 4.2], "line-dasharray": [1.5, 14] } }, "city");

  // Ambient pixel sprites: Bay of Bengal ships, Kasimedu fishing boats, palms, suburban trains & buses
  uMap.addSource("ambient-sprites", { type: "geojson", data: CHENNAI_AMBIENT_SPRITES });
  uMap.addLayer({ id: "ambient-sprites", type: "symbol", source: "ambient-sprites", minzoom: 11,
    layout: {
      "icon-image": ["get", "icon"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 11, 0.75, 16, 1.25],
      "icon-allow-overlap": true,
    } });

  // Bilingual English + Tamil landmark badges with custom pixel-art icons across Greater Chennai
  uMap.addSource("landmarks", { type: "geojson", data: CHENNAI_LANDMARKS });
  uMap.addLayer({ id: "landmarks-pin", type: "symbol", source: "landmarks", minzoom: 9.5,
    layout: {
      "icon-image": ["get", "icon"],
      "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.85, 16, 1.35],
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
    } });
  uMap.addLayer({ id: "landmarks-label", type: "symbol", source: "landmarks", minzoom: 10.5,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": ["match", ["get", "kind"], "study", 11.5, 10.5],
      "text-offset": [0, 0.3],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-color": isDark() ? "#fef08a" : "#1e1b18",
      "text-halo-color": isDark() ? "#111318" : "#fffbeb",
      "text-halo-width": 1.8,
    } });
}
const TREE_TOP = () => isDark() ? "#4f9a5c" : "#82c978";

async function runUrban() {
  const btn = $("u-run");
  btn.disabled = true; btn.textContent = "Running the urban model…";
  try {
    const body = { ...place(), site_coverage: uNum("u-coverage") / 100, mean_height_m: uNum("u-height"),
                   facade_to_site: uNum("u-facade"), tree_cover: uNum("u-trees") / 100, grass_cover: uNum("u-grass") / 100,
                   buildings: urban.form?.buildings ?? null, height_tagged_share: urban.form?.height_tagged_share ?? 0 };
    if ($("u-homes").value) body.homes = $("u-homes").value;
    if (uNum("u-street-heat") >= 0) body.street_heat_w_m2 = uNum("u-street-heat");   // left empty = the server's default
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
  $("u-draw").addEventListener("click", toggleDrawing);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && urban.drawing) { urban.drawing = null; showDrawing(); } });
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
    // the homes the urban model puts around the site, and the street heat (urban.CITY_HOMES, SENS_ANTH_W_M2)
    $("u-homes").innerHTML = Object.entries(data.homes || {}).map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join("");
    $("u-homes").value = data.site?.homes || data.default_homes || "";
    $("u-street-heat").value = data.site?.street_heat_w_m2 ?? data.street_heat_w_m2 ?? 20;
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
  setTimeout(() => { readMap(); }, 250);
}

window.urban = urban;
window.place = place;
window.placeMoved = placeMoved;
window.oasisArea = { ring: areaRing, drawing: () => !!urban.drawing, click: zoneClick,
                     holds: (lat, lon) => { const p = place(); return !!urban.grid && inArea(...toLocal([lon, lat], p), p); } };
window.pickBuilding = pickBuilding;
window.readMap = readMap;

// No painted map (px_viewer.js is not in this copy, or its library did not load): our own map is the view
window.addEventListener("load", () => {
  if (window.pxOasis) return;
  $("px-wrap").style.display = "none";
  document.querySelector('.u-views [data-view="painted"]').style.display = "none";
  mapView = "model";
  markMapView();
});
startUrban();
