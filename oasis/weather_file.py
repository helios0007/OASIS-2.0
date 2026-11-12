"""Station weather (oasis.measured.weather) -> EnergyPlus weather file (.epw).

The Chennai .epw is used as a template for the file layout. Every hour that
the station measured replaces the template's hour with the same month, day
and hour. Only the run period is simulated, so the template hours outside it
do not matter.

The station measures total sunlight on a flat surface only. EnergyPlus also
needs direct and diffuse sunlight, so the total is split with the Erbs model.
Cloud cover (used by EnergyPlus for the night sky, which cools the roof) is
estimated from how clear the sky was during the day.
"""
from pathlib import Path

import numpy as np
import pandas as pd

import config

SITES = {
    # name, country, latitude, longitude, time zone (h), elevation (m)
    "Dhaka": ("Dhaka.AWS", "BGD", 23.777176, 90.399452, 6.0, 8.0),
    "Delhi": ("Delhi.AWS", "IND", 28.544600, 77.147801, 5.5, 216.0),
}

SOLAR_CONSTANT = 1367.0   # W/m2
CLEAR_SKY_KT = 0.75       # clearness index of a clear sky


def sun_cos_zenith(index, lat, lon, tz):
    """Cosine of the sun's zenith angle at the middle of each hour."""
    mid = index + pd.Timedelta(minutes=30)
    n = mid.dayofyear.values
    b = 2 * np.pi * (n - 81) / 364
    eot_min = 9.87 * np.sin(2 * b) - 7.53 * np.cos(b) - 1.5 * np.sin(b)
    decl = np.radians(23.45) * np.sin(2 * np.pi * (284 + n) / 365)
    clock_h = mid.hour.values + mid.minute.values / 60
    solar_h = clock_h + (4 * (lon - 15 * tz) + eot_min) / 60
    hour_angle = np.radians(15 * (solar_h - 12))
    phi = np.radians(lat)
    return (np.sin(phi) * np.sin(decl)
            + np.cos(phi) * np.cos(decl) * np.cos(hour_angle)), n


def split_sunlight(ghi, cos_z, n):
    """Erbs et al. (1982): total -> direct normal and diffuse."""
    extra = SOLAR_CONSTANT * (1 + 0.033 * np.cos(2 * np.pi * n / 365))
    extra_h = extra * np.clip(cos_z, 0, None)
    kt = np.where(extra_h > 10, ghi / np.maximum(extra_h, 1e-6), 0.0)
    kt = np.clip(kt, 0, 1)
    fd = np.where(kt <= 0.22, 1 - 0.09 * kt,
         np.where(kt <= 0.80,
                  0.9511 - 0.1604 * kt + 4.388 * kt**2
                  - 16.638 * kt**3 + 12.336 * kt**4,
                  0.165))
    dhi = ghi * fd
    dni = np.where(cos_z > 0.065, (ghi - dhi) / np.maximum(cos_z, 0.065), 0.0)
    return np.clip(dni, 0, 1100), dhi, kt


def cloud_cover_tenths(kt, cos_z, index):
    """Cloud cover (0-10) from the clearness index, inverting
    Kasten & Czeplak (1980): kt/kt_clear = 1 - 0.75 N^3.4.
    Night hours take the mean of the day's daylight hours."""
    ratio = np.clip(kt / CLEAR_SKY_KT, 0, 1)
    n = ((1 - ratio) / 0.75).clip(0, 1) ** (1 / 3.4)
    cover = pd.Series(np.where(cos_z > 0.2, n, np.nan), index=index)
    daily = cover.groupby(index.date).transform("mean")
    cover = cover.fillna(daily).ffill().bfill().fillna(0.5)
    return np.round(10 * cover.values).astype(int)


def make_epw(city, weather, out_path: Path, max_gap_h=3):
    """Write an .epw for `city` from hourly station weather.
    Gaps up to max_gap_h hours are filled by straight-line interpolation.
    Returns the hours (index) that are still missing."""
    name, country, lat, lon, tz, elev = SITES[city]
    w = weather.copy()
    for col in ("temp_c", "rh", "dewpoint_c", "wind_ms", "ghi_wm2", "pressure_pa"):
        w[col] = w[col].interpolate(limit=max_gap_h, limit_area="inside")
    w["wind_dir_deg"] = w["wind_dir_deg"].fillna(0)
    missing = w.index[w["temp_c"].isna()]
    w = w.dropna(subset=["temp_c", "rh", "dewpoint_c", "wind_ms", "ghi_wm2"])
    w["pressure_pa"] = w["pressure_pa"].fillna(101325)

    cos_z, n = sun_cos_zenith(w.index, lat, lon, tz)
    ghi = np.where(cos_z > 0, w["ghi_wm2"].clip(lower=0), 0.0)
    dni, dhi, kt = split_sunlight(ghi, cos_z, n)
    cover = cloud_cover_tenths(kt, cos_z, w.index)

    by_key = {}
    for i, t in enumerate(w.index):
        # EPW hour h covers (h-1):00 to h:00, so the hour starting at t is h = t.hour + 1
        by_key[(t.month, t.day, t.hour + 1)] = i

    lines = config.EPW.read_text().splitlines()
    head, rows = lines[:8], lines[8:]
    head[0] = (f"LOCATION,{name},,{country},OASIS station file,000000,"
               f"{lat:.4f},{lon:.4f},{tz:.1f},{elev:.1f}")
    head[5] = (f"COMMENTS 1,\"Hours measured by the {city} weather station "
               f"(Tasgaonkar et al. 2022) replace the Chennai template\"")

    out = []
    for line in rows:
        f = line.split(",")
        key = (int(f[1]), int(f[2]), int(f[3]))
        i = by_key.get(key)
        if i is not None:
            r = w.iloc[i]
            f[6] = f"{r.temp_c:.1f}"
            f[7] = f"{min(r.dewpoint_c, r.temp_c):.1f}"
            f[8] = f"{r.rh:.0f}"
            f[9] = f"{r.pressure_pa:.0f}"
            f[12] = "9999"                    # sky radiation: EnergyPlus works it out
            f[13] = f"{ghi[i]:.0f}"
            f[14] = f"{dni[i]:.0f}"
            f[15] = f"{dhi[i]:.0f}"
            f[20] = f"{r.wind_dir_deg:.0f}"
            f[21] = f"{r.wind_ms:.1f}"
            f[22] = str(cover[i])
            f[23] = str(cover[i])
        out.append(",".join(f))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(head + out) + "\n")
    return missing
