"""Does the research problem exist, and does the model get the evening right?

Two parts, both for the pre-monsoon heat (Dhaka 16 May - 30 June,
Delhi 1 May - 30 June 2016, Tasgaonkar et al. 2022):

1. Measured evidence (no model). Mean daily profile of indoor air
   temperature by roof type, against the outdoor station. Shows whether
   heavy concrete roofs keep homes warm into the 20:00-21:00 power cut.

2. Evening check of the calibrated model. The calibration homes
   (calibrate_homes.select_homes) are re-run with the adopted settings and
   scored on the hours that matter for OASIS, not on the whole day:
       peak hour          hour (starting) of the mean daily maximum
       evening error      simulated - measured, mean of 19:00-22:00
       excess at 20:00    indoor - outdoor at 20:00, simulated vs measured

All hours are "hour starting" local time (20 = 20:00-21:00).

    python check_evening.py            Dhaka and Delhi
    python check_evening.py --no-sim   part 1 only
"""
import argparse
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

import config
import calibrate_homes as ch
from oasis import measured

OUT = config.OUT / "evidence"
CUT_HOUR = 20                 # power cut 20:00-21:00
EVENING = (19, 20, 21)        # 19:00-22:00
MIN_DAYS = 10                 # a logger needs this many days in the period


def roof_group(row, city):
    """Measured home -> roof group, or None (not used)."""
    roof = str(row["Roof structure"]).lower()
    above = str(row[ch.COLUMNS[city]["floor_above"]]).lower()
    if above == "yes" or "floor" in roof:
        return "Floor above"
    if above != "no":
        return None               # 'half' covered
    if "tin" in roof:
        return "Tin sheet, top floor"
    if any(k in roof for k in ("concrete", "stone", "brick")):
        return "Concrete / slab, top floor"
    return None


def daily_profile(x):
    return x.groupby(x.index.hour).mean()


# ---------------------------------------------------------------- part 1
def measured_evidence(city):
    _, _, _, period, _ = ch.CITIES[city]
    h = measured.housing(city).drop_duplicates("Logger ID")
    ind = measured.indoor(city).loc[period[0]:period[1]]
    out = measured.weather(city)["temp_c"].loc[period[0]:period[1]]
    cooler = h["Evaporative cooler"].astype(str).str.lower().str.startswith("yes")

    rows, profiles = [], {}
    for (_, r), has_cooler in zip(h.iterrows(), cooler):
        g, lid = roof_group(r, city), r["Logger ID"]
        if g is None or has_cooler or lid not in ind:
            continue                  # coolers are not modelled; keep free-running homes
        x = ind[lid].dropna()
        if len(x) < 24 * MIN_DAYS:
            continue
        p = daily_profile(x)
        o = out.reindex(x.index)
        profiles.setdefault(g, []).append(p)
        rows.append({"city": city, "logger": lid, "group": g, "days": len(x) // 24,
                     "peak_hour": int(p.idxmax()), "swing_c": p.max() - p.min(),
                     "t_cut_c": p[CUT_HOUR], "excess_cut_c": (x - o)[x.index.hour == CUT_HOUR].mean()})
    table = pd.DataFrame(rows)
    summary = (table.groupby("group")
               .agg(homes=("logger", "size"), peak_hour=("peak_hour", "median"),
                    swing_c=("swing_c", "median"), t_cut_c=("t_cut_c", "median"),
                    excess_cut_c=("excess_cut_c", "median"))
               .round(1).reset_index())
    op = daily_profile(out)
    summary.loc[len(summary)] = ["Outdoor station", 1, int(op.idxmax()), round(op.max() - op.min(), 1),
                                 round(op[CUT_HOUR], 1), 0.0]
    summary.insert(0, "city", city)
    return table, summary, {g: pd.concat(v, axis=1).mean(axis=1) for g, v in profiles.items()}, op


def measured_heat_index(city):
    """Heat index from loggers that also logged humidity (free-running homes
    only). No fan credit: this is the still-air value, as during the cut."""
    from oasis.metrics import SAFE_LIMIT_C, heat_index_c
    _, _, _, period, _ = ch.CITIES[city]
    h = measured.housing(city).drop_duplicates("Logger ID")
    ind = measured.indoor(city).loc[period[0]:period[1]]
    w = measured.weather(city).loc[period[0]:period[1]]
    out_hi = pd.Series(heat_index_c(w["temp_c"].values, w["rh"].values), index=w.index)
    rows = [{"city": city, "logger": "outdoor station", "group": "Outdoor station", "days": int(out_hi.notna().sum() // 24),
             "share_hours_over_limit_pct": round(100 * float((out_hi >= SAFE_LIMIT_C).mean()), 1),
             "share_days_cut_over_limit_pct": round(100 * float((out_hi[out_hi.index.hour == CUT_HOUR] >= SAFE_LIMIT_C).mean()), 1),
             "heat_index_cut_mean_c": round(float(out_hi[out_hi.index.hour == CUT_HOUR].mean()), 1)}]
    for _, r in h.iterrows():
        lid, g = r["Logger ID"], roof_group(r, city)
        if g is None or f"{lid} (RH)" not in ind or str(r["Evaporative cooler"]).lower().startswith("yes"):
            continue
        d = pd.DataFrame({"t": ind[lid], "rh": ind[f"{lid} (RH)"]}).dropna()
        if len(d) < 24 * MIN_DAYS:
            continue
        hi = pd.Series(heat_index_c(d["t"].values, d["rh"].values), index=d.index)
        cut = hi[hi.index.hour == CUT_HOUR]
        rows.append({"city": city, "logger": lid, "group": g, "days": len(d) // 24,
                     "share_hours_over_limit_pct": round(100 * float((hi >= SAFE_LIMIT_C).mean()), 1),
                     "share_days_cut_over_limit_pct": round(100 * float((cut >= SAFE_LIMIT_C).mean()), 1),
                     "heat_index_cut_mean_c": round(float(cut.mean()), 1)})
    return pd.DataFrame(rows)


COLOURS = {"Concrete / slab, top floor": "#c0392b", "Tin sheet, top floor": "#7f8c8d",
           "Floor above": "#2980b9", "Outdoor station": "black"}


def plot_evidence(results, png):
    fig, axes = plt.subplots(1, len(results), figsize=(6 * len(results), 4), sharey=False)
    for ax, (city, (table, summary, profiles, outdoor)) in zip(np.atleast_1d(axes), results.items()):
        ax.axvspan(CUT_HOUR, CUT_HOUR + 1, color="orange", alpha=0.3, lw=0, label="Power cut 20-21 h")
        for g, p in profiles.items():
            n = int((table["group"] == g).sum())
            ax.plot(p.index, p.values, color=COLOURS[g], lw=2, label=f"{g} (n={n})")
        ax.plot(outdoor.index, outdoor.values, color="black", ls="--", lw=1.5, label="Outdoor station")
        _, _, _, period, _ = ch.CITIES[city]
        ax.set_title(f"{city}, measured, {period[0]} to {period[1]}")
        ax.set_xlabel("Hour of day (starting)")
        ax.set_ylabel("Mean air temperature (°C)")
        ax.set_xticks(range(0, 24, 3))
        ax.set_xlim(0, 23)
        ax.grid(alpha=0.3)
        ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(png, dpi=200)
    plt.close(fig)


# ---------------------------------------------------------------- part 2
def evening_scores(sim, meas, outdoor, period):
    s = sim.loc[period[0]:period[1], "t_in"]
    m = meas.reindex(s.index)
    ok = m.notna()
    s, m, o = s[ok], m[ok], outdoor.reindex(s.index)[ok]
    ev, cut = s.index.hour.isin(EVENING), s.index.hour == CUT_HOUR
    return {"peak_sim": int(daily_profile(s).idxmax()), "peak_meas": int(daily_profile(m).idxmax()),
            "rmse_all_c": float(np.sqrt(((s - m) ** 2).mean())),
            "evening_err_c": float((s - m)[ev].mean()),
            "evening_rmse_c": float(np.sqrt(((s - m)[ev] ** 2).mean())),
            "excess_cut_sim_c": float((s - o)[cut].mean()), "excess_cut_meas_c": float((m - o)[cut].mean()),
            "days": int(ok.sum() // 24)}


def model_check(city, adopted):
    year, run_start, fit, _, epw, homes, ind, params = ch.prepare(city, "afn")
    designs = [dict(p, **adopted, name=f"home {i}") for i, p in enumerate(params)]
    print(f"{city}: simulating {len(designs)} homes with {adopted} ...")
    sims = ch.simulate(designs, OUT / f"runs_{city.lower()}", epw, year, run_start)
    outdoor = measured.weather(city)["temp_c"]
    cooler = homes["Evaporative cooler"].astype(str).str.lower().str.startswith("yes")
    rows, hourly = [], []
    for (i, r), sim in zip(homes.iterrows(), sims):
        lid = r["Logger ID"]
        rows.append({"city": city, "logger": lid, "roof": r["Roof structure"], "floor": r["Floor"],
                     "cooler": bool(cooler[i]), **evening_scores(sim, ind[lid], outdoor, fit)})
        hourly.append(pd.DataFrame({"city": city, "logger": lid, "t_sim": sim["t_in"],
                                    "t_meas": ind[lid].reindex(sim.index),
                                    "t_out": outdoor.reindex(sim.index)}))
    return pd.DataFrame(rows), pd.concat(hourly)


def plot_model(hourly, scores, png):
    """Mean daily profile, simulated vs measured, per city (homes without a cooler)."""
    cities = list(scores["city"].unique())
    fig, axes = plt.subplots(1, len(cities), figsize=(6 * len(cities), 4))
    for ax, city in zip(np.atleast_1d(axes), cities):
        keep = scores[(scores["city"] == city) & ~scores["cooler"]]["logger"]
        _, _, _, fit, _ = ch.CITIES[city]
        in_fit = (hourly.index >= fit[0]) & (hourly.index < pd.Timestamp(fit[1]) + pd.Timedelta(days=1))
        d = hourly[(hourly["city"] == city) & hourly["logger"].isin(keep) & in_fit].dropna()
        p = d.groupby(d.index.hour)[["t_meas", "t_sim", "t_out"]].mean()
        ax.axvspan(CUT_HOUR, CUT_HOUR + 1, color="orange", alpha=0.3, lw=0, label="Power cut 20-21 h")
        ax.plot(p.index, p["t_meas"], color="#c0392b", lw=2, label="Measured indoor")
        ax.plot(p.index, p["t_sim"], color="#c0392b", lw=2, ls=":", label="OASIS model")
        ax.plot(p.index, p["t_out"], color="black", lw=1.5, ls="--", label="Outdoor station")
        ax.set_title(f"{city}: {len(keep)} concrete-roof top-floor homes, {fit[0]} to {fit[1]}")
        ax.set_xlabel("Hour of day (starting)")
        ax.set_ylabel("Mean air temperature (°C)")
        ax.set_xticks(range(0, 24, 3))
        ax.set_xlim(0, 23)
        ax.grid(alpha=0.3)
        ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(png, dpi=200)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-sim", action="store_true", help="measured evidence only")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    pd.set_option("display.width", 200)

    results = {c: measured_evidence(c) for c in ("Dhaka", "Delhi")}
    pd.concat(r[0] for r in results.values()).round(2).to_csv(OUT / "measured_homes.csv", index=False)
    summary = pd.concat(r[1] for r in results.values())
    summary.to_csv(OUT / "measured_by_roof.csv", index=False)
    plot_evidence(results, OUT / "measured_daily_profile.png")
    print("Measured, free-running homes (median per group; excess = indoor - outdoor at 20:00):")
    print(summary.to_string(index=False))
    hi = pd.concat(measured_heat_index(c) for c in ("Dhaka", "Delhi"))
    hi.to_csv(OUT / "measured_heat_index.csv", index=False)
    print("\nMeasured heat index (loggers with humidity, no cooler; still air):")
    print(hi.to_string(index=False))
    if args.no_sim:
        return

    adopted = json.loads((ch.OUT / "afn" / "summary.json").read_text())["adopted"]
    parts = [model_check(c, adopted) for c in ("Dhaka", "Delhi")]
    scores = pd.concat(p[0] for p in parts)
    hourly = pd.concat(p[1] for p in parts)
    scores.round(2).to_csv(OUT / "model_evening_per_home.csv", index=False)
    hourly.round(2).to_csv(OUT / "model_evening_hourly.csv")
    plot_model(hourly, scores, OUT / "model_vs_measured_profile.png")
    print("\nModel vs measured, per home (fit period):")
    print(scores.round(2).to_string(index=False))

    groups = {}
    for (city, cooler), g in scores.groupby(["city", "cooler"]):
        key = f"{city}{' (cooler homes)' if cooler else ''}"
        groups[key] = {"homes": len(g),
                       "peak_sim_median": float(g["peak_sim"].median()), "peak_meas_median": float(g["peak_meas"].median()),
                       "peak_lag_h_mean": round(float((g["peak_meas"] - g["peak_sim"]).mean()), 1),
                       "rmse_all_c": round(float(g["rmse_all_c"].mean()), 2),
                       "evening_err_c": round(float(g["evening_err_c"].mean()), 2),
                       "evening_rmse_c": round(float(g["evening_rmse_c"].mean()), 2),
                       "excess_cut_sim_c": round(float(g["excess_cut_sim_c"].mean()), 2),
                       "excess_cut_meas_c": round(float(g["excess_cut_meas_c"].mean()), 2)}
    (OUT / "summary.json").write_text(json.dumps({"settings": adopted, "groups": groups,
                                                  "measured_by_roof": summary.to_dict("records")}, indent=2))
    print("\nSummary:")
    print(pd.DataFrame(groups).T.to_string())


if __name__ == "__main__":
    main()
