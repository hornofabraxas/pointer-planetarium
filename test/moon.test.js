// Checks src/pkjs/moon.js against PyEphem reference positions
// (test/moon_fixture.json, made by tools/make_moon_fixture.py).
// Run: node test/moon.test.js
var moon = require('../src/pkjs/moon.js');
var rows = require('./moon_fixture.json');

function wrap180(d) {
  var r = ((d + 180) % 360 + 360) % 360 - 180;
  return r;
}

var worstSep = 0, worstAlt = 0, checked = 0;
rows.forEach(function (row) {
  var p = moon.moonAltAz(new Date(row.unix_ms), row.lat, row.lon);
  // Refraction formulas disagree a lot at the horizon; nobody aims there.
  if (row.alt < 3) return;
  checked++;
  var dAlt = p.alt - row.alt;
  var dAz = wrap180(p.az - row.az) * Math.cos(row.alt * Math.PI / 180);
  var sep = Math.sqrt(dAlt * dAlt + dAz * dAz);
  worstSep = Math.max(worstSep, sep);
  worstAlt = Math.max(worstAlt, Math.abs(p.altTrue - row.altTrue));
});

console.log('checked ' + checked + ' positions above 3 deg');
console.log('worst sky separation vs PyEphem: ' + worstSep.toFixed(3) + ' deg');
console.log('worst unrefracted altitude diff: ' + worstAlt.toFixed(3) + ' deg');

// Measured 2026-10-07: median 0.027, p90 0.047, worst 0.105 deg. A wrist
// compass is good to several degrees, so 0.15 deg is still 30x finer.
var LIMIT = 0.15;
if (checked < 100 || worstSep > LIMIT) {
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS');
