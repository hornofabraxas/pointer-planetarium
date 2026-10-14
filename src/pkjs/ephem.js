// The Sun, Moon and planets for the days ahead, for the watch to answer
// from when the phone isn't there (src/c/offline.c). Sent on open; the
// watch keeps it.
//
// SKY_EPH (bytes, little-endian):
//   [0] version (1), [1..4] start (Unix seconds), [5] Moon step (hours),
//   [6] Moon samples, [7] planet step (hours), [8] planet samples,
//   [9] planets (Mercury, Venus, Mars, Jupiter, Saturn)
//   Moon samples: RA u16 (of 360 in 65536), Dec i16 (centidegrees), mag i8
//     (x 10), lit fraction u8 (x 200); RA/Dec as seen from where you are
//   then for each planet its samples: RA u16, Dec i16, mag i8
// About 700 bytes. The watch works out the Sun itself. Positions are interpolated on the watch: the Moon moves
// about 1.5 degrees in 3 hours, the planets less than a degree a day.

var A = require('./astro.js');
var planets = require('./planets.js');
var moon = require('./moon.js');

var MOON_STEP_H = 3, MOON_N = 56;      // a week
var PLANET_STEP_H = 24, PLANET_N = 14; // two weeks
var BODIES = ['mercury', 'venus', 'mars', 'jupiter', 'saturn'];

function u16(b, v) {
  v = Math.round(v) & 0xffff;
  b.push(v & 0xff, v >> 8);
}

function i16(b, v) {
  u16(b, Math.max(-32768, Math.min(32767, Math.round(v))));
}

function i8(b, v) {
  b.push(Math.max(-127, Math.min(127, Math.round(v))) & 0xff);
}

function radec(b, eq) {
  u16(b, Math.round(A.rev(eq.ra) / 360 * 65536) % 65536);
  i16(b, eq.dec * 100);
}

// The table from the hour before `date`, for the place `here`.
function encode(date, here) {
  var t0 = Math.floor(date.getTime() / 3600000) * 3600;
  var b = [1];
  var t = t0 >>> 0;
  b.push(t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, (t >>> 24) & 0xff);
  b.push(MOON_STEP_H, MOON_N, PLANET_STEP_H, PLANET_N, BODIES.length);
  var i, d, jd;
  for (i = 0; i < MOON_N; i++) {
    d = new Date((t0 + i * MOON_STEP_H * 3600) * 1000);
    jd = A.julianDay(d);
    var m = moon.moonAltAz(d, here.lat, here.lon);
    radec(b, A.horizonToEq(m.az, m.altTrue, jd, here.lat, here.lon));
    i8(b, m.mag * 10);
    b.push(Math.round(m.illum * 200));
  }
  var rows = [];
  for (i = 0; i < PLANET_N; i++) {
    d = new Date((t0 + i * PLANET_STEP_H * 3600) * 1000);
    rows.push({ jd: A.julianDay(d), bodies: planets.bodies(d, here.lat, here.lon) });
  }
  BODIES.forEach(function (id) {
    rows.forEach(function (r) {
      var x = r.bodies.filter(function (q) { return q.id === id; })[0];
      radec(b, A.horizonToEq(x.az, x.altTrue, r.jd, here.lat, here.lon));
      i8(b, x.mag * 10);
    });
  });
  return b;
}

module.exports = { encode: encode, BODIES: BODIES, MOON_STEP_H: MOON_STEP_H, MOON_N: MOON_N,
                   PLANET_STEP_H: PLANET_STEP_H, PLANET_N: PLANET_N };
