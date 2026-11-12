# OASIS: what has been built and how the tool works

Written 9 November 2026, updated 10 November 2026 with the web tool (front end 3).

OASIS (Overheating Assessment System for Intervention Strategies) predicts how many **safe hours** a new home in Chennai gives its occupants during a heatwave week with a nightly power cut, and tests which design choices add safe hours. The thesis background is in `OASIS_MVP_START.md`.

## Status in one paragraph

The full loop runs: a building is described by parameters or read from a Rhino model, Python writes an EnergyPlus model, EnergyPlus simulates the heatwave week, each hour is rated safe or in danger, and every design change is re-simulated and ranked. A sweep of 1,512 designs is stored, a fast prediction model is trained on it, and there are three front ends. **The results are not yet calibrated against measured homes**, so the numbers show that the method works, not what a real flat will do.

## The pipeline

```
Rhino model (.3dm)            optional first step
        |  oasis/from_rhino.py
        v
Building parameters           oasis/params.py
        |  oasis/build_idf.py
        v
EnergyPlus model (.idf)
        |  oasis/simulate.py   (EnergyPlus 26.2, Chennai weather file)
        v
Hourly indoor temperature and humidity
        |  oasis/metrics.py
        v
Safe hours (heat index, fan off during the power cut)
        |
        +--> Intervention loop     run_mvp.py, oasis/assess.py
        +--> Full sweep            run_sweep.py        -> outputs/sweep.csv
        +--> Prediction model      train_surrogate.py  -> outputs/surrogate.json
        +--> Tool page             make_tool.py        -> outputs/oasis_tool.html
        +--> Local app with upload app.py
        +--> Web tool (API + page)   run_server.py, backend/, frontend/
```

## The scenario

| Setting | Value | Where |
|---|---|---|
| City and weather | Chennai airport, typical-year weather file | `data/weather/chennai.epw` |
| Heatwave week | 10 to 16 May, the hottest 7 days in the file (mean 33.3 °C, peak 41.1 °C) | `config.py` |
| Power cut | 20:00 to 21:00 every night, ceiling fan off | `config.py` |
| Safe hour | Indoor heat index below 41 °C | `oasis/metrics.py` |
| Ceiling fan | Lowers the felt temperature by 2 °C when the power is on | `oasis/metrics.py` |

## The building model

One room, modelled as a box with no air-conditioning.

- **Baseline:** 6 x 5 x 3 m top-floor flat, 230 mm brick walls, exposed 150 mm concrete roof, windows on 15 % of the north and south walls, no overhang, windows shut at night, 4 occupants.
- **Floor:** treated as adiabatic, because there is a flat below. On a middle floor the ceiling is treated the same way.
- **Windows:** single clear glass. Half of each window opens, from 06:00 to 22:00, or all day with night ventilation.
- **Heat gains inside:** 100 W per person, and appliances and cooking peaking at 600 W from 18:00 to 22:00.
- **Air leakage:** 1 air change per hour at all times.

## How to use it

All commands run in the project folder with the `.venv` environment active.

| Goal | Command | Result |
|---|---|---|
| Run the baseline and three interventions | `python run_mvp.py` | `outputs/results.csv`, `outputs/heat_index_week.png` |
| Simulate every design combination | `python run_sweep.py` | `outputs/sweep.csv` (about 2.5 minutes) |
| Train and test the prediction model | `python train_surrogate.py` | `outputs/surrogate_metrics.json`, `outputs/surrogate_check.png` |
| Rebuild the tool page | `python make_tool.py` | `outputs/oasis_tool.html` |
| Assess a Rhino model from the command line | `python run_rhino.py data/rhino/sample_flat.3dm` | Safe hours and ranked changes, printed |
| Open the local app with the Rhino upload | `streamlit run app.py` | Opens in the browser |
| Start the web tool | `python run_server.py` | Open http://127.0.0.1:8000 |

### Front end 1: the tool page

`outputs/oasis_tool.html`, also published at https://claude.ai/artifact/Hq4579vYdi6DW9LeV5rPTw (private until shared).

- The user picks nine things: floor level, number of people, window orientation, walls, roof build-up, roof colour, window size, overhang and night ventilation.
- The page shows safe hours out of 168, power-cut hours in danger, peak heat index, heat above the limit, and the hourly chart.
- It ranks the three single changes that add the most safe hours, and shows the best combination for that flat.
- Every answer is a stored EnergyPlus result for exactly that combination. The page does no calculation of its own beyond looking results up and comparing them.
- It works for the fixed 6 x 5 x 3 m room only.

### Front end 2: the local app with Rhino upload

`app.py`, started with `streamlit run app.py`.

- The user uploads a `.3dm` file, or ticks the sample model.
- The app reads the room size and the glass area on each wall, and shows what it read.
- The user picks what the geometry does not say: floor level, people, walls, roof, roof colour, overhang, night ventilation.
- EnergyPlus then simulates that exact geometry on the user's computer, plus one run for every single design change. This takes a few seconds.
- The app shows the same four figures, the top three changes, the week chart, and a table of every change.

The published web page cannot run EnergyPlus, which is why the upload lives in the local app.

### Front end 3: the web tool

`python run_server.py`, then open http://127.0.0.1:8000. A FastAPI back end (`backend/main.py`) runs the simulations; a plain HTML/JS page (`frontend/`) draws the form, figures, ranked changes and week chart.

- Room size and window share can be typed in, or read from an uploaded `.3dm` file.
- Every answer is a live EnergyPlus run of the building plus each single change (8 runs, about 7 to 10 seconds). Repeated requests are cached.
- "Apply" on a ranked change adopts it and re-assesses, so the loop can be stepped through by hand.
- It listens only on this computer and has no login.

| Route | What it does |
|---|---|
| `GET /api/health` | Is the server up |
| `GET /api/options` | Choices, baseline and scenario for the form |
| `POST /api/rhino` | `.3dm` upload to room size and per-wall glass area |
| `POST /api/assess` | Building parameters to safe hours and ranked changes |

### How to draw the Rhino model

| Rule | Detail |
|---|---|
| North | World +Y is north |
| Units | Millimetres, centimetres, decimetres, metres, inches or feet |
| Room | One box on a layer whose name contains `room`, `zone` or `flat` |
| Windows | Flat rectangles on the walls, on a layer whose name contains `window`, `glaz` or `opening` |

Limits of this first version:

- The room is read as its bounding box, so it must be a box aligned with the X and Y axes. Rotated or L-shaped rooms are not handled.
- Each wall gets one centred window with the total glass area found on that wall. Window positions and sill heights are not kept.
- Skylights are ignored, with a warning.
- Overhangs, materials and floor level are not read from the model.

## Results so far

**Baseline and three interventions** (`run_mvp.py`):

| Design | Safe hours of 168 | Gain | Cut hours in danger (of 7) | Peak heat index |
|---|---|---|---|---|
| Baseline | 98 | | 7 | 53.0 °C |
| Cool roof (white coating) | 146 | +48 | 6 | 49.7 °C |
| Roof insulation (50 mm) | 117 | +19 | 6 | 50.6 °C |
| Overhang + night ventilation | 144 | +46 | 7 | 52.9 °C |

The power-cut hour stays in danger on 6 or 7 nights of 7 in all four designs.

**Sweep** (`run_sweep.py`): 1,512 designs, safe hours from 44 to 163, mean 125.

**Prediction model** (`train_surrogate.py`): XGBoost trained on 1,209 designs and tested on 303 held-back designs. R² 0.995, mean error 1.3 safe hours, largest error 6.5. It is not used by either front end yet, because every combination in the sweep is already simulated.

**Sample Rhino model** (`data/rhino/sample_flat.3dm`, 7.0 x 4.5 x 3.0 m, drawn in millimetres): 94 safe hours as drawn. A white roof coating adds 53, night ventilation adds 41, roof insulation adds 20.

## What was checked

- All EnergyPlus runs finish with no severe errors. `oasis/simulate.py` stops on any severe error.
- The baseline in the sweep matches the standalone baseline run (98 safe hours, peak 53.0 °C).
- Adding per-wall windows for the Rhino step did not change the earlier results.
- The Rhino reader converts millimetres to metres correctly on the sample model.
- The local app was run without a browser on the sample model, and its server starts and answers. The sample goes through the same code as an upload.
- Web tool, 10 November: every API route answers; bad input is rejected with a clear message; in Chrome the page loads with no console errors, the baseline shows 98 safe hours, uploading `sample_flat.3dm` gives 94 with white roof +53, and "Apply" on the white roof re-assesses to 147.

Not checked:

- The sample model was written with the `rhino3dm` library, not saved from Rhino. A file saved from Rhino has not been tried.
- The tool page has not been looked at in a browser by the author of this note.

## Calibration against measured homes (10 November 2026, first pass)

**Data.** Tasgaonkar et al. (2022), *Scientific Data* 9:285, files from Figshare (doi 10.6084/m9.figshare.12546368.v1, CC0), saved in `data/measured/`. The dataset has no Chennai site. Dhaka is used because it is the closest climate (hot and humid). Twelve homes were selected: concrete roof, no flat above, ceiling fans, no air-conditioning or coolers, and complete logger data. They form two groups of six by wall type (single and double brick). The Dhaka weather station data was turned into a weather file (`data/weather/dhaka_2016.epw`), with total sunlight split into direct and diffuse by the Erbs model.

**Method.** Each group was modelled as the OASIS flat with that wall type and the group's typical household. Every combination of the uncertain settings was simulated. The settings were fitted on 16 May to 30 June 2016 and checked on July and August, which were not used for fitting. Run with `python calibrate.py` and `python plot_calibration.py`. Results are in `outputs/calibration/`, and round 1 is kept as `round1_*`.

**Result.** Hourly error of indoor air temperature against the mean of each group's homes:

| Group | Current settings: fit | Calibrated: fit | Calibrated: check (Jul–Aug) |
|---|---|---|---|
| Single brick | 3.6 °C (model 3.1 °C too hot) | 0.8 °C (+0.2 °C) | 0.7 °C (0.0 °C) |
| Double brick | 3.9 °C (+3.6 °C) | 0.9 °C (+0.5 °C) | 0.8 °C (+0.5 °C) |

The best settings, one set for both groups, are below.

| Setting | Current | Calibrated |
|---|---|---|
| East and west walls | outside | shared with neighbours |
| Air leakage | 1 ach | 8 ach |
| Airflow factor | 0.2 | 1.6, against the weak city-station wind (about 0.5 m/s) |
| Total air change | 1.8 ach | about 14 ach |
| Appliance heat, evening peak | 600 W | 200 W |
| Internal mass (partition area) | 0 | 160 m² |

**What it means.**

- **The current model is too hot.** The main causes are too little air exchange, all four walls exposed to the sun, and too little stored heat.
- **Several different combinations fit almost equally well.** For example, airflow factor 0.4 with 16 ach scores 0.89 °C against 0.84 °C for the best set. The data constrains the *total* air change, about 10 to 20 ach, more than how it is split between windows and leaks.
- **Two settings are still at the edge of the range tried.** Appliance heat is at its lowest value (200 W) and internal mass at its highest (160 m²). 160 m² is about five times the floor area, which is more than a real flat holds, so it probably stands in for something the model lacks. A likely candidate is a heavier roof: these homes have a cement layer over the concrete.
- **The model still swings too much over the day and peaks too early.** The swing is 3.5 against 2.7 °C, and the peak comes at 14:00 instead of 16:00–17:00. With so much outside air, the room follows the outdoor temperature too closely.

**Effect on Chennai (test only, defaults not changed).** These are runs of the baseline flat in the heatwave week:

| Settings | Safe hours | Cut hours in danger | Mean indoor | Air change |
|---|---|---|---|---|
| Current | 98 / 168 | 7 | 37.7 °C | 3.4 ach |
| Calibrated, airflow 0.2 (keeps total air change near the Dhaka value) | 159 / 168 | 6 | 35.7 °C | 10 ach |
| Calibrated, airflow 1.6 | 166 / 168 | 0 | 34.8 °C | 27 ach |

The airflow factor was fitted against the Dhaka station's weak wind, and the Chennai file has airport wind. So the transferable result is the total air change, not the factor itself. The calibrated mean of 35.7 °C sits inside the 31 to 35 °C range of the Chennai SRIHER study, which supports the change. Switching the defaults would change every result, the 1,512-design sweep and the prediction model, so it is a decision still to be made.

## Known gaps and assumptions

**The model does not yet match measured Chennai homes.** The Chennai study (Climate Trends and SRIHER, 2026) found indoor temperatures of about 31 to 35 °C, humidity above 75 % and a peak at 20:00 to 21:00. The baseline here runs 34 to 41.7 °C, with humidity near 44 % and a peak around 15:00. The simulated week is hotter and drier than the study period, and the flat is a top-floor worst case. The first calibration on Dhaka homes (above) brings the mean down to 35.7 °C, but those settings are not yet the defaults.

Assumptions that are placeholders or guesses, all as named constants in the code:

| Assumption | Value | File |
|---|---|---|
| Danger limit | 41 °C heat index, to be replaced by health-based thresholds (Chen et al.) | `oasis/metrics.py` |
| Fan benefit | 2 °C, to be replaced by the ASHRAE 55 cooling effect | `oasis/metrics.py` |
| Airflow factor | 0.2, scales window airflow down from open-airport wind | `oasis/build_idf.py` |
| Appliance heat | 600 W evening peak | `oasis/build_idf.py` |
| Air leakage | 1 air change per hour | `oasis/build_idf.py` |
| Material properties | Starting values; the AAC block figures were entered from memory | `oasis/build_idf.py` |

Other gaps:

- **Cost:** not included, so changes are ranked by safe hours only.
- **Microclimate:** the airport weather file is cooler than a dense street.
- **One room, one week, one city.**

## Next steps

1. Finish calibration. The first pass on Dhaka homes is done (see above). Still to do:
   1. Decide whether to adopt the calibrated settings as defaults, then re-run the sweep and retrain the prediction model.
   2. Try a heavier roof in place of the large internal mass.
   3. Check humidity against the two Dhaka homes that logged it.
   4. Check against the Delhi homes.
2. Check material properties against ENS 2024.
3. Replace the 41 °C limit and the 2 °C fan benefit with the health-based and ASHRAE methods.
4. Add cost per measure and rank by safe hours per rupee.
5. Add room size to the sweep, so the prediction model can answer for Rhino models without a live simulation.
6. Review slides (step 8 of the start guide).

## File map

| Path | What it is |
|---|---|
| `config.py` | Paths, heatwave week, power-cut hours |
| `oasis/params.py` | Baseline building, interventions, sweep levels |
| `oasis/build_idf.py` | Parameters to EnergyPlus model |
| `oasis/simulate.py` | Runs EnergyPlus, fails on severe errors |
| `oasis/metrics.py` | Heat index and safe hours |
| `oasis/plot.py` | Week chart |
| `oasis/from_rhino.py` | Rhino model to parameters |
| `oasis/assess.py` | Live assessment of one building and its single changes |
| `oasis/measured.py` | Reads the measured-homes dataset (mixed date formats handled) |
| `oasis/weather_file.py` | Weather-station data to an EnergyPlus weather file |
| `calibrate.py`, `plot_calibration.py` | Calibration on Dhaka homes and its plots |
| `data/measured/` | Tasgaonkar et al. 2022 files for Dhaka and Delhi |
| `run_mvp.py`, `run_sweep.py`, `train_surrogate.py`, `make_tool.py`, `run_rhino.py` | The commands in the table above |
| `make_sample_rhino.py` | Writes the sample Rhino model |
| `app.py` | Local app with the Rhino upload |
| `run_server.py`, `backend/main.py` | Web tool server and API |
| `frontend/` | Web tool page (`index.html`, `app.js`, `style.css`) |
| `oasis/labels.py` | Display names for each design choice |
| `tool/template.html` | Layout of the tool page |
| `check_baseline.py`, `test_run.py` | Early checks from the first steps |
| `outputs/` | All results; safe to delete and regenerate |
