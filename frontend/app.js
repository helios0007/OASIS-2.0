// ============================================================================
// OASIS · Overheating Check (front end for backend/main.py)
//
// Flow: inputs -> POST /api/assess -> safe hours + every single change ranked.
// Applying a change makes it the new design and re-simulates; every run is
// kept in a "design trail" so the user can step back.
// ============================================================================

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp01 = x => Math.max(0, Math.min(1, x));
const HOURS = 168;
const SVG = "http://www.w3.org/2000/svg";

// Which choices sit in which block of the input sheet
const ENVELOPE = ["wall", "roof", "roof_solar_absorptance", "shading_depth_m"];
const USE = ["floor", "occupants", "night_vent"];
const ROOF_ONLY = ["roof", "roof_solar_absorptance"];      // no effect on a middle floor
const ORIENTATION = { key: "orientation_deg", title: "Windows face",
  options: [{ value: 0, label: "North & South" }, { value: 90, label: "East & West" }] };
const ROOF_SWATCH = { 0.7: "#6b665c", 0.4: "#b5afa3", 0.2: "#ffffff" };

let OPT = null;          // /api/options
let state = {};          // current design (Building fields)
let agentsRoster = [];   // customizable human occupant agents (JOS-3)
let activeAgentIdx = 0;  // highlighted agent in room stage & chart
let playTimer = null;    // interval for playing through the 168h week
let model = null;        // Rhino geometry, or null
let result = null;       // last /api/assess response
let ranFor = null;       // payload text of the last result
let preview = null;      // change being hovered (its hourly series is drawn)
let trail = [];          // [{label, safe, snapshot}]
let pendingLabel = null; // label for the next trail entry
let requestNo = 0;
let hour = 116;          // hour shown in readout & room stage (default: 14 May, 20:00 power cut)

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(body.detail) ? body.detail.map(d => d.msg).join("; ") : body.detail;
    throw new Error(detail || `Server error (${response.status}).`);
  }
  return body;
}

function engine(text, kind) {
  $("engine-text").textContent = text;
  $("engine").className = "engine " + (kind || "");
}

const limit = () => OPT.scenario.safe_limit_c;
const choice = key => key === ORIENTATION.key ? ORIENTATION : OPT.choices.find(c => c.key === key);
const labelOf = (key, value) => (choice(key)?.options.find(o => o.value === value) || {}).label ?? String(value);
const isCut = h => {
  const hr = h % 24;
  return hr >= OPT.scenario.cut_start_hour && hr < OPT.scenario.cut_end_hour;
};
const dayName = d => `${OPT.scenario.first_day + d} ${OPT.scenario.month}`;
const pad = n => String(n).padStart(2, "0");
const hourName = h => `${dayName(Math.floor(h / 24))}, ${pad(h % 24)}:00`;

// Small technical note under each option (from the physics the server reports)
function optionNote(key, value) {
  const ph = OPT.physics || {};
  if (key === "wall" && ph.walls?.[value]) return `U ${ph.walls[value].u_value}`;
  if (key === "roof" && ph.roofs?.[value]) return `U ${ph.roofs[value].u_value}`;
  if (key === "roof_solar_absorptance") return `α ${value.toFixed(1)}`;
  if (key === "occupants") return `${value * (ph.activity_w || 100)} W`;
  return "";
}

// ---------------------------------------------------------------------------
// Input sheet
// ---------------------------------------------------------------------------
function choiceHtml(c) {
  const opts = c.options.map((o, i) => {
    const note = optionNote(c.key, o.value);
    const swatch = c.key === "roof_solar_absorptance"
      ? `<i class="swatch" style="background:${ROOF_SWATCH[o.value] || "transparent"}"></i>` : "";
    return `<label><input type="radio" name="${c.key}" value="${i}">
      <span>${swatch ? `<span>${swatch}${esc(o.label)}</span>` : esc(o.label)}${note ? `<small>${esc(note)}</small>` : ""}</span></label>`;
  }).join("");
  return `<div class="choice" data-key="${c.key}">
    <span class="choice-title">${esc(c.title)}<small data-note="${c.key}"></small></span>
    <div class="seg">${opts}</div></div>`;
}

function buildForm() {
  $("seg-orientation_deg").innerHTML = ORIENTATION.options.map((o, i) =>
    `<label><input type="radio" name="orientation_deg" value="${i}"><span>${o.label}</span></label>`).join("");
  $("envelope").innerHTML = ENVELOPE.map(k => choice(k)).filter(Boolean).map(choiceHtml).join("");
  $("use").innerHTML = USE.map(k => choice(k)).filter(Boolean).map(choiceHtml).join("");

  $("form").addEventListener("change", e => {
    const name = e.target.name;
    if (name && e.target.type === "radio") state[name] = choice(name).options[+e.target.value].value;
    readNumbers();
    syncForm();
  });
  $("form").addEventListener("input", e => { if (e.target.type === "number") { readNumbers(); syncForm(); } });
  $("form").addEventListener("submit", e => { e.preventDefault(); simulate(); });
}

function readNumbers() {
  if (model) return;                       // geometry comes from the Rhino model
  for (const id of ["length_m", "width_m", "height_m"]) {
    const v = parseFloat($(id).value);
    if (!Number.isNaN(v)) state[id] = v;
  }
  const w = parseFloat($("wwr_pct").value);
  if (!Number.isNaN(w)) state.wwr = w / 100;
}

// Push state into the form and refresh dependent bits (locks, notes, stale flag)
function syncForm() {
  for (const key of [ORIENTATION.key, ...ENVELOPE, ...USE]) {
    const c = choice(key);
    if (!c) continue;
    const i = c.options.findIndex(o => o.value === state[key]);
    document.querySelectorAll(`input[name="${key}"]`).forEach(r => { r.checked = +r.value === i; });
  }
  const active = document.activeElement;
  for (const id of ["length_m", "width_m", "height_m"]) {
    if (active !== $(id)) $(id).value = +state[id].toFixed(2);
  }
  if (active !== $("wwr_pct")) $("wwr_pct").value = Math.round(state.wwr * 100);

  // Rhino model locks geometry, windows and orientation
  $("geometry").classList.toggle("locked", !!model);
  document.querySelectorAll('input[name="orientation_deg"]').forEach(r => { r.disabled = !!model; });

  // Middle floor: the roof belongs to the flat above
  const middle = state.floor === "middle";
  for (const key of ROOF_ONLY) {
    const el = document.querySelector(`.choice[data-key="${key}"]`);
    if (!el) continue;
    el.classList.toggle("off", middle);
    el.querySelectorAll("input").forEach(r => { r.disabled = middle; });
    el.querySelector("[data-note]").textContent = middle ? "flat above" : "";
  }

  const area = state.length_m * state.width_m;
  $("area").textContent = `${area.toFixed(1)} m² floor · ${(area * state.height_m).toFixed(0)} m³ air`
    + (model ? ` · glass from model (${model.report.window_to_wall_pct} % of walls)` : "");

  const stale = result && JSON.stringify(payload()) !== ranFor;
  $("run").classList.toggle("stale", !!stale);
  if (!$("run").disabled) $("run").textContent = stale ? "Re-simulate · inputs changed" : "Simulate week";
}

function payload() {
  const keys = ["length_m", "width_m", "height_m", "orientation_deg", "floor", "wall", "roof",
    "roof_solar_absorptance", "wwr", "shading_depth_m", "night_vent", "occupants"];
  const p = Object.fromEntries(keys.map(k => [k, state[k]]));
  if (model) Object.assign(p, model.geometry);   // dims, orientation and glass per wall
  p.agents = agentsRoster;
  return p;
}

// ---------------------------------------------------------------------------
// Occupant Agents Roster (Block 04)
// ---------------------------------------------------------------------------
function buildRoster() {
  const wrap = $("agent-roster");
  if (!wrap) return;
  wrap.innerHTML = agentsRoster.map((a, idx) => `
    <div class="roster-item" data-idx="${idx}">
      <div class="roster-top">
        <input type="text" class="roster-name" data-f="name" value="${esc(a.name)}" aria-label="Occupant name">
        ${agentsRoster.length > 1 ? `<button type="button" class="roster-del" data-del="${idx}" title="Remove occupant">✕</button>` : ""}
      </div>
      <div class="roster-grid">
        <label class="roster-field"><span>Age (y)</span><input type="number" data-f="age" min="1" max="100" step="1" value="${a.age}"></label>
        <label class="roster-field"><span>Sex</span>
          <select data-f="sex">
            <option value="female" ${a.sex === "female" ? "selected" : ""}>Female</option>
            <option value="male" ${a.sex === "male" ? "selected" : ""}>Male</option>
          </select>
        </label>
        <label class="roster-field"><span>Role</span>
          <select data-f="role">
            <option value="elderly" ${a.role === "elderly" ? "selected" : ""}>Elderly (Home)</option>
            <option value="homemaker" ${a.role === "homemaker" ? "selected" : ""}>Homemaker (Cooks)</option>
            <option value="worker" ${a.role === "worker" ? "selected" : ""}>Worker (Away day)</option>
            <option value="child" ${a.role === "child" ? "selected" : ""}>Child (Studies/Play)</option>
          </select>
        </label>
        <label class="roster-field"><span>Height (cm)</span><input type="number" data-f="height_cm" min="60" max="220" step="1" value="${a.height_cm}"></label>
        <label class="roster-field"><span>Weight (kg)</span><input type="number" data-f="weight_kg" min="8" max="160" step="1" value="${a.weight_kg}"></label>
        <label class="roster-field"><span>Clothing (clo)</span><input type="number" data-f="clothing_clo" min="0.2" max="1.2" step="0.05" value="${a.clothing_clo}"></label>
      </div>
    </div>
  `).join("");

  wrap.querySelectorAll(".roster-item").forEach(item => {
    const idx = +item.dataset.idx;
    item.querySelectorAll("input, select").forEach(inp => {
      inp.addEventListener("change", () => {
        const f = inp.dataset.f;
        const val = inp.type === "number" ? parseFloat(inp.value) : inp.value;
        if (inp.type === "number" && Number.isNaN(val)) return;
        agentsRoster[idx][f] = val;
        pendingLabel = `Updated occupant: ${agentsRoster[idx].name}`;
        syncForm();
        simulate();
      });
    });
  });

  wrap.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = +btn.dataset.del;
      agentsRoster.splice(idx, 1);
      if (activeAgentIdx >= agentsRoster.length) activeAgentIdx = 0;
      buildRoster();
      syncForm();
      simulate();
    });
  });
}

function bindRosterActions() {
  const addBtn = $("add-agent");
  if (!addBtn) return;
  addBtn.addEventListener("click", () => {
    const n = agentsRoster.length + 1;
    agentsRoster.push({
      id: `custom_${Date.now()}`,
      name: `Occupant ${n}`,
      age: 45,
      sex: "female",
      height_cm: 162,
      weight_kg: 64,
      clothing_clo: 0.40,
      role: "homemaker",
    });
    activeAgentIdx = agentsRoster.length - 1;
    pendingLabel = `Added Occupant ${n}`;
    buildRoster();
    syncForm();
    simulate();
  });

  const slider = $("hour-slider");
  if (slider) {
    slider.addEventListener("input", () => setHour(+slider.value));
  }
  const playBtn = $("play-btn");
  if (playBtn) {
    playBtn.addEventListener("click", () => {
      if (playTimer) {
        clearInterval(playTimer);
        playTimer = null;
        playBtn.textContent = "▶ Play week";
      } else {
        playBtn.textContent = "⏸ Pause";
        playTimer = setInterval(() => {
          setHour(((hour ?? 0) + 1) % HOURS);
        }, 180);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Rhino import
// ---------------------------------------------------------------------------
function setModel(data) {
  model = data;
  Object.assign(state, {
    length_m: data.geometry.length_m, width_m: data.geometry.width_m,
    height_m: data.geometry.height_m, orientation_deg: data.geometry.orientation_deg,
  });
  const r = data.report;
  const glass = Object.entries(r.windows || {})
    .map(([side, w]) => `${side[0].toUpperCase()} ${w.area_m2} m²`).join(" · ") || "no windows";
  $("model").innerHTML = `
    <div class="model-head"><span>${esc(r.file)}</span><button type="button" class="link" id="unload">remove</button></div>
    <span class="mono">${esc(r.size)}</span>
    <span class="mono">glass: ${esc(glass)}</span>
    ${(r.warnings || []).map(w => `<span class="warn">${esc(w)}</span>`).join("")}`;
  $("model").hidden = false;
  $("drop").hidden = true;
  $("unload").onclick = () => {
    model = null;
    $("model").hidden = true;
    $("drop").hidden = false;
    syncForm();
  };
  pendingLabel = `Imported ${r.file}`;
  syncForm();
  simulate();
}

async function upload(file) {
  $("upload-error").hidden = true;
  const form = new FormData();
  form.append("file", file);
  try {
    setModel(await api("/api/rhino", { method: "POST", body: form }));
  } catch (err) {
    $("upload-error").textContent = err.message;
    $("upload-error").hidden = false;
  }
}

function bindRhino() {
  const drop = $("drop");
  $("file").addEventListener("change", e => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ""; });
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
  });
  $("sample").hidden = !OPT.has_sample_rhino;
  $("sample").addEventListener("click", async e => {
    e.preventDefault(); e.stopPropagation();
    $("upload-error").hidden = true;
    try { setModel(await api("/api/rhino/sample", { method: "POST" })); }
    catch (err) { $("upload-error").textContent = err.message; $("upload-error").hidden = false; }
  });
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
async function simulate() {
  const body = payload();
  const text = JSON.stringify(body);
  const no = ++requestNo;
  const t0 = performance.now();
  const tick = setInterval(() => engine(`Simulating… ${((performance.now() - t0) / 1000).toFixed(0)} s`, "busy"), 500);
  engine("Simulating…", "busy");
  $("run").disabled = true;
  $("run").textContent = "Simulating…";
  $("output").classList.add("dim");
  $("error").hidden = true;
  if (!result) $("empty").querySelector(".empty-title").textContent = "Simulating the week in EnergyPlus…";

  try {
    const res = await api("/api/assess", { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
    if (no !== requestNo) return;
    result = res;
    ranFor = text;
    preview = null;
    trail.push({ label: pendingLabel || (trail.length ? "Edited inputs" : "Starting design"),
                 safe: res.summary.safe_hours, snapshot: { state: { ...state }, model } });
    pendingLabel = null;
    render();
    engine(`Done in ${((performance.now() - t0) / 1000).toFixed(1)} s`, "ok");
  } catch (err) {
    if (no !== requestNo) return;
    $("error").textContent = err.message;
    $("error").hidden = false;
    engine("Simulation failed", "bad");
  } finally {
    clearInterval(tick);
    if (no === requestNo) {
      $("run").disabled = false;
      $("output").classList.remove("dim");
      syncForm();
    }
  }
}

function applyChange(c) {
  state[c.parameter] = c.value;
  pendingLabel = `${c.title}: ${c.label}`;
  syncForm();
  simulate();
}

function undo() {
  if (trail.length < 2) return;
  trail.pop();
  const prev = trail.pop();                 // re-added when the run finishes
  state = { ...prev.snapshot.state };
  if (prev.snapshot.model) setModelQuiet(prev.snapshot.model); else clearModelQuiet();
  pendingLabel = prev.label;
  syncForm();
  simulate();
}
function setModelQuiet(m) { model = m; $("model").hidden = false; $("drop").hidden = true; }
function clearModelQuiet() { model = null; $("model").hidden = true; $("drop").hidden = false; }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  $("empty").hidden = true;
  $("output").hidden = false;
  renderVerdict();
  renderWeek();
  renderChart();
  renderPeaks();
  renderAgentChart();
  renderChanges();
  renderTrail();
  setHour(hour ?? 116);
}

function renderVerdict() {
  const s = result.summary;
  const lim = limit();
  $("score").textContent = s.safe_hours;
  const cutTotal = HOURS / 24 * (OPT.scenario.cut_end_hour - OPT.scenario.cut_start_hour);
  const days = Math.round(s.danger_hours / 24 * 10) / 10;
  $("verdict-line").innerHTML = s.danger_hours === 0
    ? `The flat stays below ${lim} °C felt heat for the whole heatwave week.`
    : `Occupants spend <b>${s.danger_hours} hours</b> above ${lim} °C felt heat this week, about ${days} days in total.`;

  const first = trail[0]?.safe;
  const delta = trail.length > 1 && first !== undefined ? s.safe_hours - first : null;
  const deltaHtml = delta === null ? "" :
    ` <small class="${delta >= 0 ? "delta-up" : "delta-down"}">${delta >= 0 ? "+" : ""}${delta} vs start</small>`;
  $("facts").innerHTML = `
    <div><dt>Safe hours</dt><dd>${s.safe_hours}${deltaHtml}</dd></div>
    <div><dt>Power-cut hours in danger</dt><dd>${s.cut_hours_in_danger} <small>of ${cutTotal}</small></dd></div>
    <div><dt>Peak felt heat</dt><dd>${s.max_heat_index_c} <small>°C</small></dd></div>
    <div><dt>Peak indoor air</dt><dd>${s.max_indoor_temp_c} <small>°C</small></dd></div>`;
  renderCheck();
}

// Two peaks: the room's normal daily peak, and the peak during the power cut.
// The cut only removes the fan credit, so every hour can be tested as a cut hour.
function renderPeaks() {
  const p = result.peaks, el = $("cutscan");
  if (!p || !el) return;
  const lim = limit(), n = p.normal, c = p.cut, w = p.by_hour[p.worst_cut_hour];
  $("peaks-line").innerHTML = `<b>Normal peak:</b> the room is hottest around <b>${pad(n.typical_hour)}:00</b>
    (up to ${n.max_indoor_temp_c} °C air, ${n.max_heat_index_c} °C felt with the fan on).
    <b>During the ${pad(c.start_hour)}:00–${pad(c.end_hour)}:00 cut:</b> up to ${c.max_indoor_temp_c} °C air and
    <b>${c.max_heat_index_c} °C felt</b>, above ${lim} °C on ${c.nights_in_danger} of ${c.days} nights.
    The worst hour for a cut is <b>${pad(w.hour)}:00</b> (${w.max_heat_index_no_fan_c} °C felt, ${w.days_in_danger} of ${c.days} days).`;
  const hiMin = 30, hiMax = Math.max(...p.by_hour.map(r => r.max_heat_index_no_fan_c), lim + 5);
  el.innerHTML = p.by_hour.map(r => {
    const hgt = Math.max(4, Math.round(100 * (r.max_heat_index_no_fan_c - hiMin) / (hiMax - hiMin)));
    const cut = r.hour >= c.start_hour && r.hour < c.end_hour;
    return `<div class="cs-col${cut ? " cut" : ""}" title="${pad(r.hour)}:00 · fan off: up to ${r.max_heat_index_no_fan_c} °C felt · ${r.days_in_danger}/${c.days} days above ${lim} °C · mean air ${r.mean_indoor_temp_c} °C">
      <span class="cs-n">${r.days_in_danger || ""}</span>
      <span class="cs-bar" style="height:${hgt}%;background:${cellColour(r.max_heat_index_no_fan_c)}"></span>
      <span class="cs-h">${r.hour === n.typical_hour ? "▲" : ""}${pad(r.hour)}</span>
    </div>`;
  }).join("");
}

// Check measure: does the JOS-3 household agree with the heat index hour by hour?
function renderCheck() {
  const el = $("check");
  if (!el) return;
  const c = result.check;
  if (!c) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>Check · body model (JOS-3, ${c.people_modelled} adult${c.people_modelled > 1 ? "s" : ""}):</b>
    everyone stays below ${c.core_limit_c.toFixed(1)} °C core in <b>${c.household_safe_hours}</b> of 168 h.
    It agrees with the heat index in ${c.hours_agree} h. In <b>${c.hi_safe_but_body_over_limit} h</b> the heat index
    calls the hour safe while someone is over the limit (most affected: ${esc(c.most_affected)}); in
    ${c.hi_danger_but_bodies_ok} h it calls danger while every body stays below it.`;
}

function cellColour(hi) {
  const lim = limit();
  if (hi < lim) {
    const t = clamp01((hi - 28) / (lim - 28));
    return `color-mix(in oklab, var(--safe-warm) ${Math.round(t * 100)}%, var(--safe))`;
  }
  const t = clamp01((hi - lim) / 8);
  return `color-mix(in oklab, var(--heat-deep) ${Math.round(t * 100)}%, var(--heat))`;
}

function renderWeek() {
  const week = $("week");
  if (!week.dataset.built) {
    let html = `<span></span>`;
    for (let h = 0; h < 24; h++) html += `<span class="hr">${pad(h)}</span>`;
    for (let d = 0; d < 7; d++) {
      html += `<span class="day">${dayName(d)}</span>`;
      for (let h = 0; h < 24; h++) {
        const i = d * 24 + h;
        html += `<span class="cell${isCut(i) ? " cut" : ""}" data-h="${i}"></span>`;
      }
    }
    week.innerHTML = html;
    week.dataset.built = "1";
    week.addEventListener("mouseover", e => { if (e.target.dataset.h) setHour(+e.target.dataset.h); });
  }
  const lim = limit();
  const series = preview ? preview.heat_index : result.heat_index;
  week.querySelectorAll(".cell").forEach(cell => {
    const i = +cell.dataset.h;
    cell.style.background = cellColour(series[i]);
    // A dot marks hours the previewed change turns from danger to safe
    cell.classList.toggle("flip", !!preview && result.heat_index[i] >= lim && series[i] < lim);
  });
}

// Week line chart: heat index (and the hovered change), outdoor air, limit, power cuts
function renderChart() {
  const W = 1000, H = 250, L = 38, R = 64, T = 12, B = 24;
  const hi = result.heat_index, out = result.outdoor_temp, alt = preview?.heat_index;
  const all = hi.concat(out, alt || [], [limit()]);
  const lo = Math.floor(Math.min(...all) / 5) * 5, top = Math.ceil(Math.max(...all) / 5) * 5;
  const x = h => L + (h + 0.5) / HOURS * (W - L - R);
  const y = v => T + (top - v) / (top - lo) * (H - T - B);
  const path = s => s.map((v, h) => `${h ? "L" : "M"}${x(h).toFixed(1)},${y(v).toFixed(1)}`).join("");

  let g = "";
  for (let d = 0; d < 7; d++) {
    for (let h = OPT.scenario.cut_start_hour; h < OPT.scenario.cut_end_hour; h++) {
      const i = d * 24 + h;
      g += `<rect class="cutband" x="${x(i) - (W - L - R) / HOURS / 2}" y="${T}" width="${(W - L - R) / HOURS}" height="${H - T - B}"/>`;
    }
    const xd = L + d * 24 / HOURS * (W - L - R);
    g += `<line class="grid" x1="${xd}" x2="${xd}" y1="${T}" y2="${H - B}"/>`;
    g += `<text x="${xd + 4}" y="${H - 6}">${dayName(d)}</text>`;
  }
  for (let v = lo; v <= top; v += 5) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  g += `<line class="limit" x1="${L}" x2="${W - R}" y1="${y(limit())}" y2="${y(limit())}"/>`;
  g += `<text class="limit-label" x="${W - R + 6}" y="${y(limit()) + 4}">${limit()} °C limit</text>`;
  g += `<path class="out" d="${path(out)}"/>`;
  g += `<path class="hi" d="${path(hi)}"/>`;
  if (alt) g += `<path class="alt" d="${path(alt)}"/>`;
  g += `<line class="cursor" id="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
  g += `<rect id="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;

  // Key
  const keys = [["hi", "felt heat, this design"], ["out", "outdoor air"]];
  if (alt) keys.splice(1, 0, ["alt", `with ${preview.label.toLowerCase()}`]);
  let kx = L;
  const key = keys.map(([cls, txt]) => {
    const s = `<g class="key"><line class="${cls}" x1="${kx}" x2="${kx + 18}" y1="-4" y2="-4"/><text x="${kx + 24}" y="0">${esc(txt)}</text></g>`;
    kx += 40 + txt.length * 6.8;
    return s;
  }).join("");

  $("chart").innerHTML = `<svg viewBox="0 -14 ${W} ${H + 14}" role="img" aria-label="Felt heat index through the week against the ${limit()} °C limit">${key}${g}</svg>`;
  const svg = $("chart").querySelector("svg");
  $("hit").addEventListener("mousemove", e => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const px = pt.matrixTransform(svg.getScreenCTM().inverse()).x;
    setHour(Math.max(0, Math.min(HOURS - 1, Math.floor((px - L) / (W - L - R) * HOURS))));
  });
  svg.dataset.l = L; svg.dataset.w = W - L - R;
}

// Linked hover: one hour shown in the readout, the grid, the chart cursor, and the live room stage
function setHour(h) {
  hour = h;
  if (!result) return;
  const lim = limit();
  const v = result.heat_index[h];
  let txt = `<b>${hourName(h)}</b>${isCut(h) ? " · power cut" : ""} · felt <b class="${v >= lim ? "hot" : ""}">${v} °C</b>`
    + ` · indoor air ${result.indoor_temp[h]} °C · RH ${result.humidity[h]} % · outdoor ${result.outdoor_temp[h]} °C`;
  if (preview) txt += ` · with change <b class="${preview.heat_index[h] >= lim ? "hot" : ""}">${preview.heat_index[h]} °C</b>`;
  $("readout").innerHTML = txt;
  if ($("hour-slider")) $("hour-slider").value = h;
  if ($("scrubber-time")) $("scrubber-time").textContent = hourName(h);

  document.querySelectorAll(".week .cell.on").forEach(c => c.classList.remove("on"));
  document.querySelector(`.week .cell[data-h="${h}"]`)?.classList.add("on");

  const svg = $("chart").querySelector("svg"), cur = $("cursor");
  if (svg && cur) {
    const cx = +svg.dataset.l + (h + 0.5) / HOURS * +svg.dataset.w;
    cur.setAttribute("x1", cx); cur.setAttribute("x2", cx); cur.setAttribute("visibility", "visible");
  }
  const asvg = $("agent-chart")?.querySelector("svg"), acur = $("agent-cursor");
  if (asvg && acur) {
    const cx = +asvg.dataset.l + (h + 0.5) / HOURS * +asvg.dataset.w;
    acur.setAttribute("x1", cx); acur.setAttribute("x2", cx); acur.setAttribute("visibility", "visible");
  }

  renderRoomStage(h);
  renderAgentCards(h);
}

const AGENT_COLORS = ["#c2410c", "#1d4ed8", "#1f6b55", "#7c3aed", "#b42318", "#0d9488"];
const STATUS_COLOR = { safe: "#1f6b55", caution: "#d97706", danger: "#ea580c", critical: "#dc2626", away: "#78716c" };
const BODY = () => OPT.body_model || { core_caution_c: 37.5, core_limit_c: 38.0, core_critical_c: 38.5, v_under_fan: 0.8, v_still: 0.1, min_age: 18 };
// The person shown in the speech bubble / highlighted: must be one JOS-3 could model
function activeAgent() {
  const a = result.agents || [];
  if (!a[activeAgentIdx]?.modelled) activeAgentIdx = Math.max(0, a.findIndex(x => x.modelled));
  return a[activeAgentIdx]?.modelled ? a[activeAgentIdx] : null;
}

function renderRoomStage(h) {
  const stage = $("room-stage");
  if (!stage || !result.agents || !result.agents.length) return;

  const cut = isCut(h);
  const tIn = result.indoor_temp[h];
  const rhIn = result.humidity[h];
  const hi = result.heat_index[h];

  const fanBadge = $("fan-badge");
  if (fanBadge) {
    fanBadge.className = "fan-badge" + (cut ? " off" : "");
    fanBadge.textContent = cut
      ? `Power cut · fan off (${BODY().v_still.toFixed(1)} m/s) · ${tIn} °C / ${rhIn}% RH`
      : `Fan on (${BODY().v_under_fan.toFixed(1)} m/s under it) · ${tIn} °C / ${rhIn}% RH`;
  }
  const titleEl = $("room-stage-title");
  if (titleEl) {
    titleEl.textContent = `${state.length_m.toFixed(1)}×${state.width_m.toFixed(1)} m Room · ${state.floor === "top" ? "Top Floor" : "Middle Floor"} · Felt ${hi} °C`;
  }

  // SVG room dimensions
  const W = 480, H = 340;
  const rx = 56, ry = 38, rw = 368, rh = 246;
  const cx = rx + rw / 2, cy = ry + rh / 2;

  // Room background tint by indoor Heat Index
  const heatRatio = clamp01((hi - 32) / 14);
  const roomBg = `rgba(234, 88, 12, ${(0.04 + heatRatio * 0.18).toFixed(2)})`;

  // Windows on N/S (orientation_deg = 0) or E/W (orientation_deg = 90)
  const ew = Math.round(state.orientation_deg) === 90;
  const hasShade = state.shading_depth_m > 0;
  let winSvg = "";
  if (!ew) {
    // North & South windows
    winSvg += `<rect x="${cx - 65}" y="${ry - 4}" width="130" height="8" fill="#38bdf8" stroke="#0284c7" stroke-width="1"/>`;
    winSvg += `<rect x="${cx - 65}" y="${ry + rh - 4}" width="130" height="8" fill="#38bdf8" stroke="#0284c7" stroke-width="1"/>`;
    if (hasShade) {
      winSvg += `<rect x="${cx - 72}" y="${ry - 11}" width="144" height="5" fill="#78716c" opacity="0.7"/>`;
      winSvg += `<rect x="${cx - 72}" y="${ry + rh + 6}" width="144" height="5" fill="#78716c" opacity="0.7"/>`;
    }
  } else {
    // East & West windows
    winSvg += `<rect x="${rx - 4}" y="${cy - 50}" width="8" height="100" fill="#38bdf8" stroke="#0284c7" stroke-width="1"/>`;
    winSvg += `<rect x="${rx + rw - 4}" y="${cy - 50}" width="8" height="100" fill="#38bdf8" stroke="#0284c7" stroke-width="1"/>`;
    if (hasShade) {
      winSvg += `<rect x="${rx - 11}" y="${cy - 56}" width="5" height="112" fill="#78716c" opacity="0.7"/>`;
      winSvg += `<rect x="${rx + rw + 6}" y="${cy - 56}" width="5" height="112" fill="#78716c" opacity="0.7"/>`;
    }
  }

  // Functional zones inside the room
  const zonesSvg = `
    <!-- Window / Daylighting Zone -->
    <rect x="${rx + 14}" y="${ry + 12}" width="${rw - 28}" height="58" rx="4" fill="none" stroke="var(--rule)" stroke-dasharray="3 3"/>
    <text x="${rx + 22}" y="${ry + 26}" font-family="var(--mono)" font-size="9.5" fill="var(--muted)">WINDOW / DAYLIGHT ZONE</text>

    <!-- Sleeping Mats Area (Bottom-Left) -->
    <rect x="${rx + 14}" y="${ry + rh - 76}" width="155" height="62" rx="4" fill="none" stroke="var(--rule)" stroke-dasharray="3 3"/>
    <text x="${rx + 22}" y="${ry + rh - 22}" font-family="var(--mono)" font-size="9.5" fill="var(--muted)">SLEEPING AREA</text>

    <!-- Kitchen / Stove Corner (Bottom-Right) -->
    <rect x="${rx + rw - 145}" y="${ry + rh - 76}" width="131" height="62" rx="4" fill="rgba(194,65,12,0.05)" stroke="var(--rule)" stroke-dasharray="3 3"/>
    <text x="${rx + rw - 137}" y="${ry + rh - 22}" font-family="var(--mono)" font-size="9.5" fill="var(--muted)">KITCHEN / STOVE</text>

    <!-- Ceiling Fan Swept Cone (Center) -->
    <circle cx="${cx}" cy="${cy - 6}" r="56" fill="${cut ? "rgba(180,35,24,0.05)" : "rgba(31,107,85,0.06)"}" stroke="${cut ? "var(--loss)" : "var(--gain)"}" stroke-opacity="0.35" stroke-dasharray="4 3"/>
    <g transform="translate(${cx},${cy - 6}) ${cut ? "" : `rotate(${(h * 47) % 360})`}">
      <line x1="-22" y1="0" x2="22" y2="0" stroke="var(--muted)" stroke-width="2.5" stroke-linecap="round" opacity="0.55"/>
      <line x1="0" y1="-22" x2="0" y2="22" stroke="var(--muted)" stroke-width="2.5" stroke-linecap="round" opacity="0.55"/>
      <circle cx="0" cy="0" r="5" fill="var(--ink-2)"/>
    </g>
  `;

  // Draw each occupant agent at their hourly normalized position [-0.85, +0.85]
  // Note: norm_y > 0 is near north window (top), norm_y < 0 is south/kitchen/work (bottom)
  let agentsSvg = "";
  const agents = result.agents;
  const actAg = activeAgent();

  agents.forEach((ag, idx) => {
    if (!ag.modelled) return;               // children: JOS-3 is an adult model
    const [nx, ny] = ag.hourly.pos[h] || [0, 0];
    // Spread slightly if multiple agents share near-identical coordinates
    const jitterX = (idx - 1.5) * 14;
    const jitterY = ((idx % 2) - 0.5) * 10;
    const ax = Math.max(rx + 24, Math.min(rx + rw - 24, cx + nx * (rw * 0.38) + jitterX));
    const ay = ny <= -0.75
      ? ry + rh + 22 // Away at work (outside south door)
      : Math.max(ry + 26, Math.min(ry + rh - 24, cy - ny * (rh * 0.38) + jitterY));

    const st = ag.hourly.status[h] || "safe";
    const col = STATUS_COLOR[st] || "#1f6b55";
    const tCr = ag.hourly.t_core[h].toFixed(2);
    const isAct = idx === activeAgentIdx;
    const shortName = ag.name.split(" ")[0];

    agentsSvg += `
      <g class="svg-agent" data-ag="${idx}" transform="translate(${ax.toFixed(1)},${ay.toFixed(1)})" style="cursor:pointer">
        ${st === "critical" || st === "danger" ? `<circle cx="0" cy="0" r="${isAct ? 24 : 19}" fill="${col}" opacity="0.22"/>` : ""}
        <circle cx="0" cy="0" r="${isAct ? 15 : 12}" fill="${col}" stroke="${isAct ? "var(--ink)" : "#fff"}" stroke-width="${isAct ? 2.5 : 1.5}"/>
        <!-- Person icon head & shoulders -->
        <circle cx="0" cy="-3.5" r="3.2" fill="#fff"/>
        <path d="M -5.5 5.5 C -5.5 1, 5.5 1, 5.5 5.5 Z" fill="#fff"/>
        <!-- Label pill below avatar -->
        <rect x="-42" y="15" width="84" height="16" rx="3" fill="var(--sheet)" stroke="${isAct ? "var(--ink)" : "var(--rule)"}" stroke-width="1"/>
        <text x="0" y="26" text-anchor="middle" font-family="var(--mono)" font-size="9.5" font-weight="600" fill="var(--ink)">${esc(shortName)} · ${tCr}°</text>
      </g>
    `;
  });

  // Active agent floating speech bubble at the bottom/top of the stage
  const actQuote = actAg ? actAg.hourly.feedback[h] || "" : "";
  const actSt = actAg ? actAg.hourly.status[h] || "safe" : "safe";
  const actCol = STATUS_COLOR[actSt] || "#1f6b55";

  stage.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Room map with the household (JOS-3 body model)">
      <!-- Compass & Wall Labels -->
      <text x="${cx}" y="16" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--muted)">NORTH ${!ew ? "(WINDOW)" : "(WALL)"}</text>
      <text x="${cx}" y="${ry + rh + 15}" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--muted)">SOUTH · DOOR / WORK EXIT</text>
      <text x="14" y="${cy}" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--muted)" transform="rotate(-90 14 ${cy})">WEST</text>
      <text x="${W - 14}" y="${cy}" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--muted)" transform="rotate(90 ${W - 14} ${cy})">EAST</text>

      <!-- Room Floor & Walls -->
      <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${roomBg}" stroke="var(--ink)" stroke-width="3.5" rx="2"/>
      ${winSvg}
      ${zonesSvg}
      ${agentsSvg}

      <!-- Speech bubble for the highlighted occupant -->
      ${actAg ? `<g transform="translate(16, ${H - 42})">
        <rect x="0" y="0" width="${W - 32}" height="36" rx="5" fill="var(--sheet)" stroke="${actCol}" stroke-width="1.5"/>
        <text x="10" y="14" font-family="var(--mono)" font-size="9.5" font-weight="600" fill="${actCol}">
          ${esc(actAg.name.toUpperCase())} (${actAg.age}${actAg.sex[0].toUpperCase()} · ${esc(actAg.hourly.activity[h])}):
        </text>
        <text x="10" y="28" font-family="var(--sans)" font-size="10.5" fill="var(--ink)">
          “${esc(actQuote.length > 78 ? actQuote.slice(0, 76) + "…" : actQuote)}”
        </text>
      </g>` : ""}
    </svg>
  `;

  stage.querySelectorAll(".svg-agent").forEach(g => {
    g.addEventListener("click", () => {
      activeAgentIdx = +g.dataset.ag;
      renderRoomStage(hour);
      renderAgentCards(hour);
      renderAgentChart();
    });
  });
}

function renderAgentCards(h) {
  const wrap = $("agent-cards");
  if (!wrap || !result.agents) return;
  activeAgent();
  wrap.innerHTML = result.agents.map((ag, idx) => {
    if (!ag.modelled) {
      return `
      <div class="agent-card off">
        <div class="ac-head"><div>
          <div class="ac-title">${esc(ag.name)}</div>
          <div class="ac-meta">${ag.age}y ${esc(ag.sex)} · ${ag.height_cm}cm · ${ag.weight_kg}kg</div>
        </div></div>
        <p class="ac-quote">${esc(ag.note)}</p>
      </div>`;
    }
    const st = ag.hourly.status[h] || "safe";
    const tCr = ag.hourly.t_core[h].toFixed(2);
    const tSk = ag.hourly.t_skin[h].toFixed(1);
    const wet = ag.hourly.wettedness_pct[h];
    const sw = ag.hourly.sweat_gh[h];
    const act = ag.hourly.activity[h];
    const quote = ag.hourly.feedback[h];
    const col = AGENT_COLORS[idx % AGENT_COLORS.length];

    return `
      <div class="agent-card st-border-${st}${idx === activeAgentIdx ? " active" : ""}" data-idx="${idx}" data-modelled="1">
        <div class="ac-head">
          <div>
            <div class="ac-title"><span style="color:${col}">●</span> ${esc(ag.name)}</div>
            <div class="ac-meta">${ag.age}y ${esc(ag.sex)} · ${ag.height_cm}cm · ${ag.weight_kg}kg · BSA ${ag.anthropometrics.bsa_m2}m²</div>
          </div>
          <span class="ac-status ${st}">${esc(st)}</span>
        </div>
        <div class="ac-vitals">
          <div class="ac-vital"><span>Core T<sub>cr</sub></span><b class="${ag.hourly.t_core[h] >= BODY().core_limit_c ? "hot" : ""}">${tCr} °C</b></div>
          <div class="ac-vital"><span>Skin T<sub>sk</sub></span><b>${tSk} °C</b></div>
          <div class="ac-vital"><span>Skin wet</span><b>${wet}%</b></div>
          <div class="ac-vital"><span>Sweat</span><b>${sw} g/h</b></div>
        </div>
        <p class="ac-quote">“${esc(quote)}”</p>
        <div class="ac-foot">
          <span>${esc(act)}</span>
          <span><b>${ag.summary.safe_hours}</b>/${ag.summary.hours_at_home} h at home below ${BODY().core_limit_c.toFixed(1)} °C · max ${ag.summary.max_core_temp_c} °C</span>
        </div>
      </div>
    `;
  }).join("");

  wrap.querySelectorAll(".agent-card[data-modelled]").forEach(card => {
    card.addEventListener("click", () => {
      activeAgentIdx = +card.dataset.idx;
      renderRoomStage(hour);
      renderAgentCards(hour);
      renderAgentChart();
    });
  });
}

function renderAgentChart() {
  const wrap = $("agent-chart");
  if (!wrap || !result.agents || !result.agents.length) return;

  const W = 1000, H = 195, L = 42, R = 72, T = 14, B = 24;
  const lo = 36.4, top = 39.0;
  const x = h => L + (h + 0.5) / HOURS * (W - L - R);
  const y = v => T + (top - Math.max(lo, Math.min(top, v))) / (top - lo) * (H - T - B);
  const path = s => s.map((v, h) => `${h ? "L" : "M"}${x(h).toFixed(1)},${y(v).toFixed(1)}`).join("");

  let g = "";
  for (let d = 0; d < 7; d++) {
    for (let h = OPT.scenario.cut_start_hour; h < OPT.scenario.cut_end_hour; h++) {
      const i = d * 24 + h;
      g += `<rect class="cutband" x="${x(i) - (W - L - R) / HOURS / 2}" y="${T}" width="${(W - L - R) / HOURS}" height="${H - T - B}"/>`;
    }
    const xd = L + d * 24 / HOURS * (W - L - R);
    g += `<line class="grid" x1="${xd}" x2="${xd}" y1="${T}" y2="${H - B}"/>`;
    g += `<text x="${xd + 4}" y="${H - 6}">${dayName(d)}</text>`;
  }
  for (const v of [36.5, 37.0, 37.5, 38.0, 38.5]) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(1)}°</text>`;
  }

  // Core temperature limit: 38.0 °C (ISO 7933:2023 / WHO)
  const lim = BODY().core_limit_c;
  g += `<line class="limit" x1="${L}" x2="${W - R}" y1="${y(lim)}" y2="${y(lim)}"/>`;
  g += `<text class="limit-label" x="${W - R + 5}" y="${y(lim) + 4}">${lim.toFixed(1)}° limit</text>`;

  // Agent core temperature trajectories
  let kx = L;
  let keySvg = "";
  result.agents.forEach((ag, idx) => {
    if (!ag.modelled) return;
    const col = AGENT_COLORS[idx % AGENT_COLORS.length];
    const isAct = idx === activeAgentIdx;
    const sw = isAct ? 2.4 : 1.3;
    const op = isAct ? 1.0 : 0.65;
    g += `<path fill="none" stroke="${col}" stroke-width="${sw}" opacity="${op}" d="${path(ag.hourly.t_core)}"/>`;

    const shortLbl = `${ag.name.split(" ")[0]} (${ag.age}${ag.sex[0].toUpperCase()})`;
    keySvg += `<g class="key"><line stroke="${col}" stroke-width="${sw}" x1="${kx}" x2="${kx + 16}" y1="-4" y2="-4"/><text x="${kx + 21}" y="0">${esc(shortLbl)}</text></g>`;
    kx += 36 + shortLbl.length * 6.8;
  });

  g += `<line class="cursor" id="agent-cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
  g += `<rect id="agent-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;

  wrap.innerHTML = `<svg viewBox="0 -14 ${W} ${H + 14}" role="img" aria-label="JOS-3 core body temperature for each person">${keySvg}${g}</svg>`;
  const svg = wrap.querySelector("svg");
  $("agent-hit").addEventListener("mousemove", e => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const px = pt.matrixTransform(svg.getScreenCTM().inverse()).x;
    setHour(Math.max(0, Math.min(HOURS - 1, Math.floor((px - L) / (W - L - R) * HOURS))));
  });
  svg.dataset.l = L; svg.dataset.w = W - L - R;
}

function renderChanges() {
  const list = result.changes;
  if (!list.length) {
    $("changes").innerHTML = `<li class="none">No single changes to test for this design.</li>`;
    return;
  }
  const maxGain = Math.max(1, ...list.map(c => Math.abs(c.safe_hours_gained)));
  $("changes").innerHTML = list.map((c, i) => {
    const g = c.safe_hours_gained;
    const from = labelOf(c.parameter, state[c.parameter]);
    return `<li class="change${g === 0 ? " flat" : ""}" data-i="${i}">
      <span class="rank">${pad(i + 1)}</span>
      <span class="what">${esc(c.title)}: ${esc(c.label)}<small>from ${esc(from)} · peak ${c.max_heat_index_c} °C</small></span>
      <span class="bar${g < 0 ? " neg" : ""}"><i style="width:${(Math.abs(g) / maxGain * 100).toFixed(1)}%"></i></span>
      <span class="gain ${g > 0 ? "delta-up" : g < 0 ? "delta-down" : ""}">${g > 0 ? "+" : ""}${g} h<small>${c.safe_hours} safe</small></span>
      <button type="button" class="apply" data-i="${i}">Apply</button>
    </li>`;
  }).join("");

  const items = $("changes").querySelectorAll(".change");
  items.forEach(li => {
    const c = list[+li.dataset.i];
    const on = () => { preview = c; li.classList.add("hl"); renderWeek(); renderChart(); if (hour !== null) setHour(hour); };
    const off = () => { if (preview === c) { preview = null; renderWeek(); renderChart(); if (hour !== null) setHour(hour); } li.classList.remove("hl"); };
    li.addEventListener("mouseenter", on);
    li.addEventListener("mouseleave", off);
    li.querySelector(".apply").addEventListener("focus", on);
    li.querySelector(".apply").addEventListener("blur", off);
    li.querySelector(".apply").addEventListener("click", () => applyChange(c));
  });
}

function renderTrail() {
  $("trail-panel").hidden = trail.length < 2;
  $("undo").hidden = trail.length < 2;
  $("trail").innerHTML = trail.map((t, i) => {
    const d = i ? t.safe - trail[i - 1].safe : null;
    const ds = d === null ? "" : ` <span class="${d >= 0 ? "delta-up" : "delta-down"}">(${d >= 0 ? "+" : ""}${d})</span>`;
    return `<li><span>${esc(t.label)}</span><span class="h">${t.safe} h${ds}</span></li>`;
  }).join("");
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function bindTheme() {
  const root = document.documentElement;
  const isDark = () => root.dataset.theme ? root.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  try { const saved = localStorage.getItem("oasis-theme"); if (saved) root.dataset.theme = saved; } catch (_) {}
  const label = () => { $("theme").textContent = isDark() ? "Light" : "Dark"; };
  label();
  $("theme").addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("oasis-theme", root.dataset.theme); } catch (_) {}
    label();
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  bindTheme();
  try {
    OPT = await api("/api/options");
  } catch (err) {
    engine("Server not reachable", "bad");
    $("error").textContent = `Could not reach the OASIS server: ${err.message}. Start it with python run_server.py.`;
    $("error").hidden = false;
    return;
  }
  const sc = OPT.scenario;
  $("scenario").textContent = `${sc.city} · ${sc.first_day}–${sc.last_day} ${sc.month} heatwave · power cut ${pad(sc.cut_start_hour)}:00–${pad(sc.cut_end_hour)}:00 nightly`;
  $("limit-a").textContent = $("limit-b").textContent = `${sc.safe_limit_c} °C`;
  $("fan-credit").textContent = `${sc.fan_credit_c} °C`;

  state = { ...OPT.baseline };
  agentsRoster = JSON.parse(JSON.stringify(OPT.default_agents || []));
  buildForm();
  buildRoster();
  bindRosterActions();
  bindRhino();
  $("run").addEventListener("click", simulate);
  $("undo").addEventListener("click", undo);
  syncForm();
  engine("EnergyPlus ready", "ok");
  simulate();                                   // show the baseline straight away
}

start();
