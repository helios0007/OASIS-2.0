# OASIS 2.0 — Handoff

Short shared notes between Claude Code and Antigravity (Gemini). Update after changing code or results; keep each section to a few bullets.

---

## Current state

- **Last updated**: 2026-11-12 by Claude Code (calibration round 4 adopted)
- **Status**: working — full pipeline, web tool, static HTML tool, Streamlit app, Round 2 Dhaka calibration, and JOS-3 + ISO 7933:2023 + Morris/Jay live human occupant agent engine (`oasis/agents.py`) are built.
- **Last change (calibration round 4, adopted)**:
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
  - Calibration: `appliances_peak_w` (200 W) and `internal_mass_m2` (160 m²) sit at grid edges; simulated daily peak ~14:00 vs measured 16:00–17:00.
  - Calibrated `airflow_factor = 1.6` doesn't transfer directly from Dhaka (weak urban wind) to Chennai EPW (airport wind) — total ACH (~10–14) is what transfers.

---

## Next steps

1. [x] Git set up and pushed to https://github.com/helios0007/OASIS-2.0 (`main`); `.gitignore` excludes `.venv/`, `__pycache__/`, EnergyPlus run folders.
2a. [x] Round 4 fitted, validated on Delhi, adopted (see Current state). Next: calibrate on Chennai homes (2027 field campaign); explain the 3 h peak lag.
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
- **2026-11-12** — Adopt calibration round 4 as defaults (AirflowNetwork, mass 320 m², appliances 100 W, leakage 8 cm²/m²). Weakly identified settings take a mid-range value within 0.03 °C of the best fit. Fan credit = hourly ASHRAE 55 cooling effect.
