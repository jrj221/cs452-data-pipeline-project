"""One-time (or occasional) step: generate observations.json, the fixed list of stations the map looks up.

Keeps Utah stations that currently report a recent temperature. After this runs, edit observations.json
by hand if you want (add/remove stations); make_map.py only ever reads that file.

Usage:  .venv/bin/python build_config.py
"""
import json
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

HEADERS = {"User-Agent": "cs452-pipeline-class-project", "Accept": "application/geo+json"}
STATE = "UT"
MAX_AGE_HOURS = 3
UTAH_BBOX = dict(west=-114.06, east=-109.04, south=36.99, north=42.01)


def get_json(url):
    for _ in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
                return json.load(r)
        except Exception:
            pass
    return None


def list_stations():
    out, url = [], f"https://api.weather.gov/stations?state={STATE}&limit=500"
    while url:
        d = get_json(url)
        if not d or not d["features"]:
            break
        for f in d["features"]:
            lon, lat = f["geometry"]["coordinates"]
            b = UTAH_BBOX
            if not (b["west"] <= lon <= b["east"] and b["south"] <= lat <= b["north"]):
                continue
            p = f["properties"]
            out.append({"id": p["stationIdentifier"], "name": p.get("name"), "lat": round(lat, 4), "lon": round(lon, 4)})
        url = d.get("pagination", {}).get("next")
    return out


def is_current(station):
    d = get_json(f"https://api.weather.gov/stations/{station['id']}/observations/latest")
    if not d:
        return False
    p = d["properties"]
    if p["temperature"]["value"] is None or not p.get("timestamp"):
        return False
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(p["timestamp"].replace("Z", "+00:00"))).total_seconds() / 3600
    return age <= MAX_AGE_HOURS


def main():
    stations = list_stations()
    print(f"{len(stations)} {STATE} stations listed; checking which report a current temperature...")
    with ThreadPoolExecutor(8) as ex:
        ok = list(ex.map(is_current, stations))
    keep = sorted((s for s, good in zip(stations, ok) if good), key=lambda s: s["id"])
    config = {
        "variable": "temperature",
        "max_age_hours": MAX_AGE_HOURS,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "stations": keep,
    }
    with open("observations.json", "w") as f:
        json.dump(config, f, indent=2)
    print(f"wrote observations.json with {len(keep)} stations")


if __name__ == "__main__":
    main()
