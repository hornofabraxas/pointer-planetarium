// Where the Moon is in your sky, accurate to a few hundredths of a degree.
//
// Low-precision lunar theory from Paul Schlyter's "How to compute planetary
// positions" (the main periodic perturbations included), plus topocentric
// parallax (the Moon sits up to ~1 degree lower than its geocentric
// position) and atmospheric refraction (Saemundsson's formula). That is far
// finer than a wrist compass can resolve, which is the point: any error the
// aim test measures belongs to the watch, not to this file.
//
// Pure functions, no Pebble APIs, so test/moon.test.js can run it in node.

var planets = require('./planets.js');

var RAD = Math.PI / 180;

function rev(deg) {
  var r = deg % 360;
  return r < 0 ? r + 360 : r;
}

function sind(d) { return Math.sin(d * RAD); }
function cosd(d) { return Math.cos(d * RAD); }
function atan2d(y, x) { return Math.atan2(y, x) / RAD; }

function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// Geocentric ecliptic longitude/latitude (degrees) and distance (Earth radii).
function moonEcliptic(d) {
  var N = rev(125.1228 - 0.0529538083 * d);
  var i = 5.1454;
  var w = rev(318.0634 + 0.1643573223 * d);
  var a = 60.2666;
  var e = 0.0549;
  var M = rev(115.3654 + 13.0649929509 * d);

  var Ms = rev(356.0470 + 0.9856002585 * d);
  var ws = 282.9404 + 4.70935e-5 * d;
  var Ls = rev(Ms + ws);

  // Kepler's equation, iterated to well under a millidegree.
  var E = M + (e / RAD) * sind(M) * (1 + e * cosd(M));
  for (var k = 0; k < 8; k++) {
    E = E - (E - (e / RAD) * sind(E) - M) / (1 - e * cosd(E));
  }

  var xv = a * (cosd(E) - e);
  var yv = a * Math.sqrt(1 - e * e) * sind(E);
  var v = atan2d(yv, xv);
  var r = Math.sqrt(xv * xv + yv * yv);

  var xh = r * (cosd(N) * cosd(v + w) - sind(N) * sind(v + w) * cosd(i));
  var yh = r * (sind(N) * cosd(v + w) + cosd(N) * sind(v + w) * cosd(i));
  var zh = r * sind(v + w) * sind(i);

  var lon = atan2d(yh, xh);
  var lat = atan2d(zh, Math.sqrt(xh * xh + yh * yh));

  var Lm = N + w + M;
  var D = Lm - Ls;
  var F = Lm - N;

  lon += -1.274 * sind(M - 2 * D)
       + 0.658 * sind(2 * D)
       - 0.186 * sind(Ms)
       - 0.059 * sind(2 * M - 2 * D)
       - 0.057 * sind(M - 2 * D + Ms)
       + 0.053 * sind(M + 2 * D)
       + 0.046 * sind(2 * D - Ms)
       + 0.041 * sind(M - Ms)
       - 0.035 * sind(D)
       - 0.031 * sind(M + Ms)
       - 0.015 * sind(2 * F - 2 * D)
       + 0.011 * sind(M - 4 * D);
  lat += -0.173 * sind(F - 2 * D)
       - 0.055 * sind(M - F - 2 * D)
       - 0.046 * sind(M + F - 2 * D)
       + 0.033 * sind(F + 2 * D)
       + 0.017 * sind(2 * M + F);
  r += -0.58 * cosd(M - 2 * D) - 0.46 * cosd(2 * D);

  return { lon: rev(lon), lat: lat, r: r };
}

// Refraction lift (degrees) for a true altitude h (degrees). Bennett's
// formula is written for apparent altitude; Saemundsson's inverse is the
// one that takes the true altitude, which is what we have.
function refraction(h) {
  if (h < -1) return 0;
  var arcmin = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * RAD);
  return arcmin / 60;
}

// date: JS Date (UTC instant). lat/lon in degrees, east longitude positive.
// Returns {az, alt, altTrue, illum, waxing, mag}: az clockwise from true
// north, alt apparent (with refraction), altTrue without refraction (all
// degrees); illum is the lit fraction 0..1, waxing true from new to full,
// mag the apparent magnitude.
var EARTH_RADIUS_KM = 6378.14;   // the Moon's distance comes in Earth radii

function moonAltAz(date, lat, lon) {
  var jd = julianDay(date);
  var d = jd - 2451543.5;

  var m = moonEcliptic(d);
  var ecl = 23.4393 - 3.563e-7 * d;

  var xe = m.r * cosd(m.lon) * cosd(m.lat);
  var ye = m.r * sind(m.lon) * cosd(m.lat);
  var ze = m.r * sind(m.lat);
  var xq = xe;
  var yq = ye * cosd(ecl) - ze * sind(ecl);
  var zq = ye * sind(ecl) + ze * cosd(ecl);

  var ra = rev(atan2d(yq, xq));
  var dec = atan2d(zq, Math.sqrt(xq * xq + yq * yq));

  var gmst = rev(280.46061837 + 360.98564736629 * (jd - 2451545.0));
  var ha = rev(gmst + lon - ra);

  var sinAlt = sind(lat) * sind(dec) + cosd(lat) * cosd(dec) * cosd(ha);
  var altGeo = Math.asin(sinAlt) / RAD;
  var az = rev(atan2d(-cosd(dec) * sind(ha),
                      sind(dec) * cosd(lat) - cosd(dec) * sind(lat) * cosd(ha)));

  // Seen from the Earth's surface rather than its centre, the Moon drops
  // by its horizontal parallax times cos(alt). Azimuth shift is negligible.
  var par = Math.asin(1 / m.r) / RAD;
  var altTrue = altGeo - par * cosd(altGeo);

  // Phase from the Moon-Sun elongation; brightness from the phase angle
  // (Schlyter's lunar magnitude, about right away from new moon).
  var sun = planets.sunEcliptic(d);
  var elong = Math.acos(cosd(m.lat) * cosd(m.lon - sun.lon)) / RAD;
  var phaseAngle = 180 - elong;
  var illum = (1 - cosd(elong)) / 2;
  var waxing = rev(m.lon - sun.lon) < 180;
  var mag = -12.7 + 0.026 * phaseAngle + 4e-9 * Math.pow(phaseAngle, 4);

  return { az: az, alt: altTrue + refraction(altTrue), altTrue: altTrue,
           illum: illum, waxing: waxing, mag: mag, distKm: m.r * EARTH_RADIUS_KM };
}

// Which way the Moon's lit side faces, as you look at it: degrees
// clockwise from straight up (90: its right side is lit), toward the Sun
// along the sky. m and sun: {az, alt} (sky.moon and sky.bodies[0]).
function litSide(m, sun) {
  function vec(az, alt) { return [cosd(alt) * sind(az), cosd(alt) * cosd(az), sind(alt)]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  var mv = vec(m.az, m.alt), sv = vec(sun.az, sun.alt);
  // Right and up across the face of the sky at the Moon (chart.js
  // projector); looking straight up, right is east of the azimuth faced.
  var right = [mv[1], -mv[0], 0];
  var n = Math.sqrt(dot(right, right));
  right = n < 1e-4 ? [cosd(m.az), -sind(m.az), 0] : [right[0] / n, right[1] / n, 0];
  var up = [right[1] * mv[2] - right[2] * mv[1], right[2] * mv[0] - right[0] * mv[2],
            right[0] * mv[1] - right[1] * mv[0]];
  var k = dot(sv, mv);
  var t = [sv[0] - k * mv[0], sv[1] - k * mv[1], sv[2] - k * mv[2]];
  return rev(atan2d(dot(t, right), dot(t, up)));
}

module.exports = { moonAltAz: moonAltAz, litSide: litSide };
