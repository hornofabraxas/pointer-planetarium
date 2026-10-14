# Reference positions and magnitudes from PyEphem (an independent
# implementation of VSOP87 and friends) for test/planets.test.js:
# the Sun, the planets, and a few bright stars.
# Run: uvx --with ephem python tools/make_sky_fixture.py
import datetime, json, math, random
import ephem

random.seed(11)
sites = [(33.45, -112.07), (51.48, 0.0), (-33.87, 151.21), (64.84, -147.72), (0.0, 0.0)]
bodies = {
    'sun': ephem.Sun, 'mercury': ephem.Mercury, 'venus': ephem.Venus, 'mars': ephem.Mars,
    'jupiter': ephem.Jupiter, 'saturn': ephem.Saturn, 'uranus': ephem.Uranus,
    'neptune': ephem.Neptune,
}
stars = ['Vega', 'Sirius', 'Polaris', 'Betelgeuse', 'Canopus', 'Arcturus', 'Deneb', 'Fomalhaut']
start = ephem.Date('2026/01/01 00:00:00')
rows = []
for k in range(120):
    lat, lon = sites[k % len(sites)]
    t = ephem.Date(start + random.uniform(0, 1460))
    obs = ephem.Observer()
    obs.lat, obs.lon = str(lat), str(lon)
    obs.elevation = 0
    obs.date = t
    obs.pressure = 1010
    obs.temp = 10
    ms = round((t.datetime() - datetime.datetime(1970, 1, 1)).total_seconds() * 1000)
    for name, cls in bodies.items():
        b = cls(obs)
        rows.append({'unix_ms': ms, 'lat': lat, 'lon': lon, 'id': name,
                     'az': math.degrees(float(b.az)), 'alt': math.degrees(float(b.alt)),
                     'mag': float(b.mag)})
    for name in stars:
        b = ephem.star(name)
        b.compute(obs)
        rows.append({'unix_ms': ms, 'lat': lat, 'lon': lon, 'id': 'star:' + name,
                     'az': math.degrees(float(b.az)), 'alt': math.degrees(float(b.alt))})
json.dump([{k: (round(v, 5) if isinstance(v, float) else v) for k, v in r.items()} for r in rows], open('test/sky_fixture.json', 'w'), separators=(',', ':'))
print(len(rows), 'rows')
