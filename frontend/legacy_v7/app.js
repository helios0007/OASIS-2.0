// ============================================================================
// OASIS 2.0 · web tool (front end for backend/main.py)
//
// Flow: intro -> inputs -> POST /api/assess -> safe hours + every single
// change ranked. Applying a change makes it the new design and re-simulates;
// every run is kept in a design history so the user can step back.
// ============================================================================

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp01 = x => Math.max(0, Math.min(1, x));
const pad = n => String(n).padStart(2, "0");
const HOURS = 168;
const TOP_CHANGES = 5;   // changes shown before "Show all"

// Which control each design choice uses, and where it sits in the sidebar
const ORIENTATION = { key: "orientation_deg", title: "Windows face",
  options: [{ value: 0, label: "North & South" }, { value: 90, label: "East & West" }] };
const BASICS = [["floor", "seg"], ["orientation_deg", "seg"], ["roof_solar_absorptance", "swatch"], ["night_vent", "switch"]];
const DETAILS = [["wall", "select"], ["roof", "select"], ["shading_depth_m", "seg"], ["occupants", "seg"]];
const ROOF_ONLY = ["roof", "roof_solar_absorptance"];        // no effect on a middle floor
const ROOF_SWATCH = { 0.7: "#6b665c", 0.4: "#b5afa3", 0.2: "#ffffff" };
const TITLES = { occupants: "People (internal heat)", night_vent: "Open windows at night" };

let OPT = null;          // /api/options
let state = {};          // current design (Building fields)
let roster = [];         // household for the JOS-3 check
let model = null;        // Rhino geometry, or null
let result = null;       // last /api/assess response
let ranFor = null;       // payload text of the last result
let preview = null;      // change chosen in "Compare with"
let trail = [];          // [{label, safe, snapshot}]
let pendingLabel = null; // label for the next history entry
let requestNo = 0;
let hour = 116;          // hour shown in readouts (14 May, 20:00: a power cut)
let activeIdx = 0;       // highlighted person
let playTimer = null;
let showAll = false;
let tab = "overview";

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
const choice = key => key === ORIENTATION.key ? ORIENTATION : OPT.choices.find(c => c.key === key);
const labelOf = (key, value) => (choice(key)?.options.find(o => o.value === value) || {}).label ?? String(value);
const isCut = h => { const hr = h % 24; return hr >= OPT.scenario.cut_start_hour && hr < OPT.scenario.cut_end_hour; };
const dayName = d => `${OPT.scenario.first_day + d} ${OPT.scenario.month}`;
const hourName = h => `${dayName(Math.floor(h / 24))}, ${pad(h % 24)}:00`;
const signed = n => (n > 0 ? "+" : "") + n;

// Small technical note under an option (from the physics the server reports)
function optionNote(key, value) {
  const ph = OPT.physics || {};
  if (key === "wall" && ph.walls?.[value]) return `U ${ph.walls[value].u_value} W/m²K`;
  if (key === "roof" && ph.roofs?.[value]) return `U ${ph.roofs[value].u_value} W/m²K`;
  return "";
}

// ---------------------------------------------------------------------------
// Toasts (Sonner-style: stack bottom-right, update in place, optional action)
// ---------------------------------------------------------------------------
const ICONS = {
  success: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  error: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>`,
  loading: `<span class="spinner"></span>`,
};
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
// Pause timers while the tab is hidden (Sonner does the same)
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
    // The baseline may still be running from the intro: say so
    if ($("run").disabled && !toasts.has("sim")) {
      toast("Simulating the heatwave week", { id: "sim", type: "loading", detail: "EnergyPlus: your design and every single change" });
    }
    if (thenPickFile) $("file").click();
  }, 200);
}
function showIntro() {
  $("app").hidden = true;
  $("app").classList.remove("entering");
  $("intro").hidden = false;
}

// ---------------------------------------------------------------------------
// Sidebar controls
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

function buildForm() {
  $("basics").innerHTML = BASICS.map(controlHtml).join("");
  $("details").innerHTML = DETAILS.map(controlHtml).join("");

  $("form").addEventListener("change", e => {
    const t = e.target, key = t.name;
    if (key && t.type === "radio") state[key] = choice(key).options[+t.value].value;
    if (key && t.type === "checkbox") state[key] = t.checked;
    if (key && t.tagName === "SELECT") state[key] = choice(key).options[+t.value].value;
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

// Push state into the controls and refresh locks, notes and the stale flag
function syncForm() {
  for (const [key] of [...BASICS, ...DETAILS]) {
    const c = choice(key);
    if (!c) continue;
    const i = c.options.findIndex(o => o.value === state[key]);
    document.querySelectorAll(`input[type=radio][name="${key}"]`).forEach(r => { r.checked = +r.value === i; });
    const sel = document.querySelector(`select[name="${key}"]`);
    if (sel) sel.value = String(i);
    const box = document.querySelector(`input[type=checkbox][name="${key}"]`);
    if (box) box.checked = !!state[key];
  }
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

  const stale = result && JSON.stringify(payload()) !== ranFor;
  $("run").classList.toggle("stale", !!stale);
  if (!$("run").disabled) $("run").textContent = stale ? "Update results" : "Run simulation";
}

function payload() {
  const keys = ["length_m", "width_m", "height_m", "orientation_deg", "floor", "wall", "roof",
    "roof_solar_absorptance", "wwr", "shading_depth_m", "night_vent", "occupants"];
  const p = Object.fromEntries(keys.map(k => [k, state[k]]));
  if (model) Object.assign(p, model.geometry);   // dims, orientation and glass per wall
  if (model?.plan_id) { p.plan_id = model.plan_id; if (model.party) p.party_walls = model.party; }
  p.agents = roster;
  return p;
}

// ---------------------------------------------------------------------------
// Household: compact list in the sidebar, editor in a drawer
// ---------------------------------------------------------------------------
const AGENT_COLORS = ["#c2410c", "#1d4ed8", "#15803d", "#7c3aed", "#b91c1c", "#0d9488"];
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
        ${roster.length > 1 ? `<button type="button" class="btn btn-ghost btn-icon" data-del="${i}" aria-label="Remove ${esc(a.name)}">
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
  $("edit-household").addEventListener("click", openSheet);
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
    ${data.plan_id ? `<span class="muted">Simulated room by room · results in the 3D tab</span>
    <label class="control"><span class="control-label">Shared walls</span>
      <select class="select" id="party">
        <option value="">As drawn (none marked = all face outside)</option>
        <option value="windowless">Every wall without a window is shared</option>
      </select></label>` : ""}
    ${(r.warnings || []).map(w => `<span class="warn">${esc(w)}</span>`).join("")}`;
  $("model").hidden = false;
  $("drop").hidden = true;
  $("unload").onclick = () => { clearModel(); syncForm(); };
  if (data.plan_id) {
    $("party").value = data.party || "";
    $("party").onchange = e => { model = { ...model, party: e.target.value || null }; syncForm(); };
  }
  if (quiet) return;
  pendingLabel = `Imported ${r.file}`;
  toast(`Imported ${r.file}`, { type: "success", detail: data.plan_id
    ? `${r.rooms} rooms: simulated room by room, shown in the 3D tab.` : "Room size and windows now come from the model." });
  syncForm();
  simulate();
}
function clearModel() { model = null; $("model").hidden = true; $("drop").hidden = false; }

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
  const drop = $("drop");
  $("pick").addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", e => { if (e.target.files[0]) upload(e.target.files[0]); e.target.value = ""; });
  // Drag a .3dm anywhere onto the sidebar
  const side = document.querySelector(".side");
  side.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  side.addEventListener("dragleave", e => { if (!side.contains(e.relatedTarget)) drop.classList.remove("over"); });
  side.addEventListener("drop", e => {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
  });
  api("/api/samples").then(list => {
    if (!list.length) { $("samples").hidden = true; return; }
    $("samples").innerHTML = "or use a sample: " + list.map(s =>
      `<button type="button" class="link" data-sample="${esc(s.id)}">${esc(s.name)}</button>`).join(" · ");
    $("samples").querySelectorAll("[data-sample]").forEach(b => b.addEventListener("click", () =>
      loadRhino(api(`/api/rhino/sample?name=${encodeURIComponent(b.dataset.sample)}`, { method: "POST" }))));
  }).catch(() => { $("samples").hidden = true; });
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
  if (!onIntro) toast("Simulating the heatwave week", { id: "sim", type: "loading", detail: "EnergyPlus: your design and every single change" });
  $("run").disabled = true;
  $("run").textContent = "Simulating…";
  $("result").classList.add("dim");
  $("error").hidden = true;

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
    const d = before === undefined ? null : res.summary.safe_hours - before;
    if (!onIntro || toasts.has("sim")) toast(`${res.summary.safe_hours} of 168 hours safe`, {
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
      $("result").classList.remove("dim");
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
  if (!result) return;
  document.querySelectorAll(".tabpanel").forEach(p => { p.hidden = p.dataset.panel !== name; });
  if (name === "week") { renderWeek(); renderChart(); }
  if (name === "body") { renderAgentChart(); }
  setHour(hour);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
let shownPlan = null;     // plan_id shown in the 3D tab

function render3d() {
  const unit = result.unit;
  $("tab-flat").hidden = !unit;
  $("method-model").textContent = unit
    ? "Room-by-room EnergyPlus 26.2 model (one zone per room, AirflowNetwork); results are where the people are: the living room by day, the hottest bedroom at night"
    : "Single-zone EnergyPlus 26.2 model";
  document.querySelector(".body-grid .room").hidden = !!unit;     // the 3D tab shows the rooms
  if (!unit) { if (tab === "flat") tab = "overview"; shownPlan = null; return; }
  const plan = JSON.parse(ranFor).plan_id, first = plan !== shownPlan;
  shownPlan = plan;
  if (first) tab = "flat";                                          // a new plan opens on the 3D tab
  const draw = () => window.OASIS3D.show(unit, { keepView: !first, name: model?.report?.file });
  if (window.OASIS3D) draw(); else window.addEventListener("oasis3d-ready", draw, { once: true });
}

function render() {
  $("loading").hidden = true;
  render3d();
  renderVerdict();
  renderChanges();
  renderPeaks();
  renderTrail();
  renderCompare();
  renderCheck();
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

function renderVerdict() {
  const s = result.summary, lim = limit();
  $("score").textContent = s.safe_hours;
  const days = Math.round(s.danger_hours / 24 * 10) / 10;
  const first = trail[0]?.safe;
  const delta = trail.length > 1 ? s.safe_hours - first : null;
  const deltaHtml = delta === null ? "" : `<span class="delta ${delta >= 0 ? "up" : "down"}">${signed(delta)} h vs start</span>`;
  $("verdict").innerHTML = s.danger_hours === 0
    ? `The flat stays below ${lim} °C felt heat all week.${deltaHtml}`
    : `People here spend <b>${s.danger_hours} hours</b> (about ${days} days) above ${lim} °C felt heat this week.${deltaHtml}`;

  $("meter").innerHTML = result.heat_index.map(v => `<i style="background:${v >= lim ? "var(--heat)" : "var(--safe-warm)"}"></i>`).join("");

  const cutTotal = HOURS / 24 * (OPT.scenario.cut_end_hour - OPT.scenario.cut_start_hour);
  const p = result.peaks;
  $("stats").innerHTML = `
    <div class="stat"><span>Hours in danger</span><b>${s.danger_hours}<small> h</small></b><em>felt heat ≥ ${lim} °C</em></div>
    <div class="stat"><span>Power-cut hours in danger</span><b>${s.cut_hours_in_danger}<small> of ${cutTotal}</small></b><em>${pad(OPT.scenario.cut_start_hour)}:00–${pad(OPT.scenario.cut_end_hour)}:00, fan off</em></div>
    <div class="stat"><span>Peak felt heat</span><b>${s.max_heat_index_c}<small> °C</small></b><em>${p ? `around ${pad(p.normal.typical_hour)}:00` : "heat index"}</em></div>
    <div class="stat"><span>Peak indoor air</span><b>${s.max_indoor_temp_c}<small> °C</small></b><em>mean ${s.mean_indoor_temp_c} °C</em></div>`;
}

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
    return `<li class="change">
      <span class="rank">${pad(i + 1)}</span>
      <span class="what">${esc(c.title)}: ${esc(c.label)}${i === 0 && g > 0 && !showAll ? `<span class="best">Best</span>` : ""}<small>now ${esc(labelOf(c.parameter, state[c.parameter]))} · ${c.safe_hours} safe h · peak ${c.max_heat_index_c} °C</small></span>
      <span class="bar${g < 0 ? " neg" : ""}"><i style="width:${(Math.abs(g) / maxGain * 100).toFixed(1)}%"></i></span>
      <span class="gain ${g > 0 ? "up" : g < 0 ? "down" : "muted"}">${signed(g)} h</span>
      <button type="button" class="btn btn-outline btn-sm" data-i="${list.indexOf(c)}">Apply</button>
    </li>`;
  }).join("");
  $("changes").querySelectorAll("[data-i]").forEach(b => b.addEventListener("click", () => applyChange(list[+b.dataset.i])));
  const hidden = list.length - shown.length;
  $("show-all").hidden = !showAll && hidden === 0;
  $("show-all").textContent = showAll ? "Show fewer" : `Show all ${list.length} changes (${hidden} more)`;
}

// Two peaks: the normal daily peak, and the peak during the power cut.
// The cut only removes the fan credit, so every hour can be tested as a cut hour.
function renderPeaks() {
  const p = result.peaks;
  if (!p) return;
  const lim = limit(), n = p.normal, c = p.cut, w = p.by_hour[p.worst_cut_hour];
  $("peaks").innerHTML = `
    <div class="peak"><span>Normal peak (fan on)</span><b>${pad(n.typical_hour)}:00 · ${n.max_heat_index_c} °C</b><em>felt; air up to ${n.max_indoor_temp_c} °C</em></div>
    <div class="peak"><span>During the ${pad(c.start_hour)}:00 cut</span><b>${c.max_heat_index_c} °C felt</b><em>above ${lim} °C on ${c.nights_in_danger} of ${c.days} nights</em></div>
    <div class="peak"><span>Worst hour for a cut</span><b>${pad(w.hour)}:00 · ${w.max_heat_index_no_fan_c} °C</b><em>above the limit on ${w.days_in_danger} of ${c.days} days</em></div>`;
  const hiMin = 30, hiMax = Math.max(...p.by_hour.map(r => r.max_heat_index_no_fan_c), lim + 5);
  $("cutscan").innerHTML = p.by_hour.map(r => {
    const hgt = Math.max(4, Math.round(100 * (r.max_heat_index_no_fan_c - hiMin) / (hiMax - hiMin)));
    const cut = r.hour >= c.start_hour && r.hour < c.end_hour;
    return `<div class="cs-col${cut ? " cut" : ""}" title="${pad(r.hour)}:00 · fan off: up to ${r.max_heat_index_no_fan_c} °C felt · ${r.days_in_danger}/${c.days} days above ${lim} °C">
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
    return `<li><span>${esc(t.label)}</span><span class="h">${t.safe} h${ds}</span></li>`;
  }).join("");
}

// ----- Hour by hour --------------------------------------------------------
function renderCompare() {
  const sel = $("compare");
  sel.innerHTML = `<option value="">No change</option>` + result.changes.map((c, i) =>
    `<option value="${i}">${esc(c.title)}: ${esc(c.label)} (${signed(c.safe_hours_gained)} h)</option>`).join("");
  sel.value = preview ? String(result.changes.indexOf(preview)) : "";
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
    // A dot marks hours the compared change turns from danger to safe
    cell.classList.toggle("flip", !!preview && result.heat_index[i] >= lim && series[i] < lim);
  });
}

// Shared SVG frame for the two week-long line charts
function weekFrame(W, H, L, R, T, B, lo, top) {
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
  return { x, y, path, g };
}

function bindHover(wrap, hitId, L, plotW) {
  const svg = wrap.querySelector("svg");
  svg.dataset.l = L; svg.dataset.w = plotW;
  $(hitId).addEventListener("mousemove", e => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const px = pt.matrixTransform(svg.getScreenCTM().inverse()).x;
    setHour(Math.max(0, Math.min(HOURS - 1, Math.floor((px - L) / plotW * HOURS))));
  });
}

function keyRow(items, L) {
  let kx = L;
  return items.map(([attrs, txt]) => {
    const s = `<g class="key"><line ${attrs} x1="${kx}" x2="${kx + 18}" y1="-4" y2="-4"/><text x="${kx + 24}" y="0">${esc(txt)}</text></g>`;
    kx += 40 + txt.length * 6.4;
    return s;
  }).join("");
}

function renderChart() {
  const W = 1000, H = 250, L = 38, R = 64, T = 12, B = 24;
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
  g += `<text class="limit-label" x="${W - R + 6}" y="${f.y(limit()) + 4}">${limit()} °C</text>`;
  g += `<path class="out" d="${f.path(out)}"/><path class="hi" d="${f.path(hi)}"/>`;
  if (alt) g += `<path class="alt" d="${f.path(alt)}"/>`;
  g += `<line class="cursor" id="cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
  g += `<rect id="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  const keys = [[`class="hi"`, "felt heat, this design"], [`class="out"`, "outdoor air"]];
  if (alt) keys.splice(1, 0, [`class="alt"`, `with ${preview.label.toLowerCase()}`]);
  $("chart").innerHTML = `<svg viewBox="0 -14 ${W} ${H + 14}" role="img" aria-label="Felt heat through the week against the ${limit()} °C limit">${keyRow(keys, L)}${g}</svg>`;
  bindHover($("chart"), "hit", L, W - L - R);
}

// Linked hover: one hour in the readout, the grid, the chart cursors and the room
function setHour(h) {
  hour = h;
  if (!result) return;
  const lim = limit(), v = result.heat_index[h];
  let txt = `<b>${hourName(h)}</b>${isCut(h) ? " · power cut" : ""} · felt <span class="${v >= lim ? "hot-v" : ""}">${v} °C</span>`
    + ` · air ${result.indoor_temp[h]} °C · RH ${result.humidity[h]} % · outdoor ${result.outdoor_temp[h]} °C`;
  if (preview) txt += ` · with change <span class="${preview.heat_index[h] >= lim ? "hot-v" : ""}">${preview.heat_index[h]} °C</span>`;
  $("readout").innerHTML = txt;
  $("hour-slider").value = h;
  $("scrubber-time").textContent = hourName(h);

  document.querySelectorAll(".week .cell.on").forEach(c => c.classList.remove("on"));
  document.querySelector(`.week .cell[data-h="${h}"]`)?.classList.add("on");
  for (const [chartId, curId] of [["chart", "cursor"], ["agent-chart", "agent-cursor"]]) {
    const svg = $(chartId).querySelector("svg"), cur = $(curId);
    if (!svg || !cur) continue;
    const cx = +svg.dataset.l + (h + 0.5) / HOURS * +svg.dataset.w;
    cur.setAttribute("x1", cx); cur.setAttribute("x2", cx); cur.setAttribute("visibility", "visible");
  }
  if (tab === "body") { renderRoomStage(h); renderAgentCards(h); }
}

// ----- Household check (JOS-3) ---------------------------------------------
const STATUS_COLOR = { safe: "#15803d", caution: "#d97706", danger: "#ea580c", critical: "#dc2626", away: "#71717a" };
const BODY = () => OPT.body_model || { core_caution_c: 37.5, core_limit_c: 38.0, core_critical_c: 38.5, v_under_fan: 0.8, v_still: 0.1, min_age: 18 };

function activeAgent() {
  const a = result.agents || [];
  if (!a[activeIdx]?.modelled) activeIdx = Math.max(0, a.findIndex(x => x.modelled));
  return a[activeIdx]?.modelled ? a[activeIdx] : null;
}
function selectAgent(i) { activeIdx = i; renderRoomStage(hour); renderAgentCards(hour); renderAgentChart(); setHour(hour); }

function renderCheck() {
  const c = result.check;
  if (!c) { $("check").textContent = "No adults in the household, so the body check did not run."; return; }
  $("check").innerHTML = `Everyone modelled stays below ${c.core_limit_c.toFixed(1)} °C core in <b>${c.household_safe_hours}</b> of 168 h.
    It agrees with the heat index in ${c.hours_agree} h; in ${c.hi_safe_but_body_over_limit} h the heat index says safe while someone
    is over the limit (most affected: ${esc(c.most_affected)}).`;
}

// ----- Room plan, to scale -------------------------------------------------
// Drawn in the room's own frame, as in oasis/build_idf.py: length_m along x,
// width_m along y, the model's "north" wall at the top. The drawing is then
// rotated by orientation_deg, so true north is always up on screen.
const FACING = { north: 0, east: 90, south: 180, west: 270 };
const compassName = deg => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

// Glass per wall: the same rule as build_idf.py:window_sizes (one centred
// window per wall, keeping the wall's proportions).
function windowWidths(p) {
  const wall = { north: p.length_m, south: p.length_m, east: p.width_m, west: p.width_m };
  const areas = p.window_area_m2
    || { north: p.wwr * p.length_m * p.height_m, south: p.wwr * p.length_m * p.height_m };
  const out = {};
  for (const [side, a] of Object.entries(areas)) {
    if (a > 0) out[side] = { area: a, width: wall[side] * Math.min(Math.sqrt(a / (wall[side] * p.height_m)), 0.95) };
  }
  return out;
}

function renderRoomStage(h) {
  const stage = $("room-stage");
  if (!result.agents?.length) { stage.innerHTML = ""; return; }
  const p = ranFor ? JSON.parse(ranFor) : payload();    // the design that was simulated
  const cut = isCut(h), tIn = result.indoor_temp[h], rhIn = result.humidity[h], hi = result.heat_index[h];
  $("fan-badge").className = "badge" + (cut ? " off" : "");
  $("fan-badge").textContent = cut ? `Power cut · fan off · ${tIn} °C` : `Fan on · ${tIn} °C · ${rhIn} % RH`;
  $("room-title").textContent = `${p.length_m.toFixed(1)} × ${p.width_m.toFixed(1)} m · ${p.floor === "top" ? "top" : "middle"} floor · felt ${hi} °C`;

  // Fit the rotated room into the drawing box
  const W = 480, H = 360, CX = 240, CY = 150, BOXW = 330, BOXH = 200;
  const rot = p.orientation_deg || 0, th = rot * Math.PI / 180;
  const ac = Math.abs(Math.cos(th)), as = Math.abs(Math.sin(th));
  const s = Math.min(BOXW / (p.length_m * ac + p.width_m * as), BOXH / (p.length_m * as + p.width_m * ac)); // px per m
  const rw = p.length_m * s, rh = p.width_m * s;
  // Room frame (origin at the centre, y down) -> screen
  const P = (x, y) => [CX + x * Math.cos(th) - y * Math.sin(th), CY + x * Math.sin(th) + y * Math.cos(th)];
  const txt = (x, y, t, size = 9.5, fill = "var(--muted-fg)", wall = false) => {
    const [sx, sy] = P(x, y);
    // Wall labels left or right of the room grow away from it
    const anchor = !wall || Math.abs(sx - CX) < 20 ? "middle" : sx < CX ? "end" : "start";
    return `<text x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-family="var(--mono)" font-size="${size}" fill="${fill}">${t}</text>`;
  };

  // Windows (to scale) and overhangs (real depth), in the room frame
  const wins = windowWidths(p), d = (p.shading_depth_m || 0) * s;
  const glass = `fill="#7dd3fc" stroke="#0284c7" stroke-width="1"`, shade = `fill="#71717a" opacity="0.6"`;
  let geo = "", labels = "";
  for (const side of ["north", "east", "south", "west"]) {
    const vertical = side === "east" || side === "west";
    const sign = side === "north" || side === "west" ? -1 : 1;
    const half = (vertical ? rw : rh) / 2;             // centre to this wall
    const w = wins[side] ? wins[side].width * s : 0;
    if (w) {
      geo += vertical
        ? `<rect x="${sign * half - 4}" y="${-w / 2}" width="8" height="${w}" ${glass}/>`
        : `<rect x="${-w / 2}" y="${sign * half - 4}" width="${w}" height="8" ${glass}/>`;
      if (d) geo += vertical
        ? `<rect x="${sign > 0 ? half + 4 : -half - 4 - d}" y="${-w / 2 - 3}" width="${d}" height="${w + 6}" ${shade}/>`
        : `<rect x="${-w / 2 - 3}" y="${sign > 0 ? half + 4 : -half - 4 - d}" width="${w + 6}" height="${d}" ${shade}/>`;
    }
    // Outside each wall: which way it faces, and its glass area
    const off = half + (vertical ? 10 : 14) + (w ? d : 0);
    const [lx, ly] = vertical ? [sign * off, 0] : [0, sign * off];
    const face = compassName(FACING[side] + rot);
    labels += txt(lx, ly, w ? `${face} · ${wins[side].area.toFixed(1)} m² glass` : face, 9.5, w ? "var(--fg-2)" : "var(--muted-fg)", true);
  }

  // Use zones and the fan scale with the room (sketches: not in the model)
  const zone = (x, y, w, hh) => `<rect x="${x}" y="${y}" width="${w}" height="${hh}" rx="4" fill="none" stroke="var(--border)" stroke-dasharray="3 3"/>`;
  const zh = rh * 0.26, pd = 8;
  geo += zone(-rw / 2 + pd, -rh / 2 + pd, rw - 2 * pd, rh * 0.22)
    + zone(-rw / 2 + pd, rh / 2 - pd - zh, rw * 0.42, zh)
    + zone(rw / 2 - pd - rw * 0.34, rh / 2 - pd - zh, rw * 0.34, zh);
  labels += txt(0, -rh / 2 + pd + rh * 0.11, wins.north ? "NEAR WINDOW" : "LIVING")
    + txt(-rw / 2 + pd + rw * 0.21, rh / 2 - pd - zh / 2, "SLEEPING")
    + txt(rw / 2 - pd - rw * 0.17, rh / 2 - pd - zh / 2, "KITCHEN");
  const fr = Math.min(rw, rh) * 0.24, blade = Math.min(22, fr * 0.45);
  geo += `<circle cx="0" cy="0" r="${fr}" fill="${cut ? "rgba(220,38,38,0.05)" : "rgba(21,128,61,0.06)"}" stroke="${cut ? "var(--loss)" : "var(--gain)"}" stroke-opacity="0.35" stroke-dasharray="4 3"/>
    <g ${cut ? "" : `transform="rotate(${(h * 47) % 360})"`}>
      <line x1="${-blade}" x2="${blade}" stroke="var(--muted-fg)" stroke-width="2.5" stroke-linecap="round" opacity="0.6"/>
      <line y1="${-blade}" y2="${blade}" stroke="var(--muted-fg)" stroke-width="2.5" stroke-linecap="round" opacity="0.6"/>
      <circle r="5" fill="var(--fg-2)"/></g>`;

  // Each modelled person at this hour's position (pos y > 0 is the model's north wall)
  let people = "";
  const act = activeAgent();
  const clamp = (v, a) => Math.max(-a, Math.min(a, v));
  result.agents.forEach((ag, idx) => {
    if (!ag.modelled) return;
    const [nx, ny] = ag.hourly.pos[h] || [0, 0];
    const x = clamp(nx * rw * 0.38 + (idx - 1.5) * 14, rw / 2 - 14);
    const y = ny <= -0.75 ? rh / 2 + 26                 // away: outside the south wall
      : clamp(-ny * rh * 0.38 + ((idx % 2) - 0.5) * 10, rh / 2 - 14);
    const [ax, ay] = P(x, y);
    const st = ag.hourly.status[h] || "safe", col = STATUS_COLOR[st], on = idx === activeIdx;
    people += `<g class="svg-agent" data-ag="${idx}" transform="translate(${ax.toFixed(1)},${ay.toFixed(1)})" style="cursor:pointer">
      ${st === "critical" || st === "danger" ? `<circle r="${on ? 24 : 19}" fill="${col}" opacity="0.22"/>` : ""}
      <circle r="${on ? 15 : 12}" fill="${col}" stroke="${on ? "var(--fg)" : "#fff"}" stroke-width="${on ? 2.5 : 1.5}"/>
      <circle cy="-3.5" r="3.2" fill="#fff"/><path d="M -5.5 5.5 C -5.5 1, 5.5 1, 5.5 5.5 Z" fill="#fff"/>
      <rect x="-42" y="15" width="84" height="16" rx="4" fill="var(--card)" stroke="${on ? "var(--fg)" : "var(--border)"}"/>
      <text y="26" text-anchor="middle" font-family="var(--mono)" font-size="9.5" font-weight="500" fill="var(--fg)">${esc(ag.name.split(" ")[0])} · ${ag.hourly.t_core[h].toFixed(2)}°</text></g>`;
  });

  // North arrow and a 1 m scale bar
  const extras = `<g transform="translate(${W - 26}, 26)"><path d="M0 -14 L6 6 L0 2 L-6 6 Z" fill="var(--fg)"/>
      <text y="20" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--fg)">N</text></g>
    <g transform="translate(18, 24)"><line x2="${s}" stroke="var(--fg)" stroke-width="2"/>
      <line y1="-4" y2="4" stroke="var(--fg)"/><line x1="${s}" x2="${s}" y1="-4" y2="4" stroke="var(--fg)"/>
      <text x="${s / 2}" y="-8" text-anchor="middle" font-family="var(--mono)" font-size="9.5" fill="var(--muted-fg)">1 m</text></g>`;

  const roomBg = `rgba(234, 88, 12, ${(0.04 + clamp01((hi - 32) / 14) * 0.18).toFixed(2)})`;
  const quote = act ? act.hourly.feedback[h] || "" : "";
  const qcol = act ? STATUS_COLOR[act.hourly.status[h] || "safe"] : "";
  stage.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Room plan to scale with the household">
    ${extras}
    <g transform="translate(${CX},${CY}) rotate(${rot})">
      <rect x="${-rw / 2}" y="${-rh / 2}" width="${rw}" height="${rh}" fill="${roomBg}" stroke="var(--fg)" stroke-width="3" rx="2"/>
      ${geo}
    </g>
    ${labels}${people}
    ${act ? `<g transform="translate(16, ${H - 42})">
      <rect width="${W - 32}" height="36" rx="6" fill="var(--card)" stroke="${qcol}" stroke-width="1.5"/>
      <text x="10" y="14" font-family="var(--mono)" font-size="9.5" font-weight="500" fill="${qcol}">${esc(act.name.toUpperCase())} · ${esc(act.hourly.activity[h])}</text>
      <text x="10" y="28" font-family="var(--sans)" font-size="10.5" fill="var(--fg)">“${esc(quote.length > 78 ? quote.slice(0, 76) + "…" : quote)}”</text></g>` : ""}
  </svg>`;
  stage.querySelectorAll(".svg-agent").forEach(g => g.addEventListener("click", () => selectAgent(+g.dataset.ag)));
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
  if (!result.agents?.some(a => a.modelled)) { wrap.innerHTML = ""; return; }
  const W = 1000, H = 195, L = 42, R = 72, T = 14, B = 24;
  const f = weekFrame(W, H, L, R, T, B, 36.4, 39.0);
  let g = f.g;
  for (const v of [36.5, 37.0, 37.5, 38.0, 38.5]) {
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${f.y(v)}" y2="${f.y(v)}"/>`;
    g += `<text x="${L - 6}" y="${f.y(v) + 4}" text-anchor="end">${v.toFixed(1)}°</text>`;
  }
  const lim = BODY().core_limit_c;
  g += `<line class="limit" x1="${L}" x2="${W - R}" y1="${f.y(lim)}" y2="${f.y(lim)}"/>`;
  g += `<text class="limit-label" x="${W - R + 5}" y="${f.y(lim) + 4}">${lim.toFixed(1)} °C</text>`;
  const keys = [];
  result.agents.forEach((ag, idx) => {
    if (!ag.modelled) return;
    const col = AGENT_COLORS[idx % AGENT_COLORS.length], on = idx === activeIdx;
    g += `<path fill="none" stroke="${col}" stroke-width="${on ? 2.4 : 1.3}" opacity="${on ? 1 : 0.6}" d="${f.path(ag.hourly.t_core)}"/>`;
    keys.push([`stroke="${col}" stroke-width="${on ? 2.4 : 1.3}"`, `${ag.name.split(" ")[0]} (${ag.age})`]);
  });
  g += `<line class="cursor" id="agent-cursor" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
  g += `<rect id="agent-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`;
  wrap.innerHTML = `<svg viewBox="0 -14 ${W} ${H + 14}" role="img" aria-label="JOS-3 core temperature for each person">${keyRow(keys, L)}${g}</svg>`;
  bindHover(wrap, "agent-hit", L, W - L - R);
}

function bindWeekControls() {
  $("compare").addEventListener("change", e => {
    preview = e.target.value === "" ? null : result.changes[+e.target.value];
    renderWeek(); renderChart(); setHour(hour);
  });
  $("hour-slider").addEventListener("input", e => setHour(+e.target.value));
  $("play").addEventListener("click", () => {
    if (playTimer) { clearInterval(playTimer); playTimer = null; $("play").textContent = "Play"; return; }
    $("play").textContent = "Pause";
    playTimer = setInterval(() => setHour((hour + 1) % HOURS), 180);
  });
  $("show-all").addEventListener("click", () => { showAll = !showAll; renderChanges(); });
  $("undo").addEventListener("click", undo);
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
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
    toast("Server not reachable", { type: "error", detail: "Start it with python run_server.py", duration: 10000 });
    return;
  }
  const sc = OPT.scenario;
  const scen = `${sc.city} · ${sc.first_day}–${sc.last_day} ${sc.month} heatwave · power cut ${pad(sc.cut_start_hour)}:00–${pad(sc.cut_end_hour)}:00`;
  $("scenario").textContent = $("intro-scenario").textContent = scen;
  $("limit").textContent = `${sc.safe_limit_c} °C`;
  $("fan-credit").textContent = `about ${sc.fan_credit_c} °C`;

  state = { ...OPT.baseline };
  roster = JSON.parse(JSON.stringify(OPT.default_agents || []));
  buildForm();
  bindHousehold();
  bindRhino();
  bindTabs();
  bindWeekControls();
  renderPeople();
  $("run").addEventListener("click", simulate);
  syncForm();
  status("Ready", "ok");
  simulate();                 // the baseline runs while the intro is showing
}

start();
