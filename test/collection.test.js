// The logbook as a collection (collection.js): shelves, places to fill,
// the same constellation found and pointed at counting together, extras,
// and stick figures.
// Run: node test/collection.test.js
var C = require('../src/pkjs/collection.js');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

var T0 = Date.UTC(2026, 9, 11, 2), H = 3600e3;
function e(i, k, id, n, w, extra) {
  var x = { t: T0 + i * H, k: k, id: id, n: n, w: w, la: 33.5, lo: -112.2 };
  for (var key in extra) x[key] = extra[key];
  return x;
}
var list = [
  e(0, 'planet', 'planet:saturn', 'Saturn', 'sure'),
  e(1, 'constellation', 'pattern:orion', 'Orion', 'sure'),
  e(2, 'constellation', 'con:Ori', 'Orion', 'found'),
  e(3, 'constellation', 'con:Ori', 'Orion', 'likely'),
  e(4, 'constellation', 'con:And', 'Andromeda', 'sure'),
  e(5, 'constellation', 'pattern:gone', 'Old Pattern', 'found'),
  e(6, 'star', 'star:2260', 'Vega', 'sure'),
  e(7, 'plane', 'plane:a', 'SWA1', 'sure', { d: 'Boeing 737-800', c: 1 })
];
var v = C.view(list, { metric: false, h12: true });
var shelf = {};
v.shelves.forEach(function (s) { shelf[s.id] = s; });

check('the Moon and the planets, all eight in their places', shelf.solar.total === 8 && shelf.solar.have === 1 &&
      shelf.solar.tiles.map(function (t) { return t.name; }).join(',') ===
      'The Moon,Mercury,Venus,Mars,Jupiter,Saturn,Uranus,Neptune');
check('... Saturn seen, with its picture', shelf.solar.tiles[5].seen && shelf.solar.tiles[5].art === 'saturn' &&
      !shelf.solar.tiles[1].seen);
var orion = shelf.cons.tiles.filter(function (t) { return t.name === 'Orion'; });
check('Orion found and pointed at is one tile, its sightings together', orion.length === 1 && orion[0].n === 3 &&
      /Found with Find it/.test(orion[0].info) && /Seen 3 times/.test(orion[0].info), JSON.stringify(orion));
check('Find it\'s 26 are the total, and what else was seen is extra', shelf.cons.total === 26 &&
      shelf.cons.have === 1 && shelf.cons.extra === 2, JSON.stringify([shelf.cons.have, shelf.cons.total, shelf.cons.extra]));
var names = shelf.cons.tiles.map(function (t) { return t.name + (t.seen ? '*' : ''); });
check('... seen first, then the extras, then the places still to fill', names[0] === 'Orion*' &&
      names[1] === 'Andromeda*' && names[2] === 'Old Pattern*' && names[3].slice(-1) !== '*', names.slice(0, 4).join(', '));
check('... an extra constellation drawn from its figure, a dropped pattern as an icon',
      !!shelf.cons.tiles[1].fig && shelf.cons.tiles[2].fig === null);
check('things seen: each once, extras included', v.things === 6, v.things);
check('a star in its colour (Vega is white-blue)', shelf.stars.tiles[0].color === C.STAR_COLOR.A);
check('a plane type with its shape', shelf.planes.tiles[0].craft === 1 && shelf.planes.tiles[0].name === 'Boeing 737-800');
check('where from, in words', v.where.length === 1 && v.where[0].label === 'near Phoenix' && v.where[0].n === 8);
check('latest first, with when and where', v.recent[0].name === 'SWA1 (Boeing 737-800)' &&
      / · near Phoenix$/.test(v.recent[0].sub), v.recent[0].sub);
check('an empty logbook: the places to fill, nothing seen', (function () {
  var w = C.view([], {});
  return w.things === 0 && w.sightings === 0 && w.shelves[0].tiles.length === 8 && w.shelves[1].tiles.length === 26;
})());

// Stick figures: fitted in the box, the pen lifted at a missing star.
var f = C.figure([[0, 1, -1, 2, 3]]);
check('a missing star splits the line', f && f.length === 2 && f[0].length === 2 && f[1].length === 2, JSON.stringify(f));
check('... and it all fits the 100 x 70 box', f.every(function (pl) {
  return pl.every(function (p) { return p[0] >= 0 && p[0] <= 100 && p[1] >= 0 && p[1] <= 70; });
}));
check('one star is no figure', C.figure([[5]]) === null);

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
