"""Does the urban weather model get a real Chennai place right?

The Neighbourhood tab passes the airport's heatwave week through the Urban Weather
Generator (oasis/urban.py) to get the air at a site. Chennai has one place inside the
city where the air was measured in that same week: the Nungambakkam station
(check_city_weather.py). This script runs the urban model for the ground around that
station and sets its answer beside what the station measured, both as "minus the airport".

What the check can and cannot say:
  - the station stands in an open, fenced compound, not in a street, so it is a check on
    the city-scale answer, not on the air between buildings;
  - the station's 24 values are drawn through 3-hourly reports (check_city_weather.py);
  - the urban model has no sea breeze. Nungambakkam is about 4 km from the sea.

    python check_urban_station.py        (after check_city_weather.py; needs the internet once)
Outputs: outputs/urban_check/summary.json, station_check.png
"""
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import config
from oasis import urban, urban_env, urban_heights

STATION = next(p for p in urban.PLACES if p["name"].startswith("Nungambakkam"))
RADIUS_M = 250                                    # the tab's default analysis circle
MEASURED = config.OUT / "city_weather" / "summary.json"
OUT = config.OUT / "urban_check"
NIGHT_HOURS = (20, 21, 22, 23, 0, 1, 2, 3, 4, 5)  # as in urban.make_site
DAY_HOURS = tuple(range(10, 17))


def mean(values, hours):
    return round(sum(values[h] for h in hours) / len(hours), 2)


def station_form():
    """Urban form and green cover around the station, read the way the tab reads them."""
    lat, lon = STATION["lat"], STATION["lon"]
    form = urban_heights.form(*urban_heights.height_grid(lat, lon, RADIUS_M), RADIUS_M)
    tree = urban_env.canopy(lat, lon, RADIUS_M)["tree_cover"]
    grass = urban_env.land_cover(lat, lon, RADIUS_M)["shares"]["grass"]
    return form, round(tree, 2), round(grass, 2)


def main():
    if not MEASURED.exists():
        raise SystemExit("Run check_city_weather.py first (it makes outputs/city_weather/summary.json).")
    measured = json.loads(MEASURED.read_text())["profile_24h"]["heatwave_week"]["d_temp_c"]
    form, tree, grass = station_form()
    print(f"Around the station: {form['site_coverage']:.0%} built, mean height {form['mean_height_m']} m, "
          f"facade / ground {form['facade_to_site']}, trees {tree:.0%}, grass {grass:.0%}")

    OUT.mkdir(parents=True, exist_ok=True)
    cases = {}
    for homes in urban.CITY_HOMES:
        epw = OUT / f"_station_{homes}.epw"
        delta = urban.urban_air(form, tree, grass, epw, homes)
        epw.unlink(missing_ok=True)
        gap = [m - s for m, s in zip(delta, measured)]
        cases[homes] = {"label": urban.CITY_HOMES[homes], "d_temp_c": delta,
                        "night_c": mean(delta, NIGHT_HOURS), "day_c": mean(delta, DAY_HOURS),
                        "mean_gap_c": round(sum(gap) / 24, 2),                         # model minus station
                        "rms_gap_c": round((sum(g * g for g in gap) / 24) ** 0.5, 2)}
    station = {"d_temp_c": measured, "night_c": mean(measured, NIGHT_HOURS), "day_c": mean(measured, DAY_HOURS)}
    summary = {"place": STATION, "radius_m": RADIUS_M, "period": "1-7 May 2024", "form": form,
               "tree_cover": tree, "grass_cover": grass, "street_heat_w_m2": urban.SENS_ANTH_W_M2,
               "station": station, "cases": cases,
               "note": "All values are air temperature minus the airport's, by hour of the day. "
                       "The station is in an open compound, not a street; the model has no sea breeze."}
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))

    print(f"{'':38s}{'night':>8s}{'day':>8s}{'rms gap':>9s}")
    print(f"{'Station (measured)':38s}{station['night_c']:+8.2f}{station['day_c']:+8.2f}")
    for c in cases.values():
        print(f"{'Model: ' + c['label']:38s}{c['night_c']:+8.2f}{c['day_c']:+8.2f}{c['rms_gap_c']:9.2f}")
    plot(station, cases)


def plot(station, cases):
    hours = range(24)
    fig, ax = plt.subplots(figsize=(8, 4))
    ax.axhline(0, color="0.6", lw=0.8)
    ax.plot(hours, station["d_temp_c"], color="black", lw=2, marker="o", ms=3, label="Nungambakkam station (measured)")
    for (homes, c), colour in zip(cases.items(), ("tab:blue", "tab:red")):
        ax.plot(hours, c["d_temp_c"], color=colour, lw=1.5, label=f"Urban model: {c['label'].lower()}")
    ax.set_xlabel("Hour of the day")
    ax.set_ylabel("Air temperature minus airport (°C)")
    ax.set_title("Urban model against the city station, 1–7 May 2024")
    ax.set_xticks(range(0, 24, 3))
    ax.legend(frameon=False, fontsize=8)
    fig.tight_layout()
    fig.savefig(OUT / "station_check.png", dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    main()
