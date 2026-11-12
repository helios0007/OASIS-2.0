"""OASIS back end: a small web API around the simulation pipeline.

Run from the project folder:
    python run_server.py
then open http://127.0.0.1:8000

Routes
    GET  /api/health    is the server up?
    GET  /api/options   the choices the front end offers, and the scenario
    POST /api/rhino     upload a .3dm file -> room size and windows
    POST /api/assess    building parameters -> safe hours + ranked changes
    A room-by-room plan (.3dm on the OASIS:: layers) imported through /api/rhino is
    kept on the server (outputs/plans/); /api/assess with its plan_id then runs the
    multi-room model and also returns 'unit' for the 3D tab.
    GET  /              the front end (files in frontend/)
"""
import hashlib
import json
import re
import tempfile
import threading
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import config
from oasis.agents import (
    CORE_CAUTION_C, CORE_CRITICAL_C, CORE_LIMIT_C, DEFAULT_AGENTS, MIN_AGE,
    V_IN_ROOM, V_STILL, V_UNDER_FAN, compare_with_heat_index, simulate_household,
)
from oasis.assess import assess, single_changes
from oasis.build_idf import (
    ACTIVITY_W, APPLIANCES_PEAK_W, GLASS_SHGC, GLASS_U,
    INFILTRATION_ACH, MATERIALS, ROOFS, WALLS,
)
from oasis.from_rhino import read_model
from oasis.labels import LABELS
from oasis.metrics import FAN_CREDIT_C, SAFE_LIMIT_C, peaks
from oasis.params import BASELINE, SWEEP_LEVELS
from oasis.unit import assess_plan

app = FastAPI(title="OASIS 2.0 Workbench")


@app.middleware("http")
async def disable_static_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# One simulation batch at a time: the model writer (eppy) is not thread-safe.
SIMULATION_LOCK = threading.Lock()
CACHE = {}            # parameters (as text) -> result, so repeats are instant
CACHE_LIMIT = 200
BODY_CACHE = {}       # building + household -> JOS-3 results (~3 s to compute)
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
SAMPLE_RHINO = config.ROOT / "data" / "rhino" / "sample_flat.3dm"
LAYOUT_DIR = config.ROOT / "data" / "layouts"      # bundled room-by-room plans
PLAN_DIR = config.OUT / "plans"                     # imported plans, by content hash


def u_value(layers, r_si=0.13, r_se=0.04):
    """Thermal transmittance U (W/m²·K) of a multi-layer construction."""
    r_layers = sum(MATERIALS[m][0] / MATERIALS[m][1] for m in layers)
    return round(1.0 / (r_si + r_layers + r_se), 2)


def heat_capacity_kj(layers):
    """Areal heat capacity (kJ/m²·K) of a multi-layer construction."""
    cap = sum(MATERIALS[m][0] * MATERIALS[m][2] * MATERIALS[m][3] for m in layers)
    return round(cap / 1000.0, 1)


def load_json_if_exists(path: Path):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


class Building(BaseModel):
    """What the front end sends. Limits keep the model physically sensible."""
    length_m: float = Field(BASELINE["length_m"], ge=2, le=30)    # east-west
    width_m: float = Field(BASELINE["width_m"], ge=2, le=30)      # north-south
    height_m: float = Field(BASELINE["height_m"], ge=2.2, le=6)
    orientation_deg: float = Field(0, ge=0, lt=360)
    floor: str = BASELINE["floor"]
    wall: str = BASELINE["wall"]
    roof: str = BASELINE["roof"]
    roof_solar_absorptance: float = Field(BASELINE["roof_solar_absorptance"], ge=0.05, le=0.95)
    wwr: float = Field(BASELINE["wwr"], ge=0.0, le=0.6)
    shading_depth_m: float = Field(BASELINE["shading_depth_m"], ge=0, le=2)
    night_vent: bool = BASELINE["night_vent"]
    occupants: int = Field(BASELINE["occupants"], ge=1, le=12)
    # Glass area per wall, from a Rhino model. Replaces wwr when given.
    window_area_m2: Optional[dict[str, float]] = None
    # Household for the JOS-3 body model (the check measure), see oasis/agents.py
    agents: Optional[list[dict]] = None
    # A room-by-room plan imported through /api/rhino (then geometry comes from the plan)
    plan_id: Optional[str] = Field(None, pattern=r"^[0-9a-f]{16}$")
    party_walls: Optional[str] = None      # None: as drawn; "windowless": every windowless wall shared


def check_choices(b: Building):
    """Reject values the model builder does not know."""
    if b.floor not in ("top", "middle"):
        raise HTTPException(422, f"Unknown floor level '{b.floor}'.")
    if b.wall not in WALLS:
        raise HTTPException(422, f"Unknown wall type '{b.wall}'.")
    if b.roof not in ROOFS:
        raise HTTPException(422, f"Unknown roof type '{b.roof}'.")
    if b.party_walls not in (None, "windowless"):
        raise HTTPException(422, "party_walls must be empty or 'windowless'.")
    if b.plan_id and not (PLAN_DIR / f"{b.plan_id}.3dm").exists():
        raise HTTPException(404, "The imported plan is no longer on the server. Import it again.")
    for side, area in (b.window_area_m2 or {}).items():
        if side not in ("north", "south", "east", "west") or area < 0:
            raise HTTPException(422, "Window areas must be per wall "
                                     "(north, south, east, west) and not negative.")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/options")
def options():
    """Everything the front end needs to draw its form."""
    return {
        "baseline": {k: BASELINE[k] for k in Building.model_fields if k in BASELINE},
        "choices": [
            {"key": key, "title": title,
             "options": [{"value": value, "label": labels[value]}
                         for value in SWEEP_LEVELS[key]]}
            for key, (title, labels) in LABELS.items()
        ],
        "scenario": {
            "city": "Chennai",
            "first_day": config.RUN_START[1], "last_day": config.RUN_END[1],
            "month": "May",
            "cut_start_hour": config.CUT_START_HOUR,
            "cut_end_hour": config.CUT_END_HOUR,
            "safe_limit_c": SAFE_LIMIT_C,
            "fan_credit_c": FAN_CREDIT_C,
        },
        "physics": {
            "walls": {
                k: {"u_value": u_value(layers), "heat_capacity_kj": heat_capacity_kj(layers), "layers": layers}
                for k, layers in WALLS.items()
            },
            "roofs": {
                k: {"u_value": u_value(layers, r_si=0.10, r_se=0.04), "heat_capacity_kj": heat_capacity_kj(layers), "layers": layers}
                for k, layers in ROOFS.items()
            },
            "glass_u": GLASS_U,
            "glass_shgc": GLASS_SHGC,
            "activity_w": ACTIVITY_W,
            "appliances_peak_w": APPLIANCES_PEAK_W,
            "infiltration_ach": INFILTRATION_ACH,
        },
        "has_sample_rhino": SAMPLE_RHINO.exists(),
        "surrogate": load_json_if_exists(config.OUT / "surrogate_metrics.json"),
        "calibration": load_json_if_exists(config.OUT / "calibration" / "homes" / "afn" / "summary.json"),
        "validation": load_json_if_exists(config.OUT / "calibration" / "homes" / "afn_validate_delhi" / "summary.json"),
        "default_agents": DEFAULT_AGENTS,
        "body_model": {
            "core_caution_c": CORE_CAUTION_C, "core_limit_c": CORE_LIMIT_C,
            "core_critical_c": CORE_CRITICAL_C, "min_age": MIN_AGE,
            "v_under_fan": V_UNDER_FAN, "v_in_room": V_IN_ROOM, "v_still": V_STILL,
        },
    }


def keep_plan(data):
    """Store an imported plan by content, so /api/assess can run it later."""
    plan_id = hashlib.sha1(data).hexdigest()[:16]
    PLAN_DIR.mkdir(parents=True, exist_ok=True)
    (PLAN_DIR / f"{plan_id}.3dm").write_bytes(data)
    return plan_id


def rhino_response(path, name):
    geometry, report = read_model(path)
    report["file"] = name
    out = {"geometry": geometry, "report": report}
    if report.get("plan"):
        out["plan_id"] = keep_plan(Path(path).read_bytes())
    return out


@app.get("/api/samples")
def samples():
    """Bundled models: the single-room sample and the room-by-room plans."""
    out = [{"id": "sample_flat", "name": "Sample room"}] if SAMPLE_RHINO.exists() else []
    return out + [{"id": f.stem, "name": f.stem.replace("_", " ").title().replace("Bhk", "BHK")}
                  for f in sorted(LAYOUT_DIR.glob("*.3dm"))]


@app.post("/api/rhino/sample")
def rhino_sample(name: Optional[str] = None):
    """Load a bundled model (default: the single-room sample)."""
    path = SAMPLE_RHINO if not name or name == "sample_flat" else LAYOUT_DIR / f"{Path(name).name}.3dm"
    if not path.exists():
        raise HTTPException(404, "Sample model not found.")
    try:
        return rhino_response(path, path.name)
    except Exception as error:
        raise HTTPException(400, f"Could not read sample model: {error}")


@app.post("/api/rhino")
async def rhino(file: UploadFile = File(...)):
    """Read the room and windows from an uploaded Rhino model."""
    name = Path(file.filename or "model.3dm").name
    if not name.lower().endswith(".3dm"):
        raise HTTPException(400, "Please upload a Rhino .3dm file.")
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "The file is larger than 50 MB.")
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / "model.3dm"
        path.write_bytes(data)
        try:
            return rhino_response(path, name)
        except ValueError as error:
            raise HTTPException(400, str(error))
        except Exception:
            raise HTTPException(400, "This file could not be read as a Rhino model.")


@app.post("/api/assess")
def assess_building(b: Building):
    """Simulate the building and each single design change (main measure: heat index
    safe hours), then run the household through JOS-3 (check measure)."""
    check_choices(b)
    dumped = b.model_dump(exclude_none=True)
    custom_agents = dumped.pop("agents", None)
    plan_id, party = dumped.pop("plan_id", None), dumped.pop("party_walls", None)
    p = dict(BASELINE, **dumped)
    if plan_id:
        return assess_plan_building(p, plan_id, party, custom_agents or DEFAULT_AGENTS)
    key = json.dumps(p, sort_keys=True)

    if key in CACHE:
        summary, hourly, changes = CACHE[key]
    else:
        with SIMULATION_LOCK:
            try:
                summary, hourly, changes = assess(p)
            except Exception as error:
                raise HTTPException(500, f"The simulation failed: {error}")
        if len(CACHE) >= CACHE_LIMIT:
            CACHE.pop(next(iter(CACHE)))
        CACHE[key] = (summary, hourly, changes)

    roster = custom_agents or DEFAULT_AGENTS
    body_key = key + json.dumps(roster, sort_keys=True)
    if body_key not in BODY_CACHE:
        if len(BODY_CACHE) >= CACHE_LIMIT:
            BODY_CACHE.pop(next(iter(BODY_CACHE)))
        try:
            people = simulate_household(roster, hourly)
        except (KeyError, TypeError, ValueError) as error:
            raise HTTPException(422, f"Check the household details: {error}")
        BODY_CACHE[body_key] = (people, compare_with_heat_index(people, hourly))
    agents_out, check = BODY_CACHE[body_key]

    return response(summary, hourly, changes, agents_out, check)


def response(summary, hourly, changes, agents_out, check, unit=None):
    """What the front end gets back from /api/assess."""
    return {
        "summary": summary,
        "heat_index": hourly["heat_index"].round(1).tolist(),
        "outdoor_temp": hourly["t_out"].round(1).tolist(),
        "indoor_temp": hourly["t_in"].round(1).tolist(),
        "humidity": hourly["rh_in"].round(0).tolist(),
        "peaks": peaks(hourly),
        "agents": agents_out,
        "check": check,
        "changes": [
            {**{k: v for k, v in change.items() if k != "hourly"},
             "title": LABELS[change["parameter"]][0],
             "label": LABELS[change["parameter"]][1][change["value"]],
             "heat_index": change["hourly"]["heat_index"].round(1).tolist(),
             "indoor_temp": change["hourly"]["t_in"].round(1).tolist(),
             "humidity": change["hourly"]["rh_in"].round(0).tolist()}
            for change in changes
        ],
        "unit": unit,
    }


def assess_plan_building(p, plan_id, party, roster):
    """A room-by-room plan: the same results, on the multi-room model."""
    key = json.dumps([p, plan_id, party, roster], sort_keys=True)
    if key not in CACHE:
        try:
            out = assess_plan(p, PLAN_DIR / f"{plan_id}.3dm", agents=roster, party=party,
                              lock=SIMULATION_LOCK, options=single_changes(p))
        except (KeyError, TypeError, ValueError) as error:
            raise HTTPException(422, f"Check the plan or the household: {error}")
        except Exception as error:
            raise HTTPException(500, f"The simulation failed: {error}")
        if len(CACHE) >= CACHE_LIMIT:
            CACHE.pop(next(iter(CACHE)))
        CACHE[key] = response(*out)
    return CACHE[key]


# The front end. Mounted last, so the /api routes above win.
app.mount("/", StaticFiles(directory=config.ROOT / "frontend", html=True), name="frontend")
