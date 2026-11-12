# OASIS 2.0 — Handoff

Short shared notes between Claude Code and Antigravity (Gemini). Update after changing code or results; keep each section to a few bullets.

---

## Current state

- **Last updated**: 2026-11-12 by Claude Code
- **Status**: working — full pipeline, web tool, static HTML tool, Streamlit app, Round 2 Dhaka calibration, and JOS-3 + ISO 7933:2023 + Morris/Jay live human occupant agent engine (`oasis/agents.py`) are built.
- **Last change**: Rebuilt `oasis/agents.py` on the real JOS-3 model (`pythermalcomfort`), fed by EnergyPlus air temp, mean radiant temp (new output) and RH; removed the hand-made PSI/heart-rate/radiant offsets; children (<18) listed but not modelled (JOS-3 is adult-only). Heat index safe hours stay the MAIN measure; the JOS-3 household (core < 38.0 °C, ISO 7933 limit) is the CHECK (`check` block in `/api/assess`). Web tool + Streamlit updated. Added `metrics.peaks()` → `/api/assess` `peaks` block + web panel "When a power cut hurts most" + Streamlit caption: normal daily peak (≈14:00, fan on) vs peak during the cut, plus felt heat with the fan off at each hour (cut is post-processing only, so no extra runs). Baseline: worst cut hour 18:00 (60.1 °C felt), the 20:00 cut is 47.0 °C.
- **Open issues**:
  - No validated thermoregulation model for children (JOS-3 child-size body reads 38.4 °C core at 25 °C); children are covered by the heat-index measure and this is a stated thesis limitation.
  - `docs/chennai_field_and_data_research.md` corrected: impossible figure, garbled citation and cost-effectiveness (now OASIS's own gains) fixed; remaining unverified claims and contacts marked ⚠ — verify before citing or emailing.
  - Calibration: `appliances_peak_w` (200 W) and `internal_mass_m2` (160 m²) sit at grid edges; simulated daily peak ~14:00 vs measured 16:00–17:00.
  - Calibrated `airflow_factor = 1.6` doesn't transfer directly from Dhaka (weak urban wind) to Chennai EPW (airport wind) — total ACH (~10–14) is what transfers.

---

## Next steps

1. [x] Git set up and pushed to https://github.com/helios0007/OASIS-2.0 (`main`); `.gitignore` excludes `.venv/`, `__pycache__/`, EnergyPlus run folders.
2. [ ] Calibration: test the TNUHDB roof build-up (85 mm brick-bat coba + 12 mm mortar + 20 mm clay tile over RCC) and `internal_mass_m2 ≈ 75` (partitions) to move the simulated peak later.
3. [ ] Check simulated indoor RH against the two Dhaka homes with humidity logs.
4. [ ] Validate calibrated model on the Delhi homes (`data/measured/Delhi *.csv`).
5. [ ] Adopt calibrated `DEFAULTS`, then re-run sweep → surrogate → HTML tool and update `docs/OASIS_tool_overview.md`.
6. [ ] Verify material properties in `oasis/build_idf.py` against ENS 2024 / ISHRAE (esp. `aac`).
7. [ ] Replace placeholder `FAN_CREDIT_C` / `SAFE_LIMIT_C` with ASHRAE 55 fan effect and Chen et al. (2024) thresholds.
8. [ ] Add intervention costs (₹) and rank by safe hours per rupee.
9. [ ] Add room dimensions to the sweep/surrogate so Rhino uploads get instant predictions.
10. [ ] Test Rhino upload with a real Rhino-saved `.3dm` file.
12. [ ] Check JOS-3 ranking agreement for every design change (now design only); consider Lu & Romps extended heat index (`pythermalcomfort.models.heat_index_lu`).
11. [ ] Decide whether to bring the new web-tool look to `tool/template.html` and `app.py`; check the web tool at phone width.

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
- **2026-11-12** — Children (<18) are not given a body model (none is validated); the heat-index measure covers them and the gap is a stated limitation. A scaled two-node model is only an optional, labelled sensitivity check.
