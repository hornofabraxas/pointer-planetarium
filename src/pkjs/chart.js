// The chart cards: the stick figure of the constellation an answer is in,
// drawn the way it stands in the sky right now (straight up on the screen
// is straight up in the sky), with the answer circled; and for a
// satellite, its path across the sky over a minute, with an arrow the way
// it's going.
//
// Stereographic projection about the answer, so shapes look right even
// near the edge. A constellation too big for the screen (Hydra, Eridanus)
// is cut to the part around the answer.
//
// Nothing under the horizon is drawn (you can't see it): a figure's lines
// with an end below it are left out, and the chart is fitted to what's
// left. A low answer is framed so the horizon sits near the chart's
// bottom, not across its middle.
//
// Wire format (R_CHART, bytes):
//   [0]   n points, then n x {x, y, info}: x and y in pixels with an offset
//         (x - X_OFF, y - Y_OFF), so lines can run off the chart's edges;
//         info: bits 0-1 size (0 faint .. 3 bright), bit 2 the answer,
//         bit 3 a planet or the Moon (or a satellite), bit 4 on the
//         stick figure (or the path)
//   then  m segments, m x {a, b} (point indices)
//   then  h horizon points, h x {x, y} (same offsets), left to right
//   then, to the end, extras, each a tag and its bytes:
//         1 {x, y}: where the user pointed (same offsets; off the chart,
//           the watch shows which way it is)
//         2 {a, b}: an arrowhead at point b, coming from point a
//         3 {len, len bytes}: a caption (UTF-8) for under the chart
//         4 {kind, a, b}: an aircraft's shape (CRAFT, planes.js) drawn at
//           point 0 in place of its dot, nose along the line from point a
//           to point b
//         5 {share, len, bytes, len, bytes}: a plane's route, from and to
//           (airport codes), and how far along it is (share of 255)
//         6 {len, len bytes}: as 3, but what else it might be ("or Vega")
//         7 {d}: the way you face looking at the chart's middle, 0 north,
//           1 northeast ... 7 northwest; only with a horizon (the watch
//           writes it in the ground)
// The chart area is W x h pixels (h is H, or the caller's): the watch
// draws it below a title line, or below the answer's name.
var A = require('./astro.js');
var stars = require('./stars.js');

var W = 192, H_FULL = 140;
var X_OFF = 32, Y_OFF = 58;        // a byte holds -32..223 and -58..197
var MAX_POINTS = 40;
var MAX_SEGS = 48;
var MAX_FIELD = 60;                // degrees across: bigger constellations are cut
var MIN_FIELD = 16;                // ... smaller ones are not blown up past this
var EXTRA_MAG = 4.0;               // stars off the stick figure shown down to this
var TRACK_STAR_MAG = 3.0;          // ... and round a satellite's path
var TRACK_MAX_FIELD = 90;          // a satellite's path is cut to this many degrees across
var HORIZON_AT = 0.8;               // a low answer's horizon: this far down the chart, or lower
var INFO = { TARGET: 4, PLANET: 8, LINE: 16 };
var TAG = { AIM: 1, ARROW: 2, CAPTION: 3, CRAFT: 4, ROUTE: 5, RIVAL: 6, DIR: 7 };
var CAPTION_MAX = 30;              // bytes
var ROUTE_CODE_MAX = 4;            // bytes: an airport's IATA or ICAO code

function vec(az, alt) {
  return [A.cosd(alt) * A.sind(az), A.cosd(alt) * A.cosd(az), A.sind(alt)];
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(v) {
  var n = Math.sqrt(dot(v, v));
  return [v[0] / n, v[1] / n, v[2] / n];
}

// The projection about c: right is to the viewer's right facing c, up is
// toward the zenith. Returns a function from {az, alt} to {x, y} in
// stereographic units (2 tan(d/2): about d in radians near the centre).
function projector(c) {
  var cv = vec(c.az, c.alt);
  var r = cross(cv, [0, 0, 1]);
  // Looking almost straight up, "right" is east of the azimuth faced.
  r = dot(r, r) < 1e-8 ? [A.cosd(c.az), -A.sind(c.az), 0] : norm(r);
  var u = cross(r, cv);
  return function (p) {
    var v = vec(p.az, p.alt);
    var k = 2 / (1 + dot(v, cv));
    return { x: k * dot(v, r), y: k * dot(v, u), back: dot(v, cv) < -0.5 };
  };
}

function sizeOf(mag) {
  return mag < 0.5 ? 3 : mag < 2 ? 2 : mag < 3.5 ? 1 : 0;
}

function stereo(deg) {
  return 2 * Math.tan(deg / 2 * A.RAD);
}

// Builds the chart. opts: {jd, lat, lon, con (IAU abbreviation), target
// ({az, alt} apparent, or null for a constellation answer), targetStar
// (catalog index of the answer, if a star), planets ([{az, alt, mag}]
// to show if they fall in the field), lines (stick figures by
// abbreviation; defaults to the catalog's), minField (degrees: the
// narrowest it zooms to, MIN_FIELD if not given), h (the chart's height,
// H if not given), aim ({az, alt} apparent: where the user pointed, marked),
// caption (text for under the chart), bare (no stick figure: just the
// answer and the stars around it)}. Returns {bytes, n, segs, scale} or
// null when there is no stick figure to draw (none of it up, say).
function build(opts) {
  var H = opts.h || H_FULL;
  var lines = opts.bare ? [] : (opts.lines || stars.lines || {})[opts.con];
  if (!opts.bare && (!lines || !lines.length)) return null;
  if (opts.bare && !opts.target) return null;
  var ofDate = stars.starsOfDate(opts.jd);
  function where(i) {
    var s = ofDate[i];
    if (!s) return null;
    var h = A.eqToHorizon(s.ra, s.dec, opts.jd, opts.lat, opts.lon);
    return { az: h.az, alt: h.alt + A.refraction(h.alt), mag: s.mag, index: i };
  }
  var pts = {}, order = [];
  lines.forEach(function (poly) {
    poly.forEach(function (i) {
      if (pts[i] || !ofDate[i]) return;
      pts[i] = where(i);
      order.push(i);
    });
  });
  if (!order.length && !opts.bare) return null;
  function up(pt) { return pt.alt >= 0; }

  // The middle of the figure (on the sphere), unless there's an answer to
  // centre on.
  var centre = opts.target;
  if (!centre) {
    var sum = [0, 0, 0];
    var shown = order.filter(function (i) { return up(pts[i]); });
    (shown.length ? shown : order).forEach(function (i) {
      var v = vec(pts[i].az, pts[i].alt);
      sum = [sum[0] + v[0], sum[1] + v[1], sum[2] + v[2]];
    });
    sum = norm(sum);
    centre = { az: A.rev(A.atan2d(sum[0], sum[1])), alt: A.asind(sum[2]) };
  }
  var proj = projector(centre);
  order.forEach(function (i) { pts[i].p = proj(pts[i]); });

  // Fit the figure above the horizon (and the answer) to the chart, within
  // the field limits, centred on the figure's box; when cut, centred on
  // the answer.
  var xs = [], ys = [];
  order.forEach(function (i) {
    if (!pts[i].p.back && up(pts[i])) {
      xs.push(pts[i].p.x);
      ys.push(pts[i].p.y);
    }
  });
  xs.push(0);
  ys.push(0);
  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  var pad = stereo(3);
  var fit = Math.min(W / (x1 - x0 + 2 * pad), H / (y1 - y0 + 2 * pad));
  var scale = Math.max(W / stereo(MAX_FIELD), Math.min(fit, W / stereo(opts.minField || MIN_FIELD)));
  var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (scale > fit + 1e-9) {
    cx = 0;
    cy = 0;
  }
  cy = lowerHorizon(proj, centre, cy, scale, H);
  function px(p) {
    return { x: Math.round(W / 2 + (p.x - cx) * scale), y: Math.round(H / 2 - (p.y - cy) * scale) };
  }
  function inByte(q) {
    return q.x >= -X_OFF && q.x <= 255 - X_OFF && q.y >= -Y_OFF && q.y <= 255 - Y_OFF;
  }
  function onChart(q) {
    return q.x >= 0 && q.x < W && q.y >= 0 && q.y < H;
  }

  var out = [];   // {x, y, info, key}
  var idx = {};
  function add(q, info, key) {
    if (out.length >= MAX_POINTS || !inByte(q)) return -1;
    idx[key] = out.length;
    out.push({ x: q.x, y: q.y, info: info });
    return idx[key];
  }

  // The answer first, so it is never squeezed out.
  if (opts.target && opts.targetStar === undefined) {
    add(px(proj(opts.target)), INFO.TARGET | INFO.PLANET | 3, 'target');
  }
  var segs = [];
  lines.forEach(function (poly) {
    for (var k = 1; k < poly.length; k++) {
      var a = pts[poly[k - 1]], b = pts[poly[k]];
      if (!a || !b || a.p.back || b.p.back || !up(a) || !up(b)) continue;
      var qa = px(a.p), qb = px(b.p);
      if (!onChart(qa) && !onChart(qb)) continue;
      var ia = idx['s' + a.index], ib = idx['s' + b.index];
      if (ia === undefined) {
        ia = add(qa, INFO.LINE | sizeOf(a.mag) | (a.index === opts.targetStar ? INFO.TARGET : 0), 's' + a.index);
      }
      if (ib === undefined) {
        ib = add(qb, INFO.LINE | sizeOf(b.mag) | (b.index === opts.targetStar ? INFO.TARGET : 0), 's' + b.index);
      }
      if (ia >= 0 && ib >= 0 && segs.length < MAX_SEGS) segs.push([ia, ib]);
    }
  });
  if (!segs.length && !opts.bare) return null;
  // The answer, if it's a star off the stick figure.
  if (opts.targetStar !== undefined && idx['s' + opts.targetStar] === undefined) {
    var t = where(opts.targetStar);
    if (t) add(px(proj(t)), INFO.TARGET | sizeOf(t.mag), 's' + opts.targetStar);
  }
  // Planets and the Moon in the field.
  (opts.planets || []).forEach(function (b, k) {
    var q = px(proj(b));
    if (onChart(q) && !proj(b).back && up(b)) add(q, INFO.PLANET | sizeOf(b.mag), 'p' + k);
  });
  // Bright stars that aren't on the figure, so the chart looks like the sky.
  fieldStars(opts, centre, scale, H, EXTRA_MAG, proj, px, onChart, add, idx);
  var hz = horizonLine(centre, proj, px, H);
  return finish(out, segs, hz, extras(opts, proj, px, H).concat(facing(hz)), scale);
}

// The stars down to maxMag around centre, above the horizon, that aren't
// on the chart yet.
function fieldStars(opts, centre, scale, H, maxMag, proj, px, onChart, add, idx) {
  var field = Math.max(W, H) / 2 / scale;   // stereographic units to the corner, roughly
  var radius = 2 * Math.atan(field / 2) / A.RAD * 1.5;
  var c = A.horizonToEq(centre.az, A.unrefract(centre.alt), opts.jd, opts.lat, opts.lon);
  var ofDate = stars.starsOfDate(opts.jd);
  stars.starsNear(c.ra, c.dec, opts.jd, Math.min(radius, 60)).filter(function (n) {
    return n.star.mag <= maxMag && idx['s' + n.star.index] === undefined;
  }).sort(function (a, b) { return a.star.mag - b.star.mag; }).forEach(function (n) {
    var s = ofDate[n.star.index];
    if (!s) return;
    var h = A.eqToHorizon(s.ra, s.dec, opts.jd, opts.lat, opts.lon);
    var alt = h.alt + A.refraction(h.alt);
    if (alt < 0) return;
    var pr = proj({ az: h.az, alt: alt });
    var q = px(pr);
    if (!pr.back && onChart(q)) add(q, sizeOf(s.mag), 's' + n.star.index);
  });
}

// cy (the chart's middle, up from centre, in stereographic units) moved
// so the horizon below centre is at least HORIZON_AT down the chart.
// Everything drawn is above the horizon, so moving it all down never
// pushes any of it off the bottom; the top only gains sky.
function lowerHorizon(proj, centre, cy, scale, H) {
  var pr = proj({ az: centre.az, alt: 0 });
  if (pr.back) return cy;
  var y = H / 2 - (pr.y - cy) * scale;
  return y < H * HORIZON_AT ? cy + (H * HORIZON_AT - y) / scale : cy;
}

// The horizon, where it crosses the chart: points along it every few
// degrees of azimuth, kept while on the chart. Five points are enough to
// draw it as a gentle curve. hz.az: the azimuth at the chart's middle.
function horizonLine(centre, proj, px, H) {
  var hz = [], mid = null;
  for (var d = -90; d <= 90; d += 3) {
    var pr = proj({ az: A.rev(centre.az + d), alt: 0 });
    if (pr.back) continue;
    var q = px(pr);
    if (q.x >= -X_OFF && q.x <= 255 - X_OFF && q.y >= 0 && q.y < H) {
      hz.push(q);
      if (!mid || Math.abs(q.x - W / 2) < Math.abs(mid.x - W / 2)) mid = { x: q.x, az: A.rev(centre.az + d) };
    }
  }
  hz.sort(function (a, b) { return a.x - b.x; });
  if (hz.length > 5) {
    var picked = [];
    for (var j = 0; j < 5; j++) picked.push(hz[Math.round(j * (hz.length - 1) / 4)]);
    hz = picked;
  }
  if (hz.length < 2) return [];
  hz.az = mid.az;
  return hz;
}

// The way you face at the chart's middle, as extras bytes (none with no
// horizon).
function facing(hz) {
  return hz.length ? [TAG.DIR, Math.round(hz.az / 45) % 8] : [];
}

// The aim mark, the caption (or what else it might be: opts.rival) and a
// plane's route, as extras bytes. An aim past what a byte
// holds is pulled in along the line from the chart's middle, so it still
// says which way it is (stereographic keeps directions, even far out).
function extras(opts, proj, px, H) {
  var out = [];
  if (opts.aim) {
    var q = px(proj(opts.aim));
    var dx = q.x - W / 2, dy = q.y - H / 2, k = 1;
    if (dx) k = Math.min(k, (dx > 0 ? 255 - X_OFF - W / 2 : W / 2 + X_OFF) / Math.abs(dx));
    if (dy) k = Math.min(k, (dy > 0 ? 255 - Y_OFF - H / 2 : H / 2 + Y_OFF) / Math.abs(dy));
    // (Clamped too: k can land a hair past the edge in floating point.)
    out.push(TAG.AIM, Math.max(0, Math.min(255, Math.round(W / 2 + dx * k) + X_OFF)),
             Math.max(0, Math.min(255, Math.round(H / 2 + dy * k) + Y_OFF)));
  }
  if (opts.caption) {
    var b = utf8(opts.caption, CAPTION_MAX);
    out.push(opts.rival ? TAG.RIVAL : TAG.CAPTION, b.length);
    out = out.concat(b);
  }
  var r = opts.route;
  if (r && r.from && r.to) {
    var from = utf8(r.from, ROUTE_CODE_MAX), to = utf8(r.to, ROUTE_CODE_MAX);
    out.push(TAG.ROUTE, Math.max(0, Math.min(255, Math.round(r.share * 255))), from.length);
    out = out.concat(from, [to.length], to);
  }
  return out;
}

// UTF-8 bytes of s, at most max, cut at a character.
function utf8(s, max) {
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.codePointAt(i);
    if (c > 0xffff) i++;
    var b = c < 0x80 ? [c] : c < 0x800 ? [0xc0 | c >> 6, 0x80 | c & 63] :
            c < 0x10000 ? [0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63] :
            [0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63];
    if (out.length + b.length > max) break;
    out = out.concat(b);
  }
  return out;
}

function finish(out, segs, hz, extra, scale) {
  var bytes = [out.length];
  out.forEach(function (o) { bytes.push(o.x + X_OFF, o.y + Y_OFF, o.info); });
  bytes.push(segs.length);
  segs.forEach(function (s) { bytes.push(s[0], s[1]); });
  bytes.push(hz.length);
  hz.forEach(function (q) { bytes.push(q.x + X_OFF, q.y + Y_OFF); });
  return { bytes: bytes.concat(extra || []), n: out.length, segs: segs.length, scale: scale };
}

// A satellite's or a plane's path. opts: {jd, lat, lon, path ([{az, alt}]
// apparent, oldest first, a few seconds apart), now (the index in path of
// where it is now), members ([{az, alt}]: the rest of its train), h, aim,
// caption, rival, craft (a plane's shape, CRAFT in planes.js), route (a
// plane's {from, to, share})}.
// The path is a line of small dots through the satellite (circled), with
// an arrowhead at its newest end; bright stars and the horizon around it.
// Returns {bytes, n, segs, scale} or null.
function track(opts) {
  var H = opts.h || H_FULL;
  var here = opts.path[opts.now];
  if (!here) return null;
  var proj = projector(here);
  var path = [];
  opts.path.forEach(function (p, i) {
    var pr = proj(p);
    if (!pr.back && (p.alt >= 0 || i === opts.now)) path.push({ p: pr, now: i === opts.now });
  });
  var xs = [0], ys = [0];
  path.forEach(function (q) {
    xs.push(q.p.x);
    ys.push(q.p.y);
  });
  var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
  var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  var pad = stereo(4);
  var fit = Math.min(W / (x1 - x0 + 2 * pad), H / (y1 - y0 + 2 * pad));
  var scale = Math.max(W / stereo(TRACK_MAX_FIELD), Math.min(fit, W / stereo(MIN_FIELD)));
  var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  if (scale > fit + 1e-9) {
    cx = 0;
    cy = 0;
  }
  cy = lowerHorizon(proj, here, cy, scale, H);
  function px(p) {
    return { x: Math.round(W / 2 + (p.x - cx) * scale), y: Math.round(H / 2 - (p.y - cy) * scale) };
  }
  function inByte(q) {
    return q.x >= -X_OFF && q.x <= 255 - X_OFF && q.y >= -Y_OFF && q.y <= 255 - Y_OFF;
  }
  function onChart(q) {
    return q.x >= 0 && q.x < W && q.y >= 0 && q.y < H;
  }
  var out = [], idx = {};
  function add(q, info, key) {
    if (out.length >= MAX_POINTS || !inByte(q)) return -1;
    idx[key] = out.length;
    out.push({ x: q.x, y: q.y, info: info });
    return idx[key];
  }
  // The satellite first, then its path, then its train.
  add(px(proj(here)), INFO.TARGET | INFO.PLANET | 2, 'now');
  var chain = [];
  path.forEach(function (q, i) {
    chain.push(q.now ? 0 : add(px(q.p), INFO.LINE, 't' + i));
  });
  var segs = [];
  for (var i = 1; i < chain.length; i++) {
    if (chain[i - 1] >= 0 && chain[i] >= 0) segs.push([chain[i - 1], chain[i]]);
  }
  (opts.members || []).forEach(function (m, k) {
    var pr = proj(m);
    var q = px(pr);
    if (!pr.back && m.alt >= 0 && onChart(q)) add(q, INFO.PLANET | 1, 'm' + k);
  });
  fieldStars(opts, here, scale, H, TRACK_STAR_MAG, proj, px, onChart, add, idx);
  var hz = horizonLine(here, proj, px, H);
  var extra = extras(opts, proj, px, H).concat(facing(hz));
  var last = chain.length - 1;
  if (last >= 1 && chain[last] >= 0 && chain[last - 1] >= 0) extra.push(TAG.ARROW, chain[last - 1], chain[last]);
  // An aircraft's shape points along its path: to the next point, else
  // from the one before.
  var at = path.map(function (q) { return q.now; }).indexOf(true);
  if (opts.craft && at >= 0) {
    if (at + 1 < chain.length && chain[at + 1] >= 0) extra.push(TAG.CRAFT, opts.craft, 0, chain[at + 1]);
    else if (at >= 1 && chain[at - 1] >= 0) extra.push(TAG.CRAFT, opts.craft, chain[at - 1], 0);
  }
  return finish(out, segs, hz, extra, scale);
}

// Reads the wire format back (for tests and the watch's point of view).
function decode(bytes) {
  var k = 0, pts = [], segs = [], hz = [], aim = null, arrow = null, caption = '', rival = false;
  var craft = null, route = null, dir = null;
  var n = bytes[k++];
  for (var i = 0; i < n; i++) {
    pts.push({ x: bytes[k] - X_OFF, y: bytes[k + 1] - Y_OFF, info: bytes[k + 2] });
    k += 3;
  }
  var m = bytes[k++];
  for (i = 0; i < m; i++) {
    segs.push([bytes[k], bytes[k + 1]]);
    k += 2;
  }
  var h = bytes[k++];
  for (i = 0; i < h; i++) {
    hz.push({ x: bytes[k] - X_OFF, y: bytes[k + 1] - Y_OFF });
    k += 2;
  }
  while (k < bytes.length) {
    var tag = bytes[k++];
    if (tag === TAG.AIM) {
      aim = { x: bytes[k] - X_OFF, y: bytes[k + 1] - Y_OFF };
      k += 2;
    } else if (tag === TAG.ARROW) {
      arrow = [bytes[k], bytes[k + 1]];
      k += 2;
    } else if (tag === TAG.CAPTION || tag === TAG.RIVAL) {
      var len = bytes[k++];
      caption = text(bytes.slice(k, k + len));
      rival = tag === TAG.RIVAL;
      k += len;
    } else if (tag === TAG.CRAFT) {
      craft = { kind: bytes[k], from: bytes[k + 1], to: bytes[k + 2] };
      k += 3;
    } else if (tag === TAG.ROUTE) {
      var share = bytes[k++] / 255;
      var fl = bytes[k++], from = text(bytes.slice(k, k + fl));
      k += fl;
      var tl = bytes[k++], to = text(bytes.slice(k, k + tl));
      k += tl;
      route = { from: from, to: to, share: share };
    } else if (tag === TAG.DIR) {
      dir = bytes[k++];
    } else {
      break;
    }
  }
  return { points: pts, segs: segs, horizon: hz, aim: aim, arrow: arrow, caption: caption, rival: rival,
           craft: craft, route: route, dir: dir, length: k };
}

function text(b) {
  return decodeURIComponent(escape(String.fromCharCode.apply(null, b)));
}

module.exports = { build: build, track: track, decode: decode, projector: projector, INFO: INFO, TAG: TAG,
                   W: W, H: H_FULL, X_OFF: X_OFF, Y_OFF: Y_OFF };
