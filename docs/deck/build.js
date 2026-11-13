// OASIS 2.0 deck: every number comes from deck_data.json (collect.py), every figure from outputs/.
const fs = require("fs");
const path = require("path");
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const fa = require("react-icons/fa");
const { applyTheme } = require(process.env.PPTX_SKILL + "/scripts/apply_theme.js");

const ROOT = "D:/IAAC/OASIS 2.0";
const OUTFILE = path.join(ROOT, "docs", "OASIS_2.0_progress.pptx");
const D = JSON.parse(fs.readFileSync(path.join(__dirname, "deck_data.json"), "utf8"));

const THEME = {
  name: "OASIS Heat",
  headFontFace: "Cambria",
  bodyFontFace: "Calibri",
  colors: {
    dk1: "1C1B22", lt1: "FFFFFF", dk2: "232634", lt2: "F3F4F6",
    accent1: "E4572E", accent2: "F3A712", accent3: "2A9D8F", accent4: "8D99AE",
    accent5: "9B2226", accent6: "4F5D75", hlink: "2A9D8F", folHlink: "8D99AE",
  },
};
const H = THEME.colors; // hex, for options that need hex
const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = "OASIS 2.0: progress";
pres.author = "OASIS 2.0 (IAAC MAAI 2026/27)";
const C = pres.SchemeColor;
const SAFE = C.accent3, HEAT = C.accent1, AMBER = C.accent2, DANGER = C.accent5, SLATE = C.accent6, MUTED = C.accent4;

// ---------- helpers ----------
async function icon(Comp, hex, px = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(Comp, { color: "#" + hex, size: px }));
  const buf = await sharp(Buffer.from(svg)).resize(px, px).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}
const sc = (s, d = 0) => (s == null ? "–" : Number(s).toFixed(d));
const find = (arr, f) => arr.find(f);
let n = 0;
const oname = (s) => `${s}_${++n}`;

// ---------- layouts ----------
const FOOT = { x: 0.6, y: 7.0, w: 9, h: 0.3, fontSize: 10, color: C.accent4, fontFace: "Calibri" };
pres.defineSlideMaster({
  title: "TITLE_DARK",
  background: { color: H.dk2 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 2.2, w: 11.7, h: 1.6, fontFace: "Cambria", fontSize: 54, bold: true, color: C.background1, valign: "bottom", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.8, y: 3.95, w: 11.0, h: 1.2, fontFace: "Calibri", fontSize: 22, color: C.accent2, valign: "top", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "SECTION",
  background: { color: H.dk2 },
  objects: [
    { placeholder: { options: { name: "num", type: "body", x: 0.8, y: 2.3, w: 3, h: 0.8, fontFace: "Calibri", fontSize: 20, bold: true, color: C.accent2, margin: 0 }, text: "" } },
    { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 3.0, w: 11.5, h: 1.2, fontFace: "Cambria", fontSize: 44, bold: true, color: C.background1, margin: 0, valign: "top", align: "left" }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.8, y: 4.3, w: 10.5, h: 1.0, fontFace: "Calibri", fontSize: 18, color: C.accent4, margin: 0, valign: "top" }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "CONTENT",
  background: { color: H.lt1 },
  margin: [0.4, 0.6, 0.6, 0.6],
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.35, w: 12.1, h: 0.85, fontFace: "Cambria", fontSize: 32, bold: true, color: C.text2, valign: "middle", align: "left", margin: 0 }, text: "" } },
    { text: { text: "OASIS 2.0 · safe hours in Chennai flats · IAAC MAAI 2026/27", options: FOOT } },
  ],
  slideNumber: { x: 12.2, y: 7.0, w: 0.6, h: 0.3, fontSize: 10, color: H.accent4, align: "right" },
});

function content(title, section) {
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: section });
  s.addText(title, { placeholder: "title" });
  return s;
}
function section(num, title, sub, sec) {
  pres.addSection({ title: sec });
  const s = pres.addSlide({ masterName: "SECTION", sectionTitle: sec });
  s.addText(num, { placeholder: "num" });
  s.addText(title, { placeholder: "title" });
  s.addText(sub, { placeholder: "body" });
  return s;
}
function card(s, x, y, w, h, fill = C.background2) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: fill }, line: { color: fill, width: 0 }, objectName: oname("card") });
}
function iconDot(s, data, x, y, d = 0.62, fill = HEAT) {
  s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill, width: 0 }, objectName: oname("icon_circle") });
  s.addImage({ data, x: x + d * 0.22, y: y + d * 0.22, w: d * 0.56, h: d * 0.56, objectName: oname("icon") });
}
function txt(s, text, o) { s.addText(text, Object.assign({ isTextBox: true, margin: 0, fontSize: 16, color: C.text1, valign: "top" }, o, { objectName: oname(o.name || "text") })); }
function stat(s, x, y, w, big, label, color = HEAT, bigSize = 54) {
  txt(s, big, { x, y, w, h: 1.0, fontSize: bigSize, bold: true, color, fontFace: "Cambria", valign: "bottom" });
  txt(s, label, { x, y: y + 1.08, w, h: 0.75, fontSize: 14, color: C.text2 });
}
function arrow(s, x, y, w, h = 0, color = H.accent4) {
  s.addShape(pres.shapes.LINE, { x, y, w, h, line: { color, width: 2, endArrowType: "triangle" }, objectName: oname("arrow") });
}
const chartText = { catAxisLabelFontFace: "+mn-lt", valAxisLabelFontFace: "+mn-lt", dataLabelFontFace: "+mn-lt", legendFontFace: "+mn-lt", titleFontFace: "+mn-lt",
  catAxisLabelColor: H.dk2, valAxisLabelColor: H.accent4, catAxisLabelFontSize: 12, valAxisLabelFontSize: 11, dataLabelFontSize: 12, legendFontSize: 12,
  valGridLine: { color: "E5E7EB", size: 0.75 }, catGridLine: { style: "none" }, titleColor: H.dk2, titleFontSize: 14 };

(async () => {
  const I = {};
  const want = { therm: fa.FaThermometerHalf, bolt: fa.FaBolt, snow: fa.FaSnowflake, wind: fa.FaWind, home: fa.FaHome, sun: fa.FaSun,
    chart: fa.FaChartBar, cogs: fa.FaCogs, db: fa.FaDatabase, code: fa.FaLaptopCode, fan: fa.FaFan, brain: fa.FaBrain, check: fa.FaCheck,
    flask: fa.FaFlask, city: fa.FaCity, users: fa.FaUsers, warn: fa.FaExclamationTriangle, plug: fa.FaPlug, cube: fa.FaCube, cloud: fa.FaCloudSun,
    clock: fa.FaClock, ruler: fa.FaRulerCombined, globe: fa.FaGlobeAsia, list: fa.FaListOl, search: fa.FaSearch, map: fa.FaMapMarkerAlt };
  for (const [k, v] of Object.entries(want)) I[k] = await icon(v, "FFFFFF");
  I.heatDark = await icon(fa.FaThermometerFull, H.accent1);

  // numbers
  const hw = D.heatwave;
  const recTop = find(hw, (r) => r.weather.startsWith("recorded") && r.design === "top floor");
  const recMid = find(hw, (r) => r.weather.startsWith("recorded") && r.design === "middle floor");
  const typTop = find(hw, (r) => r.weather.startsWith("typical") && r.design === "top floor");
  const typMid = find(hw, (r) => r.weather.startsWith("typical") && r.design === "middle floor");
  const W = D.weather;
  const S = D.scenarios;
  const cuts = [...new Set(S.map((r) => r.power_cut))];
  const weathers = [...new Set(S.map((r) => r.weather))];
  const scv = (w, dsg, c) => find(S, (r) => r.weather === w && r.design === dsg && r.power_cut === c);
  const peakHour = D.scenarios_meta.peak_heat_hour;
  const ev = D.evidence;
  const cal = D.calibration;
  const sur = D.surrogate;
  const base = D.baseline;

  // ================= 1. Title =================
  pres.addSection({ title: "Opening" });
  let s = pres.addSlide({ masterName: "TITLE_DARK", sectionTitle: "Opening" });
  s.addText("OASIS 2.0", { placeholder: "title" });
  s.addText("Overheating Assessment System for Intervention Strategies: safe hours in Chennai flats during a heatwave and an evening power cut", { placeholder: "body" });
  txt(s, "Progress report · MVP: proving the research problem with measured inputs · November 2026", { x: 0.8, y: 6.3, w: 11, h: 0.4, fontSize: 14, color: C.accent4 });
  s.addImage({ data: await icon(fa.FaThermometerFull, H.accent1, 512), x: 11.3, y: 0.9, w: 1.2, h: 1.2, objectName: "title_icon" });
  s.addNotes("OASIS asks one question: how many hours of a heatwave week is a free-running Chennai flat safe to be in, when the evening power cut switches the fans off? This deck covers the tool, the workflow, what we assume and measure, and the numbers so far.");

  // ================= 2. The problem in one week =================
  s = content("One recorded heatwave week: unsafe most of the time", "Opening");
  const outOver = recTop.outdoor_hours_over_limit;
  stat(s, 0.6, 1.5, 2.9, `${recTop.safe_hours}/168`, "safe hours on the top floor, 1–7 May 2024 (windows open, fan on)", HEAT);
  stat(s, 3.7, 1.5, 2.9, `${recTop.nights_cut_in_danger}/7`, "evenings where the 20–21 h power cut is in danger", DANGER);
  stat(s, 6.8, 1.5, 2.9, `${sc(recTop.cut_max_heat_index_c)} °C`, "highest felt heat (heat index) in the power-cut hour", HEAT);
  stat(s, 9.9, 1.5, 2.9, `${typTop.safe_hours}`, "safe hours the same flat gets in the TMYx “typical year” week", SAFE);
  card(s, 0.6, 3.75, 12.1, 2.4);
  iconDot(s, I.warn, 0.9, 4.05, 0.7, DANGER);
  txt(s, "What this means", { x: 1.85, y: 4.05, w: 10.5, h: 0.4, fontSize: 20, bold: true, color: C.text2 });
  txt(s, [
    { text: `Outdoors, the heat index was at or above 41 °C for ${outOver} of 168 hours: the danger is in the weather itself, not only the building.`, options: { bullet: true, breakLine: true } },
    { text: `A typical-year weather file hides it: the same flat is safe ${typTop.safe_hours} h on TMYx, ${recTop.safe_hours} h on the recorded week.`, options: { bullet: true, breakLine: true } },
    { text: `The middle floor is better (${recMid.safe_hours} h) but the cut hour is still in danger ${recMid.nights_cut_in_danger} of 7 evenings.`, options: { bullet: true } },
  ], { x: 1.85, y: 4.55, w: 10.6, h: 1.5, fontSize: 16, paraSpaceAfter: 6 });
  s.addNotes("These are the headline numbers. All of them come from EnergyPlus runs on measured Chennai weather, with the building calibrated on measured homes. The typical-year file has the same air temperature but is much drier, so the heat index is about 9 °C lower.");

  // ================= 3. The AC loop =================
  s = content("Why it gets worse: the air-conditioning loop", "Opening");
  const loop = [
    [I.sun, "Heatwave", "1–7 May 2024: mean outdoor heat index " + sc(W.recorded.mean_heat_index_c, 1) + " °C", HEAT],
    [I.snow, "More AC use", "Indian homes run ACs 5–7 h a day, mostly 22:00–06:00 (CEEW)", SLATE],
    [I.plug, "Grid peak", "Tamil Nadu all-time record 20,830 MW on 2 May 2024, inside this week", AMBER],
    [I.bolt, "Power cuts", "Load shedding and overloaded transformers: fans stop", DANGER],
  ];
  loop.forEach(([ic, h, b, col], i) => {
    const x = 0.6 + i * 3.1;
    card(s, x, 1.55, 2.75, 2.25);
    iconDot(s, ic, x + 0.25, 1.75, 0.62, col);
    txt(s, h, { x: x + 0.25, y: 2.5, w: 2.3, h: 0.4, fontSize: 18, bold: true, color: C.text2 });
    txt(s, b, { x: x + 0.25, y: 2.92, w: 2.3, h: 0.85, fontSize: 13, color: C.text1 });
    if (i < 3) arrow(s, x + 2.78, 2.67, 0.29);
  });
  // second chain
  arrow(s, 4.97, 3.85, 0, 0.55);
  card(s, 3.7, 4.45, 2.75, 1.25, "FDECE7");
  txt(s, "AC waste heat", { x: 3.95, y: 4.6, w: 2.3, h: 0.35, fontSize: 16, bold: true, color: C.accent5 });
  txt(s, "+0.5 to +2 °C street air at night (Paris, Phoenix, Tokyo)", { x: 3.95, y: 4.97, w: 2.35, h: 0.7, fontSize: 12 });
  arrow(s, 6.5, 5.07, 0.6);
  arrow(s, 11.12, 3.85, 0, 0.6);
  card(s, 7.2, 4.45, 5.5, 2.25, H.dk2);
  iconDot(s, I.home, 7.45, 4.65, 0.62, HEAT);
  txt(s, "The free-running flat next door", { x: 8.25, y: 4.7, w: 4.3, h: 0.5, fontSize: 18, bold: true, color: C.background1 });
  txt(s, "Windows open day and night: it breathes the warmer air, and loses its fan in the evening, when the concrete roof is still releasing the day's heat.", { x: 7.45, y: 5.4, w: 5.0, h: 1.2, fontSize: 14, color: C.background1 });
  txt(s, "OASIS models the two arrows that reach the flat: hotter outdoor air (AC heat scenario) and the fan-off hour (power cut).", { x: 0.6, y: 5.95, w: 6.2, h: 0.75, fontSize: 13, italic: true, color: C.accent6 });
  s.addNotes("The user's field observation: most neighbours have ACs. Running them at peak hours drives grid demand (and so power cuts) and dumps heat into the street. Research: Salamanca et al. 2014 (Phoenix, >1 °C at night), de Munck et al. 2013 (Paris, +0.5/+1/+2 °C), Ohashi et al. 2007 (Tokyo, +1–2 °C). The TN record demand of 2 May 2024 is from DT Next reporting.");

  // ================= 4. MVP question =================
  s = content("What the MVP sets out to prove", "Opening");
  card(s, 0.6, 1.5, 12.1, 1.3, H.dk2);
  txt(s, "Research question", { x: 0.9, y: 1.62, w: 6, h: 0.35, fontSize: 14, bold: true, color: C.accent2 });
  txt(s, "Does a free-running Chennai flat stay safe through a real heatwave with an evening power cut, using measured inputs instead of assumptions?", { x: 0.9, y: 1.98, w: 11.5, h: 0.75, fontSize: 19, color: C.background1, fontFace: "Cambria" });
  const claims = [
    [I.search, "1 · The problem shows up in measured homes", "Logger data from Dhaka and Delhi: concrete top-floor homes are hottest in the evening, when the cut falls.", SLATE],
    [I.ruler, "2 · The model reproduces those homes", "Calibrated on 12 Dhaka homes, checked on Delhi: right temperature at the cut hour.", SAFE],
    [I.cloud, "3 · Real weather, not a typical year", "The hottest recorded Chennai week (station + reanalysis sun), picked by the data.", HEAT],
  ];
  claims.forEach(([ic, h, b, col], i) => {
    const x = 0.6 + i * 4.1;
    card(s, x, 3.15, 3.8, 3.4);
    iconDot(s, ic, x + 0.3, 3.4, 0.7, col);
    txt(s, h, { x: x + 0.3, y: 4.25, w: 3.25, h: 0.8, fontSize: 17, bold: true, color: C.text2 });
    txt(s, b, { x: x + 0.3, y: 5.1, w: 3.25, h: 1.3, fontSize: 14 });
  });
  s.addNotes("Re-scope agreed in November 2026: the MVP is not about ranking interventions yet. It must show the problem exists, with true values. Interventions are still computed (later slides) but are secondary.");

  // ================= Section: workflow =================
  section("01", "Workflow and the tool", "From weather and a floor plan to safe hours and ranked design changes", "Workflow");

  // ================= 6. Pipeline =================
  s = content("The workflow: from weather to safe hours", "Workflow");
  const steps = [
    [I.cloud, "Weather", "Meenambakkam station hourly + ERA5 sunlight → .epw", HEAT],
    [I.cube, "Flat model", "eppy builds the IDF: geometry, walls, roof, windows (Rhino .3dm or form)", SLATE],
    [I.cogs, "EnergyPlus 26.2", "AirflowNetwork, 14 days: 7 spin-up + 7 scored", SLATE],
    [I.therm, "Felt heat", "Heat index of indoor air; fan cooling (ASHRAE 55) except in the cut", AMBER],
    [I.check, "Safe hours", "Hours of 168 with heat index < 41 °C", SAFE],
  ];
  steps.forEach(([ic, h, b, col], i) => {
    const x = 0.6 + i * 2.48;
    card(s, x, 1.5, 2.2, 2.75);
    iconDot(s, ic, x + 0.22, 1.7, 0.62, col);
    txt(s, h, { x: x + 0.22, y: 2.45, w: 1.85, h: 0.4, fontSize: 17, bold: true, color: C.text2 });
    txt(s, b, { x: x + 0.22, y: 2.88, w: 1.85, h: 1.3, fontSize: 12.5 });
    if (i < 4) arrow(s, x + 2.22, 2.88, 0.24);
  });
  const steps2 = [
    [I.list, "Ranked changes", "Re-simulate each single change (roof colour, insulation, walls, shading, windows)"],
    [I.db, `Sweep: ${D.sweep.designs.toLocaleString("en")} designs`, "Every combination simulated once, stored"],
    [I.brain, "XGBoost surrogate", `R² ${sur.r2}, mean error ${sur.mae_hours} h on held-out designs`],
    [I.code, "Three front ends", "Static HTML tool · Streamlit app · FastAPI web tool with 3D plan"],
  ];
  steps2.forEach(([ic, h, b], i) => {
    const x = 0.6 + i * 3.1;
    card(s, x, 4.65, 2.8, 2.05, "EEF2F7");
    iconDot(s, ic, x + 0.22, 4.85, 0.55, SLATE);
    txt(s, h, { x: x + 0.9, y: 4.88, w: 1.8, h: 0.55, fontSize: 15, bold: true, color: C.text2, valign: "middle" });
    txt(s, b, { x: x + 0.22, y: 5.55, w: 2.4, h: 1.05, fontSize: 12.5 });
    if (i < 3) arrow(s, x + 2.82, 5.67, 0.26);
  });
  s.addNotes("Top row: one assessment. Bottom row: how the tool scales. The calibration scripts (Dhaka/Delhi loggers) feed the defaults of the flat model.");

  // ================= 7. Safe hours illustration (heat strip) =================
  s = content("What a safe hour is: the baseline week, hour by hour", "Workflow");
  const strip = D.strip;
  const cw = 0.4, ch = 0.5, x0 = 1.55, y0 = 1.75;
  const colourOf = (v) => (v < 36 ? "BFE3DE" : v < 41 ? "7CC4B8" : v < 45 ? "F7C873" : v < 49 ? "EE8A5B" : "B8322A");
  for (let dday = 0; dday < 7; dday++) {
    txt(s, `${dday + 1} May`, { x: 0.6, y: y0 + dday * ch + 0.1, w: 0.9, h: 0.3, fontSize: 12, color: C.accent6 });
    for (let hr = 0; hr < 24; hr++) {
      const v = strip[dday * 24 + hr];
      s.addShape(pres.shapes.RECTANGLE, { x: x0 + hr * cw, y: y0 + dday * ch, w: cw - 0.03, h: ch - 0.04, fill: { color: colourOf(v) }, line: { color: "FFFFFF", width: 0 }, objectName: oname("cell") });
    }
  }
  for (let hr = 0; hr < 24; hr += 3) txt(s, `${String(hr).padStart(2, "0")}:00`, { x: x0 + hr * cw - 0.1, y: y0 + 7 * ch + 0.05, w: 0.7, h: 0.3, fontSize: 11, color: C.accent6 });
  s.addShape(pres.shapes.RECTANGLE, { x: x0 + 20 * cw - 0.03, y: y0 - 0.06, w: cw + 0.03, h: 7 * ch + 0.08, fill: { type: "none" }, line: { color: H.dk2, width: 2.25 }, objectName: "cut_frame" });
  txt(s, "power cut 20–21 h", { x: x0 + 20 * cw - 0.7, y: y0 - 0.4, w: 1.8, h: 0.3, fontSize: 12, bold: true, color: C.text2, align: "center" });
  const leg = [["< 36 (safe)", "BFE3DE"], ["36–41 (safe)", "7CC4B8"], ["41–45", "F7C873"], ["45–49", "EE8A5B"], ["≥ 49 °C", "B8322A"]];
  leg.forEach(([l, col], i) => {
    s.addShape(pres.shapes.RECTANGLE, { x: x0 + i * 1.9, y: 5.85, w: 0.3, h: 0.3, fill: { color: col }, line: { color: col, width: 0 }, objectName: oname("legend") });
    txt(s, l, { x: x0 + i * 1.9 + 0.38, y: 5.87, w: 1.4, h: 0.3, fontSize: 12, color: C.text2 });
  });
  txt(s, "Felt heat (heat index, fan credit applied except in the cut) — top floor, windows open, recorded heatwave", { x: x0, y: 6.3, w: 9.6, h: 0.3, fontSize: 12, italic: true, color: C.accent6 });
  card(s, 11.35, 1.65, 1.75, 4.55, H.dk2);
  txt(s, `${base.safe_hours}`, { x: 11.35, y: 1.9, w: 1.75, h: 0.9, fontSize: 48, bold: true, color: C.accent2, align: "center", fontFace: "Cambria" });
  txt(s, "safe hours of 168", { x: 11.45, y: 2.85, w: 1.55, h: 0.6, fontSize: 13, color: C.background1, align: "center" });
  txt(s, "Safe = heat index below 41 °C (NWS “Danger” band). Fan on: about 2 °C cooler felt. Cut: no fan.", { x: 11.5, y: 3.6, w: 1.45, h: 2.5, fontSize: 11.5, color: C.background1 });
  s.addNotes("Each cell is one simulated hour. The definition of a safe hour is the one chosen threshold in OASIS: heat index under 41 °C. The fan's cooling effect is computed every hour with the ASHRAE 55 SET method (0.4 m/s, 1.1 met, 0.5 clo).");

  // ================= 8. What we consider =================
  s = content("What the numbers rest on", "Workflow");
  const tag = (t) => ({ Measured: H.accent3, Observed: H.accent3, Calibrated: H.accent6, Chosen: H.accent2, Literature: H.accent1, Standard: H.accent4 }[t]);
  const rows = [
    ["Outdoor weather", "1–7 May 2024, hourly, 7 spin-up days before", "Meenambakkam WMO 43279 + ERA5 sunlight", "Measured"],
    ["Building physics", "Internal mass 320 m², appliances 100 W, wall leakage 8 cm²/m²", "Fitted on 12 Dhaka homes, checked on Delhi", "Calibrated"],
    ["Window use", "Open day and night", "Field knowledge; all calibration homes", "Observed"],
    ["Ceiling fan", "Cooling effect ~2 °C (0.4 m/s)", "ASHRAE 55-2023 SET, every hour", "Standard"],
    ["Power cut", "20:00–21:00 nightly, fan off", "Scenario; also tested at the hottest hour", "Chosen"],
    ["Safe limit", "Heat index < 41 °C", "NWS “Danger” band", "Chosen"],
    ["Neighbours' AC heat", "+1 °C at night (+2 °C doubled)", "Salamanca 2014, de Munck 2013, Ohashi 2007", "Literature"],
  ];
  const hdr = ["Input", "Value used", "Source", "Type"].map((t) => ({ text: t, options: { bold: true, color: H.lt1, fill: { color: H.dk2 }, fontSize: 13 } }));
  const body = rows.map((r) => [
    { text: r[0], options: { bold: true, color: H.dk2 } }, { text: r[1] }, { text: r[2], options: { color: H.accent6 } },
    { text: r[3], options: { bold: true, color: tag(r[3]) } }]);
  s.addTable([hdr, ...body], { x: 0.6, y: 1.5, w: 12.1, colW: [2.3, 4.2, 4.1, 1.5], fontFace: "Calibri", fontSize: 13, color: H.dk1,
    border: { type: "solid", pt: 0.75, color: "E5E7EB" }, rowH: 0.56, valign: "middle", fill: { color: H.lt1 }, objectName: "inputs_table" });
  txt(s, "Every “Chosen” and “Literature” input is labelled in the outputs; the headline uses measured weather without the AC heat.", { x: 0.6, y: 6.35, w: 12, h: 0.4, fontSize: 13, italic: true, color: C.accent6 });
  s.addNotes("This is the assumption register. The user's preference: prefer measured inputs and flag every assumption that drives a result. The only literature-based input is the AC heat, kept as a scenario.");

  // ================= Section: evidence =================
  section("02", "Evidence and calibration", "Measured homes first, then a model that reproduces them", "Evidence");

  // ================= 10. Measured evidence =================
  s = content("Measured homes: the roof's heat arrives in the evening", "Evidence");
  s.addImage({ path: path.join(ROOT, "outputs/evidence/measured_daily_profile.png"), x: 0.6, y: 1.4, w: 8.4, h: 2.8, objectName: "measured_profile" });
  const dRoof = ev.measured_by_roof.find((r) => r.city === "Dhaka" && r.group.startsWith("Concrete"));
  const deRoof = ev.measured_by_roof.find((r) => r.city === "Delhi" && r.group.startsWith("Concrete"));
  const mhi = (D.measured_hi || []).filter((r) => r.city === "Dhaka" && r.logger !== "outdoor station");
  const mOut = (D.measured_hi || []).find((r) => r.city === "Dhaka" && r.logger === "outdoor station");
  const lo = Math.min(...mhi.map((r) => r.share_days_cut_over_limit_pct)), hi = Math.max(...mhi.map((r) => r.share_days_cut_over_limit_pct));
  card(s, 9.3, 1.4, 3.4, 5.3, H.dk2);
  txt(s, `${dRoof.peak_hour.toFixed(0)}:00 / ${deRoof.peak_hour.toFixed(0)}:00`, { x: 9.55, y: 1.6, w: 3.0, h: 0.6, fontSize: 30, bold: true, color: C.accent2, fontFace: "Cambria" });
  txt(s, "indoor peak, concrete top floors (Dhaka / Delhi) vs 13:00 outdoors", { x: 9.55, y: 2.2, w: 3.0, h: 0.6, fontSize: 12.5, color: C.background1 });
  txt(s, `+${dRoof.excess_cut_c} / +${deRoof.excess_cut_c} °C`, { x: 9.55, y: 3.0, w: 3.0, h: 0.6, fontSize: 30, bold: true, color: C.accent2, fontFace: "Cambria" });
  txt(s, "indoor above outdoor at 20:00, when the cut starts", { x: 9.55, y: 3.6, w: 3.0, h: 0.6, fontSize: 12.5, color: C.background1 });
  txt(s, `${lo.toFixed(0)}–${hi.toFixed(0)} %`, { x: 9.55, y: 4.4, w: 3.0, h: 0.6, fontSize: 30, bold: true, color: C.accent2, fontFace: "Cambria" });
  txt(s, `of days with heat index ≥ 41 °C at 20:00 indoors (Dhaka, ${mhi.length} homes with humidity loggers) vs ${mOut ? mOut.share_days_cut_over_limit_pct : "–"} % outdoors`, { x: 9.55, y: 5.0, w: 3.0, h: 1.3, fontSize: 12.5, color: C.background1 });
  txt(s, [
    { text: "Data: Tasgaonkar et al. 2022 indoor loggers, pre-monsoon 2016, free-running homes.", options: { bullet: true, breakLine: true } },
    { text: "Tin roofs peak at midday and cool fast; concrete roofs store the heat and peak 4–5 h after outdoors.", options: { bullet: true, breakLine: true } },
    { text: "So the evening power cut falls on the hottest indoor hours, not the outdoor peak.", options: { bullet: true } },
  ], { x: 0.6, y: 4.45, w: 8.4, h: 2.2, fontSize: 15, paraSpaceAfter: 6 });
  s.addNotes("This is the evidence that the problem exists in the real world before any model: measured indoor air in free-running homes.");

  // ================= 11. Calibration =================
  s = content("Calibrated model: right temperature at the cut hour", "Evidence");
  s.addImage({ path: path.join(ROOT, "outputs/evidence/model_vs_measured_profile.png"), x: 0.6, y: 1.4, w: 8.4, h: 2.8, objectName: "model_vs_measured" });
  const dg = ev.groups.Dhaka, dl = ev.groups.Delhi;
  const ad = cal && cal.adopted_scores ? cal.adopted_scores : null;
  const calStats = [
    [ad ? `${sc(ad.fit_rmse, 2)} °C` : "1.10 °C", "RMSE, 12 Dhaka homes (fit period)"],
    [ad ? `${sc(ad.check_rmse, 2)} °C` : "1.05 °C", "RMSE, check period (not fitted)"],
    [`${dg.evening_err_c > 0 ? "+" : ""}${dg.evening_err_c} °C`, "Dhaka evening error 19–22 h"],
    [`${dg.excess_cut_sim_c} vs ${dg.excess_cut_meas_c}`, "°C above outdoor at 20:00, model vs measured"],
  ];
  calStats.forEach(([b, l], i) => {
    const x = 9.3 + (i % 2) * 1.75, y = 1.4 + Math.floor(i / 2) * 1.6;
    card(s, x, y, 1.6, 1.45);
    txt(s, b, { x: x + 0.12, y: y + 0.12, w: 1.4, h: 0.5, fontSize: 18, bold: true, color: C.accent3, fontFace: "Cambria" });
    txt(s, l, { x: x + 0.12, y: y + 0.65, w: 1.4, h: 0.75, fontSize: 11 });
  });
  txt(s, [
    { text: "Calibration round 4 (adopted): AirflowNetwork, one model per surveyed home, 1,440 runs.", options: { bullet: true, breakLine: true } },
    { text: `Known gap: the model peaks about ${dg.peak_lag_h_mean} h early (${dg.peak_sim_median}:00 vs ${dg.peak_meas_median}:00); the cut hour is still right in Dhaka.`, options: { bullet: true, breakLine: true } },
    { text: `Delhi (3 homes, hot-dry): evening ${dl.evening_err_c} °C too cool, so the model understates the problem there.`, options: { bullet: true } },
  ], { x: 0.6, y: 4.45, w: 8.4, h: 2.2, fontSize: 15, paraSpaceAfter: 6 });
  txt(s, "Window-timing variants tested: none fixed the lag without hurting the rest; kept as a stated limitation.", { x: 9.3, y: 4.75, w: 3.4, h: 1.8, fontSize: 12.5, italic: true, color: C.accent6 });
  s.addNotes("Calibrated settings are the defaults in oasis/build_idf.py. The lag test (check_lag.py) showed the 06:00 window opening is not the cause; the 2027 Chennai field campaign will log window times.");

  // ================= 12. Weather =================
  s = content("Real weather: far more humid than a typical year", "Evidence");
  s.addChart(pres.charts.BAR, [
    { name: "Typical year (TMYx 10–16 May)", labels: ["Mean heat index (°C)", "Mean air temp (°C)", "Mean humidity (%)"], values: [W.typical.mean_heat_index_c, W.typical.mean_temp_c, W.typical.mean_rh_pct] },
    { name: "Recorded 1–7 May 2024", labels: ["Mean heat index (°C)", "Mean air temp (°C)", "Mean humidity (%)"], values: [W.recorded.mean_heat_index_c, W.recorded.mean_temp_c, W.recorded.mean_rh_pct] },
  ], Object.assign({ x: 0.6, y: 1.45, w: 7.4, h: 5.2, barDir: "col", barGrouping: "clustered", chartColors: [H.accent4, H.accent1], showValue: true, dataLabelPosition: "outEnd", dataLabelFormatCode: "0.0",
    showLegend: true, legendPos: "b", valAxisMinVal: 0, showTitle: true, title: "Outdoor conditions, scored week" }, chartText));
  card(s, 8.4, 1.45, 4.3, 5.2);
  txt(s, "Where the weather comes from", { x: 8.7, y: 1.65, w: 3.8, h: 0.4, fontSize: 18, bold: true, color: C.text2 });
  txt(s, [
    { text: `Air temperature, humidity, wind, pressure: Chennai Meenambakkam airport (WMO 43279), ${W.hours_from_station}/${W.hours_needed} hours measured.`, options: { bullet: true, breakLine: true } },
    { text: "Sunlight: ERA5 reanalysis (the station does not measure it), split into direct and diffuse.", options: { bullet: true, breakLine: true } },
    { text: `Week picked by the data: the 7 days with the highest mean heat index, April–June 2016–2025 (${W.ranking.length} years ranked).`, options: { bullet: true, breakLine: true } },
    { text: `Station − ERA5: ${W.bias.temp_bias_c > 0 ? "+" : ""}${W.bias.temp_bias_c} °C, ${W.bias.rh_bias_pct > 0 ? "+" : ""}${W.bias.rh_bias_pct} % humidity.`, options: { bullet: true } },
  ], { x: 8.7, y: 2.15, w: 3.8, h: 4.3, fontSize: 13.5, paraSpaceAfter: 6 });
  s.addNotes("Same air temperature, much higher humidity: the TMYx file is stitched from different years and smooths out humid spells. The heat index responds strongly to humidity.");

  // ================= Section: results =================
  section("03", "Results", "Recorded heatwave, power-cut cases and neighbours' AC heat (full re-run on measured weather)", "Results");

  // ================= 14. Headline chart =================
  s = content("The typical-year file hides the heatwave", "Results");
  s.addChart(pres.charts.BAR, [
    { name: "Typical year (TMYx)", labels: ["Top floor", "Middle floor"], values: [typTop.safe_hours, typMid.safe_hours] },
    { name: "Recorded heatwave 2024", labels: ["Top floor", "Middle floor"], values: [recTop.safe_hours, recMid.safe_hours] },
  ], Object.assign({ x: 0.6, y: 1.45, w: 7.6, h: 5.2, barDir: "col", barGrouping: "clustered", chartColors: [H.accent4, H.accent1], showValue: true, dataLabelPosition: "outEnd",
    showLegend: true, legendPos: "b", valAxisMinVal: 0, valAxisMaxVal: 168, valAxisMajorUnit: 42, showTitle: true, title: "Safe hours of 168, windows open, power cut 20–21 h" }, chartText));
  stat(s, 8.6, 1.5, 4.1, `−${typTop.safe_hours - recTop.safe_hours} h`, "safe hours lost on the top floor when the real week replaces the typical year", HEAT);
  stat(s, 8.6, 3.4, 4.1, `${recTop.danger_hours} h`, `in danger on the top floor; worst felt heat ${recTop.max_heat_index_c} °C`, DANGER);
  txt(s, "Both weeks run with 7 spin-up days so the concrete starts warm. Same building, same scoring.", { x: 8.6, y: 5.6, w: 4.1, h: 1.0, fontSize: 13, italic: true, color: C.accent6 });
  s.addNotes("run_heatwave.py. This is the clearest single result for the MVP: with true weather the problem is severe; with a typical-year file it nearly disappears.");

  // ================= 15. Scenarios =================
  s = content("Power-cut cases and neighbours' AC heat, top floor", "Results");
  const shortW = (w) => (w.startsWith("measured") ? "Measured air" : w.includes("doubled") ? "+ AC heat doubled (+2 °C night)" : "+ neighbours' AC heat (+1 °C night)");
  const shortC = (c) => (c.startsWith("heatwave +") ? "Heatwave + cut 20–21 h" : c.startsWith("heatwave alone") ? "Heatwave alone (no cut)" : `Cut at peak heat (${String(peakHour).padStart(2, "0")}–${String(peakHour + 1).padStart(2, "0")} h)`);
  s.addChart(pres.charts.BAR, weathers.map((w) => ({ name: shortW(w), labels: cuts.map(shortC), values: cuts.map((c) => scv(w, "top floor", c).safe_hours) })),
    Object.assign({ x: 0.6, y: 1.45, w: 7.8, h: 5.2, barDir: "col", barGrouping: "clustered", chartColors: [H.accent4, H.accent2, H.accent5], showValue: true, dataLabelPosition: "outEnd",
      showLegend: true, legendPos: "b", valAxisMinVal: 0, valAxisMaxVal: 100, valAxisMajorUnit: 20, showTitle: true, title: "Safe hours of 168, top floor, recorded heatwave" }, chartText));
  const m0 = weathers[0], m1 = weathers[1];
  const tc = (w, c) => scv(w, "top floor", c);
  const nightLoss = tc(m0, cuts[0]).night_safe_hours_22_06 - tc(m1, cuts[0]).night_safe_hours_22_06;
  const ins = [
    [I.sun, "The heatwave is the main driver", `Fans on every hour: still only ${tc(m0, cuts[1]).safe_hours} safe hours. The cut adds ${tc(m0, cuts[1]).safe_hours - tc(m0, cuts[0]).safe_hours} more unsafe hours.`, HEAT],
    [I.bolt, "A cut at peak heat is the most intense", `Felt heat reaches ${tc(m0, cuts[2]).cut_max_heat_index_c} °C at ${String(peakHour).padStart(2, "0")}:00, vs ${tc(m0, cuts[0]).cut_max_heat_index_c} °C in the evening cut.`, DANGER],
    [I.snow, "Neighbours' ACs cost the most after weather", `+1 °C at night: ${tc(m0, cuts[0]).safe_hours} → ${tc(m1, cuts[0]).safe_hours} safe hours; ${nightLoss} fewer safe sleeping hours (22–06 h).`, SLATE],
  ];
  ins.forEach(([ic, h, b, col], i) => {
    const y = 1.45 + i * 1.75;
    card(s, 8.75, y, 3.95, 1.6);
    iconDot(s, ic, 8.95, y + 0.2, 0.55, col);
    txt(s, h, { x: 9.65, y: y + 0.18, w: 2.95, h: 0.6, fontSize: 14.5, bold: true, color: C.text2 });
    txt(s, b, { x: 9.65, y: y + 0.78, w: 2.95, h: 0.8, fontSize: 12 });
  });
  s.addNotes(`run_scenarios.py. One simulation per weather case; the power cut only removes the fan credit, so the three cut cases share it. Middle floor: ${cuts.map((c) => scv(m0, "middle floor", c).safe_hours).join(" / ")} h with measured air.`);

  // ================= 16. AC heat model =================
  s = content("How neighbours' AC heat enters the model", "Results");
  const prof = D.scenarios_meta.ac_warming_profile_c;
  const pk = Object.keys(prof).filter((k) => !k.startsWith("measured"));
  s.addChart(pres.charts.LINE, pk.map((k) => ({ name: shortW(k), labels: [...Array(24).keys()].map((h) => String(h).padStart(2, "0")), values: prof[k] })),
    Object.assign({ x: 0.6, y: 1.45, w: 7.0, h: 4.6, chartColors: [H.accent2, H.accent5], lineSize: 3, lineDataSymbol: "none", showLegend: true, legendPos: "b",
      valAxisMinVal: 0, valAxisMaxVal: 2.5, valAxisMajorUnit: 0.5, showTitle: true, title: "Added to measured outdoor air (°C), by hour of day", catAxisLabelFrequency: 3 }, chartText));
  txt(s, "Dew point kept: split ACs condense water indoors, so the street air gets heat, not moisture.", { x: 0.6, y: 6.15, w: 7.0, h: 0.5, fontSize: 13, italic: true, color: C.accent6 });
  const refs = [
    ["Salamanca et al. 2014", "Phoenix heatwave, WRF + building model: negligible by day, > 1 °C at night"],
    ["de Munck et al. 2013", "Paris: +0.5 °C today, +1 °C with dry units, +2 °C if AC heat doubles; larger at night"],
    ["Ohashi et al. 2007", "Tokyo office districts: +1–2 °C on weekdays"],
    ["CEEW (India)", "Home ACs run 5–7 h a day, mostly 22:00–06:00"],
  ];
  refs.forEach(([a, b], i) => {
    const y = 1.45 + i * 1.12;
    card(s, 8.0, y, 4.7, 1.0);
    txt(s, a, { x: 8.2, y: y + 0.1, w: 4.3, h: 0.3, fontSize: 14, bold: true, color: C.accent1 });
    txt(s, b, { x: 8.2, y: y + 0.42, w: 4.3, h: 0.55, fontSize: 12 });
  });
  txt(s, "Literature, not measured in Chennai: kept as a scenario. To measure in 2027: street logger beside AC outdoor units vs the airport.", { x: 8.0, y: 5.95, w: 4.7, h: 0.75, fontSize: 12.5, bold: true, color: C.accent5 });
  s.addNotes("oasis/ac_heat.py. The airport station is at the city edge; it already includes whatever AC heat reaches it, so the added warming stands for a denser neighbourhood.");

  // ================= 17. Design changes =================
  s = content("Which single design change helps most", "Results");
  const label = (c) => {
    const v = c.value;
    switch (c.parameter) {
      case "roof_solar_absorptance": return v <= 0.2 ? "White roof coating (0.2)" : `Lighter roof colour (${v})`;
      case "roof": return String(v).includes("insul") ? "Roof insulation 50 mm" : `Roof: ${v}`;
      case "wall": return v === "aac_200" ? "AAC block walls 200 mm" : v === "brick_115" ? "Brick walls 115 mm" : `Walls: ${v}`;
      case "shading_depth_m": return `Window overhangs ${v} m`;
      case "night_vent": return v === false || v === "False" ? "Shut windows at night" : "Open windows at night";
      default: return `${c.parameter} ${v}`;
    }
  };
  const ch_ = D.changes.slice().sort((a, b) => a.safe_hours_gained - b.safe_hours_gained);
  s.addChart(pres.charts.BAR, [
    { name: "Safe hours gained", labels: ch_.map(label), values: ch_.map((c) => Math.max(c.safe_hours_gained, 0)) },
    { name: "Safe hours lost", labels: ch_.map(label), values: ch_.map((c) => Math.min(c.safe_hours_gained, 0)) },
  ], Object.assign({ x: 0.6, y: 1.45, w: 7.9, h: 5.2, barDir: "bar", barGrouping: "stacked", chartColors: [H.accent3, H.accent5], showValue: true, dataLabelPosition: "inEnd", dataLabelColor: "FFFFFF",
    dataLabelFormatCode: "+0;-0;", catAxisLabelPos: "low", showLegend: false, showTitle: true, title: `Change in safe hours vs the baseline flat (${base.safe_hours} h)` }, chartText));
  const best = D.changes[0];
  stat(s, 8.9, 1.5, 3.8, `+${best.safe_hours_gained} h`, `${label(best)}: the strongest single change (${base.safe_hours} → ${best.safe_hours} safe hours)`, SAFE);
  stat(s, 8.9, 3.45, 3.8, `${D.sweep.max} h`, `best of ${D.sweep.designs.toLocaleString("en")} designs in the sweep (all changes combined); median ${D.sweep.median}`, SLATE);
  txt(s, "No single change makes the flat safe for the whole week: design helps, but the weather dominates.", { x: 8.9, y: 5.6, w: 3.8, h: 1.0, fontSize: 13, italic: true, color: C.accent6 });
  s.addNotes("Live assessment of the baseline flat (oasis/assess.py): each change re-simulated on its own. Interventions are secondary for the MVP but already computed on the recorded heatwave.");

  // ================= 18. Amudha =================
  s = content("Real floor plans: Amudha Elite flats, room by room", "Results");
  const am = JSON.parse(fs.readFileSync(path.join(__dirname, "amudha.json"), "utf8"));
  am.forEach((p, i) => {
    const x = 0.6 + i * 6.2;
    card(s, x, 1.45, 5.9, 5.25);
    iconDot(s, I.home, x + 0.25, 1.65, 0.6, HEAT);
    txt(s, p.name, { x: x + 1.0, y: 1.65, w: 4.7, h: 0.6, fontSize: 18, bold: true, color: C.text2, valign: "middle" });
    txt(s, `${p.household}`, { x: x + 0.25, y: 2.4, w: 1.6, h: 0.8, fontSize: 44, bold: true, color: C.accent1, fontFace: "Cambria" });
    txt(s, `household safe hours of 168 (where the people are); ${p.nights} of 56 night hours safe`, { x: x + 1.9, y: 2.5, w: 3.8, h: 0.7, fontSize: 13 });
    const rws = [[{ text: "Design change", options: { bold: true, color: H.lt1, fill: { color: H.dk2 } } }, { text: "Household", options: { bold: true, color: H.lt1, fill: { color: H.dk2 }, align: "right" } }, { text: "Gain", options: { bold: true, color: H.lt1, fill: { color: H.dk2 }, align: "right" } }]]
      .concat(p.changes.map((c) => [{ text: c.name }, { text: String(c.hours), options: { align: "right" } }, { text: (c.gain > 0 ? "+" : "") + c.gain, options: { align: "right", bold: true, color: c.gain > 0 ? H.accent3 : c.gain < 0 ? H.accent5 : H.accent4 } }]));
    s.addTable(rws, { x: x + 0.25, y: 3.45, w: 5.4, colW: [3.0, 1.2, 1.2], fontFace: "Calibri", fontSize: 13, color: H.dk1, rowH: 0.42, border: { type: "solid", pt: 0.75, color: "E5E7EB" }, fill: { color: H.lt1 }, objectName: oname("amudha_table") });
    txt(s, `Rooms safe: ${p.rooms}`, { x: x + 0.25, y: 6.05, w: 5.4, h: 0.55, fontSize: 11.5, color: C.accent6 });
  });
  s.addNotes("run_layout.py on data/layouts/amudha_*.json: one EnergyPlus zone per room, real partitions and doors, AirflowNetwork. Kitchens and toilets have no fan credit, so they are never safe in this week.");

  // ================= Section: tool =================
  section("04", "The tool today", "Three front ends on one simulation core", "Tool");

  // ================= 20. Three front ends =================
  s = content("Three ways to use OASIS", "Tool");
  const fe = [
    [I.chart, "Static HTML tool", `${D.sweep.designs.toLocaleString("en")} pre-simulated designs in one file: choose floor, walls, roof, windows, shading; see safe hours instantly. Works offline.`, "make_tool.py → outputs/oasis_tool.html"],
    [I.code, "FastAPI web tool", "Live EnergyPlus per request: Rhino .3dm import, ranked changes with Apply/Undo, hour-by-hour grid, household check (JOS-3), 3D plan with sun and felt-heat floors.", "run_server.py → 127.0.0.1:8000"],
    [I.cube, "Streamlit app", "Local research UI: upload a .3dm, run live simulations, compare peaks and power-cut hours.", "streamlit run app.py"],
  ];
  fe.forEach(([ic, h, b, cmd], i) => {
    const x = 0.6 + i * 4.1;
    card(s, x, 1.5, 3.8, 3.75);
    iconDot(s, ic, x + 0.3, 1.75, 0.7, i === 1 ? HEAT : SLATE);
    txt(s, h, { x: x + 0.3, y: 2.6, w: 3.2, h: 0.45, fontSize: 19, bold: true, color: C.text2 });
    txt(s, b, { x: x + 0.3, y: 3.1, w: 3.25, h: 1.6, fontSize: 13 });
    txt(s, cmd, { x: x + 0.3, y: 4.75, w: 3.25, h: 0.35, fontSize: 11, color: C.accent6, fontFace: "Courier New" });
  });
  const sstats = [[`${sur.r2}`, "surrogate R² (held-out designs)"], [`${sur.mae_hours} h`, "mean surrogate error"], [`${sur.max_error_hours} h`, "largest surrogate error"], ["~2 s", "one live run (14 simulated days)"]];
  sstats.forEach(([b, l], i) => {
    const x = 0.6 + i * 3.1;
    card(s, x, 5.5, 2.8, 1.2, H.dk2);
    txt(s, b, { x: x + 0.2, y: 5.6, w: 2.4, h: 0.55, fontSize: 24, bold: true, color: C.accent2, fontFace: "Cambria" });
    txt(s, l, { x: x + 0.2, y: 6.17, w: 2.5, h: 0.45, fontSize: 12, color: C.background1 });
  });
  s.addNotes("All three front ends now default to the recorded heatwave 1–7 May 2024 (config.EPW). The sweep and surrogate were re-run on it.");

  // ================= 21. Done / next =================
  s = content("Where the project stands", "Tool");
  const done = ["Simulation core: eppy → EnergyPlus 26.2, AirflowNetwork", "Calibration round 4 on 12 Dhaka homes, Delhi check", "Measured evidence of the evening heat (loggers)", "Recorded Chennai heatwave as the default weather", "Windows open day and night (field knowledge)", "Power-cut cases + neighbours' AC heat scenario", `Full re-run: sweep ${D.sweep.designs.toLocaleString("en")}, surrogate, tools, Amudha plans`];
  const next = ["Chennai field campaign 2027: indoor loggers + window-opening times", "Street logger beside AC outdoor units vs airport", "Calibrate on Chennai homes; fix the ~2 h early peak", "Choose interventions to test with residents", "Thesis submission, June 2027"];
  card(s, 0.6, 1.45, 6.2, 5.25);
  iconDot(s, I.check, 0.85, 1.65, 0.6, SAFE);
  txt(s, "Done", { x: 1.6, y: 1.7, w: 4, h: 0.5, fontSize: 22, bold: true, color: C.text2, valign: "middle" });
  txt(s, done.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < done.length - 1 } })), { x: 0.9, y: 2.5, w: 5.7, h: 4.1, fontSize: 17, paraSpaceAfter: 12 });
  card(s, 7.1, 1.45, 5.6, 5.25, H.dk2);
  iconDot(s, I.clock, 7.35, 1.65, 0.6, AMBER);
  txt(s, "Next", { x: 8.1, y: 1.7, w: 4, h: 0.5, fontSize: 22, bold: true, color: C.background1, valign: "middle" });
  txt(s, next.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < next.length - 1 } })), { x: 7.4, y: 2.5, w: 5.1, h: 4.1, fontSize: 17, color: C.background1, paraSpaceAfter: 12 });
  s.addNotes("HANDOFF.md holds the running state for both agents.");

  // ================= 22. Limitations =================
  s = content("Limitations we state openly", "Tool");
  const lim = [
    [I.clock, "Peak ~2 h early", "Model peaks 14:00 vs 17:00 measured; the cut hour is right in Dhaka."],
    [I.sun, "Delhi evenings too cool", "−2 °C in hot-dry heat (3 homes): conservative there."],
    [I.snow, "AC heat from literature", "+1/+2 °C from Phoenix, Paris, Tokyo; Chennai not measured yet."],
    [I.users, "Children", "No validated child thermoregulation model; covered by heat index only."],
    [I.therm, "Heat index range", "Very humid, hot hours sit at the edge of the NWS formula."],
    [I.wind, "Airport wind", "Station wind is more open than a dense street; total air changes are what transfer."],
  ];
  lim.forEach(([ic, h, b], i) => {
    const x = 0.6 + (i % 3) * 4.1, y = 1.5 + Math.floor(i / 3) * 2.6;
    card(s, x, y, 3.8, 2.35);
    iconDot(s, ic, x + 0.25, y + 0.25, 0.58, SLATE);
    txt(s, h, { x: x + 1.0, y: y + 0.28, w: 2.65, h: 0.55, fontSize: 16, bold: true, color: C.text2, valign: "middle" });
    txt(s, b, { x: x + 0.25, y: y + 1.0, w: 3.35, h: 1.2, fontSize: 13.5 });
  });
  s.addNotes("Each limitation is either conservative (understates the problem) or labelled in the outputs.");

  // ================= 23. Closing =================
  pres.addSection({ title: "Closing" });
  s = pres.addSlide({ masterName: "TITLE_DARK", sectionTitle: "Closing" });
  s.addText("The problem is real", { placeholder: "title" });
  s.addText(`Measured homes overheat in the evening. On a recorded Chennai heatwave, the calibrated flat is safe ${recTop.safe_hours} of 168 hours, the power cut is in danger ${recTop.nights_cut_in_danger} of 7 evenings, and neighbours' ACs push it down to ${tc(m1, cuts[0]).safe_hours}.`, { placeholder: "body" });
  txt(s, "Next: measure it in Chennai (2027 field campaign)", { x: 0.8, y: 6.3, w: 11, h: 0.4, fontSize: 14, color: C.accent4 });
  s.addNotes("Close on the MVP claim: the research problem exists, shown with measured inputs.");

  await pres.writeFile({ fileName: OUTFILE });
  await applyTheme(OUTFILE, THEME);
  console.log("wrote", OUTFILE);
})().catch((e) => { console.error(e); process.exit(1); });
