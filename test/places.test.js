// Where a sighting was, in words (places.js): suburbs go by their city,
// out-of-the-way places by a town and a direction, the sea by its
// coordinates. The spots are as the logbook keeps them (to 0.1 degree).
// Run: node test/places.test.js
var places = require('../src/pkjs/places.js');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

function is(what, lat, lon, metric, want) {
  var got = places.label(lat, lon, metric);
  check(what + ': ' + want, got === want, got);
}

is('a suburb goes by its city (Glendale, Arizona)', 33.5, -112.2, false, 'near Phoenix');
is('the city itself', 33.4, -112.1, false, 'near Phoenix');
is('a small town', 38.1, -117.2, false, 'near Tonopah');
is('a village at a national park', 36.1, -112.1, false, 'near Grand Canyon');
is('out of town: miles from the nearest', 34.9, -111.8, false, 'about 20 mi S of Flagstaff');
is('... or kilometres', 34.9, -111.8, true, 'about 40 km S of Flagstaff');
is('a dark-sky park', 41.7, -77.8, true, 'about 80 km NW of Williamsport');
is('an observatory', 32.0, -111.6, true, 'about 70 km W of Tucson');
is('a name used twice gets its region', 45.5, -122.7, false, 'near Portland, Oregon');
is('... the other one', 43.7, -70.3, false, 'near Portland, Maine');
is('outside the US', 50.8, -0.1, false, 'near Brighton');
is('the southern hemisphere', -44.0, 170.5, true, 'about 70 km NW of Timaru');
is('far out at sea: coordinates', 30, -140, false, '30.0° N, 140.0° W');
check('no where: nothing', places.label(undefined, undefined, false) === '' && places.label(NaN, 1, true) === '');

var t0 = Date.now();
for (var i = 0; i < 100; i++) places.label(30 + i / 10, -100 - i / 10, false);
var ms = Date.now() - t0;
check('quick enough for a page of places (100 in under a second)', ms < 1000, ms + ' ms');

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
