// Review 3 deck (visuals first), in the look of the earlier IAAC review decks:
// black slides, Poppins, orange accent. Numbers come from deck_data.json (collect.py)
// and review3_data.json (review3_collect.py); paper figures from review3_figs/.
// Run: node docs/deck/review3_build.js [output.pptx]   (needs pptxgenjs; PPTX_SKILL for the theme step)
const fs = require("fs");
const path = require("path");
const pptxgen = require("pptxgenjs");

const HERE = __dirname;
const FIGS = path.join(HERE, "review3_figs");
const OUTFILE = process.argv[2] || path.join(HERE, "..", "OASIS_2.0_review3.pptx");
const D = JSON.parse(fs.readFileSync(path.join(HERE, "deck_data.json"), "utf8"));
const R = JSON.parse(fs.readFileSync(path.join(HERE, "review3_data.json"), "utf8"));

const THEME = {
  name: "OASIS Review",
  headFontFace: "Poppins",
  bodyFontFace: "Poppins",
  colors: {
    dk1: "000000", lt1: "FFFFFF", dk2: "1C1C1C", lt2: "F2F2F2",
    accent1: "C0531F", accent2: "E07B45", accent3: "F2CBB5", accent4: "8C8C8C",
    accent5: "2E2E2E", accent6: "5B8DB8", hlink: "E07B45", folHlink: "8C8C8C",
  },
};
const H = THEME.colors;
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = "OASIS 2.0: Review 3";
pres.author = "Nithik Vairamuthu";
const C = pres.SchemeColor;
const WHITE = C.background1, ORANGE = C.accent1, GREY = C.accent4;

// One frame for every slide: black, small italic label top left, IAAC logo bottom right.
pres.defineSlideMaster({
  title: "FRAME",
  background: { color: H.dk1 },
  objects: [
    { image: { path: path.join(FIGS, "iaac_logo.png"), x: 11.55, y: 6.85, w: 1.3, h: 0.264 } },
    { placeholder: { options: { name: "title", type: "title", x: 0.3, y: 0.15, w: 9, h: 0.45, fontSize: 14, italic: true, color: WHITE, align: "left", valign: "middle", margin: 0 }, text: "" } },
  ],
});

// ---- helpers ---------------------------------------------------------------
function frame(label, notes) {
  const s = pres.addSlide({ masterName: "FRAME" });
  s.addText(label, { placeholder: "title" });
  if (notes) s.addNotes(notes);
  return s;
}
function text(s, t, o) {
  s.addText(t, Object.assign({ isTextBox: true, margin: 0, color: WHITE, fontSize: 14, valign: "top" }, o));
}
function headline(s, t) {
  text(s, t, { x: 0.6, y: 0.85, w: 12.1, h: 1.0, fontSize: 28, bold: true, color: ORANGE, valign: "middle" });
}
function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
// Picture fitted inside a box, centred, aspect kept.
function fitImage(s, file, x, y, w, h) {
  const p = pngSize(file);
  const k = Math.min(w / p.w, h / p.h);
  const iw = p.w * k, ih = p.h * k;
  s.addImage({ path: file, x: x + (w - iw) / 2, y: y + (h - ih) / 2, w: iw, h: ih });
}
function card(s, x, y, w, h, fill, line) {
  s.addShape(pres.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.12,
    fill: fill ? { color: fill } : { type: "none" },
    line: line ? { color: line, width: 0.75 } : { type: "none" },
  });
}
// Big number with a caption below, in an outlined card.
function stat(s, x, y, w, h, big, caption) {
  card(s, x, y, w, h, null, GREY);
  text(s, big, { x: x + 0.25, y: y + 0.18, w: w - 0.5, h: 0.75, fontSize: 32, bold: true, color: ORANGE, valign: "middle" });
  text(s, caption, { x: x + 0.25, y: y + 0.98, w: w - 0.5, h: h - 1.1, fontSize: 13, italic: true, color: WHITE });
}
const CHART = {
  catAxisLabelColor: "BFBFBF", valAxisLabelColor: "BFBFBF",
  catAxisLabelFontFace: "Poppins", valAxisLabelFontFace: "Poppins",
  catAxisLabelFontSize: 11, valAxisLabelFontSize: 11,
  valGridLine: { color: "2E2E2E", size: 0.75 }, catGridLine: { style: "none" },
  catAxisLineShow: false, valAxisLineShow: false,
  legendColor: "FFFFFF", legendFontFace: "Poppins", legendFontSize: 12,
  dataLabelFontFace: "Poppins",
};
const one = v => (v > 0 ? "+" : "") + v.toFixed(1);

// ---- numbers ---------------------------------------------------------------
const hw = (weather, design) => D.heatwave.find(r => r.weather.startsWith(weather) && r.design === design);
const typical = hw("typical", "top floor"), recorded = hw("recorded", "top floor");
const scen = (weather, design, cut) => D.scenarios.find(r => r.weather.startsWith(weather) && r.design === design && r.power_cut.startsWith(cut));
const CUT = "heatwave + power cut", NOCUT = "heatwave alone";
const base = scen("airport", "top floor", CUT), noCut = scen("airport", "top floor", NOCUT);
const dhaka = D.evidence.groups.Dhaka;
const hours = [...Array(24).keys()].map(h => String(h).padStart(2, "0"));

// ---- 1 title ---------------------------------------------------------------
{
  const s = frame("Review 3");
  text(s, [{ text: "OASIS ", options: { color: WHITE } }, { text: "2.0", options: { color: ORANGE } }],
    { x: 0.9, y: 2.3, w: 11.5, h: 1.3, fontSize: 80, bold: true, valign: "middle" });
  text(s, "Overheating Assessment System for Intervention Strategies", { x: 0.95, y: 3.7, w: 11.5, h: 0.5, fontSize: 22 });
  text(s, "Safe hours in new Chennai flats during a recorded heatwave", { x: 0.95, y: 4.3, w: 11.5, h: 0.45, fontSize: 16, italic: true, color: GREY });
}

// ---- 2 the idea in one sentence -------------------------------------------
{
  const s = frame("The idea in one sentence");
  const o = { color: ORANGE, bold: true };
  text(s, [
    { text: "Architects designing new flats in Chennai", options: o },
    { text: " cannot tell whether a home will stay safe in a heatwave, so OASIS " },
    { text: "predicts its safe hours from the plan", options: o },
    { text: " at design stage, checked against measured homes." },
  ], { x: 0.9, y: 1.3, w: 11.5, h: 2.9, fontSize: 32, valign: "middle" });
  const chips = [
    ["PROBLEM", "Homes become dangerous indoors in a heatwave, and nobody checks at design stage"],
    ["USER", "Architects and developers of new flats in Chennai"],
    ["WHAT I BUILD", "A tool that reads a plan and returns safe hours: indoor heat index below 41 °C"],
  ];
  chips.forEach(([k, v], i) => {
    const x = 0.9 + i * 3.95;
    card(s, x, 4.6, 3.7, 1.75, null, GREY);
    text(s, k, { x: x + 0.25, y: 4.78, w: 3.2, h: 0.35, fontSize: 13, bold: true, color: ORANGE });
    text(s, v, { x: x + 0.25, y: 5.18, w: 3.2, h: 1.05, fontSize: 13, italic: true });
  });
}

// ---- 3 measured evidence ---------------------------------------------------
{
  const s = frame("The problem, measured · Dhaka homes (no Chennai loggers yet)",
    "Source: Tasgaonkar et al. 2022 loggers, outputs/evidence/model_evening_hourly.csv (check_evening.py).");
  headline(s, "Measured homes hold the day's heat into the evening");
  s.addChart(pres.charts.LINE, [
    { name: "Indoors, measured", labels: hours, values: R.dhaka_profile.t_meas },
    { name: "Outdoors", labels: hours, values: R.dhaka_profile.t_out },
  ], Object.assign({}, CHART, {
    x: 0.5, y: 2.0, w: 8.4, h: 4.55, chartColors: [H.accent2, H.accent4], lineSize: 3, lineDataSymbol: "none",
    valAxisMinVal: 26, valAxisMaxVal: 33, valAxisMajorUnit: 1, catAxisLabelFrequency: 4,
    showLegend: true, legendPos: "b", showValAxisTitle: true, valAxisTitle: "Air temperature (°C)",
    valAxisTitleColor: "BFBFBF", valAxisTitleFontFace: "Poppins", valAxisTitleFontSize: 11,
  }));
  stat(s, 9.2, 2.1, 3.5, 1.95, `${R.measured_peak_hour}:00`, `Indoor peak. Outdoors peaks at ${R.outdoor_peak_hour}:00, three hours earlier`);
  stat(s, 9.2, 4.3, 3.5, 1.95, `${one(R.excess_at_20h_c)} °C`, "Indoors above outdoors at 20:00, when Chennai's evening power cuts fall");
  text(s, `Mean day of ${R.dhaka_homes} homes without AC, 2016 (Tasgaonkar et al. 2022)`, { x: 0.6, y: 6.65, w: 8.3, h: 0.3, fontSize: 11, italic: true, color: GREY });
}

// ---- 4 typical year vs recorded week --------------------------------------
{
  const s = frame("The problem, simulated · Chennai top-floor flat",
    "outputs/heatwave/results.csv (run_heatwave.py). Same model, windows open day and night, power cut 20-21 h.");
  headline(s, "A typical-year file hides the danger");
  const rows = [
    [`Typical year file · ${D.weather.typical.mean_rh_pct} % humidity`, typical.safe_hours],
    [`Recorded heatwave, 1–7 May 2024 · ${D.weather.recorded.mean_rh_pct} % humidity`, recorded.safe_hours],
  ];
  rows.forEach(([label, safe], i) => {
    const y = 2.2 + i * 2.0, W = 9.0, x = 0.6, ws = W * safe / 168;
    text(s, label, { x, y, w: 9, h: 0.4, fontSize: 16, bold: true });
    s.addShape(pres.ShapeType.rect, { x, y: y + 0.5, w: ws, h: 0.75, fill: { color: C.accent3 }, line: { type: "none" } });
    s.addShape(pres.ShapeType.rect, { x: x + ws, y: y + 0.5, w: W - ws, h: 0.75, fill: { color: ORANGE }, line: { type: "none" } });
    text(s, [{ text: `${safe}`, options: { fontSize: 44, bold: true, color: ORANGE } }, { text: "  safe hours", options: { fontSize: 16 } }],
      { x: 9.9, y: y + 0.35, w: 3.2, h: 1.0, valign: "middle" });
  });
  s.addShape(pres.ShapeType.rect, { x: 0.6, y: 6.12, w: 0.25, h: 0.25, fill: { color: C.accent3 }, line: { type: "none" } });
  text(s, "safe: felt heat below 41 °C", { x: 0.95, y: 6.08, w: 3, h: 0.33, fontSize: 12, italic: true, valign: "middle" });
  s.addShape(pres.ShapeType.rect, { x: 4.0, y: 6.12, w: 0.25, h: 0.25, fill: { color: ORANGE }, line: { type: "none" } });
  text(s, "in danger, of 168 hours in the week", { x: 4.35, y: 6.08, w: 4, h: 0.33, fontSize: 12, italic: true, valign: "middle" });
  text(s, `Same home, same air temperature (${D.weather.typical.mean_temp_c} vs ${D.weather.recorded.mean_temp_c} °C). Station: Meenambakkam.`,
    { x: 0.6, y: 6.6, w: 9.5, h: 0.3, fontSize: 11, italic: true, color: GREY });
  // Second headline: power cuts only as often as measured (Prayas ESMI, Chennai, April-June)
  if (recorded.safe_hours_measured_cuts != null)
    text(s, [{ text: "Cut every evening = stress case. ", options: { bold: true } },
             { text: `With cuts only as often as measured in Chennai: ${Math.round(recorded.safe_hours_measured_cuts)} safe hours.` }],
      { x: 0.6, y: 5.5, w: 9.0, h: 0.4, fontSize: 13, italic: true, valign: "middle" });
}

// ---- 5 the week hour by hour ----------------------------------------------
{
  const s = frame("The recorded week, hour by hour · top floor",
    "deck_data.json strip / strip_out (outputs/heatwave/hourly.csv). Indoor = felt heat with the fan credit; fan off 20-21 h.");
  headline(s, `Above the limit for ${recorded.danger_hours} of 168 hours`);
  const labels = D.strip.map((_, i) => `${Math.floor(i / 24) + 1} May`);
  s.addChart(pres.charts.LINE, [
    { name: "Indoors, felt heat", labels, values: D.strip },
    { name: "Outdoors, heat index", labels, values: D.strip_out },
    { name: "41 °C limit", labels, values: D.strip.map(() => 41) },
  ], Object.assign({}, CHART, {
    x: 0.5, y: 1.95, w: 12.3, h: 4.05, chartColors: [H.accent2, "6E6E6E", "FFFFFF"], lineSize: 2, lineDataSymbol: "none",
    valAxisMinVal: 36, valAxisMaxVal: 58, valAxisMajorUnit: 4, catAxisLabelFrequency: 24,
    showLegend: true, legendPos: "b",
  }));
  text(s, [
    { text: "Each evening spike is the power cut: " },
    { text: `fans stop at 20:00 and felt heat jumps to ${recorded.cut_max_heat_index_c.toFixed(0)} °C, the week's maximum.`, options: { bold: true, color: ORANGE } },
  ], { x: 0.6, y: 6.15, w: 10.6, h: 0.55, fontSize: 15, valign: "middle" });
}

// ---- 6 model vs measured ---------------------------------------------------
{
  const s = frame("Can the model be trusted? · checked against the measured homes",
    "outputs/evidence/summary.json (check_evening.py), calibration round 4 settings.");
  headline(s, "The model matches measured evenings, but peaks early");
  s.addChart(pres.charts.LINE, [
    { name: "Measured", labels: hours, values: R.dhaka_profile.t_meas },
    { name: "Model", labels: hours, values: R.dhaka_profile.t_sim },
    { name: "Outdoors", labels: hours, values: R.dhaka_profile.t_out },
  ], Object.assign({}, CHART, {
    x: 0.5, y: 2.0, w: 8.4, h: 4.55, chartColors: [H.accent2, "FFFFFF", "6E6E6E"], lineSize: 3, lineDataSymbol: "none",
    valAxisMinVal: 26, valAxisMaxVal: 33, valAxisMajorUnit: 1, catAxisLabelFrequency: 4,
    showLegend: true, legendPos: "b",
  }));
  stat(s, 9.2, 2.0, 3.5, 1.4, `${one(dhaka.evening_err_c)} °C`, "evening error, 19:00–22:00");
  stat(s, 9.2, 3.55, 3.5, 1.4, `${dhaka.rmse_all_c.toFixed(1)} °C`, "error over the whole day (RMSE)");
  stat(s, 9.2, 5.1, 3.5, 1.4, `${dhaka.peak_lag_h_mean.toFixed(1)} h`, "model peak too early: open limit");
  text(s, `${R.dhaka_homes} Dhaka homes, one model per home built from its survey`, { x: 0.6, y: 6.65, w: 8.3, h: 0.3, fontSize: 11, italic: true, color: GREY });
}

// ---- 7-11 key papers: one figure, one line --------------------------------
const papers = [
  { label: "Key paper 1 · Chen et al. (2024) · Guangzhou", fig: "chen_fig12.png",
    why: "Gives OASIS its yardstick: indoor heat index tied to body core temperature and water loss, not comfort",
    cap: "Fig. 12: maximum core temperature against peak heat index. 38 °C is reached near 55 °C.",
    ref: "Building and Environment 266, 112089" },
  { label: "Key paper 2 · Rajput et al. (2022) · Phoenix", fig: "rajput_fig21.png",
    why: "The house type decides exposure in an outage, so the home itself is the thing to design",
    cap: "Fig. 21: maximum temperature in six house-type zones across all city grid cells, 2006 to 2088, with no AC (top) and partial AC (bottom).",
    ref: "Energy and Buildings 259, 111605" },
  { label: "Key paper 3 · Shi et al. (2025) · Phoenix", fig: "shi_fig8.png",
    why: "Airport weather is not the street: local air changes the result across one city",
    cap: "Fig. 8: how far local air temperature departs from the airport weather file over the week (RMSE, °C). Largest downtown.",
    ref: "Building and Environment 276, 112747" },
  { label: "Key paper 4 · Mehraban et al. (2025) · 14 US climates", fig: "mehraban_fig8.png",
    why: `The AI step exists, but for US timber homes: the roof is 1 % of the envelope effect there, ${Math.round(D.surrogate.envelope_share_pct.Roof)} % in my Chennai model`,
    cap: "Fig. 8: feature importance of the XGBoost model, with the envelope parts in the inset.",
    ref: "Buildings 15, 3950" },
  { label: "Key paper 5 · Wu, Malik, Hong et al. (2025) · Jodhpur", fig: "wu_fig13.png",
    why: "An Indian precedent for counting danger hours: single measures first, then packages",
    cap: "Fig. 13: occupied hours in each heat-index band, baseline and single measures. Their packages, not the single measures, remove the danger hours.",
    ref: "Building Simulation 18" },
];
papers.forEach(p => {
  const s = frame(p.label, `Figure reproduced from the paper: ${p.ref}.`);
  card(s, 0.6, 1.0, 8.0, 5.6, H.lt1, null);
  fitImage(s, path.join(FIGS, p.fig), 0.8, 1.2, 7.6, 5.2);
  text(s, "WHY IT MATTERS", { x: 9.0, y: 1.5, w: 3.8, h: 0.35, fontSize: 13, bold: true, color: GREY });
  text(s, p.why, { x: 9.0, y: 1.95, w: 3.8, h: 2.7, fontSize: 21, bold: true, color: ORANGE });
  text(s, p.cap, { x: 9.0, y: 4.85, w: 3.8, h: 1.2, fontSize: 12, italic: true });
  text(s, p.ref, { x: 9.0, y: 6.1, w: 3.8, h: 0.35, fontSize: 11, italic: true, color: GREY });
});

// ---- 12-15 what the papers changed in the tool ------------------------------
const dayHour = h => `${Math.floor((h - 1) / 24) + 1} May, ${String((h - 1) % 24).padStart(2, "0")}:00`;
const axisTitle = t => ({ showValAxisTitle: true, valAxisTitle: t, valAxisTitleColor: "BFBFBF", valAxisTitleFontFace: "Poppins", valAxisTitleFontSize: 11 });
const barLabels = { showValue: true, dataLabelPosition: "outEnd", dataLabelColor: "FFFFFF", dataLabelFontSize: 14, dataLabelFontBold: true };

// 12 heat dose (Chen)
{
  const d = R.dose;
  const s = frame("From the papers into the tool · 1 · heat dose (Chen et al. 2024)",
    "oasis/metrics.py heat_dose, baseline room (outputs/baseline, run_mvp.py), power cut 20-21 h. Dose = felt heat index above 27 C, summed hour by hour. Limits 850 / 1,174 C.h from Chen's 7-day Guangzhou outage with no fan; here the fan's cooling is already taken off, so the comparison is indicative.");
  headline(s, `The week's heat dose passes the elderly limit after ${d.hours_to_elderly_limit} hours`);
  const labels = d.running_ch.map((_, i) => `${Math.floor(i / 24) + 1} May`);
  s.addChart(pres.charts.LINE, [
    { name: "Heat dose so far", labels, values: d.running_ch },
    { name: `Elderly limit, ${d.elderly_ch} °C·h`, labels, values: d.running_ch.map(() => d.elderly_ch) },
    { name: `Young adult limit, ${d.young_ch.toLocaleString("en-GB")} °C·h`, labels, values: d.running_ch.map(() => d.young_ch) },
  ], Object.assign({}, CHART, axisTitle("Felt heat above 27 °C, summed (°C·h)"), {
    x: 0.5, y: 2.0, w: 8.4, h: 4.55, chartColors: [H.accent2, "FFFFFF", "8C8C8C"], lineSize: 3, lineDataSymbol: "none",
    valAxisMinVal: 0, valAxisMaxVal: 2800, valAxisMajorUnit: 400, catAxisLabelFrequency: 24,
    showLegend: true, legendPos: "b",
  }));
  stat(s, 9.2, 2.0, 3.5, 1.4, dayHour(d.hours_to_elderly_limit), "elderly limit passed");
  stat(s, 9.2, 3.55, 3.5, 1.4, dayHour(d.hours_to_young_limit), "young adult limit passed");
  stat(s, 9.2, 5.1, 3.5, 1.4, `${Math.round(d.hazard_hours_ch).toLocaleString("en-GB")} °C·h`, "dose over the whole week");
  text(s, "Baseline top-floor room. Limits from a Guangzhou outage with no fan: indicative here.", { x: 0.6, y: 6.65, w: 8.3, h: 0.3, fontSize: 11, italic: true, color: GREY });
}

// 13 outage length
{
  const o = R.outage;
  const s = frame("From the papers into the tool · 2 · outage length (Chen, Shi, Mehraban)",
    "metrics.cut_hours_list + scenario.CUT_LENGTHS. Same simulation re-scored: the cut only takes the fan away. Cut starts at 20:00 every day.");
  headline(s, `One hour without a fan costs little. A week without power leaves ${o[o.length - 1].safe_hours} safe hours`);
  s.addChart(pres.charts.BAR, [{ name: "Safe hours", labels: o.map(r => `${r.label}\n${r.note}`), values: o.map(r => r.safe_hours) }],
    Object.assign({}, CHART, barLabels, axisTitle("Safe hours of 168"), {
      x: 0.5, y: 2.0, w: 8.4, h: 4.55, barDir: "col", barGapWidthPct: 60, chartColors: [H.accent1],
      valAxisMinVal: 0, valAxisMaxVal: 80, valAxisMajorUnit: 20, catAxisLabelFontSize: 12, showLegend: false,
    }));
  stat(s, 9.2, 2.1, 3.5, 1.95, `${o[0].safe_hours} → ${o[2].safe_hours} h`, "safe hours when the fan is off from 20:00 to 06:00 instead of one hour");
  stat(s, 9.2, 4.3, 3.5, 1.95, `${o[o.length - 1].max_heat_index_c.toFixed(0)} °C`, "peak felt heat with no power all week: Chen's limit for core temperature");
  text(s, "Baseline top-floor room, recorded week, daily cut from 20:00", { x: 0.6, y: 6.65, w: 8.3, h: 0.3, fontSize: 11, italic: true, color: GREY });
}

// 14 packages (Wu)
{
  const k = R.packages, g = k.greedy;
  const s = frame("From the papers into the tool · 3 · packages (Wu et al. 2025)",
    "oasis/assess.py greedy_packages: start from the best single change, add the change that reaches most safe hours on top, each step simulated in EnergyPlus.");
  headline(s, "The best pair is not the two best single changes");
  const rows = [...k.singles.map(c => [c.label, c.gain]), [k.naive.label, k.naive.gain], ...g.map(c => [c.label, c.gain])];
  s.addChart(pres.charts.BAR, [{ name: "Safe hours gained", labels: rows.map(r => r[0]), values: rows.map(r => r[1]) }],
    Object.assign({}, CHART, barLabels, {
      x: 0.5, y: 2.0, w: 8.4, h: 4.55, barDir: "bar", barGapWidthPct: 50, chartColors: [H.accent1],
      valAxisMinVal: 0, valAxisMaxVal: 60, valAxisMajorUnit: 10, catAxisLabelFontSize: 11, catAxisOrientation: "maxMin", showLegend: false,
    }));
  stat(s, 9.2, 2.1, 3.5, 1.95, `+${k.naive.gain} h`, `white roof with insulation: less than the white roof alone (+${k.singles[0].gain} h). Insulation holds the night heat in`);
  stat(s, 9.2, 4.3, 3.5, 1.95, `${g[0].safe_hours} h`, `safe hours with ${g[0].label}, from ${k.baseline}`);
  text(s, "Safe hours gained over the baseline room, each bar one EnergyPlus run", { x: 0.6, y: 6.65, w: 8.3, h: 0.3, fontSize: 11, italic: true, color: GREY });
}

// 15 surrogate (Mehraban)
{
  const m = D.surrogate, imp = m.importance_mae_rise_h, e = m.envelope_share_pct;
  const NAMES = { night_vent: "Windows open at night", weather: "Outdoor air case", wwr: "Window size", orientation_deg: "Orientation",
    roof_solar_absorptance: "Roof colour", floor: "Floor level", roof: "Roof build-up", wall: "Walls", occupants: "People",
    shading_depth_m: "Window overhang", length_m: "Room length", height_m: "Ceiling height", width_m: "Room width" };
  const keys = Object.keys(imp).slice(0, 9);
  const s = frame("From the papers into the tool · 4 · the AI step (Mehraban et al. 2025)",
    "train_surrogate.py: XGBoost on three sweeps (4,536 designs) + 1,500 random rooms (run_sample.py); 20 % held out. Importance = rise in safe-hours error when one input is shuffled among the held-out designs.");
  headline(s, "How the windows are used matters most; the roof matters far more than in US homes");
  s.addChart(pres.charts.BAR, [{ name: "Effect on safe hours", labels: keys.map(k => NAMES[k] || k), values: keys.map(k => imp[k]) }],
    Object.assign({}, CHART, barLabels, {
      x: 0.5, y: 2.0, w: 8.4, h: 4.55, barDir: "bar", barGapWidthPct: 45, chartColors: [H.accent1],
      valAxisMinVal: 0, valAxisMaxVal: 28, valAxisMajorUnit: 4, catAxisLabelFontSize: 11, catAxisOrientation: "maxMin", showLegend: false,
      dataLabelFormatCode: "0.0", dataLabelFontSize: 12,
    }));
  stat(s, 9.2, 2.0, 3.5, 1.4, `${Math.round(e.Windows)} / ${Math.round(e.Roof)} / ${Math.round(e.Walls)} %`, "windows / roof / walls. Mehraban: 74 / 1 / 4 %");
  stat(s, 9.2, 3.55, 3.5, 1.4, `${m.by_source["random rooms"].mae_hours.toFixed(1)} h`, `typical error on rooms it has not seen (worst ${m.by_source["random rooms"].max_error_hours.toFixed(0)} h)`);
  stat(s, 9.2, 5.1, 3.5, 1.4, `${m.designs_total.toLocaleString("en-GB")}`, "EnergyPlus runs behind it, three outdoor-air cases");
  text(s, "Hours of safe-hours error added when one input is shuffled. The estimate is shown before a run, never as the result.", { x: 0.6, y: 6.65, w: 8.3, h: 0.3, fontSize: 11, italic: true, color: GREY });
}

// ---- 16 the tool -----------------------------------------------------------
{
  const s = frame("What I build · the OASIS workspace, live EnergyPlus run",
    "Screenshot: frontend v8, Amudha 1BHK sample, airport air, power cut 20-21 h.");
  fitImage(s, path.join(FIGS, "tool_workspace.png"), 0.6, 0.8, 9.55, 5.75);
  text(s, "From a Rhino plan to safe hours in 30 seconds", { x: 10.45, y: 1.3, w: 2.5, h: 2.4, fontSize: 21, bold: true, color: ORANGE });
  text(s, "A 1BHK flat, room by room: 42 safe hours of 168, each person placed by their routine.", { x: 10.45, y: 3.85, w: 2.5, h: 2.2, fontSize: 13, italic: true });
}

// ---- 17 where the home stands ---------------------------------------------
{
  const s = frame("Outdoor air as a scenario · recorded week, power cut 20:00–21:00",
    "outputs/scenarios/results.csv (run_scenarios.py). City centre = measured Nungambakkam offsets; street AC = +1 °C at night, literature upper case.");
  const cases = [["airport", "Airport air\n(measured)"], ["city centre", "City centre air\n(measured)"], ["street", "Street beside AC units\n(+1 °C at night, literature)"]];
  const top = cases.map(c => scen(c[0], "top floor", CUT).safe_hours);
  const mid = cases.map(c => scen(c[0], "middle floor", CUT).safe_hours);
  headline(s, `Where the home stands moves the answer by ${Math.max(...top) - Math.min(...top)} hours`);
  const labels = cases.map(c => c[1]);
  s.addChart(pres.charts.BAR, [
    { name: "Top floor", labels, values: top },
    { name: "Middle floor", labels, values: mid },
  ], Object.assign({}, CHART, {
    x: 0.5, y: 1.95, w: 12.3, h: 4.6, barDir: "col", barGapWidthPct: 60, chartColors: [H.accent1, H.accent3],
    showValue: true, dataLabelPosition: "outEnd", dataLabelColor: "FFFFFF", dataLabelFontSize: 14, dataLabelFontBold: true,
    valAxisMinVal: 0, valAxisMaxVal: 140, valAxisMajorUnit: 20, catAxisLabelFontSize: 12,
    showLegend: true, legendPos: "b", showValAxisTitle: true, valAxisTitle: "Safe hours of 168",
    valAxisTitleColor: "BFBFBF", valAxisTitleFontFace: "Poppins", valAxisTitleFontSize: 11,
  }));
}

// ---- 18 hardest critic -----------------------------------------------------
{
  const s = frame("Hardest critic · the building-physics examiner",
    "outputs/scenarios/results.csv: heatwave alone vs heatwave + cut. Extended heat index: Lu & Romps 2022.");
  text(s, "“Your own model says the power cut costs three safe hours. Why is it in your title?”",
    { x: 0.6, y: 0.85, w: 12.1, h: 1.3, fontSize: 28, bold: true, italic: true, color: ORANGE, valign: "middle" });
  const big = (x, n, unit, cap) => {
    card(s, x, 2.4, 5.9, 2.1, null, GREY);
    text(s, [{ text: n, options: { fontSize: 60, bold: true, color: ORANGE } }, { text: " " + unit, options: { fontSize: 22, bold: true, color: ORANGE } }],
      { x: x + 0.3, y: 2.55, w: 2.5, h: 1.8, valign: "middle" });
    text(s, cap, { x: x + 2.9, y: 2.55, w: 2.8, h: 1.8, fontSize: 14, italic: true, valign: "middle" });
  };
  big(0.6, `${noCut.safe_hours - base.safe_hours}`, "h", `What the nightly cut removes: ${noCut.safe_hours} safe hours without it, ${base.safe_hours} with it`);
  big(6.8, `${base.cut_max_heat_index_c.toFixed(0)}`, "°C", `Felt heat in the cut hour: the week's maximum, above the limit on ${base.nights_cut_in_danger} nights of 7`);
  const measured = recorded.safe_hours_measured_cuts != null
    ? ` With cuts only as often as measured in Chennai: ${Math.round(recorded.safe_hours_measured_cuts)} safe hours.` : "";
  text(s, [{ text: "My answer: ", options: { bold: true, color: ORANGE } }, { text: `the heatwave sets how many hours are dangerous; the cut decides how bad the worst hour is.${measured} A longer outage is another matter: ${R.outage[2].safe_hours} safe hours with no fan through the night, ${R.outage[3].safe_hours} with no power all week.` }],
    { x: 0.6, y: 4.58, w: 12.1, h: 0.85, fontSize: 14, valign: "middle" });
  const more = [
    ["“Calibrated in Dhaka, not Chennai.”", `Evening error ${one(dhaka.evening_err_c)} °C in ${R.dhaka_homes} homes; Chennai loggers planned for 2027.`],
    ["“The result depends on your threshold.”", `${base.safe_hours} safe hours on the NWS heat index, ${base.safe_hours_extended_hi} on the extended one. I keep the cautious one.`],
  ];
  more.forEach(([q, a], i) => {
    const x = 0.6 + i * 6.2;
    text(s, q, { x, y: 5.62, w: 5.9, h: 0.35, fontSize: 13, bold: true });
    text(s, a, { x, y: 5.99, w: 5.6, h: 0.6, fontSize: 12, italic: true, color: GREY });
  });
}

// ---- 19 references ---------------------------------------------------------
{
  const s = frame("References");
  const refs = [
    "Chen, S., Zhao, H., Luo, K., Li, Q., Nie, Z., Zhao, L. (2024). Health risk assessment of residential overheating under the heat waves in Guangzhou. Building and Environment, 266, 112089.",
    "Rajput, M., Augenbroe, G., Stone, B., et al. (2022). Heat exposure during a power outage: a simulation study of residences across the metro Phoenix area. Energy and Buildings, 259, 111605.",
    "Shi, Q., Luo, W., Xiao, C., Wang, J., Zhu, H., Chen, X. (2025). Investigating urban-scale building thermal resilience under compound heat waves and power outage events. Building and Environment, 276, 112747.",
    "Mehraban, M.H. et al. (2025). AI-driven prediction of building energy performance and thermal resilience during power outages. Buildings, 15, 3950.",
    "Wu, Y., Malik, J., Hong, T. et al. (2025). Indoor thermal resilience of cooling shelters for outdoor workers in India. Building Simulation, 18.",
    "Tasgaonkar, P. et al. (2022). Indoor heat measurement data from low-income households in rural and urban South Asia. Scientific Data, 9, 285.",
    "Lu, Y.-C., Romps, D.M. (2022). Extending the heat index. Journal of Applied Meteorology and Climatology, 61(10).",
    "Weather: Meenambakkam and Nungambakkam stations (Meteostat), ERA5 sunlight (Open-Meteo), 1–7 May 2024.",
  ];
  s.addText(refs.map((r, i) => ({ text: r, options: { breakLine: i < refs.length - 1, paraSpaceAfter: 9 } })),
    { isTextBox: true, margin: 0, x: 0.6, y: 1.0, w: 11.6, h: 5.5, fontSize: 12, color: WHITE, valign: "top" });
}

(async () => {
  await pres.writeFile({ fileName: OUTFILE });
  if (process.env.PPTX_SKILL) {
    const { applyTheme } = require(process.env.PPTX_SKILL + "/scripts/apply_theme.js");
    await applyTheme(OUTFILE, THEME);
  } else {
    console.log("PPTX_SKILL not set: theme colours not applied");
  }
  console.log("wrote", OUTFILE);
})();
