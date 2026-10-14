// Checks src/pkjs/wmm.js (WMM2025, ported from magvar) against pygeomag,
// an independent implementation (test/wmm_fixture.json, made by
// tools/make_wmm_fixture.py). Run: node test/wmm.test.js
var wmm = require('../src/pkjs/wmm.js');
var rows = require('./wmm_fixture.json');

function dateOf(year) {
  var y = Math.floor(year);
  var start = Date.UTC(y, 0, 1), next = Date.UTC(y + 1, 0, 1);
  return new Date(start + (year - y) * (next - start));
}

var worst = 0, worstH = 0;
rows.forEach(function (r) {
  var f = wmm.field(r.lat, r.lon, r.altKm, dateOf(r.year));
  worst = Math.max(worst, Math.abs(f.declination - r.decl));
  worstH = Math.max(worstH, Math.abs(f.h - r.h));
});
console.log('worst declination diff vs pygeomag: ' + worst.toFixed(4) + ' deg over ' + rows.length);
console.log('worst horizontal intensity diff: ' + worstH.toFixed(1) + ' nT');

// Phoenix, 2026-10-07: NOAA's calculator gives about 9.6 deg east.
var phx = wmm.field(33.49, -111.99, 0.38, new Date(Date.UTC(2026, 9, 7))).declination;
console.log('Phoenix declination: ' + phx.toFixed(2));

// Both models share coefficients, so anything over 0.01 deg is a port bug.
if (worst > 0.01 || worstH > 5 || phx < 9 || phx > 10.5) {
  console.log('FAIL');
  process.exit(1);
}
console.log('PASS');
