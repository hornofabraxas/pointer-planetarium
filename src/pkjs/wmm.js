// Magnetic declination from the World Magnetic Model 2025 (NOAA NCEI and
// BGS; public domain), valid 2025.0 to 2030.0.
//
// The watch compass reports magnetic north; adding the declination (east
// positive) turns that into true north. Ported from magvar 2.2.0
// (https://github.com/dpyeates/magvar, MIT License, Copyright (c) 2025
// Darren Yeates), trimmed to the declination and horizontal intensity.
// Checked against pygeomag in test/wmm.test.js.

var cof = require('./wmm_cof.js');

var MAX_N = 12;
var EPOCH = cof.MODEL_EPOCH;
var VALID_UNTIL = cof.MODEL_VALID_UNTIL;
var WGS_A = 6378.137, WGS_B = 6356.7523142, R0 = 6371.2;
var DEG = Math.PI / 180;

function grid() {
  var g = [];
  for (var i = 0; i <= MAX_N; i++) {
    g.push([]);
    for (var j = 0; j <= MAX_N; j++) g[i].push(0);
  }
  return g;
}

var root = [], roots = grid().map(function (row) { return row.map(function () { return [0, 0]; }); });
for (var n0 = 2; n0 <= MAX_N; n0++) root[n0] = Math.sqrt((2 * n0 - 1) / (2 * n0));
for (var m0 = 0; m0 <= MAX_N; m0++) {
  for (var n1 = Math.max(m0 + 1, 2); n1 <= MAX_N; n1++) {
    roots[m0][n1][0] = Math.sqrt((n1 - 1) * (n1 - 1) - m0 * m0);
    roots[m0][n1][1] = 1 / Math.sqrt(n1 * n1 - m0 * m0);
  }
}

function decimalYear(date) {
  var y = date.getUTCFullYear();
  var start = Date.UTC(y, 0, 1), next = Date.UTC(y + 1, 0, 1);
  return y + (date.getTime() - start) / (next - start);
}

// lat/lon in degrees, altKm above sea level, date a JS Date.
// Returns {declination (deg, east positive), h (horizontal intensity, nT),
// valid (false outside 2025-2030)}.
function field(lat, lon, altKm, date) {
  var year = decimalYear(date);
  var dt = year - EPOCH;
  var gnm = grid(), hnm = grid(), P = grid(), DP = grid();
  for (var n = 1; n <= MAX_N; n++) {
    for (var m = 0; m <= n; m++) {
      gnm[n][m] = cof.gnmWmm[n][m] + dt * cof.gtnmWmm[n][m];
      hnm[n][m] = cof.hnmWmm[n][m] + dt * cof.htnmWmm[n][m];
    }
  }

  var latR = lat * DEG, lonR = lon * DEG;
  var sinLat = Math.sin(latR), cosLat = Math.cos(latR);
  var a2 = WGS_A * WGS_A, b2 = WGS_B * WGS_B;
  var sr = Math.sqrt(a2 * cosLat * cosLat + b2 * sinLat * sinLat);
  var theta = Math.atan2(cosLat * (altKm * sr + a2), sinLat * (altKm * sr + b2));
  var r = Math.sqrt(altKm * altKm + 2 * altKm * sr +
                    (a2 * a2 - (a2 * a2 - b2 * b2) * sinLat * sinLat) /
                    (a2 - (a2 - b2) * sinLat * sinLat));
  var c = Math.cos(theta), s = Math.sin(theta);
  var invS = 1 / (s + (s === 0 ? 1e-8 : 0));

  P[0][0] = 1; P[1][1] = s; DP[0][0] = 0; DP[1][1] = c; P[1][0] = c; DP[1][0] = -s;
  for (n = 2; n <= MAX_N; n++) {
    P[n][n] = P[n - 1][n - 1] * s * root[n];
    DP[n][n] = (DP[n - 1][n - 1] * s + P[n - 1][n - 1] * c) * root[n];
  }
  for (m = 0; m <= MAX_N; m++) {
    for (n = Math.max(m + 1, 2); n <= MAX_N; n++) {
      P[n][m] = (P[n - 1][m] * c * (2 * n - 1) - P[n - 2][m] * roots[m][n][0]) * roots[m][n][1];
      DP[n][m] = ((DP[n - 1][m] * c - P[n - 1][m] * s) * (2 * n - 1) -
                  DP[n - 2][m] * roots[m][n][0]) * roots[m][n][1];
    }
  }

  var BR = 0, BT = 0, BP = 0;
  var fn0 = R0 / r, fn = fn0 * fn0;
  for (n = 1; n <= MAX_N; n++) {
    var c1 = 0, c2 = 0, c3 = 0;
    for (m = 0; m <= n; m++) {
      var cm = Math.cos(m * lonR), sm = Math.sin(m * lonR);
      var t = gnm[n][m] * cm + hnm[n][m] * sm;
      c1 += t * P[n][m];
      c2 += t * DP[n][m];
      c3 += m * (gnm[n][m] * sm - hnm[n][m] * cm) * P[n][m];
    }
    fn *= fn0;
    BR += (n + 1) * c1 * fn;
    BT -= c2 * fn;
    BP += c3 * fn * invS;
  }

  var psi = theta - (Math.PI / 2 - latR);
  var x = -BT * Math.cos(psi) - BR * Math.sin(psi);
  var y = BP;
  return {
    declination: (x !== 0 || y !== 0) ? Math.atan2(y, x) / DEG : 0,
    h: Math.sqrt(x * x + y * y),
    valid: year >= EPOCH && year < VALID_UNTIL
  };
}

module.exports = { field: field };
