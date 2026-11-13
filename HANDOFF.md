# OASIS 2.0 — Handoff

Short shared notes between Claude Code and Antigravity (Gemini). Update after changing code or results; keep each section to a few bullets.

---

## Current state

- **Last updated**: 2026-11-13 by Claude Code (full re-run on the recorded heatwave + progress deck)
- **Status**: working — full pipeline, web tool, static HTML tool, Streamlit app, Round 2 Dhaka calibration, and JOS-3 + ISO 7933:2023 + Morris/Jay live human occupant agent engine (`oasis/agents.py`) are built.
- **Full re-run on the recorded heatwave (default weather now)**: `config.EPW` = `chennai_heatwave.epw`, scored week 1–7 May 2024, default runs start 24 Apr (`SPINUP_START`) and `simulate.drop_spinup` trims eplusout.csv to the week; `config.TMYX_EPW`/`TMYX_WEEK` keep the typical year (station-file template, run_heatwave comparison). run_mvp: baseline 59 h, white roof +39, roof insulation +27, shading +1. Sweep 1,512 (268 s, workers capped at 8: 24 exhausted the paging file; old copy `outputs/sweep_tmyx.csv`): 0–111 h, median 38. Surrogate R² 0.996, MAE 1.5 h, max 10.3 h. HTML tool rebuilt. Rhino sample 39 h (white roof +52, insul +41, shut at night −35). Amudha 1BHK household 42 h (white roof +42, insul +32, shut −38); 3BHK 33 h (+43, +33, −24). run_heatwave/run_scenarios unchanged (59/95). UI labels say 1–7 May 2024.
- **Progress deck**: `docs/OASIS_2.0_progress.pptx` (23 slides), built by `docs/deck/collect.py` (reads outputs) + `docs/deck/build.js`.
- **Neighbours' AC heat + three power-cut cases (`oasis/ac_heat.py`, `run_scenarios.py` → `outputs/scenarios/`)**: AC waste heat added to the measured outdoor air (literature, not measured in Chennai: Salamanca 2014 >1 °C at night, de Munck 2013 +0.5/+1/+2 °C, Ohashi 2007 +1–2 °C): +1 °C 22–06 h, half in shoulder hours 18–22/06–08, 0 by day, dew point kept; +2 °C = AC heat doubled. `metrics.safe_hours(csv, cut_hours)` now takes the cut hours (default 20–21). Recorded week, top floor: heatwave + cut 59 → 34 (+1 °C) → 18 (+2 °C) safe h; heatwave alone 62/35/19; cut at peak heat (14–15 h) 62/35/19 (max HI 52.5 °C). Middle floor 95/72/40. The cut costs only ~3 h because most hours are already in danger with the fan on; AC heat mainly removes safe night hours (31 → 15 of 56). TN all-time peak demand 20,830 MW was 2 May 2024, inside this week.
- **Baseline windows now open day and night** (`params.BASELINE["night_vent"] = True`): homes without AC keep windows open at night and during cuts (user's field knowledge; all Dhaka calibration homes). TMYx baseline 116 → 162 h; Rhino sample 161 h (white roof +5, shut at night −46); intervention `shade_nightvent` → `shading`; `run_layout.py` tests "windows shut at night" instead. HTML tool rebuilt (sweep has both levels, no re-run). Older plan numbers further below are superseded by the full re-run.
- **Earlier change (recorded heatwave, `get_heatwave.py` + `run_heatwave.py` → `outputs/heatwave/`)**:
  - Real Chennai weather: Meenambakkam WMO 43279 hourly (Meteostat) + ERA5 sunlight (Open-Meteo), raw cached in `data/weather/raw/`. Hottest 7 days Apr–Jun 2016–2025 by mean outdoor heat index = **1–7 May 2024** (HI 45.1 °C) vs TMYx 10–16 May 36.5 °C (same air temp; TMYx is drier). 336/336 h from the station; station − ERA5 +0.8 °C. File `data/weather/chennai_heatwave.epw` (+ `.json`), run starts 7 days early (spin-up), 7 days scored.
  - **Headline (top floor, windows open day+night = the validated calibration case): 59 / 168 safe hours on the recorded week vs 163 on TMYx; power cut in danger 7/7 nights; the cut hour is the week's maximum (HI 50 °C).** Middle floor 95 h.
  - OASIS `BASELINE` shuts windows 22–06: 10 h safe, night HI up to 76 °C (38 °C, 89 % RH, ~7 °C above outdoor) — never seen in measured homes and outside the NWS formula range → reported as "not validated", not used for the headline.
  - Measured heat index (`check_evening.py` → `measured_heat_index.csv`, Dhaka, 5 free-running homes with RH loggers): HI ≥ 41 °C at 20:00 on 26–70 % of days indoors vs 2 % outdoors.
- **Earlier change (evening check, `check_evening.py` → `outputs/evidence/`)**: MVP focus is now "does the problem exist", not interventions.
  - Measured only (pre-monsoon 2016, free-running homes): concrete-roof top-floor homes peak late (Dhaka 17 h, Delhi 18 h, outdoor 13 h) and sit +2.9 °C (Dhaka) / +3.8 °C (Delhi) above outdoor at 20:00 — the stored roof heat lands in the cut. Figure `measured_daily_profile.png`.
  - Model, adopted settings, per home: Dhaka evening (19–22 h) error +0.06 °C, excess at 20:00 3.07 sim vs 3.02 meas, even though the peak is ~2 h early (median 14 vs 17 h). Delhi no-cooler homes (only 3): evening −2.1 °C, excess 2.75 vs 4.86 → model under-predicts the evening in hot-dry heat (conservative). Figure `model_vs_measured_profile.png`.
  - Lag test (`check_lag.py` → `lag_variants.csv`): all calibration homes have windows open 24 h in the model (night code), so the 06:00 opening hour is not the cause. Less window opening moves the peak later only by overheating everything (opening 0.1: evening +1.6 °C) → rejected. Shutting 10–17 h removes the Dhaka lag (1.8 → 0.25 h) with the evening unchanged (+0.13 °C) but whole-day RMSE 1.11 → 1.25 and the survey cannot confirm it → **not adopted**; defaults stay. Morning +0.7 °C warm in every variant (not a window effect). Delhi evening −2 °C not fixed by any window variant.
  - `build_idf.py`: new `setting()` key `openable_fraction` (default 0.5, unchanged) and optional `windows_open_steps` (checks only).
- **Earlier change (calibration round 4, adopted)**:
  - `calibrate_homes.py --airflow afn`: survey roof (screed, colour/tar, ceiling height) added; 1,440 runs; scores air and operative temperature (air fits better). Adopted in `build_idf.py` DEFAULTS: AirflowNetwork default, internal mass 320 m² (identified), appliances 100 W and wall leakage 8 cm²/m² (weakly identified, mid-range within 0.03 °C). Dhaka RMSE 1.10 / 1.05 °C, bias +0.37; RH RMSE 4–5 %. Peak still 14:00 vs 17:00 (coba/screed roof does not move it).
  - `--validate Delhi` (no refit): 3 homes without evaporative coolers RMSE 2.0 °C (May–Jun) / 1.6 °C (Jul–Aug); 14 cooler homes +2.9 °C bias in May–June (no cooler in the model).
  - Fan credit = ASHRAE 55 cooling effect every hour (`metrics.fan_credit_c`, 0.4 m/s, 1.1 met, 0.5 clo), about 2 °C, up to 3 °C in dry hours. Roofs `rcc_150_screed`, `rcc_150_coba` added (SP 41 values). Layout internal mass scaled per floor area minus real partitions.
  - Re-ran sweep (old copy `outputs/sweep_pre_calibration.csv`), surrogate (R² 0.997, MAE 0.8 h), HTML tool. Baseline 98 → 116 h; 1BHK plan 108 → 118 h; ranking unchanged (night windows, white roof first).
- **Earlier change (calibration + plans)**:
  - `calibrate_homes.py`: calibration round 3, one model per Dhaka home, built from its survey (wall, people, walls with no sun → neighbour planes, window layout and open day/night from the ventilation codes). Round 2's `calibrate.py` misread the ventilation code as open/closed; per the dataset README it is the window layout.
  - `--airflow afn`: AirflowNetwork, no airflow factor. Result: per-home RMSE 1.13 °C (fit) / 1.07 °C (check), daily swing 2.5 vs 2.6 °C, RH RMSE 4–5 %. Peak still 14:00 vs 17:00.
  - `build_idf.py`: optional AirflowNetwork (`airflow_model="afn"`), neighbour planes (`shaded_walls`) and `height_above_ground_m`. The default model is unchanged (98 h).
  - `oasis/build_layout.py` + `run_layout.py`: multi-room model from a plan JSON (`data/layouts/`, two Amudha Elite flats). One zone per room, real partitions and doors, AirflowNetwork; safe hours per room and for the household.
  - Rhino: `rhino/draw_layout.py` draws a plan JSON on `OASIS::` layers, `rhino/draw_detail.py` adds a detailed model (`Detail::` 230/115 mm walls, cut openings, glass, slabs, balconies). `oasis/read_layout_3dm.py` reads a `.3dm` back (room/wall found from geometry, `OASIS::party_wall` lines → adiabatic walls, `OASIS::north` → orientation); `run_layout.py` takes `.json` or `.3dm`; the main tool's import (`from_rhino.read_model`) also accepts these plans, simplified to one room (outer size + glass per wall). Check: both Amudha `.3dm` read identical to their JSON; 1BHK household 108 h either way.
  - **3D tab in the main tool** (`frontend/viewer3d.js` + `viewer3d.css`, three.js 0.160 from CDN; `oasis/unit.py:assess_plan`): importing a room-by-room plan (`.3dm` on `OASIS::` layers, or the Amudha samples via `/api/samples`) keeps it on the server (`outputs/plans/<hash>.3dm`, `plan_id`). Run then simulates it room by room with the sidebar settings + every single change (`assess.single_changes`); results "where the people are" (living by day, hottest bedroom at night) fill Overview / Hour by hour / Household check, and the 3D tab shows the flat: cut at 1.5 m or full height, sun by hour, felt-heat floors, people placed by routine (couple in the first bedroom) with expandable JOS-3 status labels (core, skin, wetness, sweat, cardiac output; JOS-3 has no heart rate). Children: felt heat only. Shared-walls choice in the model card. ~20 s per run. Full-width layout; the standalone unit page was removed.
- **Earlier change**: Redesigned the web tool (`frontend/`, v7.0): intro page with the OASIS 2.0 title (HVRA-style gradient on "2.0"); shadcn-style neutral look (Geist font, light/dark); sidebar with 4 basic choices + collapsible building details + household summary (editor in a drawer); results in 3 tabs (Overview: score, stats, ranked changes with Apply, peaks; Hour by hour: week grid + chart with "Compare with"; Household check: JOS-3). Sonner-style toasts with Undo. Household plan is now to scale: real L×W, rotated by orientation (north up), glass per wall from `wwr` or the Rhino `window_area_m2` (same sizing rule as `build_idf.window_sizes`), overhang at real depth; zones are sketches. Still vanilla JS, no build step (the linked libraries are React-only). API unchanged.
- **Open issues**:
  - No validated thermoregulation model for children (JOS-3 child-size body reads 38.4 °C core at 25 °C); children are covered by the heat-index measure and this is a stated thesis limitation.
  - `docs/chennai_field_and_data_research.md` corrected: impossible figure, garbled citation and cost-effectiveness (now OASIS's own gains) fixed; remaining unverified claims and contacts marked ⚠ — verify before citing or emailing.
  - Peak ~2 h early (see evening check); evening/cut hour correct in Dhaka, ~2 °C low in Delhi (3 homes). Survey lists 10706822 twice (floor 1 and 3); floor 1 used.
  - Calibrated `airflow_factor = 1.6` doesn't transfer directly from Dhaka (weak urban wind) to Chennai EPW (airport wind) — total ACH (~10–14) is what transfers.

---

## Next steps

1. [x] Git set up and pushed to https://github.com/helios0007/OASIS-2.0 (`main`); `.gitignore` excludes `.venv/`, `__pycache__/`, EnergyPlus run folders.
2a. [x] Round 4 fitted, validated on Delhi, adopted (see Current state). Next: calibrate on Chennai homes (2027 field campaign); explain the 3 h peak lag.
2d. [x] Lag tested (window coupling); cut hour already right in Dhaka, lag kept as a stated limitation. Chennai field campaign must log window opening times (sensor or diary) — the missing true value. Open: Delhi evening −2 °C (3 homes) and the +0.7 °C warm mornings.
2e. [x] Baseline windows open day and night. [x] Sweep/surrogate/tools moved to the recorded heatwave (full re-run); Amudha plans re-run.
2f. [x] Neighbours' AC heat + power-cut scenarios (`run_scenarios.py`). [ ] Replace the literature AC warming with a Chennai measurement (street logger next to AC outdoor units vs airport) in the 2027 field campaign; decide whether AC heat goes into the tools.
2b. [ ] Speed: build each home's IDF once and patch only the fitted numbers (eppy writing is about 1 s per file).
2c. [ ] Plans: no party-wall data, so bound it: `run_layout.py <plan> windowless` treats every windowless outside wall as shared. Amudha: 1BHK 108 h both ways; 3BHK 112 vs 107 h; ranking of changes the same. Confirm north; connect plans to the web household check; add a PMAY plan (LHP Chennai booklet in Downloads); later CFD wind pressures (Eddy3D/Butterfly) replacing Swami-Chandra.
2. [x] TNUHDB coba roof tested: +2 safe hours, peak not moved; kept as an option (`rcc_150_coba`), baseline stays bare RCC.
3. [x] Indoor RH vs the two Dhaka RH loggers: RMSE 4.0 / 4.9 % RH.
4. [x] Delhi validation done (see Current state).
5. [x] Adopted; sweep, surrogate, HTML tool and docs updated.
6. [ ] Verify material properties in `oasis/build_idf.py` against ENS 2024 / ISHRAE (esp. `aac`).
7. [~] Fan: ASHRAE 55 cooling effect done. Limit: 41 °C kept (chosen threshold); Chen et al. (2024) thresholds still to verify and decide.
8. [ ] Add intervention costs (₹) and rank by safe hours per rupee.
9. [ ] Add room dimensions to the sweep/surrogate so Rhino uploads get instant predictions.
10. [ ] Test Rhino upload with a real Rhino-saved `.3dm` file.
12. [ ] Check JOS-3 ranking agreement for every design change (now design only); consider Lu & Romps extended heat index (`pythermalcomfort.models.heat_index_lu`).
11. [ ] Decide whether to bring the v7 web-tool look to `tool/template.html` and `app.py` (web tool checked at 400 px width).

---

## Key decisions

- 2026-11-13 (Claude Code): Default weather = recorded heatwave 1–7 May 2024 with 7 spin-up days (trimmed in `simulate.run`); TMYx kept for comparison only.
- 2026-11-13 (Claude Code): Neighbours' AC waste heat is a labelled scenario on top of measured weather (+1 / +2 °C at night, literature), not part of the default weather; power cut only changes scoring (fan credit), so cut cases share one simulation.
- **2026-11-09** — Build IDFs from scratch with `eppy` (no template); EnergyPlus 26.2 ships no `MinimalFile.idf`.
- **2026-11-09** — Run period 10–16 May (hottest Chennai week) with 20:00–21:00 nightly power cut.
- **2026-11-09** — Write IDFs sequentially (eppy not thread-safe), run EnergyPlus in parallel.
- **2026-11-10** — Keep original `DEFAULTS` until calibration is finished, so sweep/surrogate/front-end numbers stay consistent.
- **2026-11-11** — Use a lightweight handoff: only update this file after real changes; no file locks or session logs.
- **2026-11-12** — Couple EnergyPlus hourly output with a 60-substep JOS-3 + ISO 7933:2023 + Morris/Jay (2021) biophysical occupant agent model (`oasis/agents.py`) to compute person-specific core/skin temp, wettedness, heart rate, PSI, and live spatial feedback.
- **2026-11-12** — Main measure = heat index safe hours (ranks changes); check = JOS-3 (pythermalcomfort) household core temperature < 38.0 °C with EnergyPlus MRT. ISO 7933 PHS model not run hourly (workplace scope: no sleeping/lying, needs tr > tdb); only its 38 °C limit is used. Replaces the hand-written agent model.
- **2026-11-12** — Report two peaks rather than forcing the simulated peak into the cut: the normal daily peak and the peak during the cut, plus a scan of every hour as a possible cut hour. Calibration still targets the *measured* peak timing (accuracy), not the cut.
- **2026-11-12** — Calibrate per home from the survey, fitting only what no survey or standard gives. Move air with the AirflowNetwork (wind pressure, Swami-Chandra) instead of a fitted airflow factor; neighbours are shading planes, not adiabatic walls.
- **2026-11-12** — Children (<18) are not given a body model (none is validated); the heat-index measure covers them and the gap is a stated limitation. A scaled two-node model is only an optional, labelled sensitivity check.
- **2026-11-13** — Baseline windows open day and night (free-running homes without AC; matches calibration homes). Night-shut kept only as an option.
- **2026-11-13** — MVP headline uses recorded weather (1–7 May 2024, station + ERA5 sunlight, week picked by max mean outdoor heat index) and the validated window case (open day+night); TMYx kept for the tools until re-run.
- **2026-11-12** — Adopt calibration round 4 as defaults (AirflowNetwork, mass 320 m², appliances 100 W, leakage 8 cm²/m²). Weakly identified settings take a mid-range value within 0.03 °C of the best fit. Fan credit = hourly ASHRAE 55 cooling effect.
