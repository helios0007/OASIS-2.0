// ============================================================================
// OASIS 2.0 · workspace (front end for backend/main.py)
//
// Layout: model panel (left) -> POST /api/assess -> 3D viewport + timeline
// (centre) and results inspector (right). One hour of the week is "current"
// everywhere: the 3D view, the timeline cursor, the week grid and the people.
// Applying a change makes it the new design and re-simulates; every run is
// kept in a design history so the user can step back.
// ============================================================================

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp01 = x => Math.max(0, Math.min(1, x));
const pad = n => String(n).padStart(2, "0");
const HOURS = 168;
const TOP_CHANGES = 6;   // changes shown before "Show all"

// Which control each design choice uses, and which panel section holds it
const ORIENTATION = { key: "orientation_deg", title: "Windows face",
  options: [{ value: 0, label: "North & South" }, { value: 90, label: "East & West" }] };
const SECTIONS = {
  "ctl-geometry": [["floor", "seg"], ["orientation_deg", "seg"]],
  "ctl-envelope": [["wall", "select"], ["roof", "select"], ["roof_solar_absorptance", "swatch"], ["shading_depth_m", "seg"]],
  "ctl-use": [["night_vent", "switch"], ["occupants", "seg"]],
};
const CONTROLS = [...Object.values(SECTIONS).flat(), ["weather", "seg"]];
const ROOF_ONLY = ["roof", "roof_solar_absorptance"];        // no effect on a middle floor
const ROOF_SWATCH = { 0.7: "#6b665c", 0.4: "#b5afa3", 0.2: "#ffffff" };
const TITLES = { occupants: "People (internal heat)", night_vent: "Windows open at night", roof: "Roof build-up",
  shading_depth_m: "Window overhang", weather: "Outdoor air" };

let OPT = null;          // /api/options
let state = {};          // current design + scenario (Building fields)
let roster = [];         // household for the JOS-3 check
let model = null;        // Rhino geometry, or null
let result = null;       // last /api/assess response
let ranFor = null;       // payload text of the last result
let preview = null;      // change compared in the timeline
let trail = [];          // [{label, safe, snapshot}]
let pendingLabel = null; // label for the next history entry
let requestNo = 0;
let hour = 20;           // current hour of the week
let hourFor = null;      // scenario + model the current hour was picked for
let activeIdx = 0;       // highlighted person
let playTimer = null;
let showAll = false;
let tab = "summary";

// ---------------------------------------------------------------------------
// Helpers
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

function status(text, kind) {
  $("status-text").textContent = text;
  $("status").className = "status " + (kind || "");
}

const limit = () => OPT.scenario.safe_limit_c;
const weatherChoice = () => ({ key: "weather", title: "Outdoor air",
  options: OPT.scenario.weathers.filter(w => w.available).map(w => ({ value: w.key, label: w.label })) });
const choice = key => key === ORIENTATION.key ? ORIENTATION : key === "weather" ? weatherChoice() : OPT.choices.find(c => c.key === key);
const labelOf = (key, value) => (choice(key)?.options.find(o => o.value === value) || {}).label ?? String(value);
const isCut = h => !!result?.cut?.[h];
const dayName = d => `${OPT.scenario.first_day + d} ${OPT.scenario.month}`;
const hourName = h => `${dayName(Math.floor(h / 24))} · ${pad(h % 24)}:00`;
const signed = n => (n > 0 ? "+" : "") + n;
const cutLabel = (start, len = 1) => start === null || start === undefined ? "no power cut"
  : len >= 24 ? "no power all week" : `power cut ${pad(start)}:00–${pad((start + len) % 24)}:00`;
// The change or package compared in the timeline, as a <select> value and back
const previewKey = c => !c ? "" : result.changes.includes(c) ? `c${result.changes.indexOf(c)}` : `p${(result.packages || []).indexOf(c)}`;
const previewFrom = v => v === "" ? null : v[0] === "c" ? result.changes[+v.slice(1)] : result.packages[+v.slice(1)];
const weatherOf = key => OPT.scenario.weathers.find(w => w.key === key) || OPT.scenario.weathers[0];

// Small technical note under an option (from the physics the server reports)
function optionNote(key, value) {
  const ph = OPT.physics || {};
  if (key === "wall" && ph.walls?.[value]) return `U ${ph.walls[value].u_value}`;
  if (key === "roof" && ph.roofs?.[value]) return `U ${ph.roofs[value].u_value}`;
  return "";
}

// ---------------------------------------------------------------------------
// Toasts (stack bottom-right, update in place, optional action)
// ---------------------------------------------------------------------------
const ICONS = {
  success: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  error: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>`,
  loading: `<span class="spinner"></span>`,
};
const PLAY_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M6 4l14 8-14 8z"/></svg>`;
const PAUSE_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>`;
const toasts = new Map();   // id -> {el, timer, left, started}

function toast(message, { id = String(Math.random()), type = "", detail = "", action = null, duration = 4000 } = {}) {
  let t = toasts.get(id);
  if (!t) {
    const el = document.createElement("li");
    $("toaster").prepend(el);
    t = { el };
    toasts.set(id, t);
    el.addEventListener("mouseenter", () => pauseToast(t));
    el.addEventListener("mouseleave", () => resumeToast(id, t));
  }
  t.el.className = `toast ${type}`;
  t.el.innerHTML = `${ICONS[type] ? `<span class="t-ico">${ICONS[type]}</span>` : ""}
    <span class="t-msg">${esc(message)}${detail ? `<small>${esc(detail)}</small>` : ""}</span>
    ${action ? `<button type="button" class="t-action">${esc(action.label)}</button>` : ""}`;
  if (action) t.el.querySelector(".t-action").onclick = () => { action.onClick(); dismiss(id); };
  clearTimeout(t.timer);
  t.left = type === "loading" ? Infinity : duration;
  resumeToast(id, t);
  return id;
}
function pauseToast(t) { clearTimeout(t.timer); if (t.left !== Infinity) t.left -= performance.now() - t.started; }
function resumeToast(id, t) {
  if (t.left === Infinity) return;
  t.started = performance.now();
  t.timer = setTimeout(() => dismiss(id), Math.max(800, t.left));
}
function dismiss(id) {
  const t = toasts.get(id);
  if (!t) return;
  toasts.delete(id);
  clearTimeout(t.timer);
  t.el.classList.add("out");
  setTimeout(() => t.el.remove(), 220);
}
document.addEventListener("visibilitychange", () => {
  for (const [id, t] of toasts) document.hidden ? pauseToast(t) : resumeToast(id, t);
});

// ---------------------------------------------------------------------------
// Intro
// ---------------------------------------------------------------------------
function enterApp(thenPickFile) {
  const intro = $("intro");
  if (intro.hidden) return;
  intro.classList.add("leaving");
  setTimeout(() => {
    intro.hidden = true;
    intro.classList.remove("leaving");
    $("app").hidden = false;
    $("app").classList.add("entering");
    window.scrollTo(0, 0);
    if (result) { renderStrip(); renderChart(); setHour(hour); }     // sized now that the workspace is visible
    if (thenPickFile) $("file").click();
  }, 200);
}
function showIntro() {
  $("app").hidden = true;
  $("app").classList.remove("entering");
  $("intro").hidden = false;
}

// ---------------------------------------------------------------------------
// Model panel controls
// ---------------------------------------------------------------------------
function controlHtml([key, kind]) {
  const c = choice(key);
  if (!c) return "";
  const title = esc(TITLES[key] || c.title);
  const head = `<span class="control-label">${title}<small data-note="${key}"></small></span>`;

  if (kind === "switch") {
    return `<div class="control switch-row" data-key="${key}">
      <span class="control-label">${title}</span>
      <span class="switch"><input type="checkbox" name="${key}" aria-label="${title}"><span></span></span></div>`;
  }
  if (kind === "select") {
    const opts = c.options.map((o, i) => {
      const note = optionNote(key, o.value);
      return `<option value="${i}">${esc(o.label)}${note ? ` · ${esc(note)}` : ""}</option>`;
    }).join("");
    return `<label class="control" data-key="${key}">${head}<select class="select" name="${key}">${opts}</select></label>`;
  }
  const opts = c.options.map((o, i) => {
    const sw = kind === "swatch" ? `<i class="swatch" style="background:${ROOF_SWATCH[o.value] || "transparent"}"></i>` : "";
    return `<label><input type="radio" name="${key}" value="${i}"><span>${sw}${esc(o.label)}</span></label>`;
  }).join("");
  return `<div class="control" data-key="${key}">${head}<div class="seg">${opts}</div></div>`;
}

function cutOptionsHtml() {
  const hottest = result?.peaks?.normal?.typical_hour;
  let html = `<option value="">No power cut</option>`;
  for (let h = 0; h < 24; h++) {
    const note = h === OPT.baseline.cut_start_hour ? " · evening load shedding" : h === hottest ? " · room's hottest hour" : "";
    html += `<option value="${h}">from ${pad(h)}:00${note}</option>`;
  }
  return html;
}

function buildForm() {
  for (const [id, controls] of Object.entries(SECTIONS)) $(id).innerHTML = controls.map(controlHtml).join("");
  $("ctl-scenario").innerHTML = `
    ${controlHtml(["weather", "seg"])}
    <p class="hint sm muted" id="weather-hint" style="margin:-4px 0 12px;line-height:1.45"></p>
    <label class="control"><span class="control-label">Power cut (fans off)</span>
      <select class="select" id="cut_start_hour">${cutOptionsHtml()}</select></label>
    <label class="control"><span class="control-label">Cut length, every day</span>
      <select class="select" id="cut_length_h">${OPT.scenario.cut_lengths.map(c =>
        `<option value="${c.hours}">${esc(c.label)} · ${esc(c.note)}</option>`).join("")}</select></label>
    <p class="hint sm muted" style="margin-top:6px;line-height:1.45">Recorded heatwave, ${OPT.scenario.first_day}–${OPT.scenario.last_day} ${OPT.scenario.month} 2024, after ${OPT.scenario.spinup_days} warm-up days.</p>`;

  $("form").addEventListener("change", e => {
    const t = e.target, key = t.name;
    if (t.id === "cut_start_hour") state.cut_start_hour = t.value === "" ? null : +t.value;
    else if (t.id === "cut_length_h") state.cut_length_h = +t.value;
    else if (t.id === "party") return;
    else if (key && t.type === "radio") state[key] = choice(key).options[+t.value].value;
    else if (key && t.type === "checkbox") state[key] = t.checked;
    else if (key && t.tagName === "SELECT") state[key] = choice(key).options[+t.value].value;
    readNumbers();
    syncForm();
  });
  $("form").addEventListener("input", e => { if (e.target.type === "number") { readNumbers(); syncForm(); } });
  $("form").addEventListener("submit", e => { e.preventDefault(); simulate(); });
  $("form").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.type === "number") { e.preventDefault(); simulate(); } });
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

// Push state into the controls and refresh locks, notes and the stale flag
function syncForm() {
  for (const [key] of CONTROLS) {
    const c = choice(key);
    if (!c) continue;
    const i = c.options.findIndex(o => o.value === state[key]);
    document.querySelectorAll(`input[type=radio][name="${key}"]`).forEach(r => { r.checked = +r.value === i; });
    const sel = document.querySelector(`select[name="${key}"]`);
    if (sel) sel.value = String(i);
    const box = document.querySelector(`input[type=checkbox][name="${key}"]`);
    if (box) box.checked = !!state[key];
  }
  $("cut_start_hour").value = state.cut_start_hour === null ? "" : String(state.cut_start_hour);
  $("cut_length_h").value = String(state.cut_length_h);
  $("cut_length_h").disabled = state.cut_start_hour === null;
  const w = weatherOf(state.weather);
  $("weather-hint").innerHTML = `<span class="tagline ${w.source.toLowerCase()}">${esc(w.source)}</span>${esc(w.note)}`;

  const active = document.activeElement;
  for (const id of ["length_m", "width_m", "height_m"]) if (active !== $(id)) $(id).value = +state[id].toFixed(2);
  if (active !== $("wwr_pct")) $("wwr_pct").value = Math.round(state.wwr * 100);

  // A Rhino model fixes geometry, windows and orientation
  $("geometry").classList.toggle("locked", !!model);
  document.querySelectorAll('input[name="orientation_deg"]').forEach(r => { r.disabled = !!model; });

  // Middle floor: the roof belongs to the flat above
  const middle = state.floor === "middle";
  for (const key of ROOF_ONLY) {
    const el = document.querySelector(`.control[data-key="${key}"]`);
    if (!el) continue;
    el.classList.toggle("off", middle);
    el.querySelectorAll("input, select").forEach(r => { r.disabled = middle; });
    el.querySelector("[data-note]").textContent = middle ? "flat above" : "";
  }

  const area = model?.report?.inside_area_m2 ?? state.length_m * state.width_m;   // a plan: the rooms, not the outline
  $("area").textContent = `${area.toFixed(1)} m² · ${(area * state.height_m).toFixed(0)} m³`;
  $("doc-name").textContent = model
    ? `${model.report.file}${model.plan_id ? ` · ${model.report.rooms} rooms` : " · single room"}`
    : `Single room · ${state.length_m.toFixed(1)} × ${state.width_m.toFixed(1)} × ${state.height_m.toFixed(1)} m`;
  $("scenario").textContent = `${OPT.scenario.city} · ${OPT.scenario.first_day}–${OPT.scenario.last_day} ${OPT.scenario.month} 2024 · ${w.label.toLowerCase()} air · ${cutLabel(state.cut_start_hour, state.cut_length_h)}`;

  const stale = result && JSON.stringify(payload()) !== ranFor;
  $("run").classList.toggle("stale", !!stale);
  refreshEstimate(!!stale);
  if (!$("run").disabled) $("run-text").textContent = stale ? "Update results" : "Run simulation";
  $("undo").disabled = trail.length < 2 || $("run").disabled;
}

// Instant surrogate estimate for a design that has not been simulated yet
let estimateTimer = null, estimateNo = 0;
function refreshEstimate(stale) {
  const el = $("estimate");
  clearTimeout(estimateTimer);
  const no = ++estimateNo;
  if (!stale || model?.plan_id) { el.hidden = true; return; }
  estimateTimer = setTimeout(async () => {
    try {
      const e = (await api("/api/predict", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) })).estimate;
      if (no !== estimateNo) return;
      el.hidden = !e;
      if (!e) return;
      el.textContent = `AI estimate ≈ ${e.safe_hours} safe h${e.outside.length ? " · outside trained range" : ""}`;
      el.title = `XGBoost surrogate, before the simulation: about ${e.safe_hours} safe hours (typical error ${e.mae_hours} h on rooms it has not seen), heat dose about ${e.hazard_hours_ch.toLocaleString()} °C·h.`
        + (e.outside.length ? ` Outside the trained range: ${e.outside.join(", ")}.` : "") + " Run the simulation for the result.";
    } catch (_) { el.hidden = true; }
  }, 250);
}

function payload() {
  const keys = ["length_m", "width_m", "height_m", "orientation_deg", "floor", "wall", "roof",
    "roof_solar_absorptance", "wwr", "shading_depth_m", "night_vent", "occupants", "weather", "cut_start_hour", "cut_length_h"];
  const p = Object.fromEntries(keys.map(k => [k, state[k]]));
  if (model) Object.assign(p, model.geometry);   // dims, orientation and glass per wall
  if (model?.plan_id) { p.plan_id = model.plan_id; if (model.party) p.party_walls = model.party; }
  p.agents = roster;
  return p;
}

// ---------------------------------------------------------------------------
// Household: compact list in the panel, editor in a drawer
// ---------------------------------------------------------------------------
const AGENT_COLORS = ["#c2410c", "#2563eb", "#15803d", "#7c3aed", "#b91c1c", "#0d9488"];
const ROLES = { elderly: "Elderly, at home", homemaker: "Homemaker, cooks", worker: "Worker, away by day", child: "Child" };
const adult = a => a.age >= (OPT.body_model?.min_age ?? 18);

function renderPeople() {
  $("people").innerHTML = roster.map((a, i) => `<li>
    <span class="avatar" style="background:${AGENT_COLORS[i % AGENT_COLORS.length]}">${esc((a.name || "?")[0].toUpperCase())}</span>
    <span class="who">${esc(a.name)}<br><small>${a.age} y · ${esc(ROLES[a.role] || a.role)}</small></span>
    <small>${adult(a) ? "JOS-3" : "heat index"}</small></li>`).join("");
}

function renderRoster() {
  $("roster").innerHTML = roster.map((a, i) => `
    <div class="roster" data-i="${i}">
      <div class="roster-top">
        <span class="avatar" style="background:${AGENT_COLORS[i % AGENT_COLORS.length]}">${esc((a.name || "?")[0].toUpperCase())}</span>
        <input type="text" data-f="name" value="${esc(a.name)}" aria-label="Name">
        ${roster.length > 1 ? `<button type="button" class="tb-btn tb-icon" data-del="${i}" aria-label="Remove ${esc(a.name)}">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>` : ""}
      </div>
      <div class="roster-grid">
        <label>Age<input type="number" data-f="age" min="1" max="100" value="${a.age}"></label>
        <label>Sex<select data-f="sex">
          <option value="female"${a.sex === "female" ? " selected" : ""}>Female</option>
          <option value="male"${a.sex === "male" ? " selected" : ""}>Male</option></select></label>
        <label>Day<select data-f="role">${Object.entries(ROLES).map(([v, l]) =>
          `<option value="${v}"${a.role === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
        <label>Height (cm)<input type="number" data-f="height_cm" min="60" max="220" value="${a.height_cm}"></label>
        <label>Weight (kg)<input type="number" data-f="weight_kg" min="8" max="160" value="${a.weight_kg}"></label>
        <label>Clothing (clo)<input type="number" data-f="clothing_clo" min="0.2" max="1.2" step="0.05" value="${a.clothing_clo}"></label>
      </div>
      ${adult(a) ? "" : `<p class="note">Under 18: not run through JOS-3 (adult model). Covered by the heat-index safe hours.</p>`}
    </div>`).join("");
}

function bindHousehold() {
  $("roster").addEventListener("change", e => {
    const box = e.target.closest(".roster"), f = e.target.dataset.f;
    if (!box || !f) return;
    const v = e.target.type === "number" ? parseFloat(e.target.value) : e.target.value;
    if (e.target.type === "number" && Number.isNaN(v)) return;
    roster[+box.dataset.i][f] = v;
    if (f === "age") renderRoster();
  });
  $("roster").addEventListener("click", e => {
    const del = e.target.closest("[data-del]");
    if (!del) return;
    roster.splice(+del.dataset.del, 1);
    renderRoster();
  });
  $("add-person").addEventListener("click", () => {
    roster.push({ id: `p_${Date.now()}`, name: `Person ${roster.length + 1}`, age: 45, sex: "female",
      height_cm: 162, weight_kg: 64, clothing_clo: 0.4, role: "homemaker" });
    renderRoster();
    $("roster").lastElementChild?.querySelector("input")?.focus();
  });
  $("edit-household").addEventListener("click", e => { e.preventDefault(); openSheet(); });
  $("sheet-close").addEventListener("click", () => closeSheet(false));
  $("overlay").addEventListener("click", () => closeSheet(false));
  $("sheet-done").addEventListener("click", () => closeSheet(true));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(false); });
}

let rosterBefore = null;
function openSheet() {
  rosterBefore = JSON.stringify(roster);
  renderRoster();
  $("overlay").hidden = $("sheet").hidden = false;
  requestAnimationFrame(() => { $("overlay").classList.add("open"); $("sheet").classList.add("open"); });
  $("sheet-close").focus();
}
function closeSheet(save) {
  if (!save && rosterBefore) roster = JSON.parse(rosterBefore);
  $("overlay").classList.remove("open");
  $("sheet").classList.remove("open");
  setTimeout(() => { $("overlay").hidden = $("sheet").hidden = true; }, 400);
  renderPeople();
  if (save && JSON.stringify(roster) !== rosterBefore) {
    pendingLabel = "Household edited";
    simulate();
  }
  $("edit-household").focus();
}

// ---------------------------------------------------------------------------
// Rhino import
// ---------------------------------------------------------------------------
function setModel(data, quiet) {
  model = data;
  Object.assign(state, {
    length_m: data.geometry.length_m, width_m: data.geometry.width_m,
    height_m: data.geometry.height_m, orientation_deg: data.geometry.orientation_deg,
  });
  const r = data.report;
  const glass = Object.entries(r.windows || {})
    .map(([side, w]) => `${side[0].toUpperCase()} ${w.area_m2} m²`).join(" · ") || "no windows";
  $("model").innerHTML = `
    <div class="model-head"><span>${esc(r.file)}</span><button type="button" class="link" id="unload">Remove</button></div>
    <span class="muted">${esc(r.size)}</span>
    <span class="muted">Glass: ${esc(glass)} (${r.window_to_wall_pct} % of walls)</span>
    ${data.plan_id ? `<span class="muted">Simulated room by room (one zone per room, AirflowNetwork)</span>
    <label class="control"><span class="control-label">Shared walls</span>
      <select class="select" id="party">
        <option value="">As drawn (none marked = all face outside)</option>
        <option value="windowless">Every wall without a window is shared</option>
      </select></label>` : ""}
    ${(r.warnings || []).map(w => `<span class="warn">${esc(w)}</span>`).join("")}`;
  $("model").hidden = false;
  $("unload").onclick = () => { clearModel(); pendingLabel = "Back to the single room"; syncForm(); simulate(); };
  if (data.plan_id) {
    $("party").value = data.party || "";
    $("party").onchange = e => { model = { ...model, party: e.target.value || null }; syncForm(); };
  }
  if (quiet) return;
  pendingLabel = `Imported ${r.file}`;
  toast(`Imported ${r.file}`, { type: "success", detail: data.plan_id
    ? `${r.rooms} rooms: simulated room by room.` : "Room size and windows now come from the model." });
  syncForm();
  simulate();
}
function clearModel() { model = null; $("model").hidden = true; }

async function loadRhino(promise) {
  try { setModel(await promise); }
  catch (err) { toast("Could not read the model", { type: "error", detail: err.message, duration: 6000 }); }
}
function upload(file) {
  const form = new FormData();
  form.append("file", file);
  loadRhino(api("/api/rhino", { method: "POST", body: form }));
}

function bindRhino() {
  $("pick").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", e => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ""; });
  // Drag a .3dm anywhere onto the workspace
  const app = $("app"), left = document.querySelector(".panel.left");
  app.addEventListener("dragover", e => { e.preventDefault(); left.classList.add("over"); });
  app.addEventListener("dragleave", e => { if (!app.contains(e.relatedTarget)) left.classList.remove("over"); });
  app.addEventListener("drop", e => {
    e.preventDefault(); left.classList.remove("over");
    if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
  });

  const menu = $("samples"), btn = $("samples-btn");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); });
  document.addEventListener("click", close);
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  api("/api/samples").then(list => {
    menu.innerHTML = `<button type="button" data-sample="">Single room (default)</button>` + list.map(s =>
      `<button type="button" data-sample="${esc(s.id)}">${esc(s.name)}</button>`).join("");
    menu.querySelectorAll("[data-sample]").forEach(b => b.addEventListener("click", () => {
      if (b.dataset.sample) return loadRhino(api(`/api/rhino/sample?name=${encodeURIComponent(b.dataset.sample)}`, { method: "POST" }));
      clearModel();
      Object.assign(state, { length_m: OPT.baseline.length_m, width_m: OPT.baseline.width_m, height_m: OPT.baseline.height_m, orientation_deg: 0 });
      pendingLabel = "Single room (default)";
      syncForm(); simulate();
    }));
  }).catch(() => { $("samples-menu").hidden = true; });
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
async function simulate() {
  const text = JSON.stringify(payload());
  const no = ++requestNo;
  const t0 = performance.now();
  const before = result?.summary.safe_hours;
  status("Simulating", "busy");
  const onIntro = !$("intro").hidden;      // no toasts over the intro page
  if (!onIntro && result) toast("Simulating the heatwave week", { id: "sim", type: "loading", detail: "EnergyPlus: your design and every single change" });
  $("run").disabled = true;
  $("run-text").textContent = "Simulating…";
  $("undo").disabled = true;
  $("center").classList.add("busy");
  $("result").classList.add("dim");
  $("error").hidden = true;
  if (playTimer) togglePlay();

  try {
    const res = await api("/api/assess", { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
    if (no !== requestNo) return;
    result = res;
    ranFor = text;
    if (preview) preview = res.changes.find(c => c.parameter === preview.parameter && c.value === preview.value) || null;
    const label = pendingLabel || (trail.length ? "Edited inputs" : "Starting design");
    trail.push({ label, safe: res.summary.safe_hours, snapshot: { state: { ...state }, model, roster: JSON.stringify(roster) } });
    pendingLabel = null;
    render();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    status("Ready", "ok");
    $("sb-time").textContent = `last run ${secs} s`;
    const d = before === undefined ? null : res.summary.safe_hours - before;
    if (toasts.has("sim")) toast(`${res.summary.safe_hours} of 168 hours safe`, {
      id: "sim", type: "success",
      detail: (d === null ? label : `${label} · ${signed(d)} h`) + ` · ${secs} s`,
      action: trail.length > 1 ? { label: "Undo", onClick: undo } : null,
    });
  } catch (err) {
    if (no !== requestNo) return;
    $("error").textContent = err.message;
    $("error").hidden = false;
    $("loading").hidden = true;
    status("Failed", "bad");
    toast("Simulation failed", { id: "sim", type: "error", detail: err.message, duration: 8000 });
  } finally {
    if (no === requestNo) {
      $("run").disabled = false;
      $("center").classList.remove("busy");
      $("result").classList.remove("dim");
      syncForm();
    }
  }
}

function applyChange(c) {
  state[c.parameter] = c.value;
  pendingLabel = `${c.title}: ${c.label}`;
  if (preview && preview.parameter === c.parameter) preview = null;
  syncForm();
  simulate();
}

function undo() {
  if (trail.length < 2) return;
  trail.pop();
  const prev = trail.pop();                 // added back when the run finishes
  state = { ...prev.snapshot.state };
  roster = JSON.parse(prev.snapshot.roster);
  if (prev.snapshot.model) setModel(prev.snapshot.model, true); else clearModel();
  renderPeople();
  pendingLabel = prev.label;
  syncForm();
  simulate();
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function bindTabs() {
  document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
  document.querySelector(".tabs").addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const tabs = [...document.querySelectorAll(".tab")];
    const i = tabs.findIndex(t => t.dataset.tab === tab);
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.dataset.tab); next.focus();
  });
}
function setTab(name) {
  tab = name;
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  document.querySelectorAll(".tabpanel").forEach(p => { p.hidden = p.dataset.panel !== name; });
  if (!result) return;
  if (name === "people") { renderAgentCards(hour); renderAgentChart(); }
  setHour(hour);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
// The hour the workspace opens on: the hottest power-cut hour, or the hottest hour
function pickHour() {
  const hi = result.heat_index, cut = result.cut;
  let best = -1;
  for (let h = 0; h < HOURS; h++) if (cut[h] && (best < 0 || hi[h] > hi[best])) best = h;
  if (best < 0) best = hi.indexOf(Math.max(...hi));
  return best;
}

function render() {
  $("loading").hidden = true;
  const p = JSON.parse(ranFor);
  const key = JSON.stringify([p.plan_id || "box", p.weather, p.cut_start_hour, p.cut_length_h]);
  const fresh = key !== hourFor;                    // a new model or scenario: jump to its critical hour
  if (fresh) { hour = pickHour(); hourFor = key; }
  const draw = () => window.OASIS3D.show(result.unit, { keepView: true, hour });
  if (window.OASIS3D) draw(); else window.addEventListener("oasis3d-ready", draw, { once: true });

  $("cut_start_hour").innerHTML = cutOptionsHtml();
  $("sb-engine").textContent = result.unit.single_room
    ? "EnergyPlus 26.2 · single zone · AirflowNetwork"
    : `EnergyPlus 26.2 · ${Object.keys(result.unit.geometry.rooms).length} zones · AirflowNetwork`;
  $("sb-weather").textContent = `Weather: ${weatherOf(result.scenario.weather).label.toLowerCase()}, ${weatherOf(result.scenario.weather).source.toLowerCase()}`;

  renderScore();
  renderWeek();
  renderPeaks();
  renderTrail();
  renderChanges();
  renderPackages();
  renderCompare();
  renderCheck();
  renderBasis();
  renderStrip();
  renderChart();
  setTab(tab);
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

function renderScore() {
  const s = result.summary, lim = limit();
  $("score").textContent = s.safe_hours;
  const R = 27, C = 2 * Math.PI * R;
  $("gauge").innerHTML = `<svg viewBox="0 0 64 64" width="64" height="64">
    <circle class="track" cx="32" cy="32" r="${R}" fill="none" stroke-width="7"/>
    <circle class="arc" cx="32" cy="32" r="${R}" fill="none" stroke-width="7" stroke-linecap="butt"
      stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - s.safe_hours / HOURS)).toFixed(1)}" transform="rotate(-90 32 32)"/>
    <text x="32" y="36" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor" font-family="var(--mono)">${Math.round(s.safe_hours / HOURS * 100)}%</text></svg>`;
  const days = Math.round(s.danger_hours / 24 * 10) / 10;
  const first = trail[0]?.safe;
  const delta = trail.length > 1 ? s.safe_hours - first : null;
  const deltaHtml = delta === null ? "" : `<span class="delta ${delta >= 0 ? "up" : "down"}">${signed(delta)} h vs start</span>`;
  $("verdict").innerHTML = s.danger_hours === 0
    ? `Below ${lim} °C felt heat all week.${deltaHtml}`
    : `<b>${s.danger_hours} h</b> (about ${days} days) above ${lim} °C felt heat.${deltaHtml}`;

  const cutTotal = result.cut.filter(Boolean).length;
  const p = result.peaks;
  const cutStat = cutTotal
    ? `<div class="stat"><span>Power-cut hours in danger</span><b>${s.cut_hours_in_danger}<small> of ${cutTotal}</small></b><em>${p.cut.length_h >= 24 ? "no power all week" : `${pad(p.cut.start_hour)}:00–${pad(p.cut.end_hour % 24)}:00`}, fan off</em></div>`
    : `<div class="stat"><span>Power cut</span><b>none</b><em>fans run every hour</em></div>`;
  const ext = s.safe_hours_extended_hi;
  $("stats").innerHTML = `
    <div class="stat"><span>Hours in danger</span><b>${s.danger_hours}<small> h</small></b><em>felt heat ≥ ${lim} °C</em></div>
    ${cutStat}
    <div class="stat"><span>Peak felt heat</span><b>${s.max_heat_index_c}<small> °C</small></b><em>${p ? `room hottest around ${pad(p.normal.typical_hour)}:00` : "heat index"}</em></div>
    <div class="stat"><span>Peak indoor air</span><b>${s.max_indoor_temp_c}<small> °C</small></b><em>mean ${s.mean_indoor_temp_c} °C</em></div>
    <div class="stat"><span>Heat over the limit</span><b>${Math.round(s.degree_hours_over_limit)}<small> °C·h</small></b><em>degree-hours above ${lim} °C</em></div>
    <div class="stat"><span>Cross-check</span><b>${ext ?? "–"}<small> h safe</small></b><em>extended heat index</em></div>
    <div class="stat"><span>Heat dose</span><b>${Math.round(s.hazard_hours_ch).toLocaleString()}<small> °C·h</small></b><em>felt heat above ${OPT.scenario.dose.caution_c} °C, summed</em></div>
    <div class="stat"><span>Illness likely after</span><b>${doseTime(s.hours_to_elderly_limit)}</b><em>elderly; adults ${doseTime(s.hours_to_young_limit).replace("Not", "not")}</em></div>`;
  renderBands();
}

// When the week's running heat dose passes a Chen et al. (2024) limit
function doseTime(h) {
  if (h === null || h === undefined) return "Not reached";
  return `${dayName(Math.floor((h - 1) / 24))}, ${pad((h - 1) % 24)}:00`;
}

// Hours of the week in each NWS heat-index band
const BAND_NAMES = { below_caution: "Below 27", caution: "Caution 27–32", extreme_caution: "Extreme caution 32–41",
  danger: "Danger 41–54", extreme_danger: "Extreme danger 54+" };
function renderBands() {
  const rows = Object.entries(BAND_NAMES).map(([k, name]) => [k, name, result.summary[`band_${k}_h`] || 0]);
  $("bands").innerHTML = rows.filter(r => r[2]).map(([k, name, n]) =>
    `<i class="band b-${k}" style="flex:${n}" title="${name} °C: ${n} h"></i>`).join("");
  $("bands-key").innerHTML = rows.filter(r => r[2]).map(([k, name, n]) =>
    `<span><i class="band b-${k}"></i>${name} · <b>${n} h</b></span>`).join("");
}

// Two peaks: the normal daily peak, and the peak during the power cut.
// The cut only removes the fan credit, so every hour can be tested as a cut hour.
function renderPeaks() {
  const p = result.peaks;
  if (!p) return;
  const lim = limit(), n = p.normal, c = p.cut, w = p.by_hour[p.worst_cut_hour], days = p.days;
  $("peaks").innerHTML = `
    <div class="peak"><span>Normal peak, fan on</span><b>${pad(n.typical_hour)}:00 · ${n.max_heat_index_c} °C</b><em>felt heat; air up to ${n.max_indoor_temp_c} °C</em></div>
    ${c ? `<div class="peak"><span>During the ${c.length_h >= 24 ? "week without power" : `${pad(c.start_hour)}:00 cut`}</span><b>${c.max_heat_index_c} °C</b><em>above ${lim} °C on ${c.nights_in_danger} of ${c.days} days</em></div>` : ""}
    <div class="peak"><span>Worst hour for a cut</span><b>${pad(w.hour)}:00 · ${w.max_heat_index_no_fan_c} °C</b><em>above the limit on ${w.days_in_danger} of ${days} days</em></div>`;
  const hiMin = 30, hiMax = Math.max(...p.by_hour.map(r => r.max_heat_index_no_fan_c), lim + 5);
  $("cutscan").innerHTML = p.by_hour.map(r => {
    const hgt = Math.max(4, Math.round(100 * (r.max_heat_index_no_fan_c - hiMin) / (hiMax - hiMin)));
    const cut = c && isCut(r.hour);
    return `<div class="cs-col${cut ? " cut" : ""}${r.hour === n.typical_hour ? " peak-h" : ""}" title="${pad(r.hour)}:00 · fan off: up to ${r.max_heat_index_no_fan_c} °C felt · ${r.days_in_danger}/${days} days above ${lim} °C">
      <span class="cs-n">${r.days_in_danger || ""}</span>
      <span class="cs-bar" style="height:${hgt}%;background:${cellColour(r.max_heat_index_no_fan_c)}"></span>
      <span class="cs-h">${r.hour === n.typical_hour ? "▲" : ""}${pad(r.hour)}</span>
    </div>`;
  }).join("");
}

function renderTrail() {
  $("trail-card").hidden = trail.length < 2;
  $("trail").innerHTML = trail.map((t, i) => {
    const d = i ? t.safe - trail[i - 1].safe : null;
    const ds = d === null ? "" : ` <span class="${d >= 0 ? "up" : "down"}">(${signed(d)})</span>`;
    return `<li><span>${esc(t.label)}</span><span class="h2">${t.safe} h${ds}</span></li>`;
  }).join("");
}

// ----- Interventions -------------------------------------------------------
function renderChanges() {
  const list = result.changes;
  if (!list.length) {
    $("changes").innerHTML = `<li class="none">No single changes left to test for this design.</li>`;
    $("show-all").hidden = true;
    return;
  }
  const maxGain = Math.max(1, ...list.map(c => Math.abs(c.safe_hours_gained)));
  const helpful = list.filter(c => c.safe_hours_gained > 0).length;
  const shown = showAll ? list : list.slice(0, Math.max(1, Math.min(TOP_CHANGES, helpful || 1)));
  $("changes").innerHTML = shown.map((c, i) => {
    const g = c.safe_hours_gained;
    return `<li class="change${preview === c ? " on" : ""}" data-i="${list.indexOf(c)}" title="Click to compare in the timeline">
      <span class="what">${esc(c.title)}: ${esc(c.label)}${i === 0 && g > 0 ? `<span class="best">Best</span>` : ""}<small>now ${esc(labelOf(c.parameter, state[c.parameter]))} · ${c.safe_hours} safe h · peak ${c.max_heat_index_c} °C</small></span>
      <span class="gain ${g > 0 ? "up" : g < 0 ? "down" : "muted"}">${signed(g)} h</span>
      <span class="bar${g < 0 ? " neg" : ""}"><i style="width:${(Math.abs(g) / maxGain * 100).toFixed(1)}%"></i></span>
      <button type="button" class="btn btn-outline btn-sm" data-apply="${list.indexOf(c)}">Apply</button>
    </li>`;
  }).join("");
  $("changes").querySelectorAll("[data-apply]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); applyChange(list[+b.dataset.apply]); }));
  $("changes").querySelectorAll(".change").forEach(li => li.addEventListener("click", () => {
    const c = list[+li.dataset.i];
    setPreview(preview === c ? null : c);
  }));
  const hidden = list.length - shown.length;
  $("show-all").hidden = !showAll && hidden === 0;
  $("show-all").textContent = showAll ? "Show fewer" : `Show all ${list.length} changes (${hidden} more)`;
}

function setPreview(c) {
  preview = c;
  $("compare").value = previewKey(c);
  renderChanges(); renderPackages(); renderWeek(); renderChart(); setHour(hour);
}

// Packages: the best single changes simulated together
function renderPackages() {
  const list = result.packages || [];
  $("packages-block").hidden = !list.length;
  if (!list.length) return;
  const maxGain = Math.max(1, ...list.map(k => k.safe_hours_gained), ...list.map(k => k.sum_of_single_gains));
  $("packages").innerHTML = list.map((k, i) => {
    const g = k.safe_hours_gained, lost = k.sum_of_single_gains - g;
    return `<li class="change${preview === k ? " on" : ""}" data-i="${i}" title="Click to compare in the timeline">
      <span class="what">${k.changes.map(c => `${esc(c.title)}: ${esc(c.label)}`).join(" + ")}
        <small>${k.safe_hours} safe h · peak ${k.max_heat_index_c} °C · dose ${Math.round(k.hazard_hours_ch).toLocaleString()} °C·h</small>
        <small>On their own these add up to ${signed(k.sum_of_single_gains)} h${lost > 0 ? `: ${lost} h overlap` : lost < 0 ? `: ${-lost} h more together` : ""}</small></span>
      <span class="gain ${g > 0 ? "up" : g < 0 ? "down" : "muted"}">${signed(g)} h</span>
      <span class="bar"><i style="width:${(Math.max(0, g) / maxGain * 100).toFixed(1)}%"></i></span>
      <button type="button" class="btn btn-outline btn-sm" data-pack="${i}">Apply</button>
    </li>`;
  }).join("");
  $("packages").querySelectorAll("[data-pack]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); applyPackage(list[+b.dataset.pack]); }));
  $("packages").querySelectorAll(".change").forEach(li => li.addEventListener("click", () => {
    const k = list[+li.dataset.i];
    setPreview(preview === k ? null : k);
  }));
}

function applyPackage(k) {
  for (const c of k.changes) state[c.parameter] = c.value;
  pendingLabel = `Package: ${k.label}`;
  preview = null;
  syncForm();
  simulate();
}

function renderCompare() {
  const sel = $("compare");
  sel.innerHTML = `<option value="">No change</option>` + result.changes.map((c, i) =>
    `<option value="c${i}">${esc(c.title)}: ${esc(c.label)} (${signed(c.safe_hours_gained)} h)</option>`).join("")
    + (result.packages || []).map((k, i) =>
      `<option value="p${i}">${esc(k.title)}: ${esc(k.label)} (${signed(k.safe_hours_gained)} h)</option>`).join("");
  sel.value = previewKey(preview);
}

// ----- Week grid (Summary) -------------------------------------------------
function renderWeek() {
  const week = $("week");
  if (!week.dataset.built) {
    let html = `<span></span>`;
    for (let h = 0; h < 24; h++) html += `<span class="hr">${pad(h)}</span>`;
    for (let d = 0; d < 7; d++) {
      html += `<span class="day">${dayName(d)}</span>`;
      for (let h = 0; h < 24; h++) html += `<span class="cell" data-h="${d * 24 + h}"></span>`;
    }
    week.innerHTML = html;
    week.dataset.built = "1";
    const pick = e => { if (e.target.dataset.h && (e.type === "click" || e.buttons === 1)) setHour(+e.target.dataset.h); };
    week.addEventListener("click", pick);
    week.addEventListener("mouseover", pick);
  }
  const lim = limit();
  const series = preview ? preview.heat_index : result.heat_index;
  week.querySelectorAll(".cell").forEach(cell => {
    const i = +cell.dataset.h;
    cell.style.background = cellColour(series[i]);
    cell.classList.toggle("cut", isCut(i));
    cell.title = `${hourName(i)} · felt ${series[i]} °C`;
    // A dot marks hours the compared change turns from danger to safe
    cell.classList.toggle("flip", !!preview && result.heat_index[i] >= lim && series[i] < lim);
  });
}

// ----- Timeline dock: heat strip + chart -----------------------------------
const CHART = { L: 38, R: 64 };      // plot margins in px; the strip uses the same (style.css .strip)

function renderStrip() {
  const strip = $("strip");
  const series = preview ? preview.heat_index : result.heat_index;
  strip.innerHTML = series.map((v, h) =>
    `<i class="${isCut(h) ? "cut" : ""}${h % 24 === 0 && h ? " day" : ""}" style="background:${cellColour(v)}"></i>`).join("");
}

function bindStrip() {
  const strip = $("strip");
  const at = e => {
    const r = strip.getBoundingClientRect();
    setHour(Math.max(0, Math.min(HOURS - 1, Math.floor((e.clientX - r.left) / r.width * HOURS))));
  };
  strip.addEventListener("pointerdown", e => { strip.setPointerCapture(e.pointerId); at(e); });
  strip.addEventListener("pointermove", e => { if (e.buttons === 1) at(e); });
  strip.addEventListener("keydown", e => {
    const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -24, PageDown: 24 }[e.key];
    if (step) { e.preventDefault(); setHour((hour + step + HOURS) % HOURS); }
  });
}

// Shared SVG frame for the week-long line charts (W in real pixels)
function weekFrame(W, H, L, R, T, B, lo, top) {
  const x = h => L + (h + 0.5) / HOURS * (W - L - R);
  const y = v => T + (top - Math.max(lo, Math.min(top, v))) / (top - lo) * (H - T - B);
  const path = s => s.map((v, h) => `${h ? "L" : "M"}${x(h).toFixed(1)},${y(v).toFixed(1)}`).join("");
  let g = "";
  const cw = (W - L - R) / HOURS;
  for (let h = 0; h < HOURS; h++) if (isCut(h)) g += `<rect class="cutband" x="${x(h) - cw / 2}" y="${T}" width="${Math.max(cw, 1.5)}" height="${H - T - B}"/>`;
  for (let d = 0; d < 7; d++) {
    const xd = L + d * 24 / HOURS * (W - L - R);
    g += `<line class="grid" x1="${xd}" x2="${xd}" y1="${T}" y2="${H - B}"/>`;
    g += `<text x="${xd + 4}" y="${H - 6}">${W - L - R > 420 ? dayName(d) : OPT.scenario.first_day + d}</text>`;
  }
  return { x, y, path, g };
}

function bindDrag(wrap, hitId, L, plotW) {
  const svg = wrap.querySelector("svg"), hit = $(hitId);
  svg.dataset.l = L; svg.dataset.w = plotW;
  const at = e => {
    const r = svg.getBoundingClientRect();
    setHour(Math.max(0, Math.min(HOURS - 1, Math.floor((e.clientX - r.left - L) / plotW * HOURS))));
  };
  hit.style.cursor = "ew-resize";
  hit.addEventListener("pointerdown", e => { hit.setPointerCapture(e.pointerId); at(e); });
  hit.addEventListener("pointermove", e => { if (e.buttons === 1) at(e); });
}

function keyRow(items, L, y = 10) {
  let kx = L;
  return items.map(([attrs, txt]) => {
    const s = `<g class="key"><line ${attrs} x1="${kx}" x2="${kx + 16}" y1="${y - 4}" y2="${y - 4}"/><text x="${kx + 21}" y="${y}">${esc(txt)}</text></g>`;
    kx += 36 + txt.length * 5.9;
    return s;
  }).join("");
}

function renderChart() {
  const W = Math.floor($("chart").clientWidth);
  if (!W || !result) return;
  const H = 132, { L, R } = CHART, T = 20, B = 20;
  const hi = result.heat_index, out = result.outdoor_temp, alt = preview?.heat_index;
  const all = hi.concat(out, alt || [], [limit()]);
  const lo = Math.floor(Math.min(...all) / 5) * 5, top = Math.ceil(Math.max(...all) / 5) * 5;
  const f = weekFrame(W, H, L, R, T, B, lo, top);
  let g = f.g;
  for (let v = lo; v <= top; v += 5) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${f.y(v)}" y2="${f.y(v)}"/>`;
    g += `<text x="${L - 6}" y="${f.y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  g += `<line class="limit" x1="${L}" x2="${W - R}" y1="${f.y(limit())}" y2="${f.y(limit())}"/>`;
  g += `<text class="limit-label" x="${W - R + 6}" y="${f.y(limit()) + 4}">${limit()} °C limit</text>`;
  g += `<path class="out" d="${f.path(out)}"/><path class="hi" d="${f.path(hi)}"/>`;
  if (alt) g += `<path class="alt" d="${f.path(alt)}"/>`;
  g += `<line class="cursor" id="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
  g += `<rect id="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  const keys = [[`class="hi"`, "felt heat indoors (°C)"], [`class="out"`, "outdoor air"]];
  if (alt) keys.splice(1, 0, [`class="alt"`, `with ${preview.label.toLowerCase()}`]);
  $("chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Felt heat through the week against the ${limit()} °C limit">${keyRow(keys, L)}${g}</svg>`;
  bindDrag($("chart"), "hit", L, W - L - R);
}

// One current hour everywhere: readout, strip, week grid, chart cursors, people, 3D
function setHour(h) {
  hour = h;
  if (!result) return;
  const lim = limit(), v = result.heat_index[h];
  let txt = `<b>${hourName(h)}</b>${isCut(h) ? `<span class="chip">POWER CUT</span>` : " · "}felt <span class="${v >= lim ? "hot-v" : ""}">${v} °C</span>`
    + ` · air ${result.indoor_temp[h]} °C · RH ${result.humidity[h]} % · outdoor ${result.outdoor_temp[h]} °C`;
  if (preview) txt += ` · with change <span class="${preview.heat_index[h] >= lim ? "hot-v" : ""}">${preview.heat_index[h]} °C</span>`;
  $("readout").innerHTML = txt;
  $("strip").setAttribute("aria-valuenow", h);
  $("strip").setAttribute("aria-valuetext", hourName(h));

  $("strip").querySelector("i.on")?.classList.remove("on");
  $("strip").children[h]?.classList.add("on");
  document.querySelectorAll(".week .cell.on").forEach(c => c.classList.remove("on"));
  document.querySelector(`.week .cell[data-h="${h}"]`)?.classList.add("on");
  for (const [chartId, curId] of [["chart", "cursor"], ["agent-chart", "agent-cursor"]]) {
    const svg = $(chartId).querySelector("svg"), cur = $(curId);
    if (!svg || !cur) continue;
    const cx = +svg.dataset.l + (h + 0.5) / HOURS * +svg.dataset.w;
    cur.setAttribute("x1", cx); cur.setAttribute("x2", cx); cur.setAttribute("visibility", "visible");
  }
  if (tab === "people") renderAgentCards(h);
  window.OASIS3D?.setHour(h);
}

function togglePlay() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; $("play").innerHTML = PLAY_ICON; $("play").setAttribute("aria-label", "Play"); return; }
  $("play").innerHTML = PAUSE_ICON; $("play").setAttribute("aria-label", "Pause");
  playTimer = setInterval(() => setHour((hour + 1) % HOURS), 450);
}

// ----- People (JOS-3) ------------------------------------------------------
const BODY = () => OPT.body_model || { core_caution_c: 37.5, core_limit_c: 38.0, core_critical_c: 38.5, v_under_fan: 0.8, v_still: 0.1, min_age: 18 };

function activeAgent() {
  const a = result.agents || [];
  if (!a[activeIdx]?.modelled) activeIdx = Math.max(0, a.findIndex(x => x.modelled));
  return a[activeIdx]?.modelled ? a[activeIdx] : null;
}
function selectAgent(i, fromViewer) {
  activeIdx = i;
  renderAgentCards(hour); renderAgentChart(); setHour(hour);
  if (!fromViewer) window.OASIS3D?.focus(result.agents[i]?.id ?? null);
}

function renderCheck() {
  const c = result.check;
  if (!c) { $("check").textContent = "No adults in the household, so the body check did not run."; return; }
  $("check").innerHTML = `Everyone modelled stays below ${c.core_limit_c.toFixed(1)} °C core in <b>${c.household_safe_hours}</b> of 168 h.
    The body model agrees with the heat index in ${c.hours_agree} h; in ${c.hi_safe_but_body_over_limit} h the heat index says safe while someone
    is over the limit (most affected: ${esc(c.most_affected)}).`;
}

function renderAgentCards(h) {
  const wrap = $("agent-cards");
  if (!result.agents) { wrap.innerHTML = ""; return; }
  activeAgent();
  wrap.innerHTML = result.agents.map((ag, idx) => {
    const meta = `${ag.age} y · ${esc(ag.sex)} · ${ag.height_cm} cm · ${ag.weight_kg} kg`;
    if (!ag.modelled) {
      return `<div class="agent-card off"><div class="ac-title">${esc(ag.name)}</div><div class="ac-meta">${meta}</div>
        <p class="ac-quote" style="font-style:normal;margin-top:6px">${esc(ag.note)}</p></div>`;
    }
    const st = ag.hourly.status[h] || "safe", tc = ag.hourly.t_core[h];
    return `<div class="agent-card${idx === activeIdx ? " active" : ""}" data-idx="${idx}" tabindex="0">
      <div class="ac-head">
        <div><div class="ac-title"><span style="color:${AGENT_COLORS[idx % AGENT_COLORS.length]}">●</span> ${esc(ag.name)}</div><div class="ac-meta">${meta}</div></div>
        <span class="ac-status ${st}">${esc(st)}</span>
      </div>
      <div class="ac-vitals">
        <div class="ac-vital"><span>Core</span><b class="${tc >= BODY().core_limit_c ? "hot-v" : ""}">${tc.toFixed(2)} °C</b></div>
        <div class="ac-vital"><span>Skin</span><b>${ag.hourly.t_skin[h].toFixed(1)} °C</b></div>
        <div class="ac-vital"><span>Skin wet</span><b>${ag.hourly.wettedness_pct[h]} %</b></div>
        <div class="ac-vital"><span>Sweat</span><b>${ag.hourly.sweat_gh[h]} g/h</b></div>
      </div>
      <p class="ac-quote">“${esc(ag.hourly.feedback[h])}”</p>
      <div class="ac-foot"><span>${esc(ag.hourly.activity[h])}</span>
        <span><b>${ag.summary.safe_hours}</b> of ${ag.summary.hours_at_home} h at home below ${BODY().core_limit_c.toFixed(1)} °C · max ${ag.summary.max_core_temp_c} °C</span></div>
    </div>`;
  }).join("");
  wrap.querySelectorAll(".agent-card[data-idx]").forEach(card => {
    card.addEventListener("click", () => selectAgent(+card.dataset.idx));
    card.addEventListener("keydown", e => { if (e.key === "Enter") selectAgent(+card.dataset.idx); });
  });
}

function renderAgentChart() {
  const wrap = $("agent-chart");
  const W = Math.floor(wrap.clientWidth);
  if (!W || !result.agents?.some(a => a.modelled)) { if (W) wrap.innerHTML = ""; return; }
  const H = 180, L = 34, R = 10, T = 22, B = 20;
  const f = weekFrame(W, H, L, R, T, B, 36.4, 39.0);
  let g = f.g;
  for (const v of [36.5, 37.0, 37.5, 38.0, 38.5]) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${f.y(v)}" y2="${f.y(v)}"/>`;
    g += `<text x="${L - 5}" y="${f.y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`;
  }
  const lim = BODY().core_limit_c;
  g += `<line class="limit" x1="${L}" x2="${W - R}" y1="${f.y(lim)}" y2="${f.y(lim)}"/>`;
  const keys = [];
  result.agents.forEach((ag, idx) => {
    if (!ag.modelled) return;
    const col = AGENT_COLORS[idx % AGENT_COLORS.length], on = idx === activeIdx;
    g += `<path fill="none" stroke="${col}" stroke-width="${on ? 2.2 : 1.2}" opacity="${on ? 1 : 0.55}" d="${f.path(ag.hourly.t_core)}"/>`;
    keys.push([`stroke="${col}" stroke-width="${on ? 2.2 : 1.2}"`, ag.name.split(" ")[0]]);
  });
  g += `<line class="cursor" id="agent-cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
  g += `<rect id="agent-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="JOS-3 core temperature for each person">${keyRow(keys, L)}${g}</svg>`;
  bindDrag(wrap, "agent-hit", L, W - L - R);
}

// ----- Basis: what the result rests on -------------------------------------
function renderBasis() {
  const sc = OPT.scenario, ev = OPT.evidence || {}, cal = OPT.calibration, p = JSON.parse(ranFor), s = result.summary;
  const w = weatherOf(p.weather), hw = ev.heatwave, city = ev.city;
  const row = (name, tag, val, src) => `<div class="basis-row"><div class="top"><span>${name}</span><span class="tagline ${tag.toLowerCase()}">${tag}</span></div>
    <div class="val">${val}</div><div class="src">${src}</div></div>`;
  const ph = OPT.physics, wall = ph.walls[p.wall], roof = ph.roofs[p.roof];
  const rows = [
    row("Outdoor weather", w.source, `${esc(w.label)} air · ${sc.first_day}–${sc.last_day} ${sc.month} 2024`,
      esc(w.note) + (hw ? ` Week mean outdoor heat index ${hw.week_stats.mean_heat_index_c} °C (typical-year file: ${hw.typical_year_week.mean_heat_index_c} °C). ${hw.hours_from_station}/${hw.hours_needed} hours from the station; sunlight from ERA5.` : "")),
    row("Building physics", "Calibrated", cal ? `Internal mass ${cal.adopted.internal_mass_m2} m², appliances ${cal.adopted.appliances_peak_w} W, AirflowNetwork` : "Calibrated defaults",
      cal ? `Fitted on ${cal.homes} monitored Dhaka homes: hourly error ${cal.adopted_scores.fit_rmse} °C (check period ${cal.adopted_scores.check_rmse} °C). Checked on Delhi homes without refitting.` : ""),
    row("Window use", p.night_vent ? "Observed" : "Chosen", p.night_vent ? "Open day and night" : "Shut 22:00–06:00",
      p.night_vent ? "What homes without AC do; every calibration home had its windows open."
        : "Not validated: no monitored home shut its windows at night. Treat this case with care."),
    row("Ceiling fan", "Standard", `Cooling effect about ${sc.fan_credit_c} °C at ${sc.fan_air_speed_ms} m/s`, "ASHRAE 55-2023 (SET method), worked out every hour from the room's air, radiant temperature and humidity. Off during the power cut."),
    row("Power cut", "Chosen", p.cut_start_hour === null || p.cut_start_hour === undefined ? "None" : p.cut_length_h >= 24 ? "No power all week" : `${pad(p.cut_start_hour)}:00–${pad((p.cut_start_hour + (p.cut_length_h || 1)) % 24)}:00 every day`, "A scenario, not a forecast: one hour is evening load shedding, the long cases follow the outage studies (Chen 2024, Shi 2025). The cut only takes the fan away. The summary also shows the worst hour of the day for a cut."),
    row("Heat dose", "Literature", `Felt heat above ${sc.dose.caution_c} °C, summed: ${Math.round(s.hazard_hours_ch).toLocaleString()} °C·h this week`, `Chen et al. 2024: illness likely above ${sc.dose.elderly_ch} °C·h (elderly) and ${sc.dose.young_ch.toLocaleString()} °C·h (young adults), or a peak near ${sc.dose.hi_max_c} °C. From a body model in a 7-day Guangzhou outage; not checked on Indian occupants. Here the fan's cooling effect is already taken off the felt heat.`),
    row("Safe limit", "Chosen", `Heat index below ${sc.safe_limit_c} °C`, `US NWS “Danger” band. Cross-check with the extended heat index (Lu &amp; Romps 2022): ${s.safe_hours_extended_hi ?? "–"} safe hours, peak ${s.max_extended_hi_c ?? "–"} °C. The NWS value is the more cautious count.`),
    row("Constructions", "Standard", `Wall U ${wall.u_value} · roof U ${roof.u_value} W/m²K · glass U ${ph.glass_u}`, `Wall ${wall.heat_capacity_kj} and roof ${roof.heat_capacity_kj} kJ/m²K heat capacity. Material values from BIS SP 41.`),
  ];
  const cityLine = city ? `Chennai's city-centre station is ${signed(city.season.dawn_0530_d_temp_c)} °C vs the airport at dawn and ${signed(city.season.afternoon_1430_d_temp_c)} °C at 14:30 (Apr–Jun 2016–25), with ${Math.round(city.season.wind_ratio_mean * 100)} % of its wind.` : "";
  $("basis").innerHTML = `
    <h3 class="h" style="margin:0 0 8px">Inputs of this run</h3>
    <div class="basis-table">${rows.join("")}</div>
    <h3 class="h" style="margin:16px 0 8px">Known limits</h3>
    <ul class="lims">
      <li class="ok"><b>City air and wind: measured</b>${cityLine} Switch the outdoor air under Scenario to test it.</li>
      <li class="ok"><b>Heat index range: cross-checked</b>Every run is also scored with the extended heat index, valid at any temperature and humidity.</li>
      <li class="part"><b>Daily peak about 2 h early</b>${cal ? `The model's room peaks around ${cal.peak_hour_sim}:00, monitored homes around ${cal.peak_hour_meas}:00.` : ""} The 20:00 hour is right. Roof and internal mass are ruled out as the cause; daytime window use needs sensors.</li>
      <li><b>Street AC heat</b>Air beside AC outdoor units is not in either station. The +1 °C case is from studies in Paris and Phoenix.</li>
      <li><b>No Chennai homes yet</b>The calibration homes are in Dhaka. A Chennai field campaign is planned for 2027.</li>
      <li><b>Children</b>No validated body model for children: they are covered by the heat index only.</li>
    </ul>`;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------
function bindTimeline() {
  bindStrip();
  $("compare").addEventListener("change", e => setPreview(previewFrom(e.target.value)));
  $("play").addEventListener("click", togglePlay);
  $("step-back").addEventListener("click", () => setHour((hour + HOURS - 1) % HOURS));
  $("step-fwd").addEventListener("click", () => setHour((hour + 1) % HOURS));
  $("show-all").addEventListener("click", () => { showAll = !showAll; renderChanges(); });
  $("undo").addEventListener("click", undo);
  window.addEventListener("oasis3d-focus", e => {
    const i = (result?.agents || []).findIndex(a => a.id === e.detail);
    if (i >= 0 && result.agents[i].modelled) selectAgent(i, true);
  });
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, select, textarea") || $("app").hidden || !result) return;
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    if (e.key === "ArrowRight" && !e.target.matches(".tab, .strip")) setHour((hour + 1) % HOURS);
    if (e.key === "ArrowLeft" && !e.target.matches(".tab, .strip")) setHour((hour + HOURS - 1) % HOURS);
  });
  let timer = null;
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (result && !$("app").hidden) { renderChart(); if (tab === "people") renderAgentChart(); setHour(hour); } }, 120);
  }).observe($("dock"));
}

function bindTheme() {
  const root = document.documentElement;
  try { const saved = localStorage.getItem("oasis-theme"); if (saved) root.dataset.theme = saved; } catch (_) {}
  const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  $("theme").addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("oasis-theme", root.dataset.theme); } catch (_) {}
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function start() {
  bindTheme();
  $("start").addEventListener("click", () => enterApp(false));
  $("start-rhino").addEventListener("click", () => enterApp(true));
  $("home").addEventListener("click", showIntro);
  try {
    OPT = await api("/api/options");
  } catch (err) {
    status("Server not reachable", "bad");
    $("loading").hidden = true;
    $("error").textContent = `Could not reach the OASIS server (${err.message}). Start it with: python run_server.py`;
    $("error").hidden = false;
    return;
  }
  const sc = OPT.scenario;
  $("intro-scenario").textContent = `${sc.city} · ${sc.first_day}–${sc.last_day} ${sc.month} 2024 recorded heatwave · power cut ${pad(sc.cut_start_hour)}:00–${pad(sc.cut_end_hour)}:00`;
  const cal = OPT.calibration;
  $("sb-cal").textContent = cal ? `Calibrated on ${cal.homes} monitored homes · error ${cal.adopted_scores.fit_rmse} °C` : "";

  state = { ...OPT.baseline };
  roster = JSON.parse(JSON.stringify(OPT.default_agents || []));
  buildForm();
  bindHousehold();
  bindRhino();
  bindTabs();
  bindTimeline();
  renderPeople();
  $("run").addEventListener("click", simulate);
  syncForm();
  status("Ready", "ok");
  simulate();                 // the baseline runs while the intro is showing
}

start();
