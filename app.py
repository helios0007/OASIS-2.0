"""OASIS 2.0 Workbench (Streamlit Edition): Rhino .3dm + Live EnergyPlus 26.2 Studio.

Run:  streamlit run app.py
"""
import tempfile
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import streamlit as st
import streamlit.components.v1 as components

import config
from oasis.agents import DEFAULT_AGENTS, simulate_household
from oasis.assess import assess
from oasis.build_idf import MATERIALS, ROOFS, WALLS
from oasis.from_rhino import read_model
from oasis.labels import LABELS, name_of
from oasis.metrics import FAN_CREDIT_C, SAFE_LIMIT_C, peaks
from oasis.params import BASELINE, SWEEP_LEVELS

SAMPLE = config.ROOT / "data" / "rhino" / "sample_flat.3dm"


def u_value(layers, r_si=0.13, r_se=0.04):
    r_layers = sum(MATERIALS[m][0] / MATERIALS[m][1] for m in layers)
    return round(1.0 / (r_si + r_layers + r_se), 2)


def hi_color(hi):
    if hi < 32:
        return "#10b981"
    if hi < 37:
        return "#06b6d4"
    if hi < 41:
        return "#f59e0b"
    if hi < 45:
        return "#ef4444"
    return "#d946ef"


def load_model(data: bytes, filename: str):
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / filename
        path.write_bytes(data)
        return read_model(path)


@st.cache_data(show_spinner="Running parallel EnergyPlus 26.2 heat-balance simulations...")
def cached_assess(params_items):
    p = {k: (dict(v) if isinstance(v, tuple) else v) for k, v in params_items}
    return assess(p)


def build_3d_svg(p, hi_val, tout_val, hour_of_day):
    L = max(3.0, min(12.0, float(p.get("length_m", 6.0))))
    W = max(3.0, min(12.0, float(p.get("width_m", 5.0))))
    H = max(2.4, min(5.0, float(p.get("height_m", 3.0))))
    scale = min(24.0, 190.0 / max(L, W))
    lx, wy, hz = L * scale, W * scale, H * scale * 1.1
    cx, cy = 320, 210

    def iso(x, y, z):
        return cx + (x - y) * 0.866, cy + (x + y) * 0.5 - z

    def pts(arr):
        return " ".join(f"{iso(x, y, z)[0]:.1f},{iso(x, y, z)[1]:.1f}" for x, y, z in arr)

    x0, x1 = -lx / 2, lx / 2
    y0, y1 = -wy / 2, wy / 2
    z0, z1 = 0, hz
    zr0, zr1 = z1 + 34, z1 + 43
    glow = hi_color(hi_val)
    roof_abs = float(p.get("roof_solar_absorptance", 0.7))
    roof_col = "#f8fafc" if roof_abs <= 0.25 else ("#a8a29e" if roof_abs <= 0.45 else "#57534e")
    is_middle = p.get("floor") == "middle"
    has_insul = p.get("roof") == "rcc_150_insul_50"
    has_shade = float(p.get("shading_depth_m", 0.0)) > 0
    is_cut = hour_of_day == config.CUT_START_HOUR

    svg = f'<svg viewBox="0 0 640 310" width="100%" height="290" style="background:radial-gradient(circle at 50% 45%, rgba(6,182,212,0.12), #0b111e 72%);border-radius:12px;border:1px solid rgba(148,163,184,0.2)">'
    svg += f'<polygon points="{pts([(x0,y0,z0),(x0,y1,z0),(x0,y1,z1),(x0,y0,z1)])}" fill="#92400e" fill-opacity="0.78" stroke="#f59e0b"/>'
    svg += f'<polygon points="{pts([(x0,y0,z0),(x1,y0,z0),(x1,y0,z1),(x0,y0,z1)])}" fill="#b45309" fill-opacity="0.82" stroke="#f59e0b"/>'
    svg += f'<polygon points="{pts([(x0,y0,z0),(x1,y0,z0),(x1,y1,z0),(x0,y1,z0)])}" fill="{glow}" fill-opacity="0.48" stroke="{glow}" stroke-width="2"/>'
    svg += f'<polygon points="{pts([(x0,y1,z0),(x1,y1,z0),(x1,y1,z1),(x0,y1,z1)])}" fill="#b45309" fill-opacity="0.24" stroke="#f59e0b" stroke-width="1.5"/>'
    svg += f'<polygon points="{pts([(x1,y0,z0),(x1,y1,z0),(x1,y1,z1),(x1,y0,z1)])}" fill="#92400e" fill-opacity="0.20" stroke="#f59e0b" stroke-width="1.5"/>'
    svg += f'<polygon points="{pts([(-32,y1,22),(32,y1,22),(32,y1,62),(-32,y1,62)])}" fill="#38bdf8" fill-opacity="0.45" stroke="#38bdf8" stroke-width="1.8"/>'
    if has_shade:
        svg += f'<polygon points="{pts([(-38,y1,62),(38,y1,62),(38,y1+20,60),(-38,y1+20,60)])}" fill="#eab308" stroke="#fef08a"/>'
    if not is_middle:
        if has_insul:
            svg += f'<polygon points="{pts([(x0,y1,zr0-6),(x1,y1,zr0-6),(x1,y1,zr0),(x0,y1,zr0)])}" fill="#f59e0b"/>'
        svg += f'<polygon points="{pts([(x0,y0,zr1),(x1,y0,zr1),(x1,y1,zr1),(x0,y1,zr1)])}" fill="{roof_col}" stroke="#94a3b8" stroke-width="1.5"/>'
    else:
        svg += f'<polygon points="{pts([(x0,y0,zr0),(x1,y0,zr0),(x1,y1,zr0),(x0,y1,zr0)])}" fill="#475569" fill-opacity="0.72" stroke="#94a3b8"/>'
    rx, ry = iso(0, 0, z1 * 0.36)
    fan_txt = "⚡ FAN OFF (POWER CUT)" if is_cut else "🌀 FAN ON (≈ −2 °C, ASHRAE 55)"
    svg += f'<g transform="translate({rx:.1f},{ry:.1f})"><rect x="-62" y="-13" width="124" height="24" rx="12" fill="rgba(11,17,30,0.88)" stroke="{glow}" stroke-width="1.5"/><text x="0" y="3" text-anchor="middle" fill="{glow}" font-size="11" font-family="monospace" font-weight="700">HI {hi_val:.1f}°C · Out {tout_val:.1f}°C</text></g>'
    svg += f'<text x="16" y="24" fill="#cbd5e1" font-size="11.5" font-family="monospace" font-weight="700">{L:.1f}m × {W:.1f}m × {H:.1f}m · {fan_txt}</text>'
    svg += "</svg>"
    return svg


def main():
    st.set_page_config(page_title="OASIS 2.0 · Environmental Simulation Workbench", layout="wide", initial_sidebar_state="expanded")

    st.markdown("""
    <style>
      .stApp { background-color: #060911; color: #f8fafc; }
      section[data-testid="stSidebar"] { background-color: #0b111e; border-right: 1px solid rgba(148,163,184,0.16); }
      div[data-testid="stMetric"] {
        background: #101829; border: 1px solid rgba(148,163,184,0.18);
        border-top: 3px solid #06b6d4; border-radius: 10px; padding: 12px 14px;
      }
      .wb-banner {
        background: linear-gradient(90deg, rgba(6,182,212,0.15), rgba(16,185,129,0.10));
        border: 1px solid rgba(6,182,212,0.35); border-radius: 10px; padding: 10px 16px; margin-bottom: 14px;
        display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;
      }
    </style>
    """, unsafe_allow_html=True)

    st.markdown(f"""
    <div class="wb-banner">
      <div>
        <span style="color:#06b6d4;font-family:monospace;font-size:11px;font-weight:700">OASIS 2.0 · ENVIRONMENTAL & THERMAL SIMULATION WORKBENCH</span>
        <h2 style="margin:0;font-size:20px;color:#f8fafc">Chennai Heatwave (1–7 May 2024, recorded) · Nightly 20:00–21:00 Power Cut</h2>
      </div>
      <div style="font-size:12px;color:#cbd5e1">
        Safe Limit: <b>&lt; {SAFE_LIMIT_C:.0f} °C HI</b> · Ceiling Fan: <b>ASHRAE 55 cooling effect (about {FAN_CREDIT_C:.0f} °C)</b> · Full Web Studio also live at <a href="http://127.0.0.1:8000" target="_blank" style="color:#06b6d4;font-weight:700">http://127.0.0.1:8000</a>
      </div>
    </div>
    """, unsafe_allow_html=True)

    with st.sidebar:
        st.markdown("### 📐 1. Geometry Source")
        geom_mode = st.radio(
            "Input Mode",
            ["Sample Rhino Model (.3dm)", "Upload Custom Rhino (.3dm)", "Parametric Sliders"],
            index=0,
        )
        upload = None
        if geom_mode == "Upload Custom Rhino (.3dm)":
            upload = st.file_uploader("Upload a .3dm file", type=["3dm"], key="upload")

    geometry = {}
    report = None
    if geom_mode == "Sample Rhino Model (.3dm)":
        geometry, report = load_model(SAMPLE.read_bytes(), SAMPLE.name)
    elif geom_mode == "Upload Custom Rhino (.3dm)":
        if upload is not None:
            try:
                geometry, report = load_model(upload.getvalue(), upload.name)
            except Exception as error:
                st.error(f"Could not read Rhino model: {error}")
                return
        else:
            st.info("Upload a `.3dm` file in the sidebar, or switch to Sample Rhino Model / Parametric Sliders.")
            return
    else:
        with st.sidebar:
            st.markdown("### 📏 Room Dimensions")
            length_m = st.slider("Length E–W (m)", 2.5, 15.0, float(BASELINE["length_m"]), 0.1)
            width_m = st.slider("Width N–S (m)", 2.5, 15.0, float(BASELINE["width_m"]), 0.1)
            height_m = st.slider("Ceiling Height (m)", 2.4, 4.5, float(BASELINE["height_m"]), 0.1)
            wwr_pct = st.slider("Window-to-Wall Ratio (%)", 5, 50, int(BASELINE["wwr"] * 100), 1)
            orient = st.selectbox("Orientation", [0, 90], format_func=lambda v: "0° (N/S Windows)" if v == 0 else "90° (E/W Windows)")
            geometry = {
                "length_m": length_m,
                "width_m": width_m,
                "height_m": height_m,
                "wwr": wwr_pct / 100.0,
                "orientation_deg": orient,
            }

    choices = {}
    with st.sidebar:
        st.markdown("### 🧱 2. Envelope & Passive Systems")
        for key, (title, options) in LABELS.items():
            levels = SWEEP_LEVELS[key]
            choices[key] = st.selectbox(
                title, levels, index=levels.index(BASELINE[key]),
                format_func=lambda v, o=options: o[v], key=f"choice_{key}"
            )

    p = dict(BASELINE, **geometry, **choices)
    items = tuple(sorted((k, tuple(sorted(v.items())) if isinstance(v, dict) else v) for k, v in p.items()))
    summary, hourly, changes = cached_assess(items)
    agents_out = simulate_household(DEFAULT_AGENTS, hourly)   # JOS-3 check measure

    # Top KPI Strip
    pct = round(summary["safe_hours"] / summary["hours_total"] * 100)
    k1, k2, k3, k4 = st.columns(4)
    k1.metric("Thermal Autonomy (Safe Hours)", f"{summary['safe_hours']} / {summary['hours_total']} h", f"{pct}% of week safe")
    k2.metric("Power-Cut Danger Nights", f"{summary['cut_hours_in_danger']} / 7 nights", f"{7 - summary['cut_hours_in_danger']}/7 cuts safe")
    k3.metric("Peak Felt Heat Index", f"{summary['max_heat_index_c']:.1f} °C", f"Air peak {summary['max_indoor_temp_c']:.1f} °C", delta_color="inverse")
    k4.metric("Overheating Severity", f"{summary['degree_hours_over_limit']:.0f} °C·h", f"Above {SAFE_LIMIT_C:.0f} °C limit", delta_color="inverse")

    # Two peaks from the same run: the room's normal daily peak and the peak during the cut
    pk = peaks(hourly)
    n, c, w = pk["normal"], pk["cut"], pk["by_hour"][pk["worst_cut_hour"]]
    st.caption(
        f"**Normal peak:** hottest around {n['typical_hour']:02d}:00 (up to {n['max_indoor_temp_c']} °C air, "
        f"{n['max_heat_index_c']} °C felt with the fan on). **During the {c['start_hour']:02d}:00–{c['end_hour']:02d}:00 cut:** "
        f"up to {c['max_indoor_temp_c']} °C air, {c['max_heat_index_c']} °C felt, above {SAFE_LIMIT_C:.0f} °C on "
        f"{c['nights_in_danger']}/{c['days']} nights. **Worst hour for a cut:** {w['hour']:02d}:00 "
        f"({w['max_heat_index_no_fan_c']} °C felt with the fan off, {w['days_in_danger']}/{c['days']} days)."
    )

    # Main Workbench Split: Left = 3D Twin & Time Scrubber, Right = Passive Strategy Stack
    col_viz, col_rank = st.columns([1.35, 1.0])

    with col_viz:
        st.markdown("#### 🧊 3D Spatial & Solar Twin + 168-Hour Time Machine")
        scrub_hr = st.slider("Scrub Hour of Heatwave Week (0 = 10 May 00:00, 167 = 16 May 23:00)", 0, 167, 14)
        hi_now = float(hourly["heat_index"].iloc[scrub_hr])
        tout_now = float(hourly["t_out"].iloc[scrub_hr])
        st.markdown(build_3d_svg(p, hi_now, tout_now, scrub_hr % 24), unsafe_allow_html=True)
        if report:
            st.caption(f"📦 **Rhino Geometry ({report['file']})**: {report['size']} · Floor area {report['floor_area_m2']} m² · Glazing {report['window_to_wall_pct']}% of walls")

    with col_rank:
        st.markdown("#### ✨ Passive Cooling Strategies Ranked by Safe Hours Gained")
        best_per_param = {}
        for ch in changes:
            best_per_param.setdefault(ch["parameter"], ch)
        top = [ch for ch in best_per_param.values() if ch["safe_hours_gained"] > 0][:5]
        if top:
            for rank, ch in enumerate(top, start=1):
                gain = ch["safe_hours_gained"]
                d_peak = ch["max_heat_index_c"] - summary["max_heat_index_c"]
                st.markdown(f"""
                <div style="background:#101829;border:1px solid rgba(148,163,184,0.18);border-left:4px solid #10b981;border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
                  <div>
                    <b style="color:#f8fafc">#{rank} {name_of(ch['parameter'], ch['value'])}</b>
                    <div style="font-size:12px;color:#94a3b8">Reaches <b>{ch['safe_hours']} / 168 h</b> · Peak HI {d_peak:+.1f} °C · Cut danger: {ch['cut_hours_in_danger']}/7</div>
                  </div>
                  <span style="font-size:20px;font-weight:700;color:#10b981;font-family:monospace">+{gain}h</span>
                </div>
                """, unsafe_allow_html=True)
        else:
            st.success("🎉 Optimal passive configuration reached for this geometry!")

    # Analytics Tabs
    t0, t1, t2, t3 = st.tabs(["🧬 Household body check (JOS-3)", "🟧 7×24h Thermal Carpet Barcode", "📈 168-Hour Heatwave Timeline", "📋 Full Sensitivity Matrix"])
    with t0:
        st.markdown(f"**Live Occupant Biometrics & First-Person Feedback at Hour {scrub_hr} ({10 + scrub_hr // 24} May, {scrub_hr % 24:02d}:00)**")
        acols = st.columns(len(agents_out))
        for idx, ag in enumerate(agents_out):
            if not ag["modelled"]:
                with acols[idx]:
                    st.markdown(f"**{ag['name']}** · {ag['age']}y")
                    st.caption(ag['note'])
                continue
            st_lvl = ag["hourly"]["status"][scrub_hr]
            bcol = {"safe": "#10b981", "caution": "#f59e0b", "danger": "#f97316", "critical": "#ef4444", "away": "#64748b"}.get(st_lvl, "#10b981")
            with acols[idx]:
                st.markdown(f"""
                <div style="background:#101829;border:1px solid rgba(148,163,184,0.2);border-top:3px solid {bcol};border-radius:8px;padding:10px 12px;font-size:12px">
                  <div style="font-weight:700;font-size:14px;color:#f8fafc">{ag['name']}</div>
                  <div style="color:#94a3b8;font-family:monospace;font-size:11px">{ag['age']}y {ag['sex']} · {ag['height_cm']}cm · {ag['weight_kg']}kg</div>
                  <hr style="border-color:rgba(148,163,184,0.15);margin:6px 0">
                  <div>Core T<sub>cr</sub>: <b style="color:{bcol}">{ag['hourly']['t_core'][scrub_hr]:.2f} °C</b> · Skin: <b>{ag['hourly']['t_skin'][scrub_hr]:.1f} °C</b></div>
                  <div>Sweat: <b>{ag['hourly']['sweat_gh'][scrub_hr]:.0f} g/h</b> ({ag['hourly']['wettedness_pct'][scrub_hr]:.0f}% wet)</div>
                  <div style="margin-top:6px;padding:6px;background:#0b111e;border-radius:6px;font-style:italic;color:#cbd5e1">“{ag['hourly']['feedback'][scrub_hr]}”</div>
                  <div style="margin-top:6px;font-family:monospace;font-size:11px;color:#94a3b8">Safe at home: <b>{ag['summary']['safe_hours']}/{ag['summary']['hours_at_home']} h</b> (core &lt; 38 °C) · Peak T<sub>cr</sub> {ag['summary']['max_core_temp_c']}°C</div>
                </div>
                """, unsafe_allow_html=True)
    with t1:
        hi_matrix = hourly["heat_index"].to_numpy().reshape(7, 24)
        fig_hm, ax_hm = plt.subplots(figsize=(12, 3.2), facecolor="#0b111e")
        ax_hm.set_facecolor("#0b111e")
        im = ax_hm.imshow(hi_matrix, aspect="auto", cmap="turbo", vmin=30, vmax=48)
        ax_hm.set_yticks(range(7))
        ax_hm.set_yticklabels([f"{10+d} May" for d in range(7)], color="#cbd5e1", fontsize=9)
        ax_hm.set_xticks(range(24))
        ax_hm.set_xticklabels([f"{h:02d}h" for h in range(24)], color="#cbd5e1", fontsize=8)
        ax_hm.axvline(19.5, color="#fbbf24", lw=1.5, ls="--")
        ax_hm.axvline(20.5, color="#fbbf24", lw=1.5, ls="--")
        cbar = fig_hm.colorbar(im, ax=ax_hm, pad=0.02)
        cbar.ax.yaxis.set_tick_params(color="#cbd5e1")
        plt.setp(plt.getp(cbar.ax.axes, "yticklabels"), color="#cbd5e1", fontsize=8)
        fig_hm.tight_layout()
        st.pyplot(fig_hm)
        plt.close(fig_hm)

    with t2:
        fig_ts, ax_ts = plt.subplots(figsize=(12, 3.4), facecolor="#0b111e")
        ax_ts.set_facecolor("#0b111e")
        for i, is_cut in enumerate(hourly["cut"]):
            if is_cut:
                ax_ts.axvspan(i, i + 1, color="#fbbf24", alpha=0.22, lw=0)
        ax_ts.plot(hourly["heat_index"].values, label="Your Design (HI °C)", color="#06b6d4", lw=2.0)
        if top:
            ax_ts.plot(top[0]["hourly"]["heat_index"].values, label=f"+ {name_of(top[0]['parameter'], top[0]['value'])}", color="#10b981", lw=1.8)
        ax_ts.axhline(SAFE_LIMIT_C, color="#ef4444", ls="--", lw=1.4, label=f"Danger ({SAFE_LIMIT_C:.0f} °C)")
        ax_ts.tick_params(colors="#94a3b8")
        ax_ts.set_xlim(0, 168)
        ax_ts.legend(facecolor="#101829", edgecolor="#334155", labelcolor="#f8fafc", fontsize=8.5)
        fig_ts.tight_layout()
        st.pyplot(fig_ts)
        plt.close(fig_ts)

    with t3:
        table = pd.DataFrame([{
            "Change": name_of(ch["parameter"], ch["value"]),
            "Safe Hours": ch["safe_hours"],
            "Net Gain (h)": ch["safe_hours_gained"],
            "Cut Danger (/7)": ch["cut_hours_in_danger"],
            "Peak HI (°C)": ch["max_heat_index_c"],
            "Over Limit (°C·h)": ch["degree_hours_over_limit"],
        } for ch in changes])
        st.dataframe(table, hide_index=True, use_container_width=True)


if __name__ == "__main__":
    main()
