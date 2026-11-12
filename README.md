# OASIS — Overheating Assessment System for Intervention Strategies

OASIS is a design-stage tool for new free-running residential flats (PMAY-style) in hot-humid
Indian cities, starting with **Chennai**. It answers two questions:

1. **How many safe hours does this flat give its occupants in a heatwave week?**
2. **Which single design change buys the most safe hours?**

Master's thesis project: Master in AI for Architecture and the Built Environment, IAAC Barcelona, 2026/27.

> Status (12 Nov 2026): working prototype. Material properties, the fan credit and the safe limit
> are still placeholders until calibration is finished, so treat results as relative (which change is
> better), not absolute.

---

## The test scenario

| | |
|---|---|
| Weather | Chennai EPW (`data/weather/chennai.epw`) |
| Period | 10–16 May, the hottest week: 7 days × 24 h = **168 hours** |
| Power cut | Every night **20:00–21:00**: ceiling fans off |
| Safe hour | Indoor **heat index < 41 °C** (US NWS formula on indoor air temperature + humidity) |
| Fan credit | When fans run, air temperature is lowered by **2 °C** before the heat index is computed; no credit during the cut |
| Building | One free-running room/flat (no AC), modelled as a single EnergyPlus zone |

The limit and fan credit live in `oasis/metrics.py` (`SAFE_LIMIT_C`, `FAN_CREDIT_C`).
Scenario dates and cut hours live in `config.py`.

---

## How one assessment works

```
 inputs (form or Rhino .3dm)
        │
        ▼
 build IDF from scratch (eppy)          oasis/build_idf.py   ← written one by one (eppy is not thread-safe)
   design + one variant per single change
        │
        ▼
 EnergyPlus 26.2, runs in parallel      oasis/simulate.py    ← each run in its own folder, Severe errors are fatal
        │
        ▼
 hourly indoor air temp + RH ──► heat index ──► safe hours   oasis/metrics.py
        │
        ▼
 rank changes by safe hours gained      oasis/assess.py
        │
        ▼
 JSON to the web tool                   backend/main.py  (POST /api/assess, results cached)
```

For each assessment OASIS simulates **your design plus every single change** to it (other wall,
roof build-up, roof colour, overhang, night ventilation). On a middle floor the roof changes are
skipped, because the roof belongs to the flat above. A full assessment takes roughly 5–15 s, and a
repeated design comes back instantly from the server cache.

---

## The web tool (main interface)

### Start it

```powershell
.venv\Scripts\python.exe run_server.py
```

Open **http://127.0.0.1:8000**. The tool simulates the baseline flat straight away.

### Layout

**Left: the input sheet**

| Block | Inputs |
|---|---|
| **01 Room** | Import a Rhino `.3dm` (or *use sample flat*), or type length (E–W), width (N–S), ceiling height and window-to-wall ratio; windows facing N & S or E & W |
| **02 Envelope** | Walls (230 mm brick / 115 mm brick / 200 mm AAC, U-value shown), roof build-up (bare slab / + 50 mm insulation), roof colour (solar absorptance α 0.7 / 0.4 / 0.2), window overhang (none / 0.6 m) |
| **03 Position & use** | Floor level (top / middle), people living there (2 / 4 / 6), windows at night (shut 22:00–06:00 / open all night) |

Press **Simulate week**. If you change an input after a run, the button turns orange
(*Re-simulate · inputs changed*) so you always know whether the results match the inputs.

**Right: the result**, read from top to bottom:

1. **Verdict**: safe hours out of 168 in large type, one sentence on hours above the limit, and four
   facts: safe hours (with change since the first run), power-cut hours in danger (out of 7), peak
   felt heat, peak indoor air temperature.
2. **The week, hour by hour**: a 7 × 24 grid, one cell per hour. Pale cells are below the limit and
   orange/red cells are above it (darker is hotter). Outlined cells are the power cut. Below it, a
   line chart of felt heat against the 41 °C limit, with outdoor air dotted and the power-cut hours
   shaded. Hover either one: the grid, the chart cursor and the readout line (date, felt heat,
   indoor air, RH, outdoor) all follow the same hour.
3. **What to change, ranked**: every single change, best first, with a bar and **±hours gained**.
   - **Hover** a change to preview it: its felt-heat line is drawn in green on the chart, the grid
     shows its week, and a green dot marks each hour it turns from danger to safe.
   - **Apply** makes that change part of the design and re-simulates. The ranking is then recomputed
     for the new design, because changes interact. Example: on the baseline, roof insulation gains
     +19 h, but once the roof is white it *loses* 15 h (likely because it then mainly slows night-time heat loss through the roof).
4. **Household (body check)**: each adult in the household is run through **JOS-3**
   (Takahashi et al. 2021, via `pythermalcomfort`) hour by hour, using EnergyPlus's indoor air
   temperature, mean radiant temperature and humidity, an air speed of 0.8 m/s under the fan /
   0.4 m/s elsewhere / 0.1 m/s during the cut, and a daily routine (`oasis/agents.py`). An hour is
   unsafe for a person when the core reaches **38.0 °C** (ISO 7933:2023 limit). This is the
   *check* on the heat index: a line under the verdict says in how many hours the two agree.
   Children are listed but not simulated, because JOS-3 is an adult model and no validated child heat model exists; the heat-index safe hours cover them.
5. **Design trail**: every run in order with its safe hours and the step's gain. **Undo last**
   steps back one run.

### Example run (baseline top-floor flat, 6 × 5 × 3 m, 230 mm brick, grey RCC roof, WWR 15 %)

| Step | Safe hours |
|---|---|
| Starting design | 98 |
| + Roof colour: white coating | 146 (+48) |
| next best: windows open all night | +14 |

### Rhino import

Draw the room as a box on a layer named `room` / `zone` / `flat` and the glass as surfaces or boxes
on a layer named `window` / `glaz` / `opening`. +Y is north. On import the tool reads the size and
the glass area per wall (`oasis/from_rhino.py`), locks the geometry inputs, and shows any warnings
(e.g. a window larger than its wall is limited to 90 %). Click *remove* to go back to typed dimensions.

### API

| Route | Purpose |
|---|---|
| `GET /api/health` | `{"status": "ok"}` |
| `GET /api/options` | form choices, baseline, scenario, U-values, surrogate and calibration metrics |
| `POST /api/rhino` | upload a `.3dm` → geometry + report |
| `POST /api/rhino/sample` | load `data/rhino/sample_flat.3dm` |
| `POST /api/assess` | building parameters → summary, 168 h series, ranked changes |

The previous "workbench" UI (3D twin, psychrometric chart, matrix modal) is kept in
`frontend/legacy/` for reference. It is not served.

---

## Other interfaces

| Interface | Command | Notes |
|---|---|---|
| Static HTML lookup tool | `python make_tool.py` → `outputs/oasis_tool.html` | Offline, instant. It looks designs up in the 1,512-run sweep, so no live simulation and no custom room sizes |
| Streamlit app | `streamlit run app.py` | Older local UI with `.3dm` upload and live simulation |
| CLI | `python run_rhino.py data/rhino/sample_flat.3dm` | Prints safe hours and ranked changes |

---

## Research pipeline

| Task | Command | Outputs |
|---|---|---|
| Baseline + 3 MVP interventions | `python run_mvp.py` | `outputs/results.csv`, `hourly.csv`, `heat_index_week.png` |
| Full parameter sweep (1,512 runs) | `python run_sweep.py` | `outputs/sweep.csv`, `sweep_hourly.csv` |
| XGBoost surrogate | `python train_surrogate.py` | `outputs/surrogate.json`, `surrogate_metrics.json` |
| Calibration vs Dhaka loggers | `python calibrate.py` then `python plot_calibration.py` | `outputs/calibration/` |

Checks: `python test_run.py` (EnergyPlus smoke test) and `python check_baseline.py` (baseline sanity stats).

---

## Setup

- Windows, Python 3.13 in `.venv` (`pip install -r requirements.txt`)
- EnergyPlus 26.2 at `D:\IAAC\ENERGY PLUS\energyplus.exe` (path in `config.py`)

## Project layout

```
config.py            paths, run period, power-cut hours
oasis/               model builder, simulation runner, metrics, assessment, Rhino reader, labels
backend/main.py      FastAPI server
frontend/            web tool (index.html, style.css, app.js); legacy/ = previous UI
tool/template.html   template for the static HTML tool
data/                weather, Rhino sample, measured logger data
outputs/             generated, safe to delete and regenerate
docs/                OASIS_tool_overview.md
```

## Known limitations

- Single-zone model: no inter-room airflow and no neighbouring flats other than "middle floor" (adiabatic ceiling).
- `FAN_CREDIT_C` and `SAFE_LIMIT_C` are placeholders (to be replaced with the ASHRAE 55 fan effect and published thresholds).
- Calibration is still in progress: parameters sit at grid edges, and the simulated daily peak (~14:00) comes earlier than measured (16:00–17:00).
- The body check covers adults only; no validated child thermoregulation model is used.
- No intervention costs yet: changes are ranked by hours, not hours per rupee.
- The server has no login. It listens on 127.0.0.1 only.
