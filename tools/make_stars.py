# Builds src/pkjs/stars_data.js (and test/star_constellations.json) from:
#
#   Yale Bright Star Catalogue, 5th Revised Ed. (Hoffleit & Warren 1991),
#     CDS/VizieR V/50: https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz
#   IAU Catalog of Star Names (IAU WGSN), as mirrored by E. Mamajek:
#     https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt
#   Constellation boundaries (Roman 1987), CDS/VizieR VI/42:
#     https://cdsarc.cds.unistra.fr/ftp/VI/42/data.dat
#   Constellation stick figures (M. van der Sluys, CC BY 4.0,
#     DOI 10.5281/zenodo.10397192), by Bright Star Catalogue number:
#     https://github.com/MarcvdSluys/ConstellationLines (ConstellationLines.csv)
#   Distances from the Hipparcos parallaxes (ESA 1997), CDS/VizieR I/239,
#     matched by HD number: https://cdsarc.cds.unistra.fr/ftp/I/239/hip_main.dat
#
# Usage: python3 tools/make_stars.py <dir with catalog.gz, IAU-CSN.txt, data.dat,
#        ConstellationLines.csv, hip_main.dat>
#
# Stars on a stick figure are kept even when fainter than the limit, so
# every figure can be drawn whole.
#
# Each star's type from its catalog spectral type is one more character
# (spec): class * 8 + luminosity class, base 64 (see SPEC_CLASSES and
# spec_code).
#
# Stars are packed 8 characters each (RA 3, Dec 3, magnitude 2, base 64) to
# keep the phone-side bundle small: about 23 KB for the ~2,900 stars down
# to magnitude 5.5, at 5 arcsecond resolution.
import gzip, json, math, os, sys

MAG_LIMIT = 5.5
PLX_GOOD = 0.2     # a parallax with a larger relative error gives no distance
LY_PER_MAS = 3261.56
B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


def enc(v, n):
    out = ''
    for _ in range(n):
        out = B64[v % 64] + out
        v //= 64
    return out


SPEC_CLASSES = 'OBAFGKM'   # 7: anything else (carbon stars, Wolf-Rayet, white dwarfs)
# Luminosity class codes: 0 unknown, 1 supergiant (I), 2 bright giant (II),
# 3 giant (III), 4 subgiant (IV), 5 main sequence (V), 6 white dwarf.
SPEC_LUM = [('Ia0', 1), ('Iab', 1), ('Ia', 1), ('Ib', 1), ('III', 3), ('II', 2), ('IV', 4), ('V', 5), ('I', 1)]


def spec_code(sp):
    """One base-64 character for a catalog spectral type ('K0III', 'gG8',
    'B8Iae', 'M2Iab:', 'DA')."""
    sp = sp.strip()
    lum = 0
    if sp.startswith('D'):
        return enc(7 * 8 + 6, 1)
    # Mount Wilson prefixes: c supergiant, g giant, sg subgiant, d dwarf.
    for pre, code in (('sd', 0), ('sg', 4), ('c', 1), ('g', 3), ('d', 5)):
        if sp.startswith(pre) and len(sp) > len(pre) and sp[len(pre)] in SPEC_CLASSES:
            lum, sp = code, sp[len(pre):]
            break
    if not sp or sp[0] not in SPEC_CLASSES:
        return enc(7 * 8 + lum, 1)
    k = SPEC_CLASSES.index(sp[0])
    rest = sp[1:].lstrip('0123456789.:+-/ ')
    if not lum:
        for tok, code in SPEC_LUM:
            if rest.startswith(tok):
                lum = code
                break
    return enc(k * 8 + lum, 1)


def num(s):
    s = s.strip()
    return float(s) if s else None


src = sys.argv[1]
names_by_hr, names_by_hd = {}, {}
for line in open(os.path.join(src, 'IAU-CSN.txt'), encoding='utf-8'):
    if line.startswith('#') or not line.strip():
        continue
    name = line[0:18].strip()
    desig = line[36:49].strip()
    if desig.startswith('HR '):
        names_by_hr[int(desig[3:])] = name
    # Read HD from the right: ... HIP HD RA Dec Date [Notes].
    tokens = line.split()
    while tokens and not (len(tokens[-1]) == 10 and tokens[-1][4] == '-'):
        tokens.pop()
    if len(tokens) >= 4 and tokens[-4].isdigit():
        names_by_hd[int(tokens[-4])] = name

# Stick figures: [(abbreviation, [HR, ...]), ...], one per drawn line.
figures = []
for line in open(os.path.join(src, 'ConstellationLines.csv')):
    f = [x.strip() for x in line.split(',')]
    if not f or f[0] == 'abr' or not f[0]:
        continue
    hrs = [int(x) for x in f[2:2 + int(f[1])]]
    figures.append((f[0], hrs))
on_figure = set(hr for _, hrs in figures for hr in hrs)

# Hipparcos parallaxes by HD number (fields split on '|': 1 HIP, 11 Plx,
# 16 e_Plx in milliarcseconds, 71 HD).
plx_by_hd = {}
for line in open(os.path.join(src, 'hip_main.dat'), encoding='latin-1'):
    f = line.split('|')
    if len(f) < 72:
        continue
    plx, eplx, hd = num(f[11]), num(f[16]), f[71].strip()
    if plx and eplx is not None and hd and plx > 0 and eplx / plx < PLX_GOOD:
        plx_by_hd[int(hd)] = plx
if not 370 < plx_by_hd.get(48915, 0) < 390:   # Sirius: 379 mas
    sys.exit('hip_main.dat columns are not where expected (Sirius HD 48915)')

stars, names, cons, dist, spec, idx_by_hr = [], {}, [], [], [], {}
with gzip.open(os.path.join(src, 'catalog.gz'), 'rt', encoding='latin-1') as f:
    for line in f:
        line = line.rstrip('\n').ljust(197)
        hr = int(line[0:4])
        bname = line[4:14]
        hd = line[25:31].strip()
        rah, ram, ras = line[75:77].strip(), line[77:79].strip(), line[79:83].strip()
        sign, ded, dem, des = line[83], line[84:86].strip(), line[86:88].strip(), line[88:90].strip()
        vmag = num(line[102:107])
        if not rah or vmag is None or (vmag > MAG_LIMIT and hr not in on_figure):
            continue
        ra = (int(rah) + int(ram) / 60 + float(ras) / 3600) * 15
        dec = int(ded) + int(dem) / 60 + int(des) / 3600
        if sign == '-':
            dec = -dec
        idx = len(stars)
        idx_by_hr[hr] = idx
        plx = plx_by_hd.get(int(hd)) if hd else None
        # log10(light years) * 800 in 2 characters; 0 for unknown.
        code = max(1, min(4095, int(round(math.log10(LY_PER_MAS / plx) * 800)))) if plx else 0
        dist.append(enc(code, 2))
        spec.append(spec_code(line[127:147]))
        stars.append(enc(int(round(ra / 360 * 262144)) % 262144, 3) +
                     enc(int(round((dec + 90) / 180 * 262143)), 3) +
                     enc(int(round((vmag + 2) * 100)), 2))
        name = names_by_hr.get(hr) or (names_by_hd.get(int(hd)) if hd else None)
        if name:
            names[idx] = name
        con = bname[7:10].strip()
        if con:
            cons.append([idx, con])

lines = {}
missing = 0
for con, hrs in figures:
    # A star with no position breaks the line there, rather than joining
    # its neighbours.
    poly = []
    for hr in hrs + [None]:
        if hr in idx_by_hr:
            poly.append(idx_by_hr[hr])
            continue
        if hr is not None:
            missing += 1
        if len(poly) > 1:
            lines.setdefault(con, []).append(','.join(str(i) for i in poly))
        poly = []
lines_str = '|'.join('%s:%s' % (con, ';'.join(polys)) for con, polys in sorted(lines.items()))

roman = []
for line in open(os.path.join(src, 'data.dat')):
    if line.strip():
        lo, hi, de, con = line[1:8].strip(), line[9:16].strip(), line[17:25].strip(), line[26:29].strip()
        roman.append('%s,%s,%s,%s' % (lo, hi, de, con))

out = os.path.join(os.path.dirname(__file__), '..', 'src', 'pkjs', 'stars_data.js')
with open(out, 'w') as f:
    f.write('// Generated by tools/make_stars.py. Do not edit.\n')
    f.write('// Stars: Yale Bright Star Catalogue 5th ed. (Hoffleit & Warren 1991, CDS V/50),\n')
    f.write('// to magnitude %.1f, J2000. Names: IAU Catalog of Star Names (IAU WGSN, CC BY).\n' % MAG_LIMIT)
    f.write('// Constellation boundaries: Roman 1987 (CDS VI/42), equinox B1875.\n')
    f.write('// Stick figures: M. van der Sluys, ConstellationLines (CC BY 4.0).\n')
    f.write('// Distances: Hipparcos parallaxes (ESA 1997, CDS I/239), where good to %d%%.\n' % (PLX_GOOD * 100))
    f.write('// Types: the catalog\'s spectral types, as class and luminosity class.\n')
    f.write('module.exports = {\n')
    f.write('  count: %d,\n' % len(stars))
    f.write('  packed: %s,\n' % json.dumps(''.join(stars)))
    f.write('  names: %s,\n' % json.dumps(names, separators=(',', ':')))
    f.write('  dist: %s,\n' % json.dumps(''.join(dist)))
    f.write('  spec: %s,\n' % json.dumps(''.join(spec)))
    f.write('  lines: %s,\n' % json.dumps(lines_str))
    f.write('  roman: %s\n' % json.dumps(';'.join(roman)))
    f.write('};\n')

fixture = os.path.join(os.path.dirname(__file__), '..', 'test', 'star_constellations.json')
json.dump(cons, open(fixture, 'w'), separators=(',', ':'))
print('%d stars, %d named, %d with a catalog constellation, %d boundary rows, %d with a distance, '
      '%d stick figures (%d figure stars missing)' %
      (len(stars), len(names), len(cons), len(roman), sum(1 for d in dist if d != 'AA'), len(lines), missing))
