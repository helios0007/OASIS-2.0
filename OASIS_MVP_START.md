# OASIS MVP: start guide

**Goal for the review:** run the OASIS loop once on one Chennai flat.

> Build one flat → simulate a heatwave week with a nightly 8–9 PM power cut → calculate safe hours → apply an intervention → re-simulate → compare.

Everything runs from Python in VS Code. EnergyPlus works in the background as the calculation engine.

---

## 0. Project context (read this first)

### 0.1 What OASIS is
**OASIS: Overheating Assessment System for Intervention Strategies.**
Master's thesis, Master in AI for Architecture and the Built Environment (MAAI), IAAC Barcelona, 2026/27. Author: Nithik Vairamuthu. Final submission: June 2027.

OASIS is a **design-stage tool for new residential buildings in hot-humid Indian cities**. It predicts how many **safe hours** a home gives its occupants during a **heatwave combined with a night-time power cut**, and tests which **design choices** (roof, walls, windows, shading, ventilation, backup power) actually add safe hours, at the least cost.

### 0.2 The problem
- In Chennai, homes stay hot at night. A 2026 study of 50 low- and middle-income homes (Climate Trends & SRIHER) found that indoor temperature rarely drops below 31 °C and humidity stays above 75 %. The indoor peak is about **34.7 °C at 8–9 PM**.
- Evening power cuts of **40–60 minutes** land exactly on that peak. They switch off the ceiling fan, which is the only cooling most of these homes have.
- In humid heat, the danger is the **heat index** (temperature + humidity), not air temperature alone.
- The **heat–power trap:** heatwaves raise cooling demand → the grid peaks in the evening → cuts happen → the homes with least protection lose their only relief.

### 0.3 Why new homes (the design-stage pivot)
- Retrofitting existing homes is mostly a problem of money, ownership and policy, not design.
- India is building fast. About **80 % of the buildings India will have in 2070 are not built yet**, and government schemes (PMAY) deliver around **46 lakh homes a year**.
- Wall, roof, orientation and ventilation are chosen **once**, on the drawing board, where a better choice costs little.
- Evidence: in Phoenix, homes built after 2018 had **< 550 °C·h** of overheating in a 7-day outage vs **> 800 °C·h** for pre-1950 homes (Shi et al. 2025). PCM walls are more economical in new construction than in retrofit (Xu & Han 2026).
- Existing homes are still used: as the **validation set** (measured data) and for **no-cost / low-cost advice** only.

### 0.4 Research question
> How can an AI-accelerated simulation tool predict, at the design stage, how many hours a new home in a hot-humid Indian city stays safe during a heatwave with a night-time power cut, and which design choices extend those hours at the least cost?

| Sub-question | Topic |
|---|---|
| RQ1 | What indoor heat limit defines a **safe hour** in Chennai? |
| RQ2 | Which **design choices** add the most safe hours? |
| RQ3 | Do chosen measures still work when **re-simulated** and checked against **real homes**? |
| RQ4 | How much **evening peak cooling load** do they avoid? (grid) |

### 0.5 The OASIS loop
1. **Diagnose:** safe hours of the design as drawn.
2. **Intervene:** change a wall, roof, opening or backup.
3. **Re-simulate:** same heatwave, same power cut.
4. **Reassess:** did safe hours really rise? If not → back to 2.
5. **Verify:** check against measured Indian homes.

### 0.6 Full pipeline (thesis, not just the MVP)
```
Building parameters + Chennai weather + power-cut schedule
        │
        ▼
Python builds the EnergyPlus model (.idf)
        │
        ▼
EnergyPlus → hourly indoor temperature + humidity
        │
        ▼
Safe-hours calculation (heat index, fan on / off)
        │
        ├──► Intervention loop (change one parameter, re-run)
        │
        ▼
Results (chart + table)
        │
        ▼  (later)
Hundreds of runs → train AI surrogate (XGBoost) → instant predictions
        │
        ▼  (later)
Interface: user enters building parameters → safe hours + top interventions
```
- **The user enters parameters, not drawings** (roof type, wall type, window size, orientation, floor level, occupants). This also works for homes without plans.
- **EnergyPlus runs offline** to generate training data. The user-facing tool answers from the AI model in seconds.

### 0.7 Key literature behind the method
| Study | What OASIS takes from it |
|---|---|
| Rajput et al. 2022 (Phoenix) | House types as inputs; thermal mass; small battery backup halves excess heat |
| Chen et al. 2024 (Guangzhou, hot-humid) | Health-based safe-hours limit: heat-index hours (1,174 °C·h young, 850 °C·h elderly) |
| Shi et al. 2025 (Phoenix, city scale) | Indicators: time to danger, peak, duration, severity; microclimate matters (13 % error if ignored) |
| Xu & Han 2026 (US zones) | Test pattern baseline vs measure vs combined; PCM + night ventilation up to 4.4 °C cooler |
| Mehraban et al. 2025 | AI surrogate (XGBoost) on 16,856 outage runs, R² 0.94–0.99: the AI step is feasible |
| An 2026 (KU Leuven) | Realistic outage profiles from grid records |
| Rostami 2024 | Cost per measure; low willingness to pay → cheap measures first |
| Tasgaonkar et al. 2022 | Open South Asia indoor dataset (206 loggers): validation |
| Chung et al. 2019 (Delhi) | Thicker brick can **raise** risk; test "more mass", don't assume it |
| ENS 2024 (BEE) | Indian residential energy code: the baseline (RETV ≤ 15 W/m², roof U ≤ 1.2, openable windows ≥ 16.66 % of floor area in warm-humid) |

**What is new in OASIS:** none of these join the pieces for hot-humid India: health-based safe hours + short nightly cuts + Indian construction + cost per measure + AI speed + validation on Indian homes.

### 0.8 Scope
**In:** new residential buildings (PMAY-type flats), Chennai (main), Delhi (validation data), free-running homes with ceiling fans, nightly evening cuts, passive design + small backup.
**Out (for now):** outdoor microclimate, informal settlements, retrofit programmes, AC-equipped homes, city-scale maps.

### 0.9 Glossary
| Term | Meaning |
|---|---|
| Safe hour | An hour where indoor heat index stays below the danger limit (MVP: 41 °C) |
| Heat index | "Feels-like" temperature from air temperature + humidity (US NWS formula) |
| °C·h (degree-hours) | Degrees above a limit × hours, summed over a period |
| EPW | EnergyPlus weather file (hourly outdoor conditions for a year) |
| IDF | EnergyPlus model file (the building as text) |
| Free-running | No air-conditioning; indoor temperature floats with weather |
| Surrogate model | AI model trained on simulation results to predict them instantly |
| PMAY | Pradhan Mantri Awas Yojana, India's government housing scheme |
| ENS | Eco-Niwas Samhita, India's residential energy code |

### 0.10 Notes for coding assistants (Copilot / Claude in VS Code)
- **OS:** Windows. **EnergyPlus 26.2** is installed at `D:\IAAC\ENERGY PLUS\` (note the space; always quote the path or pass it as a list item to `subprocess`).
- **Language:** Python 3.11+ (3.13 in the project `.venv`), plain scripts, no Grasshopper or Rhino plugins.
- **Engine:** EnergyPlus via its command line (`energyplus -w <epw> -d <dir> -r <idf>`); models are built/edited with `eppy`.
- **Units:** SI throughout (°C, m, W/m²K, %). Heat-index formula works internally in °F; convert at the edges.
- **Placeholders to keep visible:** `FAN_CREDIT_C = 2.0`, `SAFE_LIMIT_C = 41.0`. They will be replaced by ASHRAE cooling effect and Chen et al. thresholds.
- **Keep it simple:** one zone, one flat, one week for the MVP. Readable code over clever code; every function short and commented.
- **Always check** `eplusout.err` after a run; treat any `** Severe **` as a failure.

---

## 1. Install (one time)

### 1.1 Software
| What | Where | Notes |
|---|---|---|
| Python 3.11 or newer (3.13 in use) | python.org | Tick "Add to PATH" on Windows |
| VS Code | code.visualstudio.com | |
| VS Code extensions | Extensions panel | **Python**, **Jupyter**, **Rainbow CSV** (for reading results) |
| EnergyPlus 26.2 | github.com/NREL/EnergyPlus/releases | Download the installer for your OS and install with defaults |

Installed at `D:\IAAC\ENERGY PLUS\` (done). Check:
```powershell
& "D:\IAAC\ENERGY PLUS\energyplus.exe" --version
```
You should see `EnergyPlus, Version 26.2.0`.

### 1.2 Weather file
1. Go to **climate.onebuilding.org** → WMO Region 2 Asia → India → Tamil Nadu.
2. Download the **Chennai** file (ISHRAE 2014 or TMYx) and unzip it.
3. Copy the `.epw` file to `data/weather/chennai.epw`.

### 1.3 Project folder
```
oasis-mvp/
├── OASIS_MVP_START.md      ← this file
├── requirements.txt
├── config.py               ← paths and settings
├── data/
│   └── weather/
│       └── chennai.epw
├── oasis/
│   ├── __init__.py         ← empty file
│   ├── params.py           ← building parameters and interventions
│   ├── build_idf.py        ← parameters → EnergyPlus model file (.idf)
│   ├── simulate.py         ← runs EnergyPlus
│   ├── metrics.py          ← heat index and safe hours
│   └── plot.py             ← chart
├── run_mvp.py              ← runs the whole loop
└── outputs/                ← created automatically
```

### 1.4 Python environment
In the VS Code terminal, inside `oasis-mvp/`:
```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```
Select the `.venv` interpreter in VS Code (bottom right, or Ctrl/Cmd+Shift+P → "Python: Select Interpreter").

**requirements.txt**
```
pandas
numpy
matplotlib
eppy
```
(`xgboost` and `pythermalcomfort` come later, not needed for the MVP.)

---

## 2. Settings: `config.py`
```python
from pathlib import Path

ROOT = Path(__file__).parent
EPW = ROOT / "data" / "weather" / "chennai.epw"
OUT = ROOT / "outputs"

ENERGYPLUS = r"D:\IAAC\ENERGY PLUS\energyplus.exe"

# Heatwave week to simulate (check the EPW for the hottest May week)
RUN_START = (5, 15)   # (month, day)
RUN_END   = (5, 21)

# Nightly power cut (24 h clock): fans stop 20:00–21:00
CUT_START_HOUR = 20
CUT_END_HOUR = 21
```

---

## 3. The building as parameters: `oasis/params.py`

A PMAY-style one-bedroom flat, **top floor** (worst case: exposed roof). For the MVP it's a **single room box**.

```python
BASELINE = {
    "name": "baseline",
    "length_m": 6.0,           # 6 x 5 m ≈ 30 m²
    "width_m": 5.0,
    "height_m": 3.0,
    "orientation_deg": 0,      # 0 = long side faces north
    "wall": "brick_230",       # 230 mm brick + plaster
    "roof": "rcc_150",         # 150 mm concrete slab, exposed
    "roof_solar_absorptance": 0.7,   # grey concrete
    "wwr": 0.15,               # window-to-wall ratio
    "shading_depth_m": 0.0,    # window overhang
    "night_vent": False,       # windows open at night?
    "occupants": 4,
}

INTERVENTIONS = {
    "cool_roof":     {"roof_solar_absorptance": 0.2},  # white reflective coating
    "roof_insul":    {"roof": "rcc_150_insul_50"},     # + 50 mm insulation
    "shade_nightvent": {"shading_depth_m": 0.6, "night_vent": True},
}

def variant(name):
    """Baseline with one intervention applied."""
    p = dict(BASELINE)
    p.update(INTERVENTIONS[name])
    p["name"] = name
    return p
```

**Materials** (put in `build_idf.py`). Starting values; check them against ENS 2024 or the ISHRAE handbook later:

| Layer | Thickness (m) | Conductivity (W/m·K) | Density (kg/m³) | Specific heat (J/kg·K) |
|---|---|---|---|---|
| Cement plaster | 0.015 | 0.72 | 1760 | 840 |
| Burnt clay brick | 0.230 | 0.81 | 1820 | 880 |
| RCC slab | 0.150 | 1.58 | 2288 | 880 |
| EPS insulation | 0.050 | 0.035 | 24 | 1340 |

---

## 4. Parameters → EnergyPlus model: `oasis/build_idf.py`

The simplest approach is to **build the IDF from an empty file with `eppy`**, adding every object from Python.

**Step 4.1: No template needed.**
EnergyPlus 26.2 does not ship `ExampleFiles/MinimalFile.idf`, so `build_idf.py` starts from an empty IDF (`IDF(StringIO("Version,26.2;"))`) and adds the simulation settings itself.

**Step 4.2: What the script must add.** Each item maps to one EnergyPlus object:

| Need | EnergyPlus object |
|---|---|
| Location and weather period | `Site:Location` (from EPW), `RunPeriod` |
| Materials and layers | `Material`, `Construction` |
| The room | `Zone` |
| 4 walls, roof, floor | `BuildingSurface:Detailed` (floor = `Adiabatic`, since there's a flat below) |
| Windows | `FenestrationSurface:Detailed` + `WindowMaterial:SimpleGlazingSystem` (U ≈ 5.8, SHGC ≈ 0.8, single glass) |
| Overhang | `Shading:Zone:Detailed` or `Shading:Overhang` |
| People and heat from them | `People` + schedules |
| Window ventilation | `ZoneVentilation:WindandStackOpenArea` with an opening schedule |
| No AC (free-running) | no HVAC objects at all |
| Outputs | `Output:Variable` for the 3 variables below, hourly |

**Outputs to request:**
```
Zone Mean Air Temperature
Zone Air Relative Humidity
Site Outdoor Air Drybulb Temperature
```

**Skeleton:**
```python
from eppy.modeleditor import IDF
from pathlib import Path
import config

IDF.setiddname(str(Path(config.ENERGYPLUS).parent / "Energy+.idd"))

def build_idf(p: dict, out_path: Path) -> Path:
    idf = IDF(StringIO("Version,26.2;"))   # empty model, no template

    # 1. RunPeriod  (config.RUN_START → config.RUN_END)
    # 2. Materials + constructions  (wall, roof variants from p["wall"], p["roof"])
    #    roof outer layer: set Solar_Absorptance = p["roof_solar_absorptance"]
    # 3. Zone + 6 surfaces from p["length_m"], p["width_m"], p["height_m"]
    # 4. Windows sized by p["wwr"] on the two long walls
    # 5. Overhang if p["shading_depth_m"] > 0
    # 6. People: p["occupants"], always home in the evening and at night
    # 7. Ventilation: windows open daytime; also at night if p["night_vent"]
    # 8. Output:Variable (hourly) for the 3 variables above
    # TODO: fill in each block

    idf.saveas(str(out_path))
    return out_path
```

> **Tip:** build steps 1–3 first, run it, and check that EnergyPlus finishes without errors before adding windows and ventilation. Read `outputs/<run>/eplusout.err` after every run.

---

## 5. Run EnergyPlus: `oasis/simulate.py`
```python
import subprocess
from pathlib import Path
import config

def run(idf_path: Path, run_dir: Path) -> Path:
    run_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [config.ENERGYPLUS,
         "-w", str(config.EPW),
         "-d", str(run_dir),
         "-r",                 # also write eplusout.csv
         str(idf_path)],
        check=True,
    )
    return run_dir / "eplusout.csv"
```

---

## 6. Safe hours: `oasis/metrics.py`

### 6.1 Heat index (US National Weather Service formula)
```python
import numpy as np
import pandas as pd

def heat_index_c(t_c, rh):
    """Heat index in °C from air temperature (°C) and relative humidity (%)."""
    t = np.asarray(t_c) * 9 / 5 + 32
    rh = np.asarray(rh)
    simple = 0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094)
    full = (-42.379 + 2.04901523 * t + 10.14333127 * rh
            - 0.22475541 * t * rh - 0.00683783 * t**2
            - 0.05481717 * rh**2 + 0.00122874 * t**2 * rh
            + 0.00085282 * t * rh**2 - 0.00000199 * t**2 * rh**2)
    adj_low = ((13 - rh) / 4) * np.sqrt(np.clip((17 - np.abs(t - 95)) / 17, 0, None))
    full = np.where((rh < 13) & (t > 80) & (t < 112), full - adj_low, full)
    adj_high = ((rh - 85) / 10) * ((87 - t) / 5)
    full = np.where((rh > 85) & (t > 80) & (t < 87), full + adj_high, full)
    hi_f = np.where((simple + t) / 2 >= 80, full, simple)
    return (hi_f - 32) * 5 / 9
```

### 6.2 Danger bands (NWS, in °C)
| Band | Heat index |
|---|---|
| Caution | 27–32 |
| Extreme caution | 32–41 |
| **Danger** | **41–54** |
| Extreme danger | > 54 |

**MVP definition: a safe hour is an hour with indoor heat index below 41 °C (below "Danger").**
This is a placeholder. Later, replace it with Chen et al.'s health thresholds (heat-index hours, separate limits for elderly occupants).

### 6.3 The fan and the power cut
EnergyPlus gives air temperature only. It doesn't know a ceiling fan cools the person.
- **MVP shortcut:** when the fan is on, subtract a fixed **fan credit of 2 °C** from the temperature before calculating heat index. During the 8–9 PM cut, no credit.
- **Later:** replace the fixed credit with `pythermalcomfort`'s cooling-effect calculation (ASHRAE 55, based on air speed).
- Say this openly in the review; it's a known limit of the MVP.

```python
import config

FAN_CREDIT_C = 2.0   # placeholder, see 6.3
SAFE_LIMIT_C = 41.0  # placeholder, see 6.2

def safe_hours(csv_path, zone="ZONE ONE"):
    df = pd.read_csv(csv_path)
    t = df[[c for c in df.columns if "Zone Mean Air Temperature" in c][0]]
    rh = df[[c for c in df.columns if "Zone Air Relative Humidity" in c][0]]
    hour = pd.Series(range(len(df))) % 24          # hour of day, 0–23
    cut = hour.between(config.CUT_START_HOUR, config.CUT_END_HOUR - 1)
    t_felt = t - np.where(cut, 0.0, FAN_CREDIT_C)
    hi = heat_index_c(t_felt, rh)
    return {
        "hours_total": len(df),
        "safe_hours": int((hi < SAFE_LIMIT_C).sum()),
        "danger_hours": int((hi >= SAFE_LIMIT_C).sum()),
        "max_heat_index_c": round(float(np.max(hi)), 1),
        "max_indoor_temp_c": round(float(t.max()), 1),
    }, pd.DataFrame({"t_in": t, "rh_in": rh, "heat_index": hi, "cut": cut})
```
> Check the exact column names in your `eplusout.csv` (open it with Rainbow CSV) and adjust the filters if needed.

---

## 7. The loop: `run_mvp.py`
```python
import pandas as pd
import config
from oasis.params import BASELINE, INTERVENTIONS, variant
from oasis.build_idf import build_idf
from oasis.simulate import run
from oasis.metrics import safe_hours
from oasis.plot import plot_runs

config.OUT.mkdir(exist_ok=True)
designs = [BASELINE] + [variant(n) for n in INTERVENTIONS]

rows, series = [], {}
for p in designs:
    run_dir = config.OUT / p["name"]
    idf = build_idf(p, config.OUT / f"{p['name']}.idf")   # 1. build
    csv = run(idf, run_dir)                                # 2. simulate
    summary, hourly = safe_hours(csv)                      # 3. reassess
    rows.append({"design": p["name"], **summary})
    series[p["name"]] = hourly

table = pd.DataFrame(rows)
base = table.loc[table.design == "baseline", "safe_hours"].iloc[0]
table["safe_hours_gained"] = table["safe_hours"] - base
table.to_csv(config.OUT / "results.csv", index=False)
print(table)

plot_runs(series, config.OUT / "heat_index_week.png")     # 4. compare
```

## 8. The chart: `oasis/plot.py`
```python
import matplotlib.pyplot as plt

def plot_runs(series: dict, out_png):
    fig, ax = plt.subplots(figsize=(12, 4))
    first = next(iter(series.values()))
    for i, is_cut in enumerate(first["cut"]):
        if is_cut:
            ax.axvspan(i, i + 1, color="orange", alpha=0.2, lw=0)
    for name, df in series.items():
        ax.plot(df["heat_index"].values, label=name, lw=1.5)
    ax.axhline(41, color="red", ls="--", lw=1, label="Danger (41 °C)")
    ax.set_xlabel("Hour of heatwave week")
    ax.set_ylabel("Indoor heat index (°C)")
    ax.legend(ncol=5, fontsize=8)
    fig.tight_layout()
    fig.savefig(out_png, dpi=200)
```

---

## 9. Order of work

| # | Task | Done when |
|---|---|---|
| 1 | Install EnergyPlus and Python, get the Chennai EPW | `energyplus --version` works |
| 2 | Run `ExampleFiles\1ZoneUncontrolled.idf` with the Chennai EPW (`test_run.py`) | `eplusout.csv` appears |
| 3 | `build_idf.py`: room box + walls + roof, no windows | Runs without severe errors |
| 4 | Add windows, people, ventilation, outputs | Indoor temp looks plausible |
| 5 | **Sanity check** against the Chennai study | Indoor ~31–35 °C, RH > 70 %, peak in the evening |
| 6 | `metrics.py`: safe hours for baseline | Numbers printed |
| 7 | Run the 3 interventions with `run_mvp.py` | `results.csv` + chart |
| 8 | Slides: method, chart, table, limits, next steps | |

If step 5 fails (indoor too cool or too hot), check the roof absorptance, the ventilation rates and the floor (adiabatic) before anything else.

---

## 10. What to say about limits in the review
- **One room, one flat type, one week.** Scaling up is the next phase.
- **The fan credit (2 °C) and the danger line (41 °C) are placeholders.** They'll be replaced with ASHRAE cooling effect and Chen et al.'s health thresholds.
- **No outdoor microclimate yet.** The airport weather file runs cooler than a dense street.
- **Not yet validated.** The next step is comparing with measured Indian homes (Tasgaonkar dataset, Chennai SRIHER study).

## 11. After the MVP
1. Sweep: 4–5 parameters × several levels → 100–300 runs (loop over `params`).
2. Train XGBoost on the runs: inputs = parameters, output = safe hours.
3. Compare predicted vs simulated.
4. Simple interface (Streamlit): the user enters the building and gets safe hours + the top 3 interventions.
