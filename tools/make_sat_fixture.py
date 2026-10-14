"""Reference satellite positions for test/satellites.test.js, from Skyfield.

Skyfield (its own SGP4 binding, its own frames and its own Earth-shadow
test) is independent of satellite.js and of src/pkjs/satellites.js, so the
test compares two separate pipelines from the same element set.

Run: uvx --with skyfield python tools/make_sat_fixture.py
"""
import json
import os
from skyfield.api import load, wgs84, EarthSatellite

# ISS element set from CelesTrak, 2026-10-07.
ISS = {
    'OBJECT_NAME': 'ISS (ZARYA)', 'OBJECT_ID': '1998-067A', 'EPOCH': '2026-10-07T13:30:47.478528',
    'MEAN_MOTION': 15.48762857, 'ECCENTRICITY': 0.00068101, 'INCLINATION': 51.6311,
    'RA_OF_ASC_NODE': 103.9669, 'ARG_OF_PERICENTER': 234.3585, 'MEAN_ANOMALY': 125.6769,
    'EPHEMERIS_TYPE': 0, 'CLASSIFICATION_TYPE': 'U', 'NORAD_CAT_ID': 25544, 'ELEMENT_SET_NO': 999,
    'REV_AT_EPOCH': 58917, 'BSTAR': 8.5268073e-5, 'MEAN_MOTION_DOT': 4.213e-5, 'MEAN_MOTION_DDOT': 0,
}
LAT, LON, ELEV_M = 33.45, -112.07, 340   # downtown Phoenix

ts = load.timescale()
eph = load('de421.bsp')
sat = EarthSatellite.from_omm(ts, ISS)
here = wgs84.latlon(LAT, LON, elevation_m=ELEV_M)

# Every pass above 10 degrees within a few days of the epoch, sampled every
# 30 s, plus a coarse sweep of the whole period (mostly below the horizon,
# which checks the geometry far from the observer too).
t0 = ts.utc(2026, 10, 5, 12)
t1 = ts.utc(2026, 10, 10, 12)
times = []
tt, events = sat.find_events(here, t0, t1, altitude_degrees=10)
rise = None
for t, e in zip(tt, events):
    if e == 0:
        rise = t
    elif e == 2 and rise is not None:
        n = int((t.tt - rise.tt) * 86400 / 30) + 1
        times += [ts.tt_jd(rise.tt + k * 30 / 86400) for k in range(n)]
        rise = None
times += [ts.tt_jd(t0.tt + k * 0.0913) for k in range(int((t1.tt - t0.tt) / 0.0913))]
# One whole orbit at 30 s steps around local midnight, which crosses the
# Earth's shadow twice: checks the sunlit test at its edges.
mid = ts.utc(2026, 10, 8, 6)
times += [ts.tt_jd(mid.tt + k * 30 / 86400) for k in range(186)]

rows = []
for t in times:
    topo = (sat - here).at(t)
    alt, az, dist = topo.altaz()
    lit = bool(sat.at(t).is_sunlit(eph))
    sun_alt = (eph['earth'] + here).at(t).observe(eph['sun']).apparent().altaz()[0].degrees
    rows.append({
        'utc': t.utc_iso(places=3),
        'az': round(az.degrees, 4), 'alt': round(alt.degrees, 4), 'km': round(dist.km, 2),
        'lit': lit, 'sunAlt': round(sun_alt, 2),
    })

out = {'omm': ISS, 'lat': LAT, 'lon': LON, 'elevM': ELEV_M, 'rows': rows}
with open(os.path.join(os.path.dirname(__file__), '..', 'test', 'sat_fixture.json'), 'w') as f:
    json.dump(out, f, indent=0)
print(len(rows), 'rows;', sum(r['alt'] > 10 for r in rows), 'above 10 deg;',
      sum(r['lit'] and r['alt'] > 10 and r['sunAlt'] < -6 for r in rows), 'visible')
