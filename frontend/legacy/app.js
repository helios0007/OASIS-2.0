// ============================================================================
// OASIS 2.0 · Environmental & Thermal Simulation Workbench
// ============================================================================

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const HOURS = 168;

let OPT = null;
let state = {};
let model = null;
let result = null;
let baselineSummary = null;
let pinnedChange = null;
let currentHour = 14;
let playTimer = null;
let activeView = "timeline"; // "timeline" | "psychro" | "heatmap" | "diurnal"
let heatmapMode = "you";
let shown = [];
let requestNo = 0;
let timer = null;

// Interactive 3D Viewport Camera State
let camYaw = 38;       // degrees
let camPitch = 26;     // degrees
let explodeRoof = true;
let isDragging3D = false;
let dragStart = { x: 0, y: 0, yaw: 38, pitch: 26 };

const CHOICE_META = {
  floor: {
    sub: { top: "Exposed roof slab", middle: "Adiabatic ceiling" },
    icon: { top: "☀", middle: "🏢" }
  },
  occupants: {
    sub: { 2: "200 W metabolic", 4: "400 W baseline", 6: "600 W metabolic" },
    icon: { 2: "👥", 4: "👨‍👩‍👧‍👦", 6: "👨‍👩‍👧‍👦+" }
  },
  wall: {
    sub: {
      brick_230: "U=2.08 · High mass",
      brick_115: "U=2.95 · Thin brick",
      aac_200: "U=0.77 · Insulated AAC"
    },
    icon: { brick_230: "🧱", brick_115: "🧱", aac_200: "🧊" }
  },
  roof: {
    sub: {
      rcc_150: "U=3.59 · Bare 150mm RCC",
      rcc_150_insul_50: "U=0.59 · +50mm EPS"
    },
    icon: { rcc_150: "🏗", rcc_150_insul_50: "🛡" }
  },
  roof_solar_absorptance: {
    sub: {
      0.7: "α=0.70 (30% refl)",
      0.4: "α=0.40 (60% refl)",
      0.2: "α=0.20 (80% cool)"
    },
    swatch: { 0.7: "#57534e", 0.4: "#a8a29e", 0.2: "#f8fafc" }
  },
  shading_depth_m: {
    sub: { 0: "Unshaded glass", 0.6: "600mm overhang" },
    icon: { 0: "🪟", 0.6: "⛱" }
  },
  night_vent: {
    sub: { false: "Shut 22:00–06:00", true: "24h night purge" },
    icon: { false: "🔒", true: "🌬" }
  }
};

// ---------- Thermal Scale & Psychrometric Helpers ----------
function hiColor(hi) {
  if (hi < 32) return "#10b981";
  if (hi < 37) return "#06b6d4";
  if (hi < 41) return "#f59e0b";
  if (hi < 45) return "#ef4444";
  return "#d946ef";
}

function hiBand(hi, limit = 41) {
  if (hi < 32) return { text: "COMFORTABLE · SAFE", bg: "rgba(16,185,129,0.18)", fg: "#10b981" };
  if (hi < limit) return { text: "CAUTION · SAFE (< 41°C)", bg: "rgba(6,182,212,0.18)", fg: "#06b6d4" };
  if (hi < 45) return { text: "DANGER (≥ 41°C HI)", bg: "rgba(239,68,68,0.22)", fg: "#ef4444" };
  return { text: "EXTREME DANGER (≥ 45°C)", bg: "rgba(217,70,239,0.24)", fg: "#d946ef" };
}

// US NWS Heat Index in °C (matching oasis/metrics.py)
function calcHeatIndexC(tC, rh) {
  const t = tC * 9 / 5 + 32;
  const simple = 0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094);
  if ((simple + t) / 2 < 80) return (simple - 32) * 5 / 9;
  let full = -42.379 + 2.04901523 * t + 10.14333127 * rh
    - 0.22475541 * t * rh - 0.00683783 * t * t
    - 0.05481717 * rh * rh + 0.00122874 * t * t * rh
    + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
  if (rh < 13 && t > 80 && t < 112) {
    full -= ((13 - rh) / 4) * Math.sqrt(Math.max(0, (17 - Math.abs(t - 95)) / 17));
  } else if (rh > 85 && t > 80 && t < 87) {
    full += ((rh - 85) / 10) * ((87 - t) / 5);
  }
  return (full - 32) * 5 / 9;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(body.detail) ? body.detail.map(d => d.msg).join("; ") : body.detail;
    throw new Error(detail || `Server error (${response.status}).`);
  }
  return body;
}

const choiceOf = key => OPT.choices.find(c => c.key === key);
const labelOf = (key, value) => {
  const ch = choiceOf(key);
  if (!ch) return String(value);
  const opt = ch.options.find(o => o.value === value);
  return opt ? opt.label : String(value);
};

// ---------- Build Left Parameter Inspector ----------
function buildForm() {
  $("choices").innerHTML = OPT.choices.map(c => {
    const cols = c.options.length === 3 ? "three-col" : "two-col";
    const meta = CHOICE_META[c.key] || {};
    return `<fieldset id="fs-${c.key}" class="choice-fieldset">
      <span class="field-lbl">${esc(c.title)}</span>
      <div class="seg-grid ${cols}">
        ${c.options.map((o, i) => {
          const valKey = String(o.value);
          const sub = meta.sub?.[valKey] || "";
          const swatch = meta.swatch?.[valKey];
          const icon = meta.icon?.[valKey] || "";
          const badgeHtml = swatch
            ? `<span class="swatch-dot" style="background:${swatch}"></span>`
            : (icon ? `<span>${icon}</span>` : "");
          return `<label class="seg-option">
            <input type="radio" name="${c.key}" id="in-${c.key}-${i}" value="${i}">
            <span class="seg-card">
              <span class="seg-icon">${badgeHtml}<span>${esc(o.label)}</span></span>
              ${sub ? `<span class="seg-sub">${esc(sub)}</span>` : ""}
            </span>
          </label>`;
        }).join("")}
      </div>
      ${c.key.startsWith("roof") ? `<span class="hint-banner" id="hint-${c.key}" hidden>Middle floor: roof slab belongs to upper flat (adiabatic).</span>` : ""}
    </fieldset>`;
  }).join("");

  $("choices").addEventListener("change", e => {
    const c = choiceOf(e.target.name);
    if (c) {
      state[c.key] = c.options[+e.target.value].value;
      clearActivePreset();
      syncForm();
      assessSoon(0);
    }
  });

  document.querySelectorAll('input[name="orientation_deg"]').forEach(radio => {
    radio.addEventListener("change", e => {
      state.orientation_deg = parseFloat(e.target.value);
      clearActivePreset();
      syncForm();
      assessSoon(0);
    });
  });

  const pairs = [
    ["length_m", "range_length_m", false],
    ["width_m", "range_width_m", false],
    ["height_m", "range_height_m", false],
    ["wwr_pct", "range_wwr_pct", true],
  ];
  pairs.forEach(([numId, rangeId, isWwr]) => {
    const onInput = rawVal => {
      const v = parseFloat(rawVal);
      if (!Number.isFinite(v)) return;
      if (isWwr) state.wwr = Math.max(0, Math.min(0.6, v / 100));
      else state[numId] = v;
      clearActivePreset();
      syncForm();
      assessSoon(300);
    };
    $(numId).addEventListener("input", e => onInput(e.target.value));
    $(rangeId).addEventListener("input", e => onInput(e.target.value));
  });

  document.querySelectorAll("[data-preset]").forEach(btn => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset, btn));
  });

  $("reset").addEventListener("click", () => {
    applyPreset("baseline", document.querySelector('[data-preset="baseline"]'));
  });

  $("btn-sample-rhino").addEventListener("click", loadSampleRhino);
  $("file").addEventListener("change", () => {
    if ($("file").files[0]) upload($("file").files[0]);
  });

  const drop = $("drop");
  ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => {
    const f = e.dataTransfer.files[0];
    if (f) upload(f);
  });
}

function clearActivePreset() {
  document.querySelectorAll(".preset-chip").forEach(b => b.classList.remove("active"));
}

function applyPreset(name, btn) {
  clearActivePreset();
  if (btn) btn.classList.add("active");
  model = null;
  $("file").value = "";
  delete state.window_area_m2;
  state = { ...OPT.baseline };

  if (name === "cool_roof") {
    state.roof_solar_absorptance = 0.2;
  } else if (name === "passive_bundle") {
    state.roof_solar_absorptance = 0.2;
    state.roof = "rcc_150_insul_50";
    state.wall = "aac_200";
    state.shading_depth_m = 0.6;
    state.night_vent = true;
  } else if (name === "middle_floor") {
    state.floor = "middle";
  }
  syncForm();
  assessSoon(0);
}

function syncForm() {
  OPT.choices.forEach(c => {
    const i = c.options.findIndex(o => o.value === state[c.key]);
    if (i >= 0 && $(`in-${c.key}-${i}`)) $(`in-${c.key}-${i}`).checked = true;
  });

  const middle = state.floor === "middle";
  ["roof", "roof_solar_absorptance"].forEach(k => {
    $(`fs-${k}`).disabled = middle;
    $(`hint-${k}`).hidden = !middle;
  });

  $("length_m").value = state.length_m;
  $("range_length_m").value = state.length_m;
  $("width_m").value = state.width_m;
  $("range_width_m").value = state.width_m;
  $("height_m").value = state.height_m;
  $("range_height_m").value = state.height_m;

  const wwrPct = Math.round(state.wwr * 100);
  $("wwr_pct").value = wwrPct;
  $("range_wwr_pct").value = wwrPct;

  document.querySelectorAll('input[name="orientation_deg"]').forEach(r => {
    r.checked = Math.round(parseFloat(r.value)) === Math.round(state.orientation_deg || 0);
  });

  const area = (state.length_m * state.width_m).toFixed(1);
  const vol = (state.length_m * state.width_m * state.height_m).toFixed(0);
  $("geom-pill").textContent = `${area} m² · ${vol} m³`;

  $("geometry").disabled = !!model;
  $("geometry-hint").hidden = !model;

  const box = $("model");
  box.hidden = !model;
  $("drop").hidden = !!model;
  if (model) {
    const r = model.report;
    const windows = Object.entries(r.windows).map(([side, w]) =>
      `<li><b>${esc(side[0].toUpperCase() + side.slice(1))}:</b> ${w.count} win, ${w.area_m2} m² (${w.share_of_wall_pct}%)</li>`
    ).join("");
    box.innerHTML = `
      <div class="rhino-loaded-head">
        <b>📦 ${esc(r.file)}</b>
        <button type="button" class="cmd-btn" id="remove-model" style="padding:2px 7px;font-size:10.5px">✕ Remove</button>
      </div>
      <div>${esc(r.size)} (${r.floor_area_m2} m²)</div>
      ${windows ? `<ul class="rhino-win-list">${windows}</ul>` : ""}
    `;
    $("remove-model").onclick = () => {
      model = null;
      $("file").value = "";
      delete state.window_area_m2;
      syncForm();
      assessSoon(0);
    };
  }

  renderPhysicsCard();
  drawAxon();
}

function renderPhysicsCard() {
  if (!OPT?.physics) return;
  const p = OPT.physics;
  const wallInfo = p.walls[state.wall] || { u_value: 2.08, heat_capacity_kj: 380 };
  const roofInfo = p.roofs[state.roof] || { u_value: 3.59, heat_capacity_kj: 323 };
  const reflPct = Math.round((1 - state.roof_solar_absorptance) * 100);
  const winArea = state.window_area_m2
    ? Object.values(state.window_area_m2).reduce((a, b) => a + b, 0)
    : 2 * state.wwr * state.length_m * state.height_m;
  const internalGainW = Math.round(state.occupants * p.activity_w + p.appliances_peak_w);

  $("physics-grid").innerHTML = `
    <div class="phys-item">
      <span class="phys-k">Wall U-Value</span>
      <span class="phys-v">${wallInfo.u_value.toFixed(2)} W/m²K</span>
      <span class="phys-sub">Mass: ${wallInfo.heat_capacity_kj} kJ/m²K</span>
    </div>
    <div class="phys-item">
      <span class="phys-k">${state.floor === "middle" ? "Ceiling" : "Roof U-Value"}</span>
      <span class="phys-v">${state.floor === "middle" ? "Adiabatic" : roofInfo.u_value.toFixed(2) + " W/m²K"}</span>
      <span class="phys-sub">${state.floor === "middle" ? "Zero solar gain" : `Reflectance: ${reflPct}%`}</span>
    </div>
    <div class="phys-item">
      <span class="phys-k">Window Area</span>
      <span class="phys-v">${winArea.toFixed(2)} m²</span>
      <span class="phys-sub">U=${p.glass_u} · SHGC=${p.glass_shgc}</span>
    </div>
    <div class="phys-item">
      <span class="phys-k">Peak Internal Gain</span>
      <span class="phys-v">${internalGainW} W</span>
      <span class="phys-sub">${state.occupants} occ + ${p.appliances_peak_w}W</span>
    </div>
  `;
}

// ---------- Rhino Upload ----------
async function upload(file) {
  $("upload-error").hidden = true;
  setStatus("Reading Rhino .3dm...", true);
  const form = new FormData();
  form.append("file", file);
  try {
    model = await api("/api/rhino", { method: "POST", body: form });
    Object.assign(state, model.geometry);
    clearActivePreset();
    syncForm();
    assessSoon(0);
  } catch (error) {
    model = null;
    $("file").value = "";
    $("upload-error").textContent = error.message;
    $("upload-error").hidden = false;
    setStatus("Ready", false);
  }
}

async function loadSampleRhino() {
  $("upload-error").hidden = true;
  setStatus("Loading sample_flat.3dm...", true);
  try {
    model = await api("/api/rhino/sample", { method: "POST" });
    Object.assign(state, model.geometry);
    clearActivePreset();
    $("btn-sample-rhino").classList.add("active");
    syncForm();
    assessSoon(0);
  } catch (error) {
    $("upload-error").textContent = error.message;
    $("upload-error").hidden = false;
    setStatus("Ready", false);
  }
}

// ---------- Simulation Execution ----------
function setStatus(text, busy) {
  $("status-text").textContent = text;
  $("status").classList.toggle("busy", !!busy);
}

function assessSoon(delay) {
  clearTimeout(timer);
  timer = setTimeout(assess, delay);
}

async function assess() {
  const mine = ++requestNo;
  const body = { ...state };
  if (!model) delete body.window_area_m2;
  setStatus("EnergyPlus 26.2 running...", true);
  $("out").classList.add("stale");
  $("error").hidden = true;
  const started = performance.now();
  try {
    const answer = await api("/api/assess", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (mine !== requestNo) return;
    result = answer;
    if (!baselineSummary && isBaselineState()) {
      baselineSummary = answer.summary;
    }
    render();
    const n = 1 + result.changes.length;
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    setStatus(`EnergyPlus · ${n} runs (${seconds}s)`, false);
  } catch (error) {
    if (mine !== requestNo) return;
    $("error").textContent = error.message;
    $("error").hidden = false;
    setStatus("Simulation error", false);
  }
  $("out").classList.remove("stale");
}

function isBaselineState() {
  if (model) return false;
  return Object.keys(OPT.baseline).every(k => state[k] === OPT.baseline[k]);
}

// ---------- Render Workbench Outputs ----------
function render() {
  const r = result.summary;
  const pct = Math.round((r.safe_hours / r.hours_total) * 100);
  const s0 = OPT.scenario;

  const baseSafe = baselineSummary ? baselineSummary.safe_hours : 87;
  const deltaSafe = r.safe_hours - baseSafe;
  const deltaBadge = deltaSafe > 0
    ? `<span class="kpi-badge good">+${deltaSafe}h vs base</span>`
    : deltaSafe < 0
      ? `<span class="kpi-badge bad">${deltaSafe}h vs base</span>`
      : `<span class="kpi-badge warn">${pct}% Autonomy</span>`;

  let nightPillsHtml = `<div class="night-pills">`;
  for (let d = 0; d < 7; d++) {
    const hIdx = d * 24 + s0.cut_start_hour;
    const hiVal = result.heat_index[hIdx];
    const isDanger = hiVal >= s0.safe_limit_c;
    nightPillsHtml += `<div class="night-pill ${isDanger ? "danger" : "safe"}" data-jump="${hIdx}" title="${s0.first_day + d} ${s0.month} 20:00 Cut: ${hiVal.toFixed(1)} °C">${s0.first_day + d}</div>`;
  }
  nightPillsHtml += `</div>`;

  $("figs").innerHTML = `
    <div class="kpi-card" style="--kpi-color:${r.safe_hours >= 140 ? "var(--safe)" : r.safe_hours >= 100 ? "var(--accent)" : "var(--caution)"}">
      <div class="kpi-top">
        <span class="kpi-label">Thermal Autonomy (Safe Hrs)</span>
        ${deltaBadge}
      </div>
      <div class="kpi-main">
        <span class="kpi-val">${r.safe_hours}</span>
        <span class="kpi-unit">/ ${r.hours_total} h (${pct}%)</span>
      </div>
      <div class="kpi-meter"><div class="kpi-meter-fill" style="width:${pct}%"></div></div>
      <div class="kpi-sub"><span>${r.danger_hours}h overheated (≥${s0.safe_limit_c}°C)</span><span>Goal: 168h</span></div>
    </div>

    <div class="kpi-card" style="--kpi-color:${r.cut_hours_in_danger === 0 ? "var(--safe)" : "var(--cut)"}">
      <div class="kpi-top">
        <span class="kpi-label">Power-Cut Resilience</span>
        <span class="kpi-badge ${r.cut_hours_in_danger === 0 ? "good" : "warn"}">${7 - r.cut_hours_in_danger}/7 nights safe</span>
      </div>
      <div class="kpi-main">
        <span class="kpi-val">${r.cut_hours_in_danger}</span>
        <span class="kpi-unit">/ 7 cuts in danger</span>
      </div>
      ${nightPillsHtml}
      <div class="kpi-sub"><span>Click night pill to inspect 20:00 outage</span></div>
    </div>

    <div class="kpi-card" style="--kpi-color:${r.max_heat_index_c >= s0.safe_limit_c ? "var(--danger)" : "var(--safe)"}">
      <div class="kpi-top">
        <span class="kpi-label">Peak Heat Index</span>
        <span class="kpi-badge ${r.max_heat_index_c >= s0.safe_limit_c ? "bad" : "good"}">${r.max_heat_index_c >= s0.safe_limit_c ? "Danger" : "Safe"}</span>
      </div>
      <div class="kpi-main">
        <span class="kpi-val">${r.max_heat_index_c.toFixed(1)}</span>
        <span class="kpi-unit">°C felt peak</span>
      </div>
      <div class="kpi-sub">
        <span>Peak air: <b>${r.max_indoor_temp_c.toFixed(1)}°C</b></span>
        <span>Mean: <b>${r.mean_indoor_temp_c.toFixed(1)}°C</b></span>
      </div>
    </div>

    <div class="kpi-card" style="--kpi-color:var(--extreme)">
      <div class="kpi-top">
        <span class="kpi-label">Overheating Severity</span>
        <span class="kpi-badge ${r.degree_hours_over_limit < 20 ? "good" : "bad"}">Degree-Hours</span>
      </div>
      <div class="kpi-main">
        <span class="kpi-val">${r.degree_hours_over_limit.toFixed(0)}</span>
        <span class="kpi-unit">°C·h &gt; ${s0.safe_limit_c}°C</span>
      </div>
      <div class="kpi-sub"><span>Cumulative thermal stress</span></div>
    </div>
  `;

  document.querySelectorAll(".night-pill[data-jump]").forEach(el => {
    el.addEventListener("click", () => setScrubberHour(parseInt(el.dataset.jump, 10)));
  });

  // Render 168-Hour Heat-Index Barcode under the Scrubber
  $("tm-barcode").innerHTML = result.heat_index.map((v, i) =>
    `<span style="background:${hiColor(v)}" title="Hour ${i}: ${v.toFixed(1)}°C"></span>`
  ).join("");

  // Autonomy Progress Box in Right Dock
  $("autonomy-box").innerHTML = `
    <div class="auto-top">
      <span>Passive Thermal Autonomy</span>
      <span style="color:var(--accent);font-family:var(--font-mono)">${r.safe_hours} / 168 hrs (${pct}%)</span>
    </div>
    <div class="auto-bar">
      <div class="auto-fill" style="width:${pct}%"></div>
    </div>
    <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted)">
      <span>Baseline: ${baseSafe}h</span>
      <span>Danger: ${r.danger_hours}h</span>
    </div>
  `;

  // Passive Intervention Stack
  const seen = new Set();
  const perParam = result.changes.filter(c => !seen.has(c.parameter) && seen.add(c.parameter));
  const positive = perParam.filter(c => c.safe_hours_gained > 0);
  const top = perParam.slice(0, 6);

  const applyAllBtn = $("apply-all-btn");
  if (positive.length > 1) {
    applyAllBtn.hidden = false;
    applyAllBtn.onclick = () => {
      positive.forEach(c => { state[c.parameter] = c.value; });
      clearActivePreset();
      syncForm();
      assessSoon(0);
    };
  } else {
    applyAllBtn.hidden = true;
  }

  const maxGain = Math.max(1, ...positive.map(c => c.safe_hours_gained), 55);

  if (positive.length) {
    $("changes").innerHTML = positive.map((c, n) => {
      const dPeak = c.max_heat_index_c - r.max_heat_index_c;
      const barPct = Math.min(100, Math.round((c.safe_hours_gained / maxGain) * 100));
      const isPinned = pinnedChange && pinnedChange.parameter === c.parameter && pinnedChange.value === c.value;
      return `<div class="interv-card">
        <div class="interv-row-1">
          <div class="interv-title-grp">
            <span class="interv-rank">#${n + 1}</span>
            <b title="${esc(c.title)}: ${esc(c.label)}">${esc(c.title)}: ${esc(c.label)}</b>
          </div>
          <span class="interv-gain">+${c.safe_hours_gained}h</span>
        </div>
        <div class="interv-meta">
          <span>Reaches <b>${c.safe_hours}h</b> (${Math.round(c.safe_hours / 168 * 100)}%)</span>
          <span>Peak: <b>${dPeak <= 0 ? "−" : "+"}${Math.abs(dPeak).toFixed(1)}°C</b> · Cut: ${c.cut_hours_in_danger}/7</span>
        </div>
        <div class="interv-bar-track"><div class="interv-bar-fill" style="width:${barPct}%"></div></div>
        <div class="interv-actions">
          <button type="button" class="btn-pin ${isPinned ? "pinned" : ""}" data-pin="${n}">
            ${isPinned ? "📌 Comparing on Charts" : "📈 Compare on Charts"}
          </button>
          <button type="button" class="btn-apply" data-apply="${n}">Apply Change</button>
        </div>
      </div>`;
    }).join("");
  } else {
    $("changes").innerHTML = `<div class="interv-card" style="border-color:var(--safe)">
      <b style="color:var(--safe)">✨ Optimal Passive Configuration Reached</b>
      <p style="font-size:11.5px;color:var(--ink-2)">Every single-parameter passive intervention has been applied. Total safe hours: <b>${r.safe_hours} / 168</b>.</p>
    </div>`;
  }

  positive.forEach((c, n) => {
    const applyBtn = document.querySelector(`[data-apply="${n}"]`);
    if (applyBtn) {
      applyBtn.onclick = () => {
        state[c.parameter] = c.value;
        if (pinnedChange && pinnedChange.parameter === c.parameter) pinnedChange = null;
        clearActivePreset();
        syncForm();
        assessSoon(0);
      };
    }
    const pinBtn = document.querySelector(`[data-pin="${n}"]`);
    if (pinBtn) {
      pinBtn.onclick = () => {
        if (pinnedChange && pinnedChange.parameter === c.parameter && pinnedChange.value === c.value) {
          pinnedChange = null;
        } else {
          pinnedChange = { parameter: c.parameter, value: c.value };
        }
        render();
      };
    }
  });

  // Populate Modal Sensitivity Table
  const sign = g => g > 0 ? "+" : g < 0 ? "−" : "";
  $("table").innerHTML = `<thead><tr><th>Parameter Change</th><th>Safe Hours</th><th>Gain</th><th>Cut Danger</th><th>Peak HI (°C)</th><th>Over Limit (°C·h)</th><th>Action</th></tr></thead><tbody>` +
    `<tr style="background:var(--accent-soft)"><td><b>Current Design</b></td><td><b>${r.safe_hours}</b></td><td>–</td><td>${r.cut_hours_in_danger}/7</td><td>${r.max_heat_index_c.toFixed(1)}</td><td>${r.degree_hours_over_limit.toFixed(1)}</td><td>–</td></tr>` +
    result.changes.map((c, idx) => `<tr>
      <td><b>${esc(c.title)}:</b> ${esc(c.label)}</td>
      <td>${c.safe_hours}</td>
      <td class="${c.safe_hours_gained > 0 ? "pos" : c.safe_hours_gained < 0 ? "neg" : ""}">${sign(c.safe_hours_gained)}${Math.abs(c.safe_hours_gained)}h</td>
      <td>${c.cut_hours_in_danger}/7</td>
      <td>${c.max_heat_index_c.toFixed(1)}</td>
      <td>${c.degree_hours_over_limit.toFixed(1)}</td>
      <td><button type="button" class="cmd-btn" style="padding:2px 7px;font-size:10.5px" data-tbl-apply="${idx}">Apply</button></td>
    </tr>`).join("") + "</tbody>";

  document.querySelectorAll("[data-tbl-apply]").forEach(btn => {
    btn.onclick = () => {
      const ch = result.changes[+btn.dataset.tblApply];
      if (ch) {
        state[ch.parameter] = ch.value;
        $("matrix-modal").hidden = true;
        clearActivePreset();
        syncForm();
        assessSoon(0);
      }
    };
  });

  // Determine comparison series
  shown = [];
  let compChange = null;
  if (pinnedChange) {
    compChange = result.changes.find(c => c.parameter === pinnedChange.parameter && c.value === pinnedChange.value);
  }
  if (!compChange && positive.length) {
    compChange = positive[0];
  }

  if (compChange) {
    shown.push({
      id: "alt",
      arr: compChange.heat_index,
      tin: compChange.indoor_temp,
      rh: compChange.humidity,
      color: "--alt",
      name: `With ${compChange.title}: ${compChange.label} (+${compChange.safe_hours_gained}h)`,
      short: `+ ${compChange.label}`
    });
  }
  shown.push({
    id: "you",
    arr: result.heat_index,
    tin: result.indoor_temp,
    rh: result.humidity,
    color: "--sel",
    name: "Your Design",
    short: "Your Design"
  });

  $("legend").innerHTML =
    `<span><i class="s"></i>Your Design (${r.safe_hours}h)</span>` +
    (compChange ? `<span><i></i>${esc(shown[0].name)}</span>` : "") +
    `<span><i class="d"></i>Danger (${s0.safe_limit_c}°C)</span>` +
    `<span><i class="c"></i>20:00 Cut</span>`;

  $("changes-panel").hidden = false;
  $("chart-panel").hidden = false;

  updateTelemetryAndAxon();
  drawActiveAnalyticsView();
}

// ---------- Interactive 3D Sun-Path & Orbiting Building Viewport ----------
function setScrubberHour(h) {
  currentHour = Math.max(0, Math.min(HOURS - 1, h));
  $("hour-scrubber").value = currentHour;
  updateTelemetryAndAxon();
  updateChartTimeMarker();
  if (activeView === "psychro") drawPsychro();
}

function updateTelemetryAndAxon() {
  if (!result) {
    drawAxon();
    return;
  }
  const s0 = OPT.scenario;
  const h = currentHour % 24;
  const dayIdx = Math.floor(currentHour / 24);
  const pad = n => String(n).padStart(2, "0");
  const isCut = h >= s0.cut_start_hour && h < s0.cut_end_hour;

  const hi = result.heat_index[currentHour];
  const tin = result.indoor_temp[currentHour];
  const rh = result.humidity[currentHour];
  const tout = result.outdoor_temp[currentHour];
  const band = hiBand(hi, s0.safe_limit_c);

  $("hud-day").textContent = `${s0.first_day + dayIdx} ${s0.month} · Day ${dayIdx + 1} of 7`;
  $("hud-time").textContent = `${pad(h)}:00 – ${pad(h + 1)}:00`;
  const bandEl = $("hud-band");
  bandEl.textContent = isCut ? `⚡ POWER CUT · ${band.text}` : band.text;
  bandEl.style.background = isCut ? "rgba(251,191,36,0.24)" : band.bg;
  bandEl.style.color = isCut ? "#fbbf24" : band.fg;

  $("hud-hi").textContent = `${hi.toFixed(1)} °C`;
  $("hud-hi").style.color = hiColor(hi);
  $("hud-tin").textContent = `${tin.toFixed(1)} °C`;
  $("hud-rh").textContent = `${rh.toFixed(0)} %`;
  $("hud-tout").textContent = `${tout.toFixed(1)} °C`;
  $("hud-fan").textContent = isCut ? "OFF (0.0°C · Outage)" : `ON (−${s0.fan_credit_c.toFixed(1)}°C credit)`;
  $("hud-fan").style.color = isCut ? "var(--cut)" : "var(--safe)";

  drawAxon();
}

function drawAxon() {
  const svg = $("axon-svg");
  if (!svg) return;

  const L = Math.max(3, Math.min(12, state.length_m || 6));
  const W = Math.max(3, Math.min(12, state.width_m || 5));
  const H = Math.max(2.4, Math.min(5, state.height_m || 3));
  const scale = Math.min(25, 200 / Math.max(L, W));

  const lx = L * scale;
  const wy = W * scale;
  const hz = H * scale * 1.1;

  const cx = 360;
  const cy = 225;

  // 3D Orbit Rotation Math (Yaw + Pitch)
  const yawRad = (camYaw * Math.PI) / 180;
  const pitchRad = (camPitch * Math.PI) / 180;
  const cosY = Math.cos(yawRad), sinY = Math.sin(yawRad);
  const cosP = Math.cos(pitchRad), sinP = Math.sin(pitchRad);

  const proj = (x, y, z) => {
    const rx = x * cosY - y * sinY;
    const ry = x * sinY + y * cosY;
    const px = cx + rx;
    const py = cy + ry * sinP - z * cosP;
    return [px, py];
  };
  const pts = arr => arr.map(([x, y, z]) => proj(x, y, z).map(v => v.toFixed(1)).join(",")).join(" ");

  const x0 = -lx / 2, x1 = lx / 2;
  const y0 = -wy / 2, y1 = wy / 2;
  const z0 = 0, z1 = hz;

  const h = currentHour % 24;
  const isDay = h >= 6 && h <= 18;
  const isCut = h === 20;
  const hi = result ? result.heat_index[currentHour] : 39.5;
  const tout = result ? result.outdoor_temp[currentHour] : 36.0;
  const roomGlow = hiColor(hi);

  const wallStyles = {
    brick_230: { fill: "#b45309", side: "#92400e", stroke: "#f59e0b", label: "230mm Brick" },
    brick_115: { fill: "#c2410c", side: "#9a3412", stroke: "#fb923c", label: "115mm Brick" },
    aac_200:   { fill: "#64748b", side: "#475569", stroke: "#94a3b8", label: "200mm AAC" },
  };
  const ws = wallStyles[state.wall] || wallStyles.brick_230;

  const roofColors = {
    0.7: { top: "#57534e", rim: "#44403c", name: "Grey Concrete (α=0.7)" },
    0.4: { top: "#a8a29e", rim: "#78716c", name: "Light Grey (α=0.4)" },
    0.2: { top: "#f8fafc", rim: "#cbd5e1", name: "White Cool Roof (α=0.2)" },
  };
  const rc = roofColors[state.roof_solar_absorptance] || roofColors[0.7];
  const hasInsul = state.roof === "rcc_150_insul_50";
  const isMiddle = state.floor === "middle";

  const roofLift = explodeRoof ? 38 : 0;
  const zr0 = z1 + roofLift;
  const zr1 = zr0 + 9;

  let s = "";

  // 1. 3D Ground Compass Ring & Sun-Path Dome (Andrew Marsh Sunpath 3D style)
  const domeR = Math.max(lx, wy) * 0.95 + 48;
  const ringPts = [];
  for (let a = 0; a <= 360; a += 10) {
    const rad = (a * Math.PI) / 180;
    ringPts.push([Math.cos(rad) * domeR, Math.sin(rad) * domeR, 0]);
  }
  s += `<polyline points="${pts(ringPts)}" fill="none" stroke="rgba(148,163,184,0.22)" stroke-width="1.2" stroke-dasharray="4 4"/>`;

  // Cardinal Direction Labels on Ground Ring (adjusted for building orientation)
  const orientRad = ((state.orientation_deg || 0) * Math.PI) / 180;
  [["N", 0, "#06b6d4"], ["E", 90, "#94a3b8"], ["S", 180, "#f59e0b"], ["W", 270, "#94a3b8"]].forEach(([dir, deg, col]) => {
    const a = ((deg - 90) * Math.PI) / 180 + orientRad;
    const [dx, dy] = proj(Math.cos(a) * (domeR + 14), Math.sin(a) * (domeR + 14), 0);
    s += `<text x="${dx.toFixed(1)}" y="${(dy + 4).toFixed(1)}" text-anchor="middle" fill="${col}" font-size="11" font-family="JetBrains Mono" font-weight="700">${dir}</text>`;
  });

  // 3D Solar Path Arc across sky dome
  const sunArcPts = [];
  for (let hr = 6; hr <= 18; hr += 0.5) {
    const prog = (hr - 6) / 12; // 0 at 06:00 (East), 0.5 at 12:00 (Zenith), 1 at 18:00 (West)
    const alt = Math.sin(prog * Math.PI) * 1.32;
    const az = (1 - prog * 2) * (Math.PI / 2);
    const sx = Math.sin(az) * Math.cos(alt) * domeR;
    const sy = -Math.sin(alt) * 18; // slight north-south zenith offset in May
    const sz = Math.sin(alt) * (domeR * 0.85);
    sunArcPts.push([sx, sy, sz]);
  }
  s += `<polyline points="${pts(sunArcPts)}" fill="none" stroke="rgba(251,191,36,0.45)" stroke-width="1.6" stroke-dasharray="5 4"/>`;

  // Current Hour Sun / Moon Position on 3D Dome
  const sunProg = isDay ? (h - 6) / 12 : ((h + 6) % 24) / 12;
  const alt = Math.sin(sunProg * Math.PI) * 1.32;
  const az = (1 - sunProg * 2) * (Math.PI / 2);
  const sun3D = [
    Math.sin(az) * Math.cos(alt) * domeR,
    -Math.sin(alt) * 18,
    Math.max(18, Math.sin(alt) * (domeR * 0.85))
  ];
  const [sunX, sunY] = proj(...sun3D);

  // 2. Back Walls (North-West & North-East)
  s += `<polygon points="${pts([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]])}" fill="${ws.side}" fill-opacity="0.76" stroke="${ws.stroke}" stroke-width="1.1"/>`;
  s += `<polygon points="${pts([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]])}" fill="${ws.fill}" fill-opacity="0.80" stroke="${ws.stroke}" stroke-width="1.1"/>`;

  // 3. Spatial Floor Heatmap Mesh (4x4 Thermal Grid)
  const gridN = 4;
  for (let gx = 0; gx < gridN; gx++) {
    for (let gy = 0; gy < gridN; gy++) {
      const fx0 = x0 + (lx * gx) / gridN, fx1 = x0 + (lx * (gx + 1)) / gridN;
      const fy0 = y0 + (wy * gy) / gridN, fy1 = y0 + (wy * (gy + 1)) / gridN;
      // Subtle spatial variation near South/West perimeter during daytime
      const edgeBoost = isDay && (gy === gridN - 1 || gx === gridN - 1) ? 0.6 : 0;
      const cellCol = hiColor(hi + edgeBoost);
      s += `<polygon points="${pts([[fx0, fy0, 0], [fx1, fy0, 0], [fx1, fy1, 0], [fx0, fy1, 0]])}" fill="${cellCol}" fill-opacity="0.48" stroke="${roomGlow}" stroke-opacity="0.35" stroke-width="0.8"/>`;
    }
  }
  s += `<polygon points="${pts([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]])}" fill="none" stroke="${roomGlow}" stroke-width="2"/>`;

  // 4. Occupants inside the space
  const nOcc = Math.min(6, Math.max(1, state.occupants || 4));
  for (let i = 0; i < nOcc; i++) {
    const ox = x0 * 0.45 + (i % 3) * (lx * 0.24);
    const oy = y0 * 0.35 + Math.floor(i / 3) * (wy * 0.35);
    const [px, py] = proj(ox, oy, 0);
    s += `<g transform="translate(${px.toFixed(1)},${py.toFixed(1)})">
      <ellipse cx="0" cy="0" rx="4.5" ry="2" fill="rgba(0,0,0,0.4)"/>
      <path d="M-3.5,-2 L-2.5,-13 C-2.5,-15 2.5,-15 2.5,-13 L3.5,-2 Z" fill="#f8fafc" opacity="0.9"/>
      <circle cx="0" cy="-18" r="3.4" fill="#fbbf24"/>
    </g>`;
  }

  // 5. Ceiling Fan & Downdraft Cone
  const [fx, fy] = proj(0, 0, z1 * 0.85);
  const [fTopX, fTopY] = proj(0, 0, z1);
  s += `<line x1="${fTopX}" y1="${fTopY}" x2="${fx}" y2="${fy}" stroke="#94a3b8" stroke-width="1.8"/>`;
  if (isCut) {
    s += `<g transform="translate(${fx.toFixed(1)},${fy.toFixed(1)})">
      <ellipse cx="-12" cy="0" rx="10" ry="3" fill="#ef4444" opacity="0.8"/>
      <ellipse cx="12" cy="0" rx="10" ry="3" fill="#ef4444" opacity="0.8"/>
      <circle r="4" fill="#fbbf24" stroke="#ef4444" stroke-width="1.5"/>
      <text x="0" y="-12" text-anchor="middle" fill="#fbbf24" font-size="9.5" font-family="JetBrains Mono" font-weight="700">⚡ FAN OFF (CUT)</text>
    </g>`;
  } else {
    s += `<g transform="translate(${fx.toFixed(1)},${fy.toFixed(1)})">
      <ellipse cx="0" cy="0" rx="20" ry="8" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="5 4">
        <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="0.85s" repeatCount="indefinite"/>
      </ellipse>
      <circle r="3.5" fill="#38bdf8"/>
    </g>`;
  }

  // 6. Front Cutaway Walls, Glazing & 0.6m Overhangs
  const wwr = Math.max(0.05, Math.min(0.55, state.wwr || 0.15));
  const winScale = Math.sqrt(wwr);
  const hasOverhang = (state.shading_depth_m || 0) > 0;
  const ovDepth = (state.shading_depth_m || 0) * scale * 1.4;
  const windowsOpen = state.night_vent || (h >= 6 && h < 22);

  s += `<polygon points="${pts([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]])}" fill="${ws.fill}" fill-opacity="0.24" stroke="${ws.stroke}" stroke-width="1.5"/>`;
  s += `<polygon points="${pts([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]])}" fill="${ws.side}" fill-opacity="0.20" stroke="${ws.stroke}" stroke-width="1.5"/>`;

  const swX0 = -lx * 0.5 * winScale, swX1 = lx * 0.5 * winScale;
  const swZ0 = hz * (0.5 - 0.35 * winScale), swZ1 = hz * (0.5 + 0.35 * winScale);
  s += `<polygon points="${pts([[swX0, y1, swZ0], [swX1, y1, swZ0], [swX1, y1, swZ1], [swX0, y1, swZ1]])}" fill="#38bdf8" fill-opacity="${windowsOpen ? 0.52 : 0.24}" stroke="#38bdf8" stroke-width="1.6"/>`;

  if (hasOverhang) {
    s += `<polygon points="${pts([[swX0 - 4, y1, swZ1], [swX1 + 4, y1, swZ1], [swX1 + 4, y1 + ovDepth, swZ1 - 2], [swX0 - 4, y1 + ovDepth, swZ1 - 2]])}" fill="#eab308" fill-opacity="0.9" stroke="#fef08a" stroke-width="1.1"/>`;
  }

  // Airflow streamlines when windows open
  if (windowsOpen) {
    const [v1x, v1y] = proj(0, y1 + 16, (swZ0 + swZ1) / 2);
    const [v2x, v2y] = proj(0, y0 - 14, (swZ0 + swZ1) / 2);
    s += `<path d="M ${v1x.toFixed(1)} ${v1y.toFixed(1)} Q ${cx} ${(cy - hz * 0.4).toFixed(1)} ${v2x.toFixed(1)} ${v2y.toFixed(1)}" fill="none" stroke="#06b6d4" stroke-width="1.8" stroke-dasharray="5 4"/>`;
  }

  // 7. Roof / Ceiling Assembly
  if (explodeRoof) {
    [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].forEach(([gx, gy]) => {
      const [p1x, p1y] = proj(gx, gy, z1);
      const [p2x, p2y] = proj(gx, gy, zr0);
      s += `<line x1="${p1x}" y1="${p1y}" x2="${p2x}" y2="${p2y}" stroke="#64748b" stroke-dasharray="2 3" stroke-width="0.9"/>`;
    });
  }

  if (isMiddle) {
    s += `<polygon points="${pts([[x0, y0, zr0], [x1, y0, zr0], [x1, y1, zr0], [x0, y1, zr0]])}" fill="#475569" fill-opacity="0.72" stroke="#94a3b8" stroke-width="1.4"/>`;
    const [rlx, rly] = proj(0, 0, zr0 + 5);
    s += `<text x="${rlx.toFixed(1)}" y="${rly.toFixed(1)}" text-anchor="middle" fill="#cbd5e1" font-size="10" font-family="JetBrains Mono" font-weight="600">UPPER APARTMENT (ADIABATIC)</text>`;
  } else {
    if (hasInsul) {
      const zi0 = zr0 - 6;
      s += `<polygon points="${pts([[x0, y1, zi0], [x1, y1, zi0], [x1, y1, zr0], [x0, y1, zr0]])}" fill="#f59e0b" stroke="#fbbf24" stroke-width="0.9"/>`;
      s += `<polygon points="${pts([[x1, y0, zi0], [x1, y1, zi0], [x1, y1, zr0], [x1, y0, zr0]])}" fill="#d97706" stroke="#fbbf24" stroke-width="0.9"/>`;
    }
    s += `<polygon points="${pts([[x0, y0, zr1], [x1, y0, zr1], [x1, y1, zr1], [x0, y1, zr1]])}" fill="${rc.top}" fill-opacity="0.92" stroke="#94a3b8" stroke-width="1.4"/>`;
    const [rlx, rly] = proj(0, 0, zr1);
    const txtColor = state.roof_solar_absorptance <= 0.25 ? "#0f172a" : "#f8fafc";
    s += `<text x="${rlx.toFixed(1)}" y="${(rly + 3).toFixed(1)}" text-anchor="middle" fill="${txtColor}" font-size="10" font-family="JetBrains Mono" font-weight="700">${esc(rc.name)}${hasInsul ? " + 50mm EPS" : ""}</text>`;
  }

  // 8. Sun / Moon Orb & Solar Beam
  if (isDay) {
    const [rx, ry] = proj(0, 0, zr1);
    if (!isMiddle) {
      s += `<line x1="${sunX.toFixed(1)}" y1="${sunY.toFixed(1)}" x2="${rx.toFixed(1)}" y2="${ry.toFixed(1)}" stroke="#fbbf24" stroke-width="1.6" stroke-dasharray="4 3" opacity="0.75"/>`;
    }
    s += `<g transform="translate(${sunX.toFixed(1)},${sunY.toFixed(1)})">
      <circle r="15" fill="#fbbf24" opacity="0.22"/>
      <circle r="8.5" fill="#fbbf24" stroke="#f59e0b" stroke-width="1.8"/>
      <text x="0" y="-13" text-anchor="middle" fill="#fbbf24" font-size="9.5" font-family="JetBrains Mono" font-weight="700">${tout.toFixed(1)}°C</text>
    </g>`;
  } else {
    s += `<g transform="translate(${sunX.toFixed(1)},${sunY.toFixed(1)})">
      <circle r="11" fill="#818cf8" opacity="0.2"/>
      <circle r="6.5" fill="#c7d2fe"/>
      <text x="0" y="-11" text-anchor="middle" fill="#a5b4fc" font-size="9.5" font-family="JetBrains Mono" font-weight="600">${tout.toFixed(1)}°C</text>
    </g>`;
  }

  // Interior Heat-Index Floating Tag
  const [cRoomX, cRoomY] = proj(0, 0, z1 * 0.32);
  s += `<g transform="translate(${cRoomX.toFixed(1)},${cRoomY.toFixed(1)})">
    <rect x="-48" y="-11" width="96" height="21" rx="10.5" fill="rgba(11,17,30,0.88)" stroke="${roomGlow}" stroke-width="1.4"/>
    <text x="0" y="3" text-anchor="middle" fill="${roomGlow}" font-size="10.5" font-family="JetBrains Mono" font-weight="700">HI ${hi.toFixed(1)} °C</text>
  </g>`;

  svg.innerHTML = s;
}

// ---------- Multi-Analytics Views ----------
function drawActiveAnalyticsView() {
  if (!result) return;
  $("view-timeline").hidden = activeView !== "timeline";
  $("view-psychro").hidden = activeView !== "psychro";
  $("view-heatmap").hidden = activeView !== "heatmap";
  $("view-diurnal").hidden = activeView !== "diurnal";
  $("timeline-controls").hidden = activeView !== "timeline";

  if (activeView === "timeline") drawChart();
  else if (activeView === "psychro") drawPsychro();
  else if (activeView === "heatmap") drawHeatmap();
  else if (activeView === "diurnal") drawDiurnalAndBands();
}

// ---------- TAB 1: 168-Hour Heatwave Timeline ----------
let geo = null;
function drawChart() {
  if (!result) return;
  const s0 = OPT.scenario, LIMIT = s0.safe_limit_c;
  const el = $("chart"), W = Math.max(320, el.clientWidth), H = 225;
  const wide = W >= 620;
  const m = { t: 12, r: wide ? 95 : 12, b: 24, l: 34 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  const showTout = $("chk-tout")?.checked;
  const showTin = $("chk-tin")?.checked;

  let allVals = shown.flatMap(d => d.arr).concat([LIMIT]);
  if (showTout) allVals = allVals.concat(result.outdoor_temp);
  if (showTin) allVals = allVals.concat(result.indoor_temp);

  const y0 = Math.floor((Math.min(...allVals) - 1) / 5) * 5;
  const y1 = Math.ceil((Math.max(...allVals) + 1) / 5) * 5;
  const x = h => m.l + (h / HOURS) * pw;
  const y = v => m.t + ((y1 - v) / (y1 - y0)) * ph;
  geo = { m, pw, ph, x, y, W };

  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  if (y(LIMIT) > m.t) {
    s += `<rect x="${m.l}" y="${m.t}" width="${pw}" height="${Math.max(0, y(LIMIT) - m.t)}" fill="var(--danger-wash)"/>`;
  }
  for (let v = y0; v <= y1; v += 5) {
    s += `<line x1="${m.l}" x2="${m.l + pw}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>`;
    s += `<text x="${m.l - 6}" y="${y(v) + 3.5}" text-anchor="end">${v}°</text>`;
  }
  for (let d = 0; d < 7; d++) {
    const cx = x(d * 24 + s0.cut_start_hour);
    const cw = Math.max(2.5, x(d * 24 + s0.cut_end_hour) - cx);
    s += `<rect x="${cx}" y="${m.t}" width="${cw}" height="${ph}" fill="var(--cut-wash)"/>`;
    if (d) s += `<line x1="${x(d * 24)}" x2="${x(d * 24)}" y1="${m.t}" y2="${m.t + ph}" stroke="var(--line)"/>`;
    s += `<text x="${x(d * 24 + 12)}" y="${H - 6}" text-anchor="middle">${s0.first_day + d} ${s0.month}</text>`;
  }
  s += `<line x1="${m.l}" x2="${m.l + pw}" y1="${y(LIMIT)}" y2="${y(LIMIT)}" stroke="var(--danger)" stroke-width="1.4" stroke-dasharray="5 4"/>`;

  const path = a => a.map((v, i) => `${i ? "L" : "M"}${x(i + 0.5).toFixed(1)},${y(v).toFixed(1)}`).join("");
  if (showTout) s += `<path d="${path(result.outdoor_temp)}" fill="none" stroke="var(--muted)" stroke-width="1.3" stroke-dasharray="3 3" opacity="0.75"/>`;
  if (showTin) s += `<path d="${path(result.indoor_temp)}" fill="none" stroke="#f59e0b" stroke-width="1.4" stroke-dasharray="5 3"/>`;

  shown.forEach(d => {
    s += `<path d="${path(d.arr)}" fill="none" stroke="var(${d.color})" stroke-width="${d.id === "you" ? 2.3 : 1.9}"/>`;
  });

  if (wide) {
    const ends = shown.map(d => ({ d, yy: y(d.arr[HOURS - 1]) })).sort((a, b) => a.yy - b.yy);
    if (ends.length === 2 && ends[1].yy - ends[0].yy < 14) {
      const mid = (ends[0].yy + ends[1].yy) / 2;
      ends[0].yy = mid - 7;
      ends[1].yy = mid + 7;
    }
    ends.forEach(e => {
      s += `<text class="lab" x="${m.l + pw + 6}" y="${e.yy + 3.5}" fill="var(${e.d.color})">${esc(e.d.short)}</text>`;
    });
  }

  const tmX = x(currentHour + 0.5);
  s += `<line id="tm-line" x1="${tmX}" x2="${tmX}" y1="${m.t}" y2="${m.t + ph}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="2 2"/>`;

  s += `<g id="hover" visibility="hidden">
    <line id="hx" y1="${m.t}" y2="${m.t + ph}" stroke="var(--ink)"/>
    ${shown.map(d => `<circle id="dot-${d.id}" r="4" fill="var(${d.color})" stroke="var(--bg-card)" stroke-width="1.8"/>`).join("")}
  </g>`;
  s += `<rect id="hit" x="${m.l}" y="${m.t}" width="${pw}" height="${ph}" fill="transparent" style="cursor:crosshair"/></svg>`;

  const tip = $("tip");
  tip.hidden = true;
  el.querySelector("svg")?.remove();
  el.insertAdjacentHTML("afterbegin", s);

  const hit = el.querySelector("#hit");
  hit.addEventListener("pointermove", hover);
  hit.addEventListener("pointerdown", e => {
    hover(e);
    const svg = el.querySelector("svg"), box = svg.getBoundingClientRect();
    const px = (e.clientX - box.left) * (geo.W / box.width);
    const idx = Math.min(HOURS - 1, Math.max(0, Math.floor(((px - geo.m.l) / geo.pw) * HOURS)));
    setScrubberHour(idx);
  });
  hit.addEventListener("pointerleave", () => {
    el.querySelector("#hover").setAttribute("visibility", "hidden");
    tip.hidden = true;
  });
}

function updateChartTimeMarker() {
  if (!geo) return;
  const line = document.querySelector("#tm-line");
  if (line) {
    const tmX = geo.x(currentHour + 0.5);
    line.setAttribute("x1", tmX);
    line.setAttribute("x2", tmX);
  }
}

function hover(e) {
  const el = $("chart"), svg = el.querySelector("svg"), box = svg.getBoundingClientRect(), g = geo, s0 = OPT.scenario;
  const px = (e.clientX - box.left) * (g.W / box.width);
  const i = Math.min(HOURS - 1, Math.max(0, Math.floor(((px - g.m.l) / g.pw) * HOURS)));
  const hx = g.x(i + 0.5);

  svg.querySelector("#hover").setAttribute("visibility", "visible");
  const line = svg.querySelector("#hx");
  line.setAttribute("x1", hx);
  line.setAttribute("x2", hx);

  shown.forEach(d => {
    const c = svg.querySelector("#dot-" + d.id);
    c.setAttribute("cx", hx);
    c.setAttribute("cy", g.y(d.arr[i]));
  });

  const h = i % 24, pad = n => String(n).padStart(2, "0");
  const tip = $("tip");
  tip.innerHTML =
    `<div class="t">${s0.first_day + Math.floor(i / 24)} ${s0.month} · ${pad(h)}:00–${pad(h + 1)}:00</div>` +
    shown.slice().reverse().map(d => `<div class="r"><span>${esc(d.short)}</span><b>${d.arr[i].toFixed(1)} °C</b></div>`).join("") +
    `<div class="r"><span>Indoor Air</span><b>${result.indoor_temp[i].toFixed(1)} °C (${result.humidity[i].toFixed(0)}% RH)</b></div>` +
    `<div class="r"><span>Outdoor Air</span><b>${result.outdoor_temp[i].toFixed(1)} °C</b></div>` +
    (h >= s0.cut_start_hour && h < s0.cut_end_hour ? `<div class="cutflag">⚡ Power Cut: Fan Off</div>` : "");
  tip.hidden = false;
  const left = (hx * box.width) / g.W, tw = tip.offsetWidth;
  tip.style.left = (left + 14 + tw > box.width ? Math.max(0, left - tw - 14) : left + 14) + "px";
}

// ---------- TAB 2: CBE Psychrometric Comfort Chart (T_db vs RH) ----------
function drawPsychro() {
  if (!result) return;
  const box = $("psychro-chart");
  const W = Math.max(320, box.clientWidth || 520), H = 225;
  const m = { t: 14, r: 18, b: 28, l: 38 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  const tMin = 27, tMax = 43;
  const rhMin = 25, rhMax = 88;
  const x = t => m.l + ((t - tMin) / (tMax - tMin)) * pw;
  const y = rh => m.t + ((rhMax - rh) / (rhMax - rhMin)) * ph;

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;

  // Grid lines
  for (let t = 28; t <= 42; t += 2) {
    svg += `<line x1="${x(t)}" x2="${x(t)}" y1="${m.t}" y2="${m.t + ph}" stroke="var(--line)"/>`;
    svg += `<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${t}°C</text>`;
  }
  for (let rh = 30; rh <= 80; rh += 10) {
    svg += `<line x1="${m.l}" x2="${m.l + pw}" y1="${y(rh)}" y2="${y(rh)}" stroke="var(--line)"/>`;
    svg += `<text x="${m.l - 6}" y="${y(rh) + 3.5}" text-anchor="end">${rh}%</text>`;
  }

  // NWS Heat Index Iso-Curves (for felt temperature = T_in - 2°C fan credit)
  const isoCurves = [
    { targetHI: 35, col: "#06b6d4", dash: "3 3", label: "35°C HI" },
    { targetHI: 41, col: "#ef4444", dash: "5 3", label: "41°C Danger Limit" },
    { targetHI: 46, col: "#d946ef", dash: "3 3", label: "46°C Extreme" },
  ];
  isoCurves.forEach(curve => {
    const pts = [];
    for (let rh = rhMin; rh <= rhMax; rh += 3) {
      // Binary search T_felt that produces targetHI at rh
      let lo = 24, hi = 46;
      for (let it = 0; it < 12; it++) {
        const mid = (lo + hi) / 2;
        if (calcHeatIndexC(mid, rh) < curve.targetHI) lo = mid;
        else hi = mid;
      }
      const tFelt = (lo + hi) / 2;
      if (tFelt >= tMin && tFelt <= tMax) {
        pts.push(`${pts.length ? "L" : "M"}${x(tFelt).toFixed(1)},${y(rh).toFixed(1)}`);
      }
    }
    if (pts.length > 1) {
      svg += `<path d="${pts.join("")}" fill="none" stroke="${curve.col}" stroke-width="1.6" stroke-dasharray="${curve.dash}"/>`;
    }
  });

  // Plot Pinned / Top Comparison 168-Hour Cloud (if available)
  const altSeries = shown.find(d => d.id === "alt");
  if (altSeries && altSeries.tin && altSeries.rh) {
    for (let i = 0; i < HOURS; i++) {
      const isCut = (i % 24) === 20;
      const tFelt = altSeries.tin[i] - (isCut ? 0 : 2.0);
      const rh = altSeries.rh[i];
      svg += `<circle cx="${x(tFelt).toFixed(1)}" cy="${y(rh).toFixed(1)}" r="2.5" fill="var(--safe)" fill-opacity="0.38"/>`;
    }
  }

  // Plot Your Design 168-Hour Cloud
  for (let i = 0; i < HOURS; i++) {
    const isCut = (i % 24) === 20;
    const tFelt = result.indoor_temp[i] - (isCut ? 0 : 2.0);
    const rh = result.humidity[i];
    const col = hiColor(result.heat_index[i]);
    svg += `<circle cx="${x(tFelt).toFixed(1)}" cy="${y(rh).toFixed(1)}" r="3" fill="${col}" fill-opacity="0.78"/>`;
  }

  // Highlight Current Scrubbed Hour
  const curCut = (currentHour % 24) === 20;
  const curTFelt = result.indoor_temp[currentHour] - (curCut ? 0 : 2.0);
  const curRH = result.humidity[currentHour];
  svg += `<circle cx="${x(curTFelt).toFixed(1)}" cy="${y(curRH).toFixed(1)}" r="6.5" fill="none" stroke="#fff" stroke-width="2"/>`;

  svg += `</svg>`;
  box.innerHTML = svg;

  $("psychro-info").innerHTML = `
    <b style="color:var(--accent)">CBE Psychrometric Comfort Cloud</b>
    <p>Plots all <b>168 hours</b> of Effective Felt Temperature ($T_{\\text{in}} - 2^\\circ\\text{C}$ fan effect) vs Relative Humidity ($\\%$) against NWS Heat Index thresholds.</p>
    <div style="border-top:1px solid var(--line);padding-top:6px;display:flex;flex-direction:column;gap:4px">
      <span>🔴 <b>Red Dashed Curve:</b> 41 °C Danger Limit</span>
      <span>🟢 <b>Green Cloud:</b> ${altSeries ? esc(altSeries.short) : "Passive Intervention"}</span>
      <span>⚪ <b>White Ring:</b> Current Scrubbed Hour (${result.heat_index[currentHour].toFixed(1)} °C)</span>
    </div>
  `;
}

// ---------- TAB 3: 7x24h Carpet Heatmap ----------
function drawHeatmap() {
  if (!result) return;
  const s0 = OPT.scenario;
  const altSeries = shown.find(d => d.id === "alt")?.arr || result.heat_index;

  let html = `<div class="carpet-grid"><div class="carpet-hdr">Day\\Hr</div>`;
  for (let h = 0; h < 24; h++) {
    html += `<div class="carpet-hdr ${h === s0.cut_start_hour ? "cut-col" : ""}">${String(h).padStart(2, "0")}</div>`;
  }
  for (let d = 0; d < 7; d++) {
    html += `<div class="carpet-day">${s0.first_day + d} ${s0.month}</div>`;
    for (let h = 0; h < 24; h++) {
      const idx = d * 24 + h;
      const isCut = h === s0.cut_start_hour;
      const vYou = result.heat_index[idx];
      const vAlt = altSeries[idx];
      let bg = hiColor(vYou);
      let txt = vYou.toFixed(0);
      if (heatmapMode === "top") {
        bg = hiColor(vAlt);
        txt = vAlt.toFixed(0);
      } else if (heatmapMode === "delta") {
        const diff = vAlt - vYou;
        txt = diff <= -0.05 ? diff.toFixed(1) : "0";
        const intensity = Math.min(1, Math.abs(diff) / 5);
        bg = diff < -0.1 ? `rgba(6, 182, 212, ${0.25 + 0.65 * intensity})` : "rgba(100, 116, 139, 0.25)";
      }
      html += `<div class="carpet-cell ${isCut ? "is-cut" : ""}" data-hidx="${idx}" style="background:${bg}" title="${s0.first_day + d} ${s0.month} ${String(h).padStart(2, "0")}:00 · HI: ${vYou.toFixed(1)} °C">${txt}</div>`;
    }
  }
  html += `</div>`;
  $("heatmap-container").innerHTML = html;
  document.querySelectorAll(".carpet-cell[data-hidx]").forEach(cell => {
    cell.addEventListener("click", () => setScrubberHour(parseInt(cell.dataset.hidx, 10)));
  });
}

// ---------- TAB 4: 24-Hour Diurnal Cycle & Comfort Bands ----------
function drawDiurnalAndBands() {
  if (!result) return;
  const s0 = OPT.scenario;
  const avgHI = new Array(24).fill(0);
  const avgTin = new Array(24).fill(0);
  const avgTout = new Array(24).fill(0);
  for (let i = 0; i < HOURS; i++) {
    const h = i % 24;
    avgHI[h] += result.heat_index[i] / 7;
    avgTin[h] += result.indoor_temp[i] / 7;
    avgTout[h] += result.outdoor_temp[i] / 7;
  }

  const box = $("diurnal-chart");
  const W = Math.max(280, box.clientWidth || 420), H = 195;
  const m = { t: 12, r: 16, b: 24, l: 34 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const all = avgHI.concat(avgTin, avgTout, [s0.safe_limit_c]);
  const y0 = Math.floor(Math.min(...all) - 1);
  const y1 = Math.ceil(Math.max(...all) + 1);
  const x = h => m.l + (h / 23) * pw;
  const y = v => m.t + ((y1 - v) / (y1 - y0)) * ph;
  const linePath = arr => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  for (let v = Math.ceil(y0 / 2) * 2; v <= y1; v += 2) {
    svg += `<line x1="${m.l}" x2="${m.l + pw}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/>`;
    svg += `<text x="${m.l - 5}" y="${y(v) + 3.5}" text-anchor="end">${v}°</text>`;
  }
  svg += `<rect x="${x(19.5)}" y="${m.t}" width="${x(20.5) - x(19.5)}" height="${ph}" fill="var(--cut-wash)"/>`;
  svg += `<line x1="${m.l}" x2="${m.l + pw}" y1="${y(s0.safe_limit_c)}" y2="${y(s0.safe_limit_c)}" stroke="var(--danger)" stroke-dasharray="4 3" stroke-width="1.3"/>`;
  svg += `<path d="${linePath(avgTout)}" fill="none" stroke="var(--muted)" stroke-width="1.6" stroke-dasharray="3 3"/>`;
  svg += `<path d="${linePath(avgTin)}" fill="none" stroke="#f59e0b" stroke-width="1.8"/>`;
  svg += `<path d="${linePath(avgHI)}" fill="none" stroke="var(--sel)" stroke-width="2.3"/>`;
  for (let h = 0; h < 24; h += 4) {
    svg += `<text x="${x(h)}" y="${H - 5}" text-anchor="middle">${String(h).padStart(2, "0")}h</text>`;
  }
  svg += `</svg>`;
  box.innerHTML = svg;

  const bands = [
    { label: "Comfortable (< 32 °C)", min: -99, max: 32, color: "#10b981" },
    { label: "Warm Caution · Safe (32–41 °C)", min: 32, max: 41, color: "#06b6d4" },
    { label: "NWS Danger (41–45 °C)", min: 41, max: 45, color: "#ef4444" },
    { label: "Extreme Danger (≥ 45 °C)", min: 45, max: 999, color: "#d946ef" },
  ];
  $("comfort-bands").innerHTML = `<div class="band-list">` + bands.map(b => {
    const count = result.heat_index.filter(v => v >= b.min && v < b.max).length;
    const pct = Math.round((count / HOURS) * 100);
    return `<div class="band-item">
      <div class="band-top">
        <span>${esc(b.label)}</span>
        <span style="color:${b.color};font-family:var(--font-mono)">${count}h (${pct}%)</span>
      </div>
      <div class="band-bar"><div class="band-fill" style="width:${pct}%;background:${b.color}"></div></div>
    </div>`;
  }).join("") + `</div>`;
}

function renderValidationSummary() {
  const sur = OPT.surrogate || { designs_total: 1512, r2: 0.995, mae_hours: 1.34 };
  const cal = OPT.calibration?.groups?.["single brick"]?.calibrated || { check_rmse_c: 0.74, mean_ach: 14.3 };

  $("validation-mini").innerHTML = `
    <div><b>🔬 Calibrated Physics Engine</b></div>
    <div>Dhaka Logger Validation: <b>RMSE ${cal.check_rmse_c} °C</b> (~${cal.mean_ach} ACH)</div>
    <div>XGBoost Surrogate (${sur.designs_total} runs): <b>R² = ${sur.r2}</b> (MAE ${sur.mae_hours}h)</div>
  `;

  $("method-grid").innerHTML = `
    <div class="method-box">
      <span class="method-tag">01 · CAD &amp; Parametric</span>
      <b>Rhino .3dm &amp; Live Sliders</b>
      <p>Reads room bounding boxes and per-wall glazing areas directly from <code>.3dm</code> files or interactive workbench sliders.</p>
    </div>
    <div class="method-box">
      <span class="method-tag">02 · Simulation Engine</span>
      <b>EnergyPlus 26.2 Parallel</b>
      <p>Builds multi-layer constructions via <code>eppy</code> and runs 9 parallel heat-balance simulations per design change.</p>
    </div>
    <div class="method-box">
      <span class="method-tag">03 · Logger Calibration</span>
      <b>Dhaka &amp; Delhi Measured Homes</b>
      <p>Calibrated against indoor logger datasets (Tasgaonkar et al. 2022), achieving <b>RMSE = ${cal.check_rmse_c} °C</b>.</p>
    </div>
    <div class="method-box">
      <span class="method-tag">04 · Surrogate ML</span>
      <b>XGBoost (${sur.designs_total} Sweep)</b>
      <p>Trained on ${sur.designs_total} EnergyPlus runs with <b>R² = ${sur.r2}</b> and <b>MAE = ${sur.mae_hours} safe hours</b>.</p>
    </div>
  `;
}

// ---------- UI Events & 3D Orbit Dragging ----------
function initUIEvents() {
  $("theme-toggle").addEventListener("click", () => {
    const html = document.documentElement;
    const next = html.getAttribute("data-theme") === "light" ? "dark" : "light";
    html.setAttribute("data-theme", next);
    $("theme-icon").textContent = next === "dark" ? "☀" : "🌙";
    $("theme-label").textContent = next === "dark" ? "Light" : "Dark";
  });

  // Modal Open/Close
  $("btn-open-modal").addEventListener("click", () => { $("matrix-modal").hidden = false; });
  $("btn-close-modal").addEventListener("click", () => { $("matrix-modal").hidden = true; });
  $("matrix-modal").addEventListener("click", e => {
    if (e.target === $("matrix-modal")) $("matrix-modal").hidden = true;
  });

  // Interactive 3D Orbit Drag on Viewport
  const stage = $("axon-stage");
  stage.addEventListener("pointerdown", e => {
    isDragging3D = true;
    dragStart = { x: e.clientX, y: e.clientY, yaw: camYaw, pitch: camPitch };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", e => {
    if (!isDragging3D) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    camYaw = (dragStart.yaw + dx * 0.45) % 360;
    camPitch = Math.max(5, Math.min(82, dragStart.pitch + dy * 0.35));
    document.querySelectorAll("[data-cam]").forEach(b => b.classList.remove("active"));
    drawAxon();
  });
  stage.addEventListener("pointerup", () => { isDragging3D = false; });

  // Camera Presets & Explode Roof Toggle
  document.querySelectorAll("[data-cam]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-cam]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      if (btn.dataset.cam === "iso") { camYaw = 38; camPitch = 26; }
      else if (btn.dataset.cam === "south") { camYaw = 0; camPitch = 8; }
      else if (btn.dataset.cam === "top") { camYaw = 0; camPitch = 78; }
      drawAxon();
    });
  });
  $("btn-explode-roof").addEventListener("click", e => {
    explodeRoof = !explodeRoof;
    e.currentTarget.classList.toggle("active", explodeRoof);
    drawAxon();
  });

  // Scrubber & Playback
  $("hour-scrubber").addEventListener("input", e => setScrubberHour(parseInt(e.target.value, 10)));
  $("play-btn").addEventListener("click", () => {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      $("play-icon").textContent = "▶";
    } else {
      $("play-icon").textContent = "⏸";
      playTimer = setInterval(() => setScrubberHour((currentHour + 1) % HOURS), 110);
    }
  });

  $("jump-peak").addEventListener("click", () => {
    if (!result) return;
    let maxIdx = 0;
    result.heat_index.forEach((v, i) => { if (v > result.heat_index[maxIdx]) maxIdx = i; });
    setScrubberHour(maxIdx);
  });
  $("jump-cut").addEventListener("click", () => {
    const day = Math.floor(currentHour / 24);
    setScrubberHour(day * 24 + (OPT?.scenario?.cut_start_hour || 20));
  });
  $("jump-cool").addEventListener("click", () => {
    const day = Math.floor(currentHour / 24);
    setScrubberHour(day * 24 + 6);
  });

  // Analytics Dock Tabs
  document.querySelectorAll("[data-view]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-view]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeView = btn.dataset.view;
      drawActiveAnalyticsView();
    });
  });

  document.querySelectorAll("[data-hm]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-hm]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      heatmapMode = btn.dataset.hm;
      drawHeatmap();
    });
  });

  ["chk-tout", "chk-tin"].forEach(id => {
    $(id)?.addEventListener("change", () => drawChart());
  });
}

(async function start() {
  initUIEvents();
  try {
    OPT = await api("/api/options");
  } catch (error) {
    $("error").textContent = "The OASIS server is not responding. Start it with: python run_server.py";
    $("error").hidden = false;
    return;
  }

  const s = OPT.scenario;
  $("scenario-pills").textContent = `${s.city} · ${s.first_day}–${s.last_day} ${s.month} Heatwave · Nightly Cut ${s.cut_start_hour}:00–${s.cut_end_hour}:00 · Safe < ${s.safe_limit_c}°C HI`;

  state = { ...OPT.baseline };
  buildForm();
  syncForm();
  renderValidationSummary();
  assess();

  let lastW = $("chart").clientWidth;
  new ResizeObserver(() => {
    const w = $("chart").clientWidth;
    if (w !== lastW) {
      lastW = w;
      drawActiveAnalyticsView();
    }
  }).observe($("chart"));
})();
