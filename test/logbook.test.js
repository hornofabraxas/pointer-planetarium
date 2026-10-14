// The logbook: what goes in, the same sighting again, the life list.
// Run: node test/logbook.test.js
var book = require('../src/pkjs/logbook.js');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

var T0 = Date.UTC(2026, 9, 11, 2, 0, 0);
var MIN = 60 * 1000;
var home = { lat: 33.49, lon: -111.99 };
var cabin = { lat: 34.25, lon: -111.33 };   // about 100 km away
var saturn = { type: 3, word: 1, l1: 'Saturn', ref: { kind: 'planet', id: 'saturn', name: 'Saturn' } };
var vega = { type: 5, word: 2, l1: 'Vega', ref: { kind: 'star', index: 2260 } };
function plane(hex, name, type, craft) {
  return { type: 1, word: 1, l1: name, ref: { kind: 'plane', hex: hex, typeName: type, craft: craft || 0 } };
}

// What goes in.
var e = book.entryFor(saturn, 'sure', T0, home);
check('a planet: its id, name and roughly where (0.1 degree)', e && e.id === 'planet:saturn' && e.n === 'Saturn' &&
      e.k === 'planet' && e.la === 33.5 && e.lo === -112, JSON.stringify(e));
check('no where: none kept', !('la' in book.entryFor(saturn, 'sure', T0, null)));
check('not the Sun, nothing there, a chart or fact card', [7, 0, 8, 9].every(function (t) {
  return book.entryFor({ type: t, l1: 'x', ref: {} }, 'sure', T0, home) === null;
}));
check('not without a word for how sure', book.entryFor(saturn, '', T0, home) === null);
check('the Moon is "The Moon"', book.entryFor({ type: 4, l1: 'Moon', ref: { kind: 'moon' } }, 'found', T0, null).n ===
      'The Moon');
check('a star pattern and a constellation', book.entryFor({ type: 6, l1: 'Big Dipper', ref: { kind: 'pattern', id: 'bigdipper' } },
                                                          'found', T0, null).id === 'pattern:bigdipper' &&
      book.entryFor({ type: 6, l1: 'Lyra', ref: { kind: 'constellation', id: 'Lyr' } }, 'sure', T0, null).id === 'con:Lyr');
var pe = book.entryFor(plane('a1b2c3', 'Southwest 900', 'Boeing 737-800'), 'sure', T0, null);
check('a plane keeps its type', pe.id === 'plane:a1b2c3' && pe.d === 'Boeing 737-800' && !('c' in pe), JSON.stringify(pe));
check('... and its shape when known', book.entryFor(plane('a1', 'X', 'Airbus A320', 1), 'sure', T0, null).c === 1);

// The same thing again soon is the same sighting.
var list = [];
book.add(list, book.entryFor(saturn, 'likely', T0, home));
book.add(list, book.entryFor(vega, 'likely', T0 + MIN, home));
book.add(list, book.entryFor(saturn, 'sure', T0 + 5 * MIN, home));
check('pointing at it again soon: one sighting, now sure', list.length === 2 && list[0].w === 'sure',
      list.map(function (x) { return x.n + ' ' + x.w; }).join(', '));
book.add(list, book.entryFor(saturn, 'likely', T0 + 10 * MIN, home));
check('... never less sure', list[0].w === 'sure');
book.add(list, book.entryFor(saturn, 'sure', T0 + 60 * MIN, home));
check('an hour later: a new sighting', list.length === 3);
var big = [];
for (var i = 0; i < book.MAX + 5; i++) {
  book.add(big, book.entryFor({ type: 5, word: 1, l1: 's' + i, ref: { kind: 'star', index: i } }, 'sure', T0 + i, null));
}
check('kept to MAX, the oldest dropped', big.length === book.MAX && big[0].n === 's5');

book.add(list, book.entryFor(vega, 'found', T0 + 2000 * MIN, cabin));
check('forgetting where', book.forgetWhere(list.map(function (x) { return Object.assign({}, x); })).every(function (x) {
  return !('la' in x) && !('lo' in x);
}));

// The life list.
book.add(list, book.entryFor(plane('aaa111', 'Southwest 900', 'Boeing 737-800'), 'sure', T0 + 3000 * MIN, null));
book.add(list, book.entryFor(plane('bbb222', 'Southwest 12', 'Boeing 737-800', 1), 'sure', T0 + 3001 * MIN, null));
book.add(list, book.entryFor(plane('ccc333', 'N123', ''), 'likely', T0 + 3002 * MIN, null));
var life = book.lifeList(list);
check('life list: each thing once, first seen first', life.planet.length === 1 && life.planet[0].n === 2 &&
      life.planet[0].first.t === T0 && life.star.length === 1 && life.star[0].n === 2);
check('... the last time, and the surest', life.planet[0].last.t === T0 + 60 * MIN && life.planet[0].best === 'sure' &&
      life.star[0].best === 'found' && life.star[0].key === 'star:2260',
      JSON.stringify(life.star[0]));
check('... a type\'s shape from any of its planes', life.plane[0].c === 1);
check('... planes by type, unknown ones together', life.plane.length === 2 && life.plane[0].name === 'Boeing 737-800' &&
      life.plane[0].n === 2 && life.plane[1].name === 'Other planes', JSON.stringify(life.plane.map(function (r) {
        return r.name + ' ' + r.n;
      })));

// Times and the CSV.
var d = new Date(2026, 9, 11, 19, 5);
check('when, 12 hour', book.when(d.getTime(), true) === 'Sun 11 Oct, 7:05 pm', book.when(d.getTime(), true));
check('when, 24 hour', book.when(d.getTime(), false) === 'Sun 11 Oct, 19:05');
check('day', book.day(d.getTime()) === '11 Oct 2026');
var csv = book.csv([{ t: T0, k: 'plane', id: 'plane:x', n: 'Flight "A", B', d: 'Cessna 172', w: 'sure', la: 33.5, lo: -112 }],
                   function (x) { return x.la === 33.5 ? 'near Phoenix' : ''; });
check('CSV, quoted where it must be, with the place in words', csv.split('\n')[1] ===
      '2026-10-11T02:00:00.000Z,plane,"Flight ""A"", B",Cessna 172,sure,near Phoenix,33.5,-112', csv.split('\n')[1]);

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
