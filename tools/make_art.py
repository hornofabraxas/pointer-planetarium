#!/usr/bin/env python3
"""Builds the watch's pictures from art/manifest.json (stdlib only).

Usage: python3 tools/make_art.py            writes resources/images/*.png
       python3 tools/make_art.py --check    fails if they don't match their sources
       python3 tools/make_art.py --sheet out.png   also writes a review sheet

The planets and the Moon: each photo (art/src, a public domain NASA image
shrunk with sips, see the manifest for where it came from) is cut out of
its black sky, shrunk to the size the watch shows it by averaging (so the
sky never darkens the edge), toned, then dithered (Atkinson) onto a few
colours the Pebble Time 2 can show, picked by hand per picture. Out comes
a palettised PNG with the sky transparent; the SDK keeps it palettised on
the watch (2 or 4 bits a pixel), and the watch swaps the palette for the
red Stargazer theme.

The launcher icon is drawn here too: Saturn in black on transparent, as
the launcher wants it.

--check compares decoded pixels and palettes, not file bytes (zlib's
output differs between versions).

The review sheet has a row per picture: the photo shrunk without
dithering, then as the watch shows it in the Night, Day and Stargazer
themes, all at twice the watch's size.
"""
import base64
import json
import math
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---------------------------------------------------------------- PNG

def read_png(path):
    """(w, h, rows): rows of (r, g, b, a) tuples, 0..255. 8-bit, not interlaced."""
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(path + ': not a PNG')
    k, idat, plte, trns = 8, b'', None, None
    while k < len(data):
        n, kind = struct.unpack('>I4s', data[k:k + 8])
        body = data[k + 8:k + 8 + n]
        if kind == b'IHDR':
            w, h, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', body)
        elif kind == b'PLTE':
            plte = body
        elif kind == b'tRNS':
            trns = body
        elif kind == b'IDAT':
            idat += body
        k += 12 + n
    if interlace:
        raise ValueError(path + ': interlaced')
    if ctype == 3:
        if depth not in (1, 2, 4, 8):
            raise ValueError(path + ': bit depth %d' % depth)
    elif depth != 8:
        raise ValueError(path + ': bit depth %d' % depth)
    chans = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    stride = (w * chans * depth + 7) // 8
    bpp = max(1, chans * depth // 8)
    raw = zlib.decompress(idat)
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        row = []
        for x in range(w):
            if ctype == 3:
                bit = x * depth
                v = (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
                al = trns[v] if trns and v < len(trns) else 255
                row.append((plte[3 * v], plte[3 * v + 1], plte[3 * v + 2], al))
            elif ctype == 0:
                row.append((line[x],) * 3 + (255,))
            elif ctype == 4:
                row.append((line[2 * x],) * 3 + (line[2 * x + 1],))
            elif ctype == 2:
                row.append(tuple(line[3 * x:3 * x + 3]) + (255,))
            else:
                row.append(tuple(line[4 * x:4 * x + 4]))
        rows.append(row)
    return w, h, rows


def png_chunk(kind, body):
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body) & 0xffffffff)


def write_png_palette(path, w, h, index, palette):
    """index: rows of palette indices; palette: (r, g, b, a) tuples."""
    depth = 1 if len(palette) <= 2 else 2 if len(palette) <= 4 else 4 if len(palette) <= 16 else 8
    raw = bytearray()
    for row in index:
        line = bytearray((w * depth + 7) // 8)
        for x, v in enumerate(row):
            bit = x * depth
            line[bit >> 3] |= v << (8 - depth - (bit & 7))
        raw += b'\0' + line
    out = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, depth, 3, 0, 0, 0))
    out += png_chunk(b'PLTE', bytes(c for p in palette for c in p[:3]))
    alphas = bytes(p[3] for p in palette).rstrip(b'\xff')
    if alphas:
        out += png_chunk(b'tRNS', alphas)
    out += png_chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + png_chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(out)


def write_png_rgba(path, w, h, rows):
    raw = bytearray()
    for row in rows:
        raw += b'\0' + bytes(c for p in row for c in p)
    out = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    out += png_chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + png_chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(out)

# ---------------------------------------------------------------- colour

def hex_rgb(s):
    v = int(s, 16)
    rgb = ((v >> 16) & 255, (v >> 8) & 255, v & 255)
    if any(c not in (0, 0x55, 0xAA, 0xFF) for c in rgb):
        raise ValueError(s + ' is not a Pebble colour')
    return rgb


def luma(c):
    return (299 * c[0] + 587 * c[1] + 114 * c[2]) / 1000


def nearest(c, pal):
    # Red-mean weighted distance: closer to what the eye sees than plain RGB.
    best, bd = 0, None
    for i, p in enumerate(pal):
        rm = (c[0] + p[0]) / 2
        dr, dg, db = c[0] - p[0], c[1] - p[1], c[2] - p[2]
        d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db
        if bd is None or d < bd:
            best, bd = i, d
    return best


def red_for(c):
    """Stargazer: a colour's brightness as one of the four reds (main.c red_palette)."""
    level = (int(luma(c)) + 42) // 85
    return (level * 85, 0, 0)

# ---------------------------------------------------------------- pictures

def find_box(w, h, rows, thr):
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            if luma(rows[y][x]) > thr:
                xs.append(x)
                ys.append(y)
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def axis_weights(n_out, start, length, n_src):
    """For each output index, [(source index, weight)] covering its share of the source span."""
    out = []
    step = length / n_out
    for i in range(n_out):
        a, b = start + i * step, start + (i + 1) * step
        ws = []
        for s in range(max(0, int(math.floor(a))), min(n_src, int(math.ceil(b)))):
            wgt = min(b, s + 1) - max(a, s)
            if wgt > 0:
                ws.append((s, wgt))
        out.append(ws)
    return out


def shrink(e, w, h, rows):
    """The picture at the watch's size: [(r, g, b) or None for sky] rows, and its size."""
    thr = e.get('threshold', 24)
    x0, y0, x1, y1 = e.get('box') or find_box(w, h, rows, thr)
    bw, bh = x1 - x0, y1 - y0
    if 'width' in e:
        ow = e['width']
        oh = max(1, round(ow * bh / bw))
    else:
        oh = e['height']
        ow = max(1, round(oh * bw / bh))
    # The shape: an ellipse filling the box (a planet's disc), or whatever
    # is brighter than the sky (Saturn and its rings).
    if e.get('mask', 'disc') == 'disc':
        cx, cy, rx, ry = (x0 + x1) / 2, (y0 + y1) / 2, bw / 2, bh / 2
        def inside(x, y):
            return ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1
    else:
        def inside(x, y):
            return luma(rows[y][x]) > thr
    wx = axis_weights(ow, x0, bw, w)
    wy = axis_weights(oh, y0, bh, h)
    out = []
    for j in range(oh):
        line = []
        for i in range(ow):
            tot = cov = r = g = b = 0.0
            for sy, a in wy[j]:
                for sx, c in wx[i]:
                    wgt = a * c
                    tot += wgt
                    if inside(sx, sy):
                        p = rows[sy][sx]
                        cov += wgt
                        r += wgt * p[0]
                        g += wgt * p[1]
                        b += wgt * p[2]
            line.append((r / cov, g / cov, b / cov) if cov >= 0.5 * tot and cov > 0 else None)
        out.append(line)
    return out, ow, oh


def tone(e, px):
    """Gain, gamma and saturation, from the manifest."""
    gain, gamma, sat = e.get('gain', 1.0), e.get('gamma', 1.0), e.get('saturation', 1.0)
    out = []
    for row in px:
        line = []
        for p in row:
            if p is None:
                line.append(None)
                continue
            l = luma(p)
            q = [l + (c - l) * sat for c in p]
            q = [255 * min(1.0, max(0.0, c * gain / 255)) ** gamma for c in q]
            line.append(tuple(q))
        out.append(line)
    return out


def dither(e, px, ow, oh):
    """Palette indices into the manifest's colours (None for sky), Atkinson."""
    pal = [hex_rgb(c) for c in e['colours']]
    strength = e.get('strength', 1.0)
    err = [[[0.0, 0.0, 0.0] for _ in range(ow)] for _ in range(oh)]
    out = []
    for y in range(oh):
        line = []
        for x in range(ow):
            p = px[y][x]
            if p is None:
                line.append(None)
                continue
            want = [p[k] + err[y][x][k] for k in range(3)]
            i = nearest([min(255, max(0, c)) for c in want], pal)
            line.append(i)
            d = [(want[k] - pal[i][k]) * strength / 8 for k in range(3)]
            for dx, dy in ((1, 0), (2, 0), (-1, 1), (0, 1), (1, 1), (0, 2)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < ow and ny < oh and px[ny][nx] is not None:
                    for k in range(3):
                        err[ny][nx][k] += d[k]
        out.append(line)
    return out, pal


def build_picture(e):
    w, h, rows = read_png(os.path.join(ROOT, e['src']))
    px, ow, oh = shrink(e, w, h, rows)
    px = tone(e, px)
    idx, pal = dither(e, px, ow, oh)
    # Transparent first, then the colours used, dark to light.
    used = sorted({i for row in idx for i in row if i is not None}, key=lambda i: (luma(pal[i]), pal[i]))
    if len(used) > 15:
        raise ValueError(e['name'] + ': %d colours, at most 15' % len(used))
    remap = {i: k + 1 for k, i in enumerate(used)}
    palette = [(0, 0, 0, 0)] + [pal[i] + (255,) for i in used]
    index = [[0 if i is None else remap[i] for i in row] for row in idx]
    return ow, oh, index, palette, px


def build_icon():
    """Saturn, 25 x 25, black on transparent: a ball in a tilted ring, the
    ring's near side in front of the ball with a gap cut round it."""
    n, ss = 25, 8
    cx = cy = n / 2
    tilt = math.radians(-18)
    ct, st = math.cos(tilt), math.sin(tilt)
    ball, a, b, ring_w, gap = 8.0, 12.4, 3.2, 1.7, 0.8

    def ring_dist(u, v):
        # Distance (roughly) from the ellipse's line, in pixels.
        f = math.hypot(u / a, v / b)
        g = math.hypot(u / (a * a), v / (b * b))
        return abs(f - 1) / (g / f) if g else 99

    rows = []
    for y in range(n):
        line = []
        for x in range(n):
            cover = 0
            for sy in range(ss):
                for sx in range(ss):
                    px, py = x + (sx + 0.5) / ss - cx, y + (sy + 0.5) / ss - cy
                    u, v = px * ct + py * st, -px * st + py * ct
                    rd = ring_dist(u, v)
                    in_ring = rd <= ring_w / 2
                    in_ball = math.hypot(px, py) <= ball
                    front = v > 0
                    if in_ring and (front or not in_ball):
                        cover += 1
                    elif in_ball and not (front and rd <= ring_w / 2 + gap):
                        cover += 1
            line.append((0, 0, 0, round(255 * cover / (ss * ss))))
        rows.append(line)
    return n, n, rows

# ---------------------------------------------------------------- the sheet

def sheet(entries, built, path):
    """Rows: undithered | Night | Day | Stargazer, at twice the size."""
    scale, pad = 2, 8
    cell_w = max(b[0] for b in built) * scale + 2 * pad
    cells = []
    for e, (ow, oh, index, palette, px) in zip(entries, built):
        def tile(kind):
            t = []
            for y in range(oh):
                line = []
                for x in range(ow):
                    i = index[y][x]
                    if kind == 'source':
                        p = px[y][x]
                        c = (0, 0, 0) if p is None else tuple(int(v) for v in p)
                    elif i == 0:
                        c = (0, 0, 0)
                    elif kind == 'star':
                        c = red_for(palette[i])
                    else:
                        c = palette[i][:3]
                    line.append(c)
                t.append(line)
            return t
        cells.append((ow, oh, [tile('source'), tile('night'), tile('night'), tile('star')]))
    sw = 4 * cell_w
    sh = sum(oh * scale + 2 * pad for ow, oh, _ in cells)
    canvas = [[(40, 40, 40, 255)] * sw for _ in range(sh)]
    y0 = 0
    for ow, oh, tiles in cells:
        ch = oh * scale + 2 * pad
        for k, t in enumerate(tiles):
            x0 = k * cell_w
            # Night and Stargazer on black; Day on white, the picture in a
            # black window (as the watch draws it); the source on black.
            bg = (255, 255, 255) if k == 2 else (0, 0, 0)
            for y in range(ch):
                for x in range(cell_w):
                    canvas[y0 + y][x0 + x] = bg + (255,)
            if k == 2:
                for y in range(pad // 2, ch - pad // 2):
                    for x in range(pad // 2, cell_w - pad // 2):
                        canvas[y0 + y][x0 + x] = (0, 0, 0, 255)
            ox = x0 + (cell_w - ow * scale) // 2
            for y in range(oh):
                for x in range(ow):
                    c = t[y][x]
                    for dy in range(scale):
                        for dx in range(scale):
                            canvas[y0 + pad + y * scale + dy][ox + x * scale + dx] = c + (255,)
        y0 += ch
    write_png_rgba(path, sw, sh, canvas)

# ---------------------------------------------------------------- main

PAGE_ART = os.path.join(ROOT, 'src', 'pkjs', 'page_art.js')


def page_art(man, check, bad):
    """The same pictures for the phone's settings page (its logbook), as
    data: URLs in src/pkjs/page_art.js: {name: url}, from the files just
    written (or, with --check, the ones there)."""
    rows = []
    for e in man['pictures']:
        try:
            data = open(os.path.join(ROOT, e['out']), 'rb').read()
        except OSError:
            continue   # reported by emit
        rows.append('  %s: \'data:image/png;base64,%s\'' % (e['name'], base64.b64encode(data).decode('ascii')))
    text = ('// Made by tools/make_art.py from resources/images: the watch\'s pictures for the\n'
            '// settings page\'s logbook. Don\'t edit.\n'
            'module.exports = {\n' + ',\n'.join(rows) + '\n};\n')
    if not check:
        open(PAGE_ART, 'w').write(text)
    elif not os.path.exists(PAGE_ART) or open(PAGE_ART).read() != text:
        bad.append('src/pkjs/page_art.js: out of date (run python3 tools/make_art.py)')


def main(argv):
    check = '--check' in argv
    sheet_path = argv[argv.index('--sheet') + 1] if '--sheet' in argv else None
    man = json.load(open(os.path.join(ROOT, 'art', 'manifest.json')))
    bad = []

    def emit(rel, w, h, index=None, palette=None, rgba=None):
        path = os.path.join(ROOT, rel)
        if check:
            try:
                gw, gh, got = read_png(path)
            except (OSError, ValueError) as ex:
                bad.append('%s: %s' % (rel, ex))
                return
            want = rgba or [[palette[i] for i in row] for row in index]
            # Fully transparent pixels match whatever their colour.
            norm = lambda rs: [[p if p[3] else (0, 0, 0, 0) for p in r] for r in rs]
            if (gw, gh) != (w, h) or norm(got) != norm(want):
                bad.append(rel + ': out of date (run python3 tools/make_art.py)')
        elif rgba:
            write_png_rgba(path, w, h, rgba)
        else:
            write_png_palette(path, w, h, index, palette)

    w, h, rows = build_icon()
    emit(man['icon'], w, h, rgba=rows)
    entries, built = [], []
    for e in man['pictures']:
        b = build_picture(e)
        entries.append(e)
        built.append(b)
        ow, oh, index, palette, _ = b
        emit(e['out'], ow, oh, index=index, palette=palette)
        if not check:
            raw = ow * oh * (2 if len(palette) <= 4 else 4) // 8
            print('%-10s %3d x %3d  %2d colours  %5d bytes on the watch' % (e['name'], ow, oh, len(palette) - 1, raw))
    page_art(man, check, bad)
    if sheet_path:
        sheet(entries, built, sheet_path)
    if bad:
        print('\n'.join(bad))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
