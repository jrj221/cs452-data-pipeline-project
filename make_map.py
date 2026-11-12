"""Build a Utah temperature map from live NWS observations.

Reads the fixed station list from observations.json (see build_config.py), fetches each station's latest
observation from NWS, and writes map.html:
  * a heatmap of the whole state (blue = cold, red = hot), clipped to Utah's border. Each cell is the
    Gaussian-weighted average of nearby station temperatures, so overlapping influence is averaged;
  * small station dots with hover details (temperature + observation time);
  * an overlay card with the refresh time and the overall least-recent observation.

Usage:  .venv/bin/python make_map.py
"""
import html
import json
import math
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np
import plotly.graph_objects as go
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely import contains_xy

HEADERS = {"User-Agent": "cs452-pipeline-class-project", "Accept": "application/geo+json"}
CONFIG_FILE = "observations.json"
TZ = ZoneInfo("America/Denver")
COUNTY_GEOJSON = "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json"
COUNTY_CACHE = "utah_counties.geojson"

# --- tuning knobs ---
SIGMA_KM = 14.0    # how far a station's temperature "spreads"; bigger = smoother / more blended
GRID_STEP = 0.015  # degrees per heatmap cell (~1.6 km)
VIEW_PAD = 0.15    # degrees of margin around Utah; also the zoom-out limit
BG = "#e8ecf1"     # page / outside-the-state background
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
COLORSCALE = "RdBu_r"


def get_json(url):
    for _ in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
                return json.load(r)
        except Exception:
            pass
    return None


def fetch(station):
    """Latest observation for one configured station. Returns a dict (temp_f/observed may be None)."""
    out = dict(station, temp_f=None, observed=None, status="no data")
    d = get_json(f"https://api.weather.gov/stations/{station['id']}/observations/latest")
    if not d:
        return out
    p = d["properties"]
    if p.get("timestamp"):
        out["observed"] = datetime.fromisoformat(p["timestamp"].replace("Z", "+00:00"))
    t = p["temperature"]["value"]
    if t is None:
        out["status"] = "no temperature"
    else:
        out["temp_f"] = t * 9 / 5 + 32
        out["status"] = "ok"
    return out


def fmt_time(dt):
    return dt.astimezone(TZ).strftime("%b %d %H:%M %Z") if dt else "—"


def fmt_age(dt, now):
    if not dt:
        return "—"
    m = int((now - dt).total_seconds() // 60)
    return f"{m} min" if m < 120 else f"{m / 60:.1f} h"


def load_county_outlines():
    """Utah county polygons (GeoJSON), downloaded once and cached next to the script."""
    if not os.path.exists(COUNTY_CACHE):
        geo = get_json(COUNTY_GEOJSON)
        geo["features"] = [f for f in geo["features"] if f["id"].startswith("49")]
        with open(COUNTY_CACHE, "w") as f:
            json.dump(geo, f)
    with open(COUNTY_CACHE) as f:
        return json.load(f)


def exterior_rings(geo):
    """Outer boundary ring of every county polygon (holes such as lakes are ignored on purpose)."""
    rings = []
    for feat in geo["features"]:
        g = feat["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        rings += [poly[0] for poly in polys]
    return rings


def lines_trace(rings, color, width):
    xs, ys = [], []
    for ring in rings:
        xs += [p[0] for p in ring] + [None]
        ys += [p[1] for p in ring] + [None]
    return go.Scatter(x=xs, y=ys, mode="lines", line=dict(color=color, width=width), hoverinfo="skip", showlegend=False)


def temperature_grid(shown, state_poly, vmin_lat):
    """Kernel-weighted average of station temps on a lon/lat grid; NaN outside the state border."""
    minx, miny, maxx, maxy = state_poly.bounds
    lons = np.arange(minx, maxx + GRID_STEP, GRID_STEP)
    lats = np.arange(miny, maxy + GRID_STEP, GRID_STEP)
    LON, LAT = np.meshgrid(lons, lats)
    inside = contains_xy(state_poly, LON, LAT)
    px, py = LON[inside], LAT[inside]

    slon = np.array([o["lon"] for o in shown])
    slat = np.array([o["lat"] for o in shown])
    stemp = np.array([o["temp_f"] for o in shown])
    kx = math.cos(math.radians(vmin_lat)) * 111.32  # km per degree lon at Utah's latitude
    ky = 110.57                                      # km per degree lat

    vals = np.empty(px.size)
    for i in range(0, px.size, 4000):  # chunked to keep memory small
        dx = (px[i:i + 4000, None] - slon[None, :]) * kx
        dy = (py[i:i + 4000, None] - slat[None, :]) * ky
        d2 = dx * dx + dy * dy
        w = np.exp(-d2 / (2 * SIGMA_KM ** 2))
        wsum = w.sum(axis=1)
        avg = (w * stemp).sum(axis=1) / np.where(wsum > 0, wsum, 1)
        far = wsum < 1e-12  # farther than the kernel reaches: fall back to the nearest station
        avg[far] = stemp[d2[far].argmin(axis=1)]
        vals[i:i + 4000] = avg

    z = np.full(LON.shape, np.nan)
    z[inside] = vals
    return lons, lats, np.round(z, 1)


def main():
    with open(CONFIG_FILE) as f:
        cfg = json.load(f)
    max_age_h = cfg["max_age_hours"]
    print(f"{len(cfg['stations'])} stations in {CONFIG_FILE}; fetching...")
    with ThreadPoolExecutor(8) as ex:
        obs = list(ex.map(fetch, cfg["stations"]))
    now = datetime.now(timezone.utc)

    for o in obs:  # stale readings are listed in the table but not used on the map
        if o["status"] == "ok" and (now - o["observed"]).total_seconds() > max_age_h * 3600:
            o["status"] = f"stale (>{max_age_h} h)"
    shown = [o for o in obs if o["status"] == "ok"]
    print(f"{len(shown)} current, {len(obs) - len(shown)} missing/stale")

    oldest = min(shown, key=lambda o: o["observed"])
    newest = max(shown, key=lambda o: o["observed"])

    geo = load_county_outlines()
    rings = exterior_rings(geo)
    state_poly = unary_union([Polygon(r).buffer(0) for r in rings]).buffer(0)
    minx, miny, maxx, maxy = state_poly.bounds
    lons, lats, z = temperature_grid(shown, state_poly, (miny + maxy) / 2)

    temps = [o["temp_f"] for o in shown]
    # Fit the color range to where most stations are (3rd-97th percentile, rounded to 5 degrees),
    # so a couple of extreme stations don't wash out the rest of the map.
    lo, hi = np.percentile(temps, [3, 97])
    zmin, zmax = 5 * math.floor(lo / 5), 5 * math.ceil(hi / 5)
    fig = go.Figure()
    fig.add_trace(go.Heatmap(
        x=lons, y=lats, z=z, zmin=zmin, zmax=zmax, colorscale=COLORSCALE, zsmooth=False,
        colorbar=dict(
            orientation="h", x=0.02, y=0.04, xanchor="left", yanchor="bottom", len=0.26, lenmode="fraction",
            thickness=10, title=dict(text="Temperature (°F)", side="top", font=dict(size=12)),
            ticksuffix="°", tickfont=dict(size=11), outlinewidth=0, bgcolor="rgba(255,255,255,0.85)",
            borderwidth=0, xpad=12, ypad=10,
        ),
        hovertemplate="%{z:.1f} °F (blended estimate)<extra></extra>",
    ))
    fig.add_trace(lines_trace(rings, "rgba(40,40,40,0.28)", 0.6))  # county borders
    boundary = state_poly.boundary
    border_lines = list(boundary.geoms) if hasattr(boundary, "geoms") else [boundary]
    fig.add_trace(lines_trace([list(l.coords) for l in border_lines], "#1c2430", 1.8))  # state border
    fig.add_trace(go.Scatter(
        x=[o["lon"] for o in shown], y=[o["lat"] for o in shown], mode="markers",
        marker=dict(size=5, color=temps, cmin=zmin, cmax=zmax, colorscale=COLORSCALE,
                    line=dict(color="rgba(20,28,40,0.65)", width=0.8)),
        customdata=[[o["id"], o["name"], o["temp_f"], fmt_time(o["observed"]), fmt_age(o["observed"], now)] for o in shown],
        hovertemplate="<b>%{customdata[1]}</b> · %{customdata[0]}<br>%{customdata[2]:.1f} °F<br>"
                      "<span style='opacity:.7'>observed %{customdata[3]} (%{customdata[4]} ago)</span><extra></extra>",
        showlegend=False,
    ))

    # View: Utah fills the window height. The y-range is the real zoom-out limit; x is allowed much wider so
    # the map fills the full window width and you can pan sideways on wide screens.
    yr = [miny - VIEW_PAD, maxy + VIEW_PAD]
    xr = [minx - VIEW_PAD, maxx + VIEW_PAD]
    lat_mid = (miny + maxy) / 2
    axis = dict(showgrid=False, zeroline=False, showticklabels=False, ticks="", showline=False, constrain="range")
    fig.update_layout(
        xaxis=dict(range=xr, minallowed=xr[0] - 6, maxallowed=xr[1] + 6, **axis),
        # keep Utah's true shape: a degree of longitude is shorter than a degree of latitude
        yaxis=dict(range=yr, minallowed=yr[0], maxallowed=yr[1], scaleanchor="x",
                   scaleratio=1 / math.cos(math.radians(lat_mid)), **axis),
        dragmode="pan", plot_bgcolor=BG, paper_bgcolor=BG, margin=dict(l=0, r=0, t=0, b=0),
        hoverlabel=dict(bgcolor="white", font=dict(family=FONT, size=13, color="#1c2430"), bordercolor="#d5dae1"),
        font=dict(family=FONT, color="#1c2430"),
    )
    map_div = fig.to_html(
        full_html=False, include_plotlyjs="cdn", default_width="100%", default_height="100%",
        config={"scrollZoom": True, "displaylogo": False, "doubleClick": "reset", "responsive": True,
                "modeBarButtonsToRemove": ["select2d", "lasso2d", "autoScale2d"]},
    )

    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Utah temperatures</title>
<style>
  html,body{{height:100%;margin:0;background:{BG};font-family:{FONT};color:#1c2430}}
  #map{{position:fixed;inset:0}}
  .card{{position:fixed;top:16px;left:16px;z-index:10;width:300px;box-sizing:border-box;padding:16px 18px;
    background:rgba(255,255,255,.92);backdrop-filter:blur(6px);border:1px solid #dde2e9;border-radius:12px;
    box-shadow:0 4px 18px rgba(20,30,50,.10)}}
  .card h1{{margin:0 0 2px;font-size:18px;font-weight:650;letter-spacing:-.01em}}
  .card .sub{{margin:0 0 12px;font-size:12.5px;color:#5b6675}}
  .stat{{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid #edf0f4;font-size:13px}}
  .stat span:first-child{{color:#5b6675}} .stat span:last-child{{text-align:right;font-weight:550}}
  .stat small{{display:block;font-weight:400;color:#5b6675;font-size:11.5px}}
  .warn span:last-child{{color:#b4540a}}
  @media (max-width:600px){{.card{{width:auto;right:16px;padding:12px 14px}}}}
</style></head><body>
<div id="map">{map_div}</div>
<div class="card">
  <h1>Utah temperatures</h1>
  <p class="sub">Live NWS station observations, blended across the state</p>
  <div class="stat"><span>Refreshed</span><span>{fmt_time(now)}</span></div>
  <div class="stat"><span>Stations</span><span>{len(shown)} of {len(obs)} current</span></div>
  <div class="stat{' warn' if (now - oldest['observed']).total_seconds() > 2 * 3600 else ''}"><span>Least recent</span>
    <span>{fmt_time(oldest['observed'])}<small>{html.escape(oldest['name'] or oldest['id'])} · {fmt_age(oldest['observed'], now)} ago</small></span></div>
  <div class="stat"><span>Most recent</span>
    <span>{fmt_time(newest['observed'])}<small>{html.escape(newest['name'] or newest['id'])} · {fmt_age(newest['observed'], now)} ago</small></span></div>
</div>
</body></html>"""
    with open("map.html", "w") as f:
        f.write(page)
    print(f"wrote map.html | color range {zmin}-{zmax} F | least recent: {oldest['id']} {fmt_time(oldest['observed'])} ({fmt_age(oldest['observed'], now)} ago)")


if __name__ == "__main__":
    main()
