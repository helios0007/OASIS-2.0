# Agent Rules & Project Guide (`AGENTS.md`)

This repository is shared between **Claude Code** and **Antigravity (Gemini)**. Both agents follow the light handoff below and the conventions in this file.

---

## 1. Handoff (keep it light)

1. **Before a coding task**: Read `HANDOFF.md` (short: current state, next steps, key decisions).
2. **After changing code or results**: Update `HANDOFF.md` briefly:
   - Rewrite **Current state** (date, your agent name, status, one line on what you changed, open issues).
   - Tick off or add items in **Next steps**.
   - Add a one-line entry to **Key decisions** only for modelling or architecture choices.
3. **Skip the update** for questions, explanations or trivial edits.
4. **Keep it short**: a few bullets per section, no session logs. Don't remove the other agent's key decisions.
5. **Git**: Once git is set up, commit when the user asks.

---

## 2. Project Context

### Description
**OASIS (Overheating Assessment System for Intervention Strategies)** is a Master's thesis project (Master in AI for Architecture and the Built Environment, IAAC Barcelona, 2026/27, by Nithik Vairamuthu).

It is a design-stage simulation and decision-support tool for new residential buildings (PMAY-style flats) in hot-humid Indian cities (primary focus: **Chennai**). OASIS predicts how many **safe hours** (hours with indoor Heat Index < 41 °C) a free-running home gives its occupants during a recorded 7-day Chennai heatwave (1–7 May 2024, Meenambakkam station + ERA5 sunlight; 7 spin-up days before) combined with a nightly 20:00–21:00 power cut (when ceiling fans switch off), and ranks passive design interventions (roof reflectance, roof insulation, wall material, window-to-wall ratio, shading overhangs, night ventilation, orientation, floor level) by safe hours gained. It also includes calibration scripts against measured indoor logger datasets from Dhaka and Delhi (Tasgaonkar et al. 2022).

### Tech Stack
- **OS & Python**: Windows, Python 3.13 in `.venv` (`.venv\Scripts\python.exe`).
- **Simulation Engine**: EnergyPlus 26.2 installed at `D:\IAAC\ENERGY PLUS\energyplus.exe`. IDF models are generated programmatically from scratch using `eppy` (`Version,26.2;`).
- **Data Science & Surrogate ML**: `pandas`, `numpy`, `matplotlib`, `scikit-learn`, `xgboost` (`XGBRegressor` trained on a 1,512-design parameter sweep).
- **3D Geometry Input**: `rhino3dm` for reading room bounding boxes (`room` / `zone` / `flat` layers) and glazing areas (`window` / `glaz` / `opening` layers) from `.3dm` files.
- **Interfaces (3 Front Ends)**:
  1. **Static HTML Tool** (`make_tool.py` + `tool/template.html` → `outputs/oasis_tool.html`): standalone lookup tool backed by the 1,512 pre-simulated sweep results for each outdoor-air case (airport / city centre / street AC, `oasis/scenario.py`).
  2. **Streamlit Local App** (`app.py`): interactive local UI supporting `.3dm` uploads and live EnergyPlus simulations, with the same outdoor-air and power-cut-hour scenario choices as the web tool.
  3. **FastAPI + Vanilla JS Web Tool** (`run_server.py`, `backend/main.py`, `frontend/`): REST API (`/api/health`, `/api/options`, `/api/rhino`, `/api/assess`, `/api/predict`) and single-page web interface with live simulation, caching, and step-by-step intervention application.

### How to Run
Run all commands from the project root (`D:\IAAC\OASIS 2.0`) using the `.venv` Python environment (`.venv\Scripts\activate` or `.venv\Scripts\python.exe`):

| Task | Command | Main Outputs |
|---|---|---|
| Run baseline + 3 MVP interventions | `python run_mvp.py` | `outputs/results.csv`, `outputs/hourly.csv`, `outputs/heat_index_week.png` |
| Run full parameter sweep (1,512 runs) | `python run_sweep.py` (airport air); `--weather city` / `--weather street_ac` for the other cases | `outputs/sweep.csv`, `outputs/sweep_hourly.csv` (`sweep_<case>.csv`, `sweep_hourly_<case>.csv`) |
| Random rooms for the surrogate (1,500 runs: size, orientation, all three air cases) | `python run_sample.py` | `outputs/sample.csv` |
| Train XGBoost surrogate (safe hours + heat dose; three sweeps + random rooms) | `python train_surrogate.py` | `outputs/surrogate.json`, `surrogate_hazard.json`, `surrogate_metrics.json`, `surrogate_check.png`, `surrogate_importance.png` |
| Build standalone HTML tool | `python make_tool.py` | `outputs/oasis_tool.html` |
| Assess a Rhino `.3dm` model in CLI | `python run_rhino.py data/rhino/sample_flat.3dm` | Prints safe hours and ranked interventions |
| Run model calibration (Dhaka homes) | `python calibrate.py` | `outputs/calibration/summary.json`, `grid_results.csv`, `hourly.csv` |
| Calibration round 4 (adopted) / Delhi check | `python calibrate_homes.py --airflow afn` / `... --validate Delhi` | `outputs/calibration/homes/afn/summary.json`, `afn_validate_delhi/` |
| Evening check (measured evidence + model at the cut hour) / lag test | `python check_evening.py` / `python check_lag.py` | `outputs/evidence/` |
| Recorded Chennai heatwave (download + .epw) / MVP headline run | `python get_heatwave.py` / `python run_heatwave.py` | `data/weather/chennai_heatwave.epw`, `outputs/heatwave/` |
| City centre vs airport air (Nungambakkam vs Meenambakkam, measured) | `python check_city_weather.py` | `outputs/city_weather/` |
| Recorded heatwave: airport / city wind / city centre / street AC +1 °C × power cut 20–21 h / none / at peak heat / 20–06 h / no power all week | `python run_scenarios.py` (after `check_city_weather.py`) | `outputs/scenarios/` |
| Progress deck (numbers from outputs) | `python docs/deck/collect.py` then `node docs/deck/build.js` (needs pptxgenjs, react-icons, sharp; `PPTX_SKILL` for the theme step) | `docs/OASIS_2.0_progress.pptx` |
| Plot calibration charts | `python plot_calibration.py` | `outputs/calibration/calibration_daily_cycle.png`, `calibration_timeseries.png` |
| Start Streamlit app | `streamlit run app.py` | Local browser app (`http://localhost:8501`) |
| Start FastAPI + Web UI server | `python run_server.py` | `http://127.0.0.1:8000` |

### How to Test & Verify
There is no `pytest` suite yet; verification uses dedicated check scripts and API probes:
1. **EnergyPlus smoke test**: `python test_run.py` — runs `1ZoneUncontrolled.idf` against `data/weather/chennai.epw`, checks that `outputs/test_run/eplusout.csv` is created and `eplusout.err` has no `** Severe **` lines.
2. **Baseline model sanity check**: `python check_baseline.py` — builds and simulates `BASELINE` (`outputs/baseline.idf`), prints summary stats (`min`, `mean`, `max` indoor temperature/humidity and peak hour), and outputs the final status line of `eplusout.err`.
3. **Rhino parser & live assessment check**: `python make_sample_rhino.py` followed by `python run_rhino.py data/rhino/sample_flat.3dm` (expected on the recorded heatwave, windows open day and night: 39 safe hours as drawn, white roof coating +52, roof insulation +41, shutting windows at night −35).
4. **Web server check**: Run `python run_server.py` and verify `GET http://127.0.0.1:8000/api/health` returns `{"status": "ok"}`.

---

## 3. Conventions

- **Units**: Use SI units throughout all code and data (`°C`, `m`, `m²`, `W/m·K`, `kg/m³`, `J/kg·K`, `%`, `ACH`). Only `oasis/metrics.py:heat_index_c` converts to `°F` internally for the US NWS regression formula and converts back to `°C` before returning.
- **Weather and spin-up**: `config.EPW` is the recorded heatwave; default runs start at `config.SPINUP_START` and `simulate.run` drops the spin-up rows, so every reader sees 168 rows from 00:00 on 1 May. `config.TMYX_EPW` is the typical year (template for station files, comparison only). Calibration runs set their own dates and are not trimmed.
- **EnergyPlus execution**:
  - `config.ENERGYPLUS` (`r"D:\IAAC\ENERGY PLUS\energyplus.exe"`) contains a space; always pass it as the first element of a command list to `subprocess.run`, never as an unquoted shell string.
  - Always set `cwd=run_dir` in `subprocess.run` so EnergyPlus temporary files do not collide across parallel runs.
  - Always call `check_errors(run_dir)` (`oasis/simulate.py`) after running EnergyPlus and treat any `** Severe **` entry in `eplusout.err` as a fatal error.
- **Concurrency & `eppy` thread-safety**:
  - `eppy` modifies global IDD state and is **not thread-safe**. Always generate `.idf` files sequentially in a single thread (and hold `SIMULATION_LOCK` in `backend/main.py`), then fan out `oasis.simulate.run` across `ThreadPoolExecutor` or `ProcessPoolExecutor`.
- **IDF geometry & constructions**:
  - Build IDFs from `IDF(StringIO("Version,26.2;"))` in `oasis/build_idf.py` without external template files.
  - Surface vertices follow `UpperLeftCorner`, `Counterclockwise` (viewed from outside), `Relative` coordinates. At `orientation_deg = 0`, `length_m` runs east–west (north/south walls) and `width_m` runs north–south (east/west walls).
  - Construction material layers in `oasis/build_idf.py` are always listed **from outside to inside**.
- **Visible assumptions & parameters**:
  - Keep modelling constants explicit (heat dose after Chen et al. 2024: `CAUTION_C = 27`, `DOSE_LIMIT_ELDERLY_CH = 850`, `DOSE_LIMIT_YOUNG_CH = 1174`; `SAFE_LIMIT_C = 41.0`, applied to the NWS heat index and, as a cross-check, the extended heat index `heat_index_ext_c`, and the ASHRAE 55 fan settings in `oasis/metrics.py`; calibrated `DEFAULTS` in `oasis/build_idf.py`, from `calibrate_homes.py --airflow afn`).
  - Use `setting(p, key)` in `oasis/build_idf.py` for calibration-tunable parameters (`airflow_factor`, `infiltration_ach`, `appliances_peak_w`, `internal_mass_m2`, `windows_open_hour`, `windows_close_hour`, `openable_fraction`) so calibration scripts can test overrides via parameter dicts without silently mutating baseline defaults.
- **Code style & file hygiene**:
  - Write straightforward, well-commented Python with short functions and minimal dependencies.
  - Keep `outputs/` reproducible (safe to delete and regenerate). Clean up temporary simulation directories (`outputs/live_runs/<batch>`, `outputs/sweep_runs`, `outputs/calibration/runs`) using `shutil.rmtree(..., ignore_errors=True)`.

