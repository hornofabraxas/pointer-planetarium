#!/usr/bin/env python3
"""Builds the watch's aircraft shapes, resources/data/craft.bin (stdlib only).

Usage: python3 tools/make_craft.py           writes resources/data/craft.bin
       python3 tools/make_craft.py --check   fails if it doesn't match SHAPES
       python3 tools/make_craft.py --svg out.svg   also writes a review sheet

Each shape is a plane seen from below (or above: they're the same), nose
up, drawn on a plane's chart along its path (main.c draw_craft). They're
rough on purpose: a 747 and a 757 look alike at this size, but neither
looks like a fighter. Which shape a plane gets is planes.js CRAFT (the
order here is its numbering, from 1).

Units: 120 from nose to tail (signed bytes), x to the right, y toward the
tail, the middle of the plane at 0. A part is one of:
    ('mirror', [(x, y), ...])  the right half of an outline, from the nose
                               on the centre line to the tail on it; the
                               watch mirrors it for the left
    ('pair', [(x, y), ...])    a right-hand piece (an engine), and its mirror
    ('ring', (x, y, r))        a circle's outline (a rotor)

File: a count, then each shape's offset (u16, little-endian), then the
shapes, each its part count then its parts: 0 (mirror) or 1 (pair), the
point count and the points (x, y as signed bytes); 2 (ring), x, y, r.
"""
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'resources', 'data', 'craft.bin')
OUT_JS = os.path.join(ROOT, 'src', 'pkjs', 'craft_svg.js')   # the same shapes for the settings page


def rect(x, y, w, h):
    return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]


SHAPES = [
    # 1 AIRLINER: swept wings, an engine under each.
    ('airliner', [
        ('mirror', [(0, -56), (4, -50), (5, -10), (50, 14), (50, 20), (5, 8), (5, 36), (20, 48), (20, 53),
                    (3, 50), (0, 56)]),
        ('pair', rect(16, -14, 7, 16)),
    ]),
    # 2 JUMBO: wider, four engines.
    ('jumbo', [
        ('mirror', [(0, -58), (6, -50), (6, -12), (58, 18), (58, 24), (6, 8), (6, 38), (22, 50), (22, 55),
                    (3, 52), (0, 58)]),
        ('pair', rect(15, -17, 7, 16)),
        ('pair', rect(33, -6, 7, 16)),
    ]),
    # 3 REAR_JET: straighter wings, engines on the tail, a T-tail.
    ('rear jet', [
        ('mirror', [(0, -52), (4, -46), (4, -4), (40, 10), (40, 15), (4, 8), (4, 44), (18, 52), (18, 56),
                    (0, 56)]),
        ('pair', rect(5, 22, 7, 14)),
    ]),
    # 4 PROPS: straight wings, an engine and propeller on each.
    ('props', [
        ('mirror', [(0, -48), (4, -42), (4, -8), (48, -6), (48, 2), (4, 2), (4, 40), (18, 46), (18, 51),
                    (0, 51)]),
        ('pair', rect(15, -18, 6, 18)),
        ('pair', rect(9, -21, 18, 3)),
    ]),
    # 5 LIGHT: one propeller, long straight wings.
    ('light', [
        ('mirror', [(0, -40), (5, -36), (5, -12), (44, -12), (44, -2), (5, -2), (3, 32), (14, 34), (14, 40),
                    (0, 40)]),
        ('mirror', [(0, -45), (12, -45), (12, -42), (0, -42)]),
    ]),
    # 6 HELI: the rotor's circle, a body and a tail.
    ('helicopter', [
        ('ring', (0, -8, 44)),
        ('mirror', [(0, -26), (6, -23), (9, -16), (10, -8), (9, 0), (5, 7), (2, 9), (2, 46), (8, 46), (8, 49),
                    (0, 49)]),
    ]),
    # 7 FAST_JET: a pointed nose, swept wings, twin fins.
    ('fast jet', [
        ('mirror', [(0, -60), (4, -44), (6, -20), (36, 20), (36, 26), (8, 22), (8, 32), (22, 48), (22, 52),
                    (4, 48), (0, 52)]),
    ]),
    # 8 GLIDER: very long thin wings.
    ('glider', [
        ('mirror', [(0, -28), (3, -22), (3, -8), (58, -6), (58, -2), (3, 0), (2, 34), (12, 36), (12, 40),
                    (0, 40)]),
    ]),
]

KIND = {'mirror': 0, 'pair': 1, 'ring': 2}


def shape_bytes(parts):
    out = bytearray([len(parts)])
    for kind, data in parts:
        out.append(KIND[kind])
        if kind == 'ring':
            out += struct.pack('<bbB', *data)
        else:
            out.append(len(data))
            for x, y in data:
                out += struct.pack('<bb', x, y)
    return bytes(out)


def build():
    bodies = [shape_bytes(parts) for _, parts in SHAPES]
    at = 1 + 2 * len(bodies)
    head = bytearray([len(bodies)])
    for b in bodies:
        head += struct.pack('<H', at)
        at += len(b)
    return bytes(head) + b''.join(bodies)


def check_limits():
    """The watch's limits (main.c CRAFT_PTS_MAX, CRAFT_BYTES_MAX)."""
    for name, parts in SHAPES:
        n = len(shape_bytes(parts))
        assert n <= 160, '%s: %d bytes' % (name, n)
        for kind, data in parts:
            if kind == 'mirror':
                assert data[0][0] == 0 and data[-1][0] == 0, name + ': a half outline starts and ends on the centre'
                assert 2 * len(data) - 2 <= 24, name + ': too many points'
            elif kind == 'pair':
                assert len(data) <= 24, name + ': too many points'
            for v in (data if kind == 'ring' else [c for p in data for c in p]):
                assert -127 <= v <= 127, name + ': out of a byte'


def outline(kind, data):
    """A part's polygons (each [(x, y), ...]), or a ring's (x, y, r)."""
    if kind == 'ring':
        return [data]
    sides = [1, -1] if kind == 'pair' else [1]
    out = []
    for sx in sides:
        pts = [(sx * x, y) for x, y in data]
        if kind == 'mirror':
            pts += [(-x, y) for x, y in data[-2:0:-1]]
        out.append(pts)
    return out


def page_js():
    """src/pkjs/craft_svg.js: each shape as SVG markup in a -64..64 box,
    in CRAFT order (from 1; [0] is unused)."""
    shapes = ['']
    for _, parts in SHAPES:
        marks = []
        for kind, data in parts:
            for o in outline(kind, data):
                if kind == 'ring':
                    marks.append('<circle cx="%d" cy="%d" r="%d" fill="none" stroke="currentColor" stroke-width="4"/>' % o)
                else:
                    marks.append('<polygon points="%s"/>' % ' '.join('%d,%d' % p for p in o))
        shapes.append(''.join(marks))
    return ('// Made by tools/make_craft.py: the watch\'s aircraft shapes (planes.js CRAFT, from\n'
            '// 1) as SVG for the settings page, in a -64..64 box, nose up. Don\'t edit.\n'
            'module.exports = ' + json.dumps(shapes, indent=0).replace('\n', ' ') + ';\n')


def svg(path):
    cell = 140
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">' % (cell * len(SHAPES), cell + 20)]
    for i, (name, parts) in enumerate(SHAPES):
        cx, cy = cell * i + cell / 2, cell / 2
        for kind, data in parts:
            if kind == 'ring':
                out.append('<circle cx="%g" cy="%g" r="%g" fill="none" stroke="black"/>' %
                           (cx + data[0], cy + data[1], data[2]))
                continue
            sides = [1, -1] if kind == 'pair' else [1]
            for sx in sides:
                pts = [(sx * x, y) for x, y in data]
                if kind == 'mirror':
                    pts += [(-x, y) for x, y in data[-2:0:-1]]
                out.append('<polygon points="%s"/>' % ' '.join('%g,%g' % (cx + x, cy + y) for x, y in pts))
        out.append('<text x="%g" y="%d" text-anchor="middle" font-size="12">%s</text>' % (cx, cell + 14, name))
    out.append('</svg>')
    open(path, 'w').write('\n'.join(out))


def main(argv):
    check_limits()
    data = build()
    js = page_js()
    if '--check' in argv:
        if not os.path.exists(OUT) or open(OUT, 'rb').read() != data:
            print('resources/data/craft.bin is out of date: run python3 tools/make_craft.py')
            return 1
        if not os.path.exists(OUT_JS) or open(OUT_JS).read() != js:
            print('src/pkjs/craft_svg.js is out of date: run python3 tools/make_craft.py')
            return 1
        return 0
    open(OUT, 'wb').write(data)
    open(OUT_JS, 'w').write(js)
    if '--svg' in argv:
        svg(argv[argv.index('--svg') + 1])
    print('craft.bin: %d shapes, %d bytes' % (len(SHAPES), len(data)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
