// Shared sky math: angles, time, coordinate conversions, precession and
// refraction. Pure functions, no Pebble APIs, so the tests run in node.
//
// Conventions: degrees everywhere; azimuth clockwise from true north;
// longitude east positive; "of date" means the mean equator and equinox of
// the moment in question (what Schlyter's elements give).

var RAD = Math.PI / 180;

function rev(deg) {
  var r = deg % 360;
  return r < 0 ? r + 360 : r;
}

function wrap180(deg) {
  return rev(deg + 180) - 180;
}

function sind(d) { return Math.sin(d * RAD); }
function cosd(d) { return Math.cos(d * RAD); }
function tand(d) { return Math.tan(d * RAD); }
function asind(x) { return Math.asin(Math.max(-1, Math.min(1, x))) / RAD; }
function acosd(x) { return Math.acos(Math.max(-1, Math.min(1, x))) / RAD; }
function atan2d(y, x) { return Math.atan2(y, x) / RAD; }

function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

// Greenwich mean sidereal time, degrees.
function gmst(jd) {
  return rev(280.46061837 + 360.98564736629 * (jd - 2451545.0));
}

// Mean obliquity of the ecliptic (Schlyter), d = days since 2000 Jan 0.0.
function obliquity(d) {
  return 23.4393 - 3.563e-7 * d;
}

// Ecliptic lon/lat to equatorial ra/dec, both of date.
function eclToEq(lon, lat, ecl) {
  var x = cosd(lon) * cosd(lat);
  var y = sind(lon) * cosd(lat);
  var z = sind(lat);
  var yq = y * cosd(ecl) - z * sind(ecl);
  var zq = y * sind(ecl) + z * cosd(ecl);
  return { ra: rev(atan2d(yq, x)), dec: atan2d(zq, Math.sqrt(x * x + yq * yq)) };
}

// Equatorial (of date) to horizontal, without refraction.
function eqToHorizon(ra, dec, jd, lat, lon) {
  var ha = rev(gmst(jd) + lon - ra);
  var alt = asind(sind(lat) * sind(dec) + cosd(lat) * cosd(dec) * cosd(ha));
  var az = rev(atan2d(-cosd(dec) * sind(ha),
                      sind(dec) * cosd(lat) - cosd(dec) * sind(lat) * cosd(ha)));
  return { az: az, alt: alt };
}

// Horizontal (true, no refraction) back to equatorial of date.
function horizonToEq(az, alt, jd, lat, lon) {
  var dec = asind(sind(lat) * sind(alt) + cosd(lat) * cosd(alt) * cosd(az));
  var ha = atan2d(-sind(az) * cosd(alt), cosd(lat) * sind(alt) - sind(lat) * cosd(alt) * cosd(az));
  return { ra: rev(gmst(jd) + lon - ha), dec: dec };
}

// Refraction lift (degrees) for a true altitude h (Saemundsson). Tapered to
// zero below -1 degree, where nothing is being aimed at anyway.
function refraction(h) {
  if (h < -1) return 0;
  return 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * RAD) / 60;
}

// Inverse: true altitude from an apparent (observed) one (Bennett).
function unrefract(hApp) {
  if (hApp < -1) return hApp;
  return hApp - 1 / Math.tan((hApp + 7.31 / (hApp + 4.4)) * RAD) / 60;
}

// IAU 1976 precession of ra/dec from one Julian day's mean equinox to
// another's. Good to well under an arcsecond over centuries; used for the
// star catalog (J2000 to date) and for the constellation table (B1875).
function precess(ra, dec, jdFrom, jdTo) {
  var T = (jdFrom - 2451545.0) / 36525;
  var t = (jdTo - jdFrom) / 36525;
  var s = 1 / 3600;
  var zeta = ((2306.2181 + 1.39656 * T - 0.000139 * T * T) * t +
              (0.30188 - 0.000344 * T) * t * t + 0.017998 * t * t * t) * s;
  var z = ((2306.2181 + 1.39656 * T - 0.000139 * T * T) * t +
           (1.09468 + 0.000066 * T) * t * t + 0.018203 * t * t * t) * s;
  var theta = ((2004.3109 - 0.85330 * T - 0.000217 * T * T) * t -
               (0.42665 + 0.000217 * T) * t * t - 0.041833 * t * t * t) * s;
  var A = cosd(dec) * sind(ra + zeta);
  var B = cosd(theta) * cosd(dec) * cosd(ra + zeta) - sind(theta) * sind(dec);
  var C = sind(theta) * cosd(dec) * cosd(ra + zeta) + cosd(theta) * sind(dec);
  return { ra: rev(atan2d(A, B) + z), dec: asind(C) };
}

var JD_J2000 = 2451545.0;
var JD_B1875 = 2405889.258550475;

// Angle between two directions given as (az, alt) or (ra, dec) pairs.
function separation(a1, b1, a2, b2) {
  var c = sind(b1) * sind(b2) + cosd(b1) * cosd(b2) * cosd(a1 - a2);
  return acosd(c);
}

module.exports = {
  RAD: RAD, rev: rev, wrap180: wrap180, sind: sind, cosd: cosd, tand: tand,
  asind: asind, acosd: acosd, atan2d: atan2d, julianDay: julianDay, gmst: gmst,
  obliquity: obliquity, eclToEq: eclToEq, eqToHorizon: eqToHorizon,
  horizonToEq: horizonToEq, refraction: refraction, unrefract: unrefract,
  precess: precess, separation: separation, JD_J2000: JD_J2000, JD_B1875: JD_B1875
};
