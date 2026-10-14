// Checks the Sun, the planets (src/pkjs/planets.js) and catalog stars
// (src/pkjs/stars.js) against PyEphem (test/sky_fixture.json, made by
// tools/make_sky_fixture.py). Run: node test/planets.test.js
var planets = require('../src/pkjs/planets.js');
var stars = require('../src/pkjs/stars.js');
var A = require('../src/pkjs/astro.js');
var rows = require('./sky_fixture.json');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

function sep(az1, alt1, az2, alt2) {
  return A.separation(az1, alt1, az2, alt2);
}

// Where the Sun was for each fixture instant and place, to skip magnitude
// checks for planets lost in its glare.
var sunAt = {};
rows.forEach(function (row) {
  if (row.id === 'sun') sunAt[row.unix_ms + ',' + row.lat] = row;
});

var worst = {}, worstMag = {}, n = {};
rows.forEach(function (row) {
  if (row.alt < 3) return;   // refraction models disagree at the horizon; nobody aims there
  var date = new Date(row.unix_ms);
  var az, alt, mag = null;
  if (row.id.indexOf('star:') === 0) {
    var name = row.id.slice(5);
    var s = stars.starsOfDate(A.julianDay(date)).filter(function (x) { return x.name === name; })[0];
    var h = A.eqToHorizon(s.ra, s.dec, A.julianDay(date), row.lat, row.lon);
    az = h.az;
    alt = h.alt + A.refraction(h.alt);
  } else {
    var b = planets.bodies(date, row.lat, row.lon).filter(function (x) { return x.id === row.id; })[0];
    az = b.az;
    alt = b.alt;
    mag = b.mag;
  }
  var key = row.id.indexOf('star:') === 0 ? 'stars' : row.id;
  var d = sep(az, alt, row.az, row.alt);
  worst[key] = Math.max(worst[key] || 0, d);
  n[key] = (n[key] || 0) + 1;
  var sun = sunAt[row.unix_ms + ',' + row.lat];
  var visible = sep(row.az, row.alt, sun.az, sun.alt) > 15;
  if (mag !== null && row.id !== 'sun' && visible) {
    worstMag[key] = Math.max(worstMag[key] || 0, Math.abs(mag - row.mag));
  }
});

// Measured 2026-10-07. Arcminute-level agreement is 300x finer than a
// wrist compass; the limits leave room without hiding a real bug.
var LIMIT = { sun: 0.05, mercury: 0.1, venus: 0.1, mars: 0.1, jupiter: 0.1, saturn: 0.1,
              uranus: 0.1, neptune: 0.1, stars: 0.05 };
Object.keys(LIMIT).forEach(function (k) {
  check(k + ' position', n[k] > 20 && worst[k] < LIMIT[k],
        'worst ' + (worst[k] || 0).toFixed(3) + ' deg over ' + n[k]);
});
// Magnitudes only rank brightness and pick words like "very bright".
// Mercury and Venus use Mallama and Hilton (2018); PyEphem still uses the
// older formulas, which read a crescent Venus up to 0.7 fainter.
// (astronomy-engine, checked by hand 2026-10-07, agrees with ours to 0.3
// everywhere a planet is visible.)
Object.keys(worstMag).forEach(function (k) {
  var limit = k === 'venus' ? 0.8 : k === 'mercury' ? 0.6 : 0.35;
  check(k + ' magnitude (15+ deg from the Sun)', worstMag[k] < limit, 'worst ' + worstMag[k].toFixed(2));
});

if (failures) {
  console.log(failures + ' FAILED');
  process.exit(1);
}
console.log('PASS');
