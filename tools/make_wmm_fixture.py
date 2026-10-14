# Reference declinations from pygeomag (an independent WMM2025
# implementation) for test/wmm.test.js.
# Run: uvx --with pygeomag python tools/make_wmm_fixture.py
import json, random
from pygeomag import GeoMag

gm = GeoMag(coefficients_file='wmm/WMM_2025.COF')
random.seed(3)
rows = []
for k in range(60):
    lat = random.uniform(-80, 80)
    lon = random.uniform(-180, 180)
    alt = random.uniform(0, 3)
    year = random.uniform(2025.0, 2029.9)
    r = gm.calculate(glat=lat, glon=lon, alt=alt, time=year)
    rows.append({"lat": lat, "lon": lon, "altKm": alt, "year": year, "decl": r.d, "h": r.h})
json.dump(rows, open("test/wmm_fixture.json", "w"), indent=0)
print(len(rows), "rows")
