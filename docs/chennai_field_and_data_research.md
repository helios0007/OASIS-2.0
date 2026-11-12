# OASIS 2.0 — Chennai Empirical Data, TNUHDB Construction Specs, Weather, Outages & Cost Reference

Compiled research dossier covering the 7 empirical grounding pillars for the **OASIS (Overheating Assessment System for Intervention Strategies)** thesis.

> **Verification status (checked by Claude Code, 2026-11-12).** Treat every figure, name and contact below as a *lead* until you have checked it against the primary source. Items marked **⚠ Unverified** could not be confirmed or contradict OASIS; corrections are marked **✔ Corrected**. OASIS figures come from `outputs/results.csv` and `outputs/sweep.csv` (current `DEFAULTS`, Chennai EPW, 10–16 May).

---

## 1. Measured Indoor Temperature & Humidity Data (Chennai)

### A. Climate Trends Study (Oct 2025 – Apr 2026) — Fastest Empirical Dataset
- **Report Title**: *Night-time Thermal Stress in Low & Middle-Income Housing in India: Linking Indoor Temperatures and Relative Humidity with Perceptions of Comfort* (Released at the India Heat Summit, 2026).
- **Lead Organization & Academic Partners**:
  - **Climate Trends** (New Delhi): Lead & Founder-Director **Aarti Khosla**.
  - **⚠ Unverified — Academic Lead (Chennai)**: none of the press coverage checked names an academic partner; confirm before citing. Listed as **Dr. Naveen Puttaswamy**, Associate Professor, Department of Environmental Health Engineering / Faculty of Public Health, **Sri Ramachandra Institute of Higher Education and Research (SRIHER)**, Porur, Chennai.
- **Sample & Methodology**:
  - High-resolution continuous indoor temperature ($T_{db}$) and relative humidity ($RH$) loggers deployed inside **50 low- and middle-income residential units** across urban Chennai neighborhoods from **October 2025 to April 2026** (7 months).
  - Almost all sampled low/middle-income homes had **RCC slabs/walls** and relied exclusively on **ceiling fans** (0% AC ownership in low-income group vs. 100% AC in high-income comparison group).
- **Headline Quantitative Findings**:
  - **Evening Peak (Thermal Lag)**: Indoor temperatures peaked between **20:00 and 21:00 (8:00–9:00 PM)** at nearly **34.7 °C** (and >35 °C in warmer April spells), lagging outdoor afternoon peaks by 5–6 hours due to the "thermal battery" effect of uninsulated RCC roofs + weathering course.
  - **Nocturnal Heat Retention**: Nighttime indoor $T_{db}$ rarely dropped below **31.0 °C** even in cooler months, and stayed between **33.8 °C and 34.0 °C** into early morning hours during warm spells.
  - **⚠ Unverified — Chronic Exposure**: the original note said worst-affected homes logged "5,700–5,800 hours above 32 °C". This is impossible: October 2025–April 2026 contains only about 5,090 hours. Get the real figure from the report itself.
  - **Persistent High Humidity**: Indoor $RH$ remained **consistently >75%** throughout the monitoring period, pushing evening/nighttime Heat Index into the *Extreme Caution* / *Danger* (>41 °C HI) regime and crippling evaporative sweat cooling.
- **How to Request the Raw Hourly CSVs** (**⚠ Unverified contacts** — find the current address on the Climate Trends website / report before writing):
  - **Climate Trends Desk**: `contact@climatetrends.in` | Tel: `+91 11 4164 6732` (Statesman House, B-712, 7th Floor, Barakhamba Road, New Delhi).
  - **Academic Contact (SRIHER Chennai)**: Dr. Naveen Puttaswamy, Faculty of Public Health, Sri Ramachandra Institute of Higher Education and Research (SRIHER), Porur, Chennai (`naveenp@sriramachandra.edu.in` / SRIHER Environmental Health Engineering dept).
  - **What to Request**:
    1. Anonymized hourly (or 15/30-min) indoor $T_{db}$ and $RH$ time-series for the April 2026 subset (or full Oct 2025–Apr 2026 dataset).
    2. Metadata table per logger ID: floor level (top floor vs. intermediate floor), roof type (bare RCC vs. weathering course / lime-brick-bat coba), wall material, window orientation, and neighborhood.

### B. Published Chennai Indoor Logger Benchmarks (Secondary Literature)
- **Rajasekar & Ramachandraiah (2010)**, *Adaptive comfort and thermal expectations – a subjective evaluation in hot humid climate* (**✔ Corrected**: garbled word removed; **⚠ check the exact title, journal and year** — the field study was in Chennai apartments), Building and Environment / IIT Madras: Measured naturally ventilated apartments in Chennai; documented indoor operative temperatures reaching 32–36.5 °C and strong reliance on air speed ($0.6\text{–}1.5\text{ m/s}$ from ceiling fans).
- **Indraganti et al. (2014)**, *Adaptive model of thermal comfort for offices and residential buildings in Chennai and Hyderabad*: Provides empirical distributions of window opening, fan operation above 28 °C, and indoor comfort bands.
- **Lilly Rose Amirtham (Sathyabama / Anna University)**: Microclimate and urban canyon studies in Chennai residential typologies showing 2–4 °C nocturnal urban heat island (UHI) elevation in dense concrete neighborhoods compared to airport weather stations.

### C. April–May 2027 Field Campaign Protocol (TNUHDB Perumbakkam / Kannagi Nagar)
- **Target Sites**: 4–6 tenements in a single **TNUHDB (formerly TNSCB)** block in **Perumbakkam** (G+7 / G+8) or **Kannagi Nagar / KP Park** (G+3 to G+5), pairing **top-floor flats** (directly under the terrace slab) with **middle-floor flats** (same orientation, 2 floors below) to isolate roof vs. wall/ventilation heat gains.
- **Instrumentation Kit**:
  - **4–6 Indoor $T_{db}$ + $RH$ loggers** (e.g., Onset HOBO MX2301A / UX100-003 or Lascar EL-USB-2, accuracy $\pm 0.2\text{ °C}$, $\pm 2.5\%\text{ RH}$), suspended 1.1–1.5 m above floor near the center of the living/sleeping zone (away from direct sun and fan motor heat).
  - **1 Black Globe Thermometer logger** ($T_g$, 40 mm or 150 mm matte black copper globe with internal thermistor) in the primary top-floor flat to directly validate Mean Radiant Temperature ($T_{mrt}$) from the hot ceiling slab.
  - **1 Roof Surface / Soffit Contact Thermistor** taped with conductive paste + reflective tape to the underside (ceiling soffit) and top surface of the roof slab to directly measure conductive phase lag (amplitude decrement $f$ and time lag $\phi$).
  - **1 Outdoor Shielded Reference Logger** on a shaded north balcony/terrace mast to capture local urban canyon $T_{db}$ and $RH$ vs. Meenambakkam Airport EPW.
- **Sampling Interval & Duration**: 15-minute logging for at least **21–28 days** spanning late April to mid-May.

---

## 2. Standard Household & Building Survey Checklist

For either the Climate Trends metadata request or the 2027 field campaign, record these exact fields per flat (directly maps to `oasis/build_idf.py` and `oasis/agents.py`):

| Category | Survey Question / Measurement | Maps to OASIS Parameter |
|---|---|---|
| **Geometry** | Internal room length $\times$ width $\times$ floor-to-ceiling height ($\text{m}$) | `length_m`, `width_m`, `height_m` |
| **Glazing & Openings** | Window width $\times$ height per wall ($\text{m}$), sill height, openable fraction (sliding 50% vs. casement 90%), mosquito mesh / security bars present? | `wwr`, `OPENABLE_FRACTION`, `airflow_factor` |
| **Orientation & Context** | Compass bearing of main window wall ($\text{deg}$ from North), distance to opposite building block ($\text{m}$), corridor side | `orientation_deg`, shading context |
| **Envelope Build-up** | Floor number / total floors; roof finish (bare grey concrete, pressed clay tiles over brick-jelly coba, white paint); wall type & thickness (200 mm AAC, 200 mm fly-ash block, 230 mm / 115 mm clay brick) | `floor`, `roof_type`, `roof_absorptance`, `wall_type` |
| **Occupancy & Profiles** | Number of occupants by age/sex/role (e.g., adult home all day, elderly, working adult, child); daytime vs. nighttime headcount | `occupants`, `oasis/agents.py` profiles |
| **Sleep Location** | Where do occupants sleep during May heatwaves? (Living room floor on mat, bed, balcony, or open roof terrace?) | Nighttime zone assignment |
| **Ventilation & Fans** | Exact hours windows and main door are kept open (e.g., closed at 22:00 for security/mosquitoes or cracked open all night?); ceiling fan speed & hours | `windows_open_hour`, `windows_close_hour`, `night_vent`, `FAN_CREDIT_C` |
| **Internal Loads** | LPG stove cooking schedule (morning & evening times/durations), fridge, TV, ironing/pump loads | `appliances_peak_w`, `APPLIANCES_LATENT` |
| **Power Cuts** | Frequency, time of day (especially 20:00–02:00 night trips), and typical duration of TANGEDCO/TNPDCL outages in April–May | `POWER_CUT_HOURS` |

---

## 3. Construction Details for Chennai TNUHDB / PMAY Flats

Based on **TNUHDB (Tamil Nadu Urban Habitat Development Board)** and **TN PWD Building Specifications / Tender BoQs** for Chennai tenement schemes (Perumbakkam, Kannagi Nagar, KP Park, Moorthingar Street):

### A. Roof Construction: RCC Slab + Brick-Jelly Lime Concrete Weathering Course + Pressed Tiles
- **Key Finding**: TNUHDB flats do **not** have a bare 150 mm RCC roof. Standard Tamil Nadu PWD / TNUHDB tender BoQs specify a heavy **weathering course (brick-jelly concrete) + machine-pressed clay flat tiles** over the structural RCC slab:
  1. **Structural Slab**: $120\text{–}150\text{ mm}$ Reinforced Cement Concrete (RCC M20/M25).
  2. **Weathering Course (Brick-Jelly Lime Concrete / Brick-Bat Coba)**: Broken burnt-clay brick bats/jelly ($20\text{ mm}$ nominal gauge) mixed with slaked lime (standard TN PWD mix $32:12.5$ brick jelly to lime by volume, or $1:4:8$ cement-lime mortar) laid to a 1:100 slope and compacted with wooden beaters. Average thickness is **$75\text{–}100\text{ mm}$** (ranging from $65\text{ mm}$ at rainwater outlets to $115\text{ mm}$ at ridges).
  3. **Top Finish (Pressed Clay Tiles)**: One course of **$200 \times 200 \times 20\text{ mm}$ machine-pressed clay weatherproof tiles** set in $12\text{ mm}$ thick Cement Mortar ($1:3$) mixed with 2% integral waterproofing compound, joints pointed full depth.
- **Why This Matters for OASIS Calibration**:
  - Total roof thickness is **$225\text{–}280\text{ mm}$** ($150\text{ mm}$ RCC + $75\text{–}100\text{ mm}$ brick-jelly coba + $12\text{ mm}$ mortar + $20\text{ mm}$ clay tile), not $150\text{ mm}$!
  - Adding an $85\text{ mm}$ brick-jelly coba + $30\text{ mm}$ mortar/tile layer ($\lambda \approx 0.65\text{–}0.80\text{ W/m}\cdot\text{K}$, $\rho \approx 1600\text{–}1800\text{ kg/m}^3$, $c_p \approx 880\text{ J/kg}\cdot\text{K}$) increases the roof's thermal time lag (**⚠ Unverified** — the "+2.5 to +3.5 h" figure has no source; calculate it or measure it with the roof thermistors in §1C).
  - **⚠ Hypothesis, not yet tested — possible resolution of the calibration peak-time issue**: In our Dhaka calibration, the bare $150\text{ mm}$ RCC slab peaked around 14:00–15:00 indoors, forcing the optimizer to push `internal_mass_m2` to its upper bound ($160\text{ m}^2$). Adding the real **weathering course (`coba_85` + `tile_30`)** on top of `rcc` *may* shift the indoor peak later, towards the measured 16:00–17:00 (Dhaka) and 20:00–21:00 (Climate Trends, Chennai). Test it in `calibrate.py` (HANDOFF next step 2) before claiming it.

### B. Wall Materials: AAC Blocks & Fly-Ash Bricks vs. Clay Brick
- **Older TNSCB Tenements (pre-2014, e.g., early Kannagi Nagar / Semmencherry)**: $230\text{ mm}$ external walls and $115\text{ mm}$ internal partitions in burnt clay brick or solid concrete blocks.
- **Recent TNUHDB / PMAY Tenements (2016–2026, e.g., Perumbakkam G+8 blocks, KP Park, Moolakothalam)**:
  - **RCC Shear-Wall / Monolithic Mivan Formwork or RCC Frame with Infill**:
  - **External Walls**: **$200\text{ mm}$ (or $150\text{ mm}$) AAC blocks** (conforming to IS 2185 Part 3, dry density $550\text{–}650\text{ kg/m}^3$, jointed with $3\text{ mm}$ polymer-modified thin-bed mortar) **OR** **$200\text{ mm}$ / $230\text{ mm}$ Fly-Ash Lime Gypsum bricks** (conforming to IS 12894 / IS 13757, density $\sim 1700\text{–}1800\text{ kg/m}^3$, $\lambda \approx 0.90\text{–}1.05\text{ W/m}\cdot\text{K}$).
  - **Internal Partitions**: **$100\text{ mm}$ AAC blocks** or **$115\text{ mm}$ fly-ash brick** plastered $12\text{–}15\text{ mm}$ on both sides.

### C. Typical Flat Floor Plan vs. the OASIS $6 \times 5\text{ m}$ ($30\text{ m}^2$) Box
- **Plinth & Carpet Area**:
  - Standard TNUHDB PMAY 1-BHK tenement has a **plinth (built-up) area of $390\text{–}406\text{ sq.ft.}$ ($36.2\text{–}37.7\text{ m}^2$)** and a **carpet area of $290\text{–}320\text{ sq.ft.}$ ($\sim 27.0\text{–}29.7\text{ m}^2$)**.
- **Room-by-Room Breakdown (TNCDBR EWS / TNUHDB Standard 1-BHK)**:
  1. **Multi-purpose Living / Dining Hall**: $\sim 3.0\text{ m} \times 4.3\text{ m}$ ($13.0\text{ m}^2$ / $140\text{ sq.ft.}$)
  2. **Bedroom**: $\sim 3.0\text{ m} \times 3.1\text{ m}$ ($9.3\text{ m}^2$ / $100\text{ sq.ft.}$)
  3. **Kitchen**: $\sim 1.6\text{ m} \times 2.8\text{ m}$ ($4.5\text{ m}^2$ / $48\text{ sq.ft.}$)
  4. **Bath + WC & Balcony**: $\sim 2.5\text{–}3.2\text{ m}^2$ ($27\text{–}35\text{ sq.ft.}$)
- **How well does the OASIS $6 \times 5\text{ m}$ ($30\text{ m}^2$) box match?**
  - **Total Floor Area**: The $6 \times 5\text{ m} = 30.0\text{ m}^2$ single-zone box matches the **entire habitable carpet area ($27\text{–}30\text{ m}^2$)** of a standard TNUHDB 1-BHK flat almost identically!
  - **Missing Internal Partitions**: Because a real $30\text{ m}^2$ 1-BHK flat is subdivided by internal partition walls (between the hall, bedroom, kitchen, and bath—roughly $12\text{–}15\text{ linear meters}$ of $2.9\text{ m}$ high wall $\approx 70\text{–}85\text{ m}^2$ of two-sided exposed surface area), setting `INTERNAL_MASS_M2 ≈ 75` (instead of `0.0`) in `oasis/build_idf.py` would represent the internal partition walls. **⚠ Hypothesis**: test it in calibration together with the coba layer; don't change `DEFAULTS` until calibration is finished (HANDOFF key decision 2026-11-10).

---

## 4. Real Heatwave Weather Data for Chennai (May 2024)

### A. Meteorological Record (IMD Meenambakkam & Nungambakkam, May 2024)
- **Stations**:
  - **Chennai Meenambakkam Airport** (WMO / NOAA ISD Station **432790-99999**, $12.994^\circ\text{N}, 80.180^\circ\text{E}$): Suburban/inland benchmark (matches Perumbakkam/southwest residential belt better than coastal station).
  - **Chennai Nungambakkam** (WMO Station **432780**, $13.067^\circ\text{N}, 80.240^\circ\text{E}$): Urban core / coastal station.
- **Two Major Heatwave Spells in May 2024** (**⚠ Unverified daily values** — confirm against the NOAA ISD / IMD records below before citing):
  1. **Early May Spell (1–6 May 2024)**:
     - **1 May 2024**: Meenambakkam hit **$40.7\text{ °C}$** (first $40\text{ °C}+$ day of 2024); Nungambakkam reached **$39.0\text{ °C}$**.
     - **2–5 May 2024**: Consecutive $40\text{ °C}+$ days at Meenambakkam with high coastal humidity ($60\text{–}80\%\text{ RH}$).
  2. **Late May Extreme Spike (25–31 May 2024 — Cyclone Remal Westerly Draw)**:
     - Strong dry continental westerlies blocked the afternoon sea breeze until late evening.
     - **27 May 2024**: Both Meenambakkam and Nungambakkam recorded **$40.6\text{ °C}$**.
     - **28–29 May 2024**: Meenambakkam peaked at **$41.3\text{ °C}$** ($+2.4\text{ °C}$ above normal) and Nungambakkam hit **$41.1\text{ °C}$** ($+3.1\text{ °C}$ above normal), with nighttime minimums staying around **$29.5\text{–}31.0\text{ °C}$**.
- **Fetching & Building a May 2024 EPW**:
  - **Open-Meteo Historical Archive API** (`https://archive-api.open-meteo.com/v1/archive`) provides hourly ERA5 + ERA5-Land + CERRA reanalysis (`temperature_2m`, `relative_humidity_2m`, `dew_point_2m`, `surface_pressure`, `shortwave_radiation`, `direct_radiation`, `diffuse_radiation`, `wind_speed_10m`, `wind_direction_10m`, `cloud_cover`) for Chennai ($13.00^\circ\text{N}, 80.22^\circ\text{E}$) for full year 2024 with zero account registration.
  - **NOAA ISD (`43279099999.csv` for 2024)**: Direct synoptic observations from Meenambakkam Airport (`https://www.ncei.noaa.gov/data/global-hourly/access/2024/43279099999.csv`).
  - We can splice May 2024 hourly data directly into a copy of `data/weather/chennai.epw` (`data/weather/chennai_may2024.epw`) to test interventions under both the TMY heatwave week (10–16 May) and the real May 2024 heatwaves (1–7 May or 24–30 May 2024).

---

## 5. Power Cuts in Chennai (Summer 2024–2025 Reality Check)

- **Official Utility Context**: Tamil Nadu Generation and Distribution Corporation (**TANGEDCO**, restructured under **TNPDCL** — Tamil Nadu Power Distribution Corporation Ltd).
- **Why Nighttime Outages Happen (20:00–02:00)**:
  - Tamil Nadu did not declare formal *scheduled* evening load-shedding in Chennai city during May 2024/2025 (scheduled maintenance shutdowns occur between **09:00 and 14:00 / 17:00**).
  - Instead, Chennai experienced widespread **unscheduled nighttime outages between 20:00 and 02:00** during May 2024 and May 2025 because **city power demand hit all-time highs** (Chennai peak demand crossed $4,300\text{–}4,500\text{ MW}$; Tamil Nadu state peak crossed $20,830\text{ MW}$ in May 2024) precisely between **20:00 and 23:00** when domestic air conditioners in middle/high-income blocks switched on simultaneously.
  - **Fault Mechanisms Reported (The New Indian Express, Times of India, The Hindu, May 2024–2025)**:
    - Distribution transformer (DT) oil overheating and fuse blowouts after 20:00.
    - Underground (UG) cable joint failures caused by high soil temperatures + peak nocturnal current load.
    - $11\text{ kV}$ and $33\text{ kV}$ feeder trips and phase voltage drops (low voltage causing ceiling fans to spin at $<50\%$ speed).
- **Duration & Vulnerability in Tenements**:
  - Most localized transformer/fuse faults last **1 to 3 hours** (most commonly starting around **20:00–22:00** when evening cooking + neighborhood AC loads peak).
  - In peripheral suburban/resettlement feeders (Perumbakkam, Semmencherry, Avadi, Tirunindravur, Medavakkam), major cable faults lasted **3 to 6 hours overnight**.
  - Unlike middle-class apartments that have home battery inverters (UPS) to keep fans running during a 1–2 hour trip, low-income TNUHDB tenements have **zero inverter backup**, meaning a 20:00–21:00 feeder trip immediately stops all ceiling fans at the exact hour (`20:00–21:00`) when indoor temperature hits its daily peak ($34.7\text{ °C}$ in the Climate Trends study!).
- **Thesis Justification**:
  - The **20:00–21:00 nightly power cut** in OASIS is strongly grounded as a **coincident peak-load fault scenario**: 20:00–21:00 is simultaneously (a) the measured indoor temperature peak in concrete Chennai homes (Climate Trends, 2026) and (b) the onset of evening domestic distribution grid overload in Chennai.
  - To obtain official feeder-level outage logs: File an online **RTI application** (₹10 fee on `rtionline.tn.gov.in`) addressed to the **Public Information Officer (PIO), TNPDCL (South Chennai / Chengalpattu Circle)** requesting *"Feeder-wise interruption log (SAIDI/SAIFI, tripping time, restoration time, and cause) for 11 kV feeders serving Perumbakkam and Okkiyam Thoraipakkam (Kannagi Nagar) for the period 1 April 2024 to 30 June 2025."*

---

## 6. Intervention Costs (TN PWD Schedule of Rates 2024–2026 & Chennai Market Rates)

Below are the extracted unit rates from the **Tamil Nadu PWD / TNUHDB Schedule of Rates (SoR 2024–25 / 2025–26)** and current Chennai contractor rates, together with total cost per flat for the standard OASIS **$6 \times 5\text{ m}$ ($30\text{ m}^2$ roof, $2.9\text{ m}$ height)** geometry:

> **✔ Corrected quantities**: the OASIS baseline is 6 × 5 × **3.0 m** with **15 % WWR** (`oasis/params.py`), not 2.9 m / 10 %. Gross wall 66.0 m², windows ≈ 9.9 m², net wall ≈ 56.1 m², roof 30 m². Rows 3, 5 and 6 below were worked out for 6.4 m² of window and scale by about ×1.55. The unit rates themselves are **⚠ unverified** — check them against the TN PWD SoR.

| Intervention (`oasis` key) | Specification (TN PWD / CPWD / Market) | Unit Rate (INR ₹) | Quantity for $6 \times 5 \times 2.9\text{ m}$ Flat | Estimated Cost per Flat (₹) |
|---|---|---|---|---|
| **1. White Cool Roof Coating** (`roof_solar_absorptance = 0.2`) | Surface prep, 1 coat acrylic primer + 2–3 coats high-albedo elastomeric solar reflective coating ($\text{SRI} \ge 104$, e.g., Dr. Fixit Newcoat Cool / Asian Paints SmartCare Damp Proof Ultra) or white lime-cement wash | **₹160 – ₹240 / $\text{m}^2$** (Elastomeric, 5-yr life)<br>*(₹45 – ₹65 / $\text{m}^2$ for seasonal white lime wash)* | **$30.0\text{ m}^2$** roof area | **₹6,000** *(Elastomeric @ ₹200/$\text{m}^2$)*<br>*(or ₹1,500 for lime wash)* |
| **2. Roof Insulation (`rcc_150_insul_50`)** | $50\text{ mm}$ Extruded Polystyrene (XPS) / High-Density EPS board laid over slab + protective $40\text{ mm}$ cement screed / tile topping | **₹450 – ₹600 / $\text{m}^2$** (50 mm EPS/XPS board) + **₹350 / $\text{m}^2$** protective screed = **₹800 – ₹950 / $\text{m}^2$** | **$30.0\text{ m}^2$** roof area | **₹25,500** *(@ ₹850/$\text{m}^2$)* |
| **3. AAC Block Walls (`aac_200` vs `brick_230`)** | $200\text{ mm}$ AAC block masonry (IS 2185 Pt 3) in $3\text{ mm}$ thin-bed polymer mortar (~₹6,600–₹7,200/$\text{m}^3$ = **₹1,350/$\text{m}^2$**) vs. $230\text{ mm}$ Clay/Fly-Ash Brick masonry in CM 1:6 (~₹6,200–₹6,800/$\text{m}^3$ = **₹1,480/$\text{m}^2$**) | **New Build Differential**: **₹0 to −₹130 / $\text{m}^2$** (AAC is often *cheaper* or cost-neutral in new construction + saves structural steel)<br>**Retrofit / Material Premium**: ~**₹150 / $\text{m}^2$** | **$57.4\text{ m}^2$** net external wall area ($63.8\text{ m}^2$ gross − $6.4\text{ m}^2$ windows at 10% WWR) | **₹0 – ₹8,500** *(New-build marginal cost; ₹8,500 if priced at ₹150/$\text{m}^2$ procurement premium)* |
| **4. Window Overhangs (`overhang_m = 0.6`)** | $600\text{ mm}$ deep, $75\text{ mm}$ thick RCC sunshade (*chajja*) with M20 concrete, steel reinforcement ($8\text{ mm}$ bars), formwork & $12\text{ mm}$ plaster | **₹1,800 – ₹2,400 / $\text{m}^2$** of projection (or **₹1,100 – ₹1,450 per running meter** for $0.6\text{ m}$ depth) | **$3.8\text{ m}^2$** total projection area ($\sim 6.4\text{ linear meters}$ of window width $\times 0.6\text{ m}$ depth) | **₹8,000** *(@ ₹2,100/$\text{m}^2$)* |
| **5. Night Ventilation Enabler: Security Grille + Mosquito Mesh (`night_vent = True`)** | MS square bar security grille ($12\text{ mm}$ bars @ $100\text{ mm}$ c/c, ~15 $\text{kg/m}^2$ @ ₹110/kg = ₹1,650/$\text{m}^2$) + stainless steel (SS 304) mosquito wire mesh in aluminum frame (₹650/$\text{m}^2$) | **₹650 / $\text{m}^2$** (SS mosquito mesh only, if MS grille already exists)<br>**₹2,300 / $\text{m}^2$** (Full MS security grille + SS mesh) | **$6.4\text{ m}^2$** window area (at 10% WWR) | **₹4,200** *(Mesh upgrade only)* to **₹14,700** *(Full MS grille + SS mesh)* |
| **6. Reduced WWR (`wwr = 0.10` vs baseline `0.15`)** | Replacing $6.4\text{ m}^2$ of UPVC/aluminum single-glazed sliding window (~₹3,800/$\text{m}^2$) with $200\text{ mm}$ plastered masonry wall (~₹1,950/$\text{m}^2$ incl. plaster & paint) | **−₹1,850 / $\text{m}^2$** of window area avoided (Net **cost saving** at design stage) | **$6.4\text{ m}^2$** glazing difference | **−₹11,800** *(Design-stage capital saving)* |

### Cost-Effectiveness Preview (Safe Hours Gained per ₹1,000 Spent)
**✔ Corrected with OASIS's own results.** The earlier version used gains that OASIS doesn't produce (e.g. insulation +55–60 h, AAC +15–22 h) and a 94 h baseline. These are single changes to the baseline top-floor flat (**98 safe hours**, 4 occupants; `outputs/sweep.csv`). Costs are the unverified estimates above, scaled to 9.9 m² of window.

| Change | Safe hours gained (OASIS) | Cost per flat (₹, unverified) | Safe hours per ₹1,000 |
|---|---|---|---|
| White roof coating (absorptance 0.7 → 0.2) | **+48** | 6,000 (elastomeric) / 1,500 (lime wash) | **8.0** / 32 |
| Night ventilation (windows open at night; mesh as the enabler) | **+44** | ≈ 6,400 (mesh) / ≈ 22,800 (grille + mesh) | **6.9** / 1.9 |
| 50 mm roof insulation | **+19** | 25,500 | **0.7** |
| 0.6 m window overhangs | **+5** | ≈ 8,000 | **0.6** |
| AAC 200 walls instead of 230 mm brick | **−10** (loses hours) | 0 – 8,400 | — |
| Fewer windows (WWR 0.15 → 0.10) | **−9** (loses hours: less ventilation) | saving ≈ 9,200 | — |

Notes: night ventilation in OASIS is a schedule change (windows open at night); the mesh/grille cost is what makes that realistic, so state the link as an assumption. AAC walls and smaller windows *lose* safe hours in this model, so don't present them as recommended changes without explaining why.

---

## 7. Empirical Benchmarks for Checking Model Results (Cool Roof Studies)

To validate the magnitude of OASIS's simulated indoor temperature reduction from a cool roof:
1. **Vellingiri et al. (2020)** — *“Combating Climate Change-induced Heat Stress: Assessing Cool Roofs and Its Impact on the Indoor Ambient Temperature of the Households in the Urban Slums of Ahmedabad”*, **Indian Journal of Occupational and Environmental Medicine**, 24(1), 25–29 (IIPH Gandhinagar & Mahila Housing Trust):
   - Monitored low-income dwellings in Ahmedabad across pre-summer, summer, and post-summer seasons.
   - Found that cool roof interventions reduced indoor ambient temperatures by **$2.0\text{ °C}$ to $5.0\text{ °C}$** during peak afternoon/evening hours (mean reduction of **$2.5\text{ °C}$** for insulated/reflective roofs and **$3.0\text{–}4.5\text{ °C}$** for solar-reflective coatings and ModRoof panels).
2. **NRDC, IIPH-G & Mahila Housing Trust (2018)** — *Expanding Cool Roofs in India*:
   - Documented $2\text{–}5\text{ °C}$ indoor air temperature drops and up to $15\text{–}20\text{ °C}$ roof surface temperature reductions in concrete and sheet-roofed low-income homes.
3. **Telangana / Hyderabad Cool Roof Policy Benchmarks (ASCI & NRDC, 2022)**:
   - Top-floor RCC residential flats with high-albedo elastomeric coatings ($\text{SRI} \ge 104$, solar absorptance $\alpha \approx 0.20\text{–}0.25$) showed **$2.1\text{–}3.8\text{ °C}$** reductions in peak indoor operative temperature, (**⚠ Unverified** — source and numbers not confirmed; the "closely matching OASIS" claim had not been checked). Compare with OASIS's own white-roof result: mean indoor temperature 37.7 → 35.2 °C (−2.5 °C) and peak 41.7 → 38.3 °C (−3.4 °C) for absorptance 0.7 → 0.2 (`outputs/results.csv`).
