// Checks src/pkjs/attitude.js by building watch orientations from a known
// pointing direction and wrist roll, simulating what the accelerometer and
// firmware compass would report, and inverting them.
// Run: node test/attitude.test.js
var att = require('../src/pkjs/attitude.js');
var A = require('../src/pkjs/astro.js');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

// ENU unit vector for an azimuth/altitude.
function enu(az, alt) {
  return [A.sind(az) * A.cosd(alt), A.cosd(az) * A.cosd(alt), A.sind(alt)];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v) {
  var n = Math.sqrt(dot(v, v));
  return [v[0] / n, v[1] / n, v[2] / n];
}
function rotate(v, axis, deg) {   // Rodrigues
  var c = A.cosd(deg), s = A.sind(deg), k = axis, kv = cross(k, v), kd = dot(k, v);
  return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
          v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}

// Watch pointing along (az, alt) with the face rolled by `roll` degrees
// about the forearm (0 = face as up as it can be). Returns what the sensors
// would report.
function simulate(az, alt, roll, wrist, decl) {
  var f = enu(az, alt);
  var x = wrist ? [-f[0], -f[1], -f[2]] : f;              // the 3 o'clock axis
  var upPerp = norm([-f[2] * f[0], -f[2] * f[1], 1 - f[2] * f[2]]);   // up, square to f
  var z = rotate(upPerp, f, roll);                         // screen normal
  var y = cross(z, x);                                      // 12 o'clock
  var down = [0, 0, -1];
  var accel = { x: 1000 * dot(down, x), y: 1000 * dot(down, y), z: 1000 * dot(down, z) };
  var yTrueAz = A.rev(A.atan2d(y[0], y[1]));
  var magnetic = A.rev(yTrueAz - decl);
  return { headRaw: A.rev(360 - magnetic), accel: accel };
}

var BARE = { yaw: 0, pitch: 0 };   // the forearm itself, which simulate() points
var worst = 0, cases = 0, flagged = 0;
[0, 1].forEach(function (wrist) {
  for (var az = 0; az < 360; az += 37) {
    for (var alt = 0; alt <= 80; alt += 20) {
      [-50, -20, 0, 20, 50].forEach(function (roll) {
        var s = simulate(az, alt, roll, wrist, 9.6);
        var r = att.aimDirection(s.headRaw, s.accel, wrist, 9.6, BARE);
        if (r.rollTooFar) {
          flagged++;
          return;
        }
        cases++;
        worst = Math.max(worst, A.separation(r.az, r.alt, az, alt));
      });
    }
  }
});
check('round trip, both wrists, roll -50..50, alt 0..80', cases > 300 && worst < 1e-6,
      cases + ' cases, worst ' + worst.toExponential(1) + ' deg, ' + flagged + ' flagged');

// A thumb-up fist aimed low points the 12 o'clock edge at the sky: flagged.
var fist = simulate(120, 10, 90, 0, 9.6);
check('thumb-up roll at a low target flagged', att.aimDirection(fist.headRaw, fist.accel, 0, 9.6, BARE).rollTooFar);

// Level, palm down, left wrist, arm pointing north: 12 o'clock points west
// (true 270), so the raw CCW magnetic reading is 360 - (270 - 9.6).
var level = att.aimDirection(360 - 260.4, { x: 0, y: 0, z: -1000 }, 0, 9.6, BARE);
check('level left wrist points north', A.separation(level.az, level.alt, 0, 0) < 1e-9,
      level.az.toFixed(3) + '/' + level.alt.toFixed(3));

// Field aims from 2026-10-07 (daytime Moon at az 228.0-228.2, alt 54.1-54.2).
// The bare forearm pointed 7 to 11 degrees right of the Moon; the default
// finger offset was fitted to these same aims, so this is a regression
// check, not independent proof.
[[227.89, -860, -157, -511, 228.011, 54.181], [226.11, -801, -106, -608, 228.120, 54.128],
 [229.22, -857, -107, -525, 228.172, 54.103]].forEach(function (a, i) {
  var r = att.aimDirection(a[0], { x: a[1], y: a[2], z: a[3] }, 0, 9.61);
  var miss = A.separation(r.az, r.alt, a[4], a[5]);
  check('field aim ' + (i + 1) + ' miss under 5 deg with the default finger offset', miss < 5,
        'az ' + r.az.toFixed(1) + ' alt ' + r.alt.toFixed(1) + ' miss ' + miss.toFixed(1));
});

// Field aims from 2026-10-07 at dusk (the Phoenix area,
// declination 9.72). Targets are the app's own top answers, which matched
// what was pointed at; true (unrefracted) positions from PyEphem-checked
// code. Also a fit input, so a regression check.
var dusk = [
  ['Arcturus', 174.51, -349, -64, -936, 280.4, 19.6], ['Vega', 153.9, -987, -154, -177, 299.7, 77.9],
  ['Altair', 270.22, -951, -27, -355, 168.4, 65.0], ['Antares', 227.67, -326, 3, -948, 221.7, 16.0],
  ['Vega', 120.6, -1006, -34, -148, 299.0, 77.5], ['Vega', 127.18, -1012, -39, -91, 298.9, 77.5],
  ['Saturn', 350.74, -234, 61, -972, 95.4, 11.4], ['Saturn', 351.61, -256, -19, -967, 95.4, 11.4],
  ['Deneb', 40.43, -985, -132, -220, 42.6, 72.5]
];
var misses = dusk.map(function (a) {
  var r = att.aimDirection(a[1], { x: a[2], y: a[3], z: a[4] }, 0, 9.72);
  return A.separation(r.az, A.unrefract(r.alt), a[5], a[6]);
});
check('dusk field aims all within 5 deg with the default finger offset',
      misses.every(function (m) { return m < 5; }), misses.map(function (m) { return m.toFixed(1); }).join(' '));

if (failures) {
  console.log(failures + ' FAILED');
  process.exit(1);
}
console.log('PASS');
