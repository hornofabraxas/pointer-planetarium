#!/usr/bin/env python3
# Writes src/pkjs/places_data.js, the towns and cities the logbook names
# places by ("near Phoenix", "about 100 km N of Flagstaff"; places.js),
# from Natural Earth's populated places (public domain):
#
#   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson
#
# Places of fewer than MIN_POP people are left out (Natural Earth lists
# ghost towns and tiny hamlets with a population of 0 or 10). Each kept
# place is one line, tab-separated: name, latitude and longitude in
# hundredths of a degree, Natural Earth's size rank (rank_max: 9 is
# 100,000 people or more, 12 a million or more), and its region (state,
# province) when another kept place has the same name.
#
# Run: python3 tools/make_places.py <ne_10m_populated_places_simple.geojson>
# (python3 only, no other packages).

import collections
import json
import os
import sys

MIN_POP = 1000
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'pkjs', 'places_data.js')


def main(path):
    with open(path, encoding='utf-8') as f:
        features = json.load(f)['features']
    kept = []
    for feature in features:
        p = feature['properties']
        name = (p.get('name') or '').strip()
        if not name or (p.get('pop_max') or 0) < MIN_POP:
            continue
        kept.append((name, round(p['latitude'] * 100), round(p['longitude'] * 100), int(p.get('rank_max') or 0),
                     (p.get('adm1name') or '').strip()))
    kept.sort(key=lambda r: (-r[3], r[0], r[1], r[2]))   # biggest first; the order is fixed so reruns match
    count = collections.Counter(r[0] for r in kept)
    lines = []
    for name, lat, lon, rank, region in kept:
        for s in (name, region):
            if '\t' in s or '\n' in s:
                raise SystemExit('unexpected tab or newline in %r' % s)
        row = [name, str(lat), str(lon), str(rank)]
        if count[name] > 1 and region and region != name:
            row.append(region)
        lines.append('\t'.join(row))
    with open(OUT, 'w', encoding='ascii') as f:
        f.write('// Made by tools/make_places.py from Natural Earth\'s populated places (public domain);\n'
                '// don\'t edit. One place a line: name, lat and lon (hundredths of a degree), size\n'
                '// rank (Natural Earth rank_max), region if the name is not unique.\n')
        f.write('module.exports = ' + json.dumps('\n'.join(lines), ensure_ascii=True) + ';\n')
    print('%d places, %d bytes' % (len(lines), os.path.getsize(OUT)))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('usage: python3 tools/make_places.py <ne_10m_populated_places_simple.geojson>')
    main(sys.argv[1])
