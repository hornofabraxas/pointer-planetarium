// The logbook as a collection, for the settings page (settings_page.js
// draws it): shelves of what you've seen, each thing once with how many
// times and where you first saw it, and the empty places still to fill
// (the planets, the constellations Find it knows).
//
// view(list, opts) takes the logbook (logbook.js entries) and {metric
// (place distances in km), h12 (12-hour times)} and gives:
//   {sightings, things, where: [{label, n}] (most first), shelves: [{id,
//   title, have, total (null: open-ended), tiles: [tile]}], recent: [{kind,
//   name, sub}]}
// A tile: {name, seen, n, info (a sentence or two for when it's tapped),
// and what to draw: art (page_art.js), fig ([[[x, y], ...]]: lines in a
// 0..100 x 0..70 box), color (a star's), craft (planes.js CRAFT)}. A
// shelf with a total can also have extra: things seen beyond its places
// (constellations pointed at that Find it doesn't list).

var logbook = require('./logbook.js');
var places = require('./places.js');
var stars = require('./stars.js');
var patterns = require('./patterns.js');

var SOLAR = [['moon', 'The Moon'], ['mercury', 'Mercury'], ['venus', 'Venus'], ['mars', 'Mars'],
             ['jupiter', 'Jupiter'], ['saturn', 'Saturn'], ['uranus', 'Uranus'], ['neptune', 'Neptune']];
var RECENT = 15;
var FIG_W = 100, FIG_H = 70, FIG_PAD = 6;
// Star colours by spectral class (stars.js types), roughly as the eye sees them.
var STAR_COLOR = { O: '#9bb0ff', B: '#aabfff', A: '#cad7ff', F: '#f8f7ff', G: '#fff1d8', K: '#ffc98a', M: '#ff9a6b' };
var HOW = { found: 'Found with Find it', sure: "The watch was sure (THAT'S IT)", likely: 'The watch said PROBABLY' };

// A constellation's stick figure as seen looking up (east on the left),
// fitted into the figure box: lines of catalog star indexes in, lines of
// [x, y] out (null if there's nothing to draw). A star that isn't in the
// catalog (-1) lifts the pen.
function figure(lines) {
  var split = [];
  lines.forEach(function (poly) {
    var cur = [];
    poly.forEach(function (i) {
      if (i >= 0) {
        cur.push(i);
      } else if (cur.length) {
        split.push(cur);
        cur = [];
      }
    });
    if (cur.length) split.push(cur);
  });
  lines = split;
  var pts = [];
  lines.forEach(function (poly) { poly.forEach(function (i) { if (i >= 0) pts.push(i); }); });
  if (pts.length < 2) return null;
  function vec(i) {
    var s = stars.catalog[i], ra = s.ra * Math.PI / 180, dec = s.dec * Math.PI / 180;
    return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  }
  var c = [0, 0, 0];
  pts.forEach(function (i) { var v = vec(i); c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; });
  var n = Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2]);
  c = [c[0] / n, c[1] / n, c[2] / n];
  // East and north at the middle (near a pole, any east will do).
  var e = [-c[1], c[0], 0], en = Math.sqrt(e[0] * e[0] + e[1] * e[1]);
  e = en > 1e-6 ? [e[0] / en, e[1] / en, 0] : [1, 0, 0];
  var no = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  var raw = lines.map(function (poly) {
    return poly.map(function (i) {
      var v = vec(i), z = dot(v, c);
      return [-dot(v, e) / z, -dot(v, no) / z];   // east to the left, north up
    });
  }).filter(function (poly) { return poly.length; });
  var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  raw.forEach(function (poly) {
    poly.forEach(function (p) {
      x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    });
  });
  var w = FIG_W - 2 * FIG_PAD, h = FIG_H - 2 * FIG_PAD;
  var k = Math.min(w / Math.max(x1 - x0, 1e-9), h / Math.max(y1 - y0, 1e-9));
  var ox = FIG_PAD + (w - (x1 - x0) * k) / 2, oy = FIG_PAD + (h - (y1 - y0) * k) / 2;
  return raw.map(function (poly) {
    return poly.map(function (p) {
      return [Math.round((ox + (p[0] - x0) * k) * 10) / 10, Math.round((oy + (p[1] - y0) * k) * 10) / 10];
    });
  });
}

// Two life-list rows for the same thing (a pattern found, the
// constellation pointed at) as one: either may be null.
function merge(a, b) {
  if (!a || !b) return a || b;
  var RANK = { likely: 1, sure: 2, found: 3 };
  return { key: a.key, name: a.name, n: a.n + b.n, first: a.first.t <= b.first.t ? a.first : b.first,
           last: a.last.t >= b.last.t ? a.last : b.last, best: RANK[b.best] > RANK[a.best] ? b.best : a.best };
}

function view(list, opts) {
  opts = opts || {};
  list = Array.isArray(list) ? list : [];
  var labels = {};
  function where(e) {
    if (typeof e.la !== 'number') return '';
    var key = e.la + ',' + e.lo;
    if (!(key in labels)) labels[key] = places.label(e.la, e.lo, !!opts.metric);
    return labels[key];
  }
  function info(r) {
    var w = where(r.first);
    var s = 'First seen ' + logbook.day(r.first.t) + (w ? ', ' + w : '') + '.';
    if (r.n > 1) s += ' Seen ' + r.n + ' times, last on ' + logbook.day(r.last.t) + '.';
    return s + (HOW[r.best] ? ' ' + HOW[r.best] + '.' : '');
  }
  function tile(r, extra) {
    var t = { name: r ? r.name : '', seen: !!r, n: r ? r.n : 0, info: r ? info(r) : '' };
    for (var k in extra) t[k] = extra[k];
    return t;
  }
  var life = logbook.lifeList(list);
  var byKey = {};
  logbook.KINDS.forEach(function (k) { life[k].forEach(function (r) { byKey[r.key] = r; }); });

  // The Moon and the planets: every one has its place.
  var solar = SOLAR.map(function (p) {
    var r = byKey[p[0] === 'moon' ? 'moon' : 'planet:' + p[0]];
    var t = tile(r, { art: p[0] });
    t.name = p[1];
    return t;
  });

  // Constellations: Find it's, each in its place; any other seen (an aim
  // at one, or a pattern since dropped) after them, as extras. A
  // constellation pointed at is the same as Find it's whole one (Orion,
  // Cassiopeia): their sightings count together.
  var all = patterns.all();
  var used = {};
  var cons = all.map(function (p) {
    var r = byKey['pattern:' + p.id] || null;
    if (r) used[r.key] = true;
    life.constellation.forEach(function (x) {
      var abbr = x.key.indexOf('con:') === 0 ? x.key.slice(4) : null;
      if (abbr && (abbr === p.con || (p.whole && stars.constellationName(abbr) === p.name))) {
        r = merge(r, x);
        used[x.key] = true;
      }
    });
    var t = tile(r, { fig: figure(p.lines) });
    t.name = p.name;
    return t;
  });
  var extra = life.constellation.filter(function (r) { return !used[r.key]; }).map(function (r) {
    var abbr = r.key.indexOf('con:') === 0 ? r.key.slice(4) : null;
    return tile(r, { fig: abbr ? figure(stars.lines[abbr] || []) : null });
  });
  var haveCons = cons.filter(function (t) { return t.seen; }).length;
  cons.sort(function (a, b) { return (b.seen ? 1 : 0) - (a.seen ? 1 : 0); });   // stable: list order otherwise
  cons = cons.slice(0, haveCons).concat(extra, cons.slice(haveCons));

  var starTiles = life.star.map(function (r) {
    var i = r.key.indexOf('star:') === 0 ? +r.key.slice(5) : -1;
    var type = i >= 0 && stars.types[i];
    return tile(r, { color: (type && STAR_COLOR[type.cls]) || STAR_COLOR.F });
  });
  var sats = life.satellite.map(function (r) { return tile(r, {}); });
  var planeTiles = life.plane.map(function (r) { return tile(r, { craft: r.c || 0 }); });

  function have(tiles) {
    return tiles.filter(function (t) { return t.seen; }).length;
  }
  var shelves = [
    { id: 'solar', title: 'Moon and planets', have: have(solar), total: solar.length, extra: 0, tiles: solar },
    { id: 'cons', title: 'Constellations', have: haveCons, total: all.length, extra: extra.length, tiles: cons },
    { id: 'stars', title: 'Stars', have: starTiles.length, total: null, tiles: starTiles },
    { id: 'sats', title: 'Satellites', have: sats.length, total: null, tiles: sats },
    { id: 'planes', title: 'Planes, by type', have: planeTiles.length, total: null, tiles: planeTiles }
  ];

  var from = {};
  list.forEach(function (e) {
    var w = where(e);
    if (w) from[w] = (from[w] || 0) + 1;
  });
  var whereList = Object.keys(from).map(function (k) { return { label: k, n: from[k] }; })
    .sort(function (a, b) { return b.n - a.n || (a.label < b.label ? -1 : 1); });

  var recent = list.slice(-RECENT).reverse().map(function (e) {
    var w = where(e);
    return { kind: e.k, name: e.n + (e.d ? ' (' + e.d + ')' : ''),
             sub: logbook.when(e.t, !!opts.h12) + (w ? ' · ' + w : '') + (e.w === 'found' ? ' · found' : '') };
  });

  return {
    sightings: list.length,
    things: shelves.reduce(function (s, sh) { return s + sh.have + (sh.extra || 0); }, 0),
    where: whereList,
    shelves: shelves,
    recent: recent,
    place: where
  };
}

module.exports = { view: view, figure: figure, STAR_COLOR: STAR_COLOR };
