"""Build docs/utah.json: simplified Utah state outline + county borders for the website.

Usage:  .venv/bin/python build_site_geo.py      (needs utah_counties.geojson, created by make_map.py)
"""
import json

from shapely.geometry import Polygon
from shapely.ops import unary_union

TOL = 0.003  # degrees (~300 m) of simplification; invisible at statewide zoom, keeps the file small


def rings_of(geom):
    polys = geom.geoms if hasattr(geom, "geoms") else [geom]
    return [list(p.exterior.coords) for p in polys]


geo = json.load(open("utah_counties.geojson"))
county_polys = []
for feat in geo["features"]:
    g = feat["geometry"]
    parts = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    county_polys += [Polygon(p[0]).buffer(0) for p in parts]  # outer rings only (lakes are not cut out)

state = unary_union(county_polys).buffer(0).simplify(TOL)
rnd = lambda ring: [[round(x, 3), round(y, 3)] for x, y in ring]
out = {
    "bbox": [round(v, 3) for v in state.bounds],
    "state": [rnd(r) for r in rings_of(state)],
    "counties": [rnd(r) for p in county_polys for r in rings_of(p.simplify(TOL))],
}
json.dump(out, open("docs/utah.json", "w"), separators=(",", ":"))
print("bbox", out["bbox"], "| state rings", len(out["state"]), "| county rings", len(out["counties"]),
      "| state points", sum(map(len, out["state"])))
