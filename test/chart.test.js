// The constellation chart: shape and orientation as seen in the sky, the
// answer marked, and the wire format within its limits.
// Run: node test/chart.test.js
var A = require('../src/pkjs/astro.js');
var stars = require('../src/pkjs/stars.js');
var chart = require('../src/pkjs/chart.js');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

var byName = {};
stars.catalog.forEach(function (s, i) { if (s.name) byName[s.name] = i; });
function ix(n) { return byName[n]; }

// Orion's stick figure, as the generated data would give it.
var orion = [[ix('Betelgeuse'), ix('Alnitak'), ix('Alnilam'), ix('Mintaka'), ix('Bellatrix')],
             [ix('Alnitak'), ix('Saiph')], [ix('Mintaka'), ix('Rigel')], [ix('Betelgeuse'), ix('Bellatrix')]];
var lines = { Ori: orion };
var PHX = { lat: 33.45, lon: -112.07 };

function at(iso) {
  return A.julianDay(new Date(iso));
}

function posOf(jd, name) {
  var s = stars.starsOfDate(jd)[ix(name)];
  var h = A.eqToHorizon(s.ra, s.dec, jd, PHX.lat, PHX.lon);
  return { az: h.az, alt: h.alt + A.refraction(h.alt) };
}

// Mid January, 9 pm in Phoenix: Orion high in the south.
var jd = at('2026-01-16T04:00:00Z');
var res = chart.build({ jd: jd, lat: PHX.lat, lon: PHX.lon, con: 'Ori', target: posOf(jd, 'Betelgeuse'),
                        targetStar: ix('Betelgeuse'), lines: lines });
check('a chart is built', res && res.n >= 7 && res.segs === 7, res && (res.n + ' points, ' + res.segs + ' segments'));
var d = chart.decode(res.bytes);
check('it decodes to the same length', d.length === res.bytes.length && res.bytes.every(function (b) {
  return b >= 0 && b <= 255 && b === Math.floor(b);
}));
check('small enough for one message', res.bytes.length <= 220, res.bytes.length + ' bytes');
var targets = d.points.filter(function (p) { return p.info & chart.INFO.TARGET; });
check('exactly one point is the answer', targets.length === 1);

// Find points by matching projected positions: Betelgeuse (the answer),
// Rigel (bright, size 3), and the belt.
var betel = targets[0];
var bright = d.points.filter(function (p) { return (p.info & 3) === 3 && !(p.info & chart.INFO.TARGET); });
check('Rigel is the other very bright point', bright.length === 1);
var rigel = bright[0];
check('in the south, Betelgeuse is up and to the left of Rigel', betel.x < rigel.x && betel.y < rigel.y,
      'Betelgeuse ' + betel.x + ',' + betel.y + ' Rigel ' + rigel.x + ',' + rigel.y);
check('the figure fits on the chart', d.points.filter(function (p) { return p.info & chart.INFO.LINE; })
  .every(function (p) { return p.x >= 0 && p.x < chart.W && p.y >= 0 && p.y < chart.H; }));
check('no horizon when it is high up', d.horizon.length === 0);
// Orion is about 20 degrees tall: the chart should use most of its height.
var ys = d.points.filter(function (p) { return p.info & chart.INFO.LINE; }).map(function (p) { return p.y; });
check('scaled to fill the chart', Math.max.apply(null, ys) - Math.min.apply(null, ys) > chart.H * 0.6);

// Rising in the east at dusk in November: lying on its side, the belt
// standing almost upright, and the horizon below it.
var jd2 = at('2026-11-16T04:00:00Z');
var low = posOf(jd2, 'Alnilam');
var res2 = chart.build({ jd: jd2, lat: PHX.lat, lon: PHX.lon, con: 'Ori', target: posOf(jd2, 'Betelgeuse'),
                         targetStar: ix('Betelgeuse'), lines: lines });
check('rising Orion still charts', !!res2, 'Alnilam at alt ' + low.alt.toFixed(1));
var d2 = chart.decode(res2.bytes);
check('a horizon below a low constellation', d2.horizon.length >= 2 &&
      d2.horizon.every(function (h) { return h.y > chart.H / 2; }), JSON.stringify(d2.horizon));
// The belt: three line stars of similar size between Betelgeuse and Rigel.
// Rising, Betelgeuse (north) is to the left and Rigel to the right; the
// belt runs up and down more than across.
var r2 = d2.points.filter(function (p) { return (p.info & 3) === 3 && !(p.info & chart.INFO.TARGET); })[0];
var b2 = d2.points.filter(function (p) { return p.info & chart.INFO.TARGET; })[0];
check('rising, Betelgeuse is left of Rigel (on its side)', b2.x < r2.x, b2.x + ' vs ' + r2.x);

// A planet in the field is marked.
var pl = posOf(jd, 'Bellatrix');
var res3 = chart.build({ jd: jd, lat: PHX.lat, lon: PHX.lon, con: 'Ori', target: null, lines: lines,
                         planets: [{ az: pl.az + 3, alt: pl.alt + 2, mag: -2 }] });
var d3 = chart.decode(res3.bytes);
check('no answer: no point is marked', !d3.points.some(function (p) { return p.info & chart.INFO.TARGET; }));
check('a planet in the field shows', d3.points.some(function (p) { return p.info & chart.INFO.PLANET; }));

// A planet answer (no catalog star) is marked as the answer.
var res4 = chart.build({ jd: jd, lat: PHX.lat, lon: PHX.lon, con: 'Ori', lines: lines,
                         target: { az: pl.az + 3, alt: pl.alt + 2 } });
var t4 = chart.decode(res4.bytes).points.filter(function (p) { return p.info & chart.INFO.TARGET; });
check('a planet answer is circled', t4.length === 1 && (t4[0].info & chart.INFO.PLANET));

check('no stick figure, no chart', chart.build({ jd: jd, lat: PHX.lat, lon: PHX.lon, con: 'Xyz', target: null,
                                                  lines: lines }) === null);
check('a figure behind the viewer: no chart', chart.build({
  jd: jd, lat: PHX.lat, lon: PHX.lon, con: 'Ori', target: { az: A.rev(posOf(jd, 'Alnilam').az + 180), alt: 0 },
  lines: lines }) === null);

// A big figure (made-up: a line 80 degrees long) is cut to the field.
var jd5 = at('2026-01-16T04:00:00Z');
var wide = { Hya: [[ix('Betelgeuse'), ix('Procyon'), ix('Regulus'), ix('Spica')]] };
var res5 = chart.build({ jd: jd5, lat: PHX.lat, lon: PHX.lon, con: 'Hya', target: posOf(jd5, 'Procyon'),
                         targetStar: ix('Procyon'), lines: wide });
var d5 = res5 && chart.decode(res5.bytes);
var t5 = d5 && d5.points.filter(function (p) { return p.info & chart.INFO.TARGET; })[0];
check('a huge figure is cut, centred on the answer', t5 && Math.abs(t5.x - chart.W / 2) <= 1 &&
      Math.abs(t5.y - chart.H / 2) <= 1, t5 && (t5.x + ',' + t5.y));

// Extras: where you pointed, and a caption. On the answer's own page the
// chart is shorter (h).
var bet = posOf(jd, 'Betelgeuse');
var res6 = chart.build({ jd: jd, lat: PHX.lat, lon: PHX.lon, con: 'Ori', target: bet, targetStar: ix('Betelgeuse'),
                         lines: lines, h: 118, aim: { az: bet.az + 2, alt: bet.alt }, caption: 'in Orion' });
var d6 = chart.decode(res6.bytes);
var t6 = d6.points.filter(function (p) { return p.info & chart.INFO.TARGET; })[0];
check('the aim is marked, to the right of an answer 2 degrees left of it', d6.aim && d6.aim.x > t6.x + 3 &&
      Math.abs(d6.aim.y - t6.y) <= 3, JSON.stringify(d6.aim) + ' vs ' + t6.x + ',' + t6.y);
check('the caption comes back', d6.caption === 'in Orion' && d6.length === res6.bytes.length);
check('a short chart keeps the figure inside its height', d6.points.filter(function (p) {
  return p.info & chart.INFO.LINE;
}).every(function (p) { return p.y >= 0 && p.y < 118; }));
var res7 = chart.build({ jd: jd, lat: PHX.lat, lon: PHX.lon, con: 'Ori', target: bet, targetStar: ix('Betelgeuse'),
                         lines: lines, aim: { az: bet.az - 70, alt: bet.alt }, caption: 'Großenhain über alles, wirklich' });
var d7 = chart.decode(res7.bytes);
// (Up a little too: a circle of equal altitude curves up away from the answer.)
check('an aim far off the chart is pulled in, still to the left', d7.aim && d7.aim.x < 0 && d7.aim.x >= -chart.X_OFF &&
      d7.aim.y >= -chart.Y_OFF, JSON.stringify(d7.aim));
check('a long caption is cut at a character, in bytes', res7.bytes.length <= 320 &&
      d7.caption.length > 10 && Buffer.byteLength(d7.caption) <= 30, d7.caption);

// Every byte a byte, wherever the aim is (a float a hair past the edge
// once came out as -1).
var bad = 0, tried = 0;
['Betelgeuse', 'Rigel', 'Bellatrix'].forEach(function (nm) {
  var tp = posOf(jd, nm);
  for (var da = -30; da <= 30; da += 1.5) {
    for (var dd = -30; dd <= 30; dd += 1.5) {
      var rb = chart.build({ jd: jd, lat: PHX.lat, lon: PHX.lon, con: 'Ori', target: tp, targetStar: ix(nm),
                             lines: lines, h: 118, aim: { az: tp.az + da, alt: tp.alt + dd } });
      tried++;
      if (!rb.bytes.every(function (b) { return b >= 0 && b <= 255 && b === Math.floor(b); })) bad++;
    }
  }
});
check('every chart byte is a byte, for aims all round', bad === 0, bad + ' of ' + tried + ' bad');

// A satellite's path: the satellite circled, a line of dots through it,
// an arrowhead at its newest end.
var jd8 = at('2026-10-09T05:00:00Z');
var path = [];
for (var k = -2; k <= 4; k++) path.push({ az: 250 + k * 9, alt: 40 + k * 4 });
var t8 = chart.track({ jd: jd8, lat: PHX.lat, lon: PHX.lon, path: path, now: 2, h: 118, caption: '263 mi up' });
var d8 = chart.decode(t8.bytes);
var sat8 = d8.points.filter(function (p) { return p.info & chart.INFO.TARGET; });
check('a path: one satellite, six dots, six segments', sat8.length === 1 &&
      d8.points.filter(function (p) { return p.info & chart.INFO.LINE; }).length === 6 && d8.segs.length === 6,
      d8.points.length + ' points, ' + d8.segs.length + ' segments');
var last8 = d8.arrow && d8.points[d8.arrow[1]], prev8 = d8.arrow && d8.points[d8.arrow[0]];
check('the arrow is at the newest end, going up and right (rising toward the west-northwest)', last8 &&
      last8.x > prev8.x && last8.y < prev8.y && last8.x > sat8[0].x, JSON.stringify(d8.arrow));
check('the path fits the chart', d8.points.filter(function (p) { return p.info & chart.INFO.LINE; })
  .every(function (p) { return p.x >= 0 && p.x < chart.W && p.y >= 0 && p.y < 118; }));
check('the path\'s caption', d8.caption === '263 mi up' && !d8.rival && !d8.craft && !d8.route);

// A plane's path: its shape along it, its route, and what else it might be
// in place of a caption.
var t9 = chart.track({ jd: jd8, lat: PHX.lat, lon: PHX.lon, path: path, now: 2, h: 70, craft: 3,
                       route: { from: 'SJC', to: 'PHX', share: 0.5 }, caption: 'or Southwest 1123', rival: true });
var d9 = chart.decode(t9.bytes);
check('a plane: its shape at point 0, nose toward the next point on', d9.craft && d9.craft.kind === 3 &&
      d9.craft.from === 0 && d9.points[d9.craft.to].x > d9.points[0].x && d9.craft.to !== 0, JSON.stringify(d9.craft));
check('its route, half way', d9.route && d9.route.from === 'SJC' && d9.route.to === 'PHX' &&
      Math.abs(d9.route.share - 128 / 255) < 1e-9, JSON.stringify(d9.route));
check('what else it might be, marked as such', d9.caption === 'or Southwest 1123' && d9.rival);
check('all of it read to the end', d9.length === t9.bytes.length);
var t10 = chart.track({ jd: jd8, lat: PHX.lat, lon: PHX.lon, path: path.slice(0, 3), now: 2, h: 70, craft: 1 });
var d10 = chart.decode(t10.bytes);
check('at the end of its path: nose from the point before', d10.craft && d10.craft.to === 0 && d10.craft.from !== 0 &&
      d10.points[d10.craft.from].x < d10.points[0].x, JSON.stringify(d10.craft));

// Nothing under the horizon. Saturn low in the east, 11 Oct 2026 6:30 pm
// in Phoenix: it sits just inside Cetus, whose whole figure is still
// below the horizon.
var planetsMod = require('../src/pkjs/planets.js');
var whenS = new Date('2026-10-12T01:30:00Z'), jdS = A.julianDay(whenS);
var sat = planetsMod.bodies(whenS, PHX.lat, PHX.lon).filter(function (b) { return b.name === 'Saturn'; })[0];
var satAt = { az: sat.az, alt: sat.alt };
check('Saturn is low in the east for the test', sat.alt > 5 && sat.alt < 15 && sat.az > 80 && sat.az < 110,
      sat.az.toFixed(0) + ' ' + sat.alt.toFixed(1));
check('a figure all under the horizon: no chart', chart.build({ jd: jdS, lat: PHX.lat, lon: PHX.lon, con: 'Cet',
                                                                target: satAt }) === null);
// The horizon's height at x, between its points.
function hzAt(d, x) {
  var h = d.horizon;
  for (var k = 1; k < h.length; k++) {
    if (x <= h[k].x) return h[k - 1].y + (h[k].y - h[k - 1].y) * (x - h[k - 1].x) / Math.max(1, h[k].x - h[k - 1].x);
  }
  return h[h.length - 1].y;
}
var bare = chart.build({ jd: jdS, lat: PHX.lat, lon: PHX.lon, target: satAt, bare: true, minField: 40 });
var db = bare && chart.decode(bare.bytes);
check('bare: just the answer and the stars round it', db && db.segs.length === 0 && db.points.length > 1 &&
      (db.points[0].info & chart.INFO.TARGET), db && db.points.length + ' points');
check('... none of them under the horizon', db && db.horizon.length >= 2 && db.points.every(function (q) {
  return q.y <= hzAt(db, q.x) + 1;
}));
check('... the horizon low on the chart, not across its middle', db && db.horizon.every(function (h) {
  return h.y >= chart.H * 0.7;
}), db && JSON.stringify(db.horizon));
// Pisces, half risen: only its risen lines, and the horizon low.
var pisc = chart.build({ jd: jdS, lat: PHX.lat, lon: PHX.lon, con: 'Psc', target: satAt });
var dp = pisc && chart.decode(pisc.bytes);
var pscUp = 0, pscAll = 0;
stars.lines.Psc.forEach(function (poly) {
  poly.forEach(function (i) {
    var s = stars.starsOfDate(jdS)[i];
    pscAll++;
    if (A.eqToHorizon(s.ra, s.dec, jdS, PHX.lat, PHX.lon).alt > 0) pscUp++;
  });
});
check('a rising figure keeps only what is up', dp && dp.segs.length > 0 && pscUp < pscAll &&
      dp.points.every(function (q) { return q.y <= hzAt(dp, q.x) + 1; }), dp && dp.segs.length + ' lines');
check('... with its horizon low on the chart', dp && dp.horizon.length >= 2 &&
      Math.max.apply(null, dp.horizon.map(function (h) { return h.y; })) >= chart.H * 0.75,
      dp && JSON.stringify(dp.horizon));

// Which way the chart faces, for its ground: only with a horizon.
check('a horizon says which way you face (east)', db && db.dir === 2, db && db.dir);
var high = chart.build({ jd: jd, lat: PHX.lat, lon: PHX.lon, con: 'Ori', target: bet, targetStar: ix('Betelgeuse'),
                         lines: lines });
var dh = chart.decode(high.bytes);
check('... and none without one', dh.horizon.length === 0 && dh.dir === null, JSON.stringify(dh.horizon));

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
