// OASIS 2.0 — Neighbourhood tab (urban layer, oasis/urban.py).
// Place on the map -> urban form -> street air -> handed to the Home tab as the
// outdoor air "Site". Uses the helpers and state of app.js ($, api, esc, pad, toast, OPT, state).

let urban = { places: [], buildings: [], form: null, grid: null, around: null, site: null, radius: 250 };
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
    Object.assign(urban, { buildings: data.buildings, form: data.form, grid: data.grid, around: data.surroundings, radius: p.radius_m });
    fillForm(data.form);
    drawMap();
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

// Satellite heights as a small picture (one pixel per 4 m cell), stronger = taller
function heightImage(grid, top) {
  const n = grid.heights.length, canvas = document.createElement("canvas");
  canvas.width = canvas.height = n;
  const ctx = canvas.getContext("2d"), img = ctx.createImageData(n, n);
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const [r, g, b] = dark ? [236, 238, 241] : [16, 18, 22];
  grid.heights.forEach((row, y) => row.forEach((h, x) => {
    const i = 4 * (y * n + x);
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
    img.data[i + 3] = h > 0 ? Math.round(255 * (0.22 + 0.68 * Math.min(1, h / top))) : 0;
  }));
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

// Top of the colour scale: the height 98% of the built cells stay under (one tower would wash out the rest)
function topHeight(grid) {
  const built = grid.heights.flat().filter(h => h > 0).sort((a, b) => a - b);
  return built.length ? built[Math.floor(0.98 * (built.length - 1))] : 0;
}

function drawMap() {
  const R = urban.radius, pad_m = R * 0.12, size = 2 * (R + pad_m), g = urban.grid;
  const inside = urban.buildings.filter(b => b.inside);
  const top = g ? Math.max(6, topHeight(g)) : Math.max(6, ...inside.map(b => b.height_m));
  const outlines = urban.buildings.map(b => {
    const pts = b.xy.map(([x, y]) => `${x.toFixed(1)},${(-y).toFixed(1)}`).join(" ");
    if (g) return `<polygon points="${pts}" fill="none" stroke="var(--accent)" stroke-opacity=".55" stroke-width="${(R / 300).toFixed(1)}"/>`;
    if (!b.inside) return `<polygon points="${pts}" fill="var(--grid)" opacity=".5"/>`;
    return `<polygon points="${pts}" fill="var(--fg-2)" fill-opacity="${(0.25 + 0.65 * b.height_m / top).toFixed(2)}"><title>${b.height_m.toFixed(0)} m</title></polygon>`;
  }).join("");
  const picture = g ? `<image href="${heightImage(g, top)}" x="${-g.half_m}" y="${-g.half_m}" width="${2 * g.half_m}" height="${2 * g.half_m}" preserveAspectRatio="none" style="image-rendering:pixelated"/>` : "";
  const rays = (urban.around?.rays || []).filter(r => r.gap_m !== null && r.gap_m <= 30).map(r => {
    const a = r.bearing * Math.PI / 180;
    return `<line x1="0" y1="0" x2="${(Math.sin(a) * r.gap_m).toFixed(1)}" y2="${(-Math.cos(a) * r.gap_m).toFixed(1)}" stroke="var(--accent)" stroke-width="${(R / 200).toFixed(1)}"><title>${r.gap_m} m to a ${r.height_m} m building</title></line>`;
  }).join("");
  const bar = R >= 300 ? 200 : 100, fs = R / 18;
  $("u-map").innerHTML = `<svg viewBox="${-R - pad_m} ${-R - pad_m} ${size} ${size}" role="img" aria-label="Buildings around the place">
    <defs><clipPath id="u-clip"><circle r="${R}"/></clipPath></defs>
    <circle r="${R}" fill="var(--card)" stroke="var(--ring)" stroke-width="${R / 250}" stroke-dasharray="${R / 40} ${R / 40}"/>
    <g clip-path="url(#u-clip)">${picture}${outlines}</g>
    ${rays}<circle r="${R / 70}" fill="var(--accent)"/>
    <g font-family="var(--mono)" font-size="${fs}" fill="var(--muted-fg)">
      <line x1="${-R}" y1="${R + pad_m * 0.5}" x2="${-R + bar}" y2="${R + pad_m * 0.5}" stroke="var(--muted-fg)" stroke-width="${R / 150}"/>
      <text x="${-R + bar + fs / 2}" y="${R + pad_m * 0.5 + fs / 3}">${bar} m</text>
      <text x="${R - fs}" y="${-R + fs * 0.4}" text-anchor="middle">N ↑</text>
    </g></svg>`;
  $("u-map-key").textContent = g
    ? `Shaded cells: buildings from satellite data, stronger shade = taller (scale tops out at ${top.toFixed(0)} m). Orange outlines: buildings on the street map. Orange spokes from the centre: the gap to the nearest building in that direction, used for shading in the Home tab.`
    : `Darker = taller (up to ${top.toFixed(0)} m, from your storeys). Pale shapes lie outside the ${R} m circle.`;
}

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
    const data = await api("/api/urban/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    urban.site = data.site;
    setSiteWeather(data.weather);
    renderUrban();
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
      <ul class="u-list">${s.assumptions.map(a => `<li><span class="tagline ${a.status === "Mapped" ? "mapped" : a.status === "Assumed" ? "assumed" : "chosen"}">${esc(a.status)}</span>${esc(a.text)}</li>`).join("")}</ul></div>`;
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
  $("u-read").addEventListener("click", readMap);
  $("u-run").addEventListener("click", runUrban);
  $("u-form").addEventListener("submit", e => e.preventDefault());
  for (const id of ["u-coverage", "u-height", "u-facade"]) $(id).addEventListener("input", () => {
    $("u-run").disabled = !(uNum("u-coverage") && uNum("u-height") && uNum("u-facade"));
  });
  try {
    const data = await api("/api/urban");
    urban.places = data.places;
    $("u-place").innerHTML = data.places.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join("");
    $("u-place").addEventListener("change", e => fillPlace(urban.places[+e.target.value]));
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
}

startUrban();
