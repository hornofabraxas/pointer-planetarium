// The Sun and the planets Mercury to Neptune: where they are in your sky
// and how bright they look.
//
// Method and constants from Paul Schlyter, "How to compute planetary
// positions" (https://stjarnhimlen.se/comp/ppcomp.html), after van Flandern
// and Pulkkinen (1980): mean orbital elements of date, Kepler's equation,
// the main Jupiter/Saturn/Uranus perturbations, and his magnitude formulas.
// Good to about an arcminute; checked against PyEphem in
// test/planets.test.js. Parallax is ignored (arcseconds for these bodies).

var A = require('./astro.js');

// N, i, w, a, e, M and their daily rates. d = days since 2000 Jan 0.0 UT.
var ELEMENTS = {
  mercury: [48.3313, 3.24587e-5, 7.0047, 5.00e-8, 29.1241, 1.01444e-5, 0.387098, 0,
            0.205635, 5.59e-10, 168.6562, 4.0923344368],
  venus: [76.6799, 2.46590e-5, 3.3946, 2.75e-8, 54.8910, 1.38374e-5, 0.723330, 0,
          0.006773, -1.302e-9, 48.0052, 1.6021302244],
  mars: [49.5574, 2.11081e-5, 1.8497, -1.78e-8, 286.5016, 2.92961e-5, 1.523688, 0,
         0.093405, 2.516e-9, 18.6021, 0.5240207766],
  jupiter: [100.4542, 2.76854e-5, 1.3030, -1.557e-7, 273.8777, 1.64505e-5, 5.20256, 0,
            0.048498, 4.469e-9, 19.8950, 0.0830853001],
  saturn: [113.6634, 2.38980e-5, 2.4886, -1.081e-7, 339.3939, 2.97661e-5, 9.55475, 0,
           0.055546, -9.499e-9, 316.9670, 0.0334442282],
  uranus: [74.0005, 1.3978e-5, 0.7733, 1.9e-8, 96.6612, 3.0565e-5, 19.18171, -1.55e-8,
           0.047318, 7.45e-9, 142.5905, 0.011725806],
  neptune: [131.7806, 3.0173e-5, 1.7700, -2.55e-7, 272.8461, -6.027e-6, 30.05826, 3.313e-8,
            0.008606, 2.15e-9, 260.2471, 0.005995147]
};

var NAMES = {
  sun: 'Sun', mercury: 'Mercury', venus: 'Venus', mars: 'Mars', jupiter: 'Jupiter',
  saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune'
};

// Absolute magnitude and phase coefficients (Schlyter, except as noted).
function magnitude(id, r, R, FV) {
  var base = 5 * Math.log(r * R) / Math.LN10;
  switch (id) {
    // Mercury and Venus: Mallama and Hilton (2018), which holds up near
    // inferior conjunction where Schlyter's polynomials drift by magnitudes.
    case 'mercury':
      return base - 0.613 + 6.3280e-2 * FV - 1.6336e-3 * FV * FV + 3.3644e-5 * Math.pow(FV, 3) -
             3.4265e-7 * Math.pow(FV, 4) + 1.6893e-9 * Math.pow(FV, 5) - 3.0334e-12 * Math.pow(FV, 6);
    case 'venus':
      if (FV < 163.7) {
        return base - 4.384 - 1.044e-3 * FV + 3.687e-4 * FV * FV - 2.814e-6 * Math.pow(FV, 3) +
               8.938e-9 * Math.pow(FV, 4);
      }
      return base + 236.05828 - 2.81914 * FV + 8.39034e-3 * FV * FV;
    case 'mars': return -1.51 + base + 0.016 * FV;
    case 'jupiter': return -9.25 + base + 0.014 * FV;
    case 'saturn': return -9.0 + base + 0.044 * FV;   // plus the ring term, added by the caller
    case 'uranus': return -7.15 + base + 0.001 * FV;
    case 'neptune': return -6.90 + base + 0.001 * FV;
  }
  return 99;
}

function kepler(M, e) {
  var E = M + (e / A.RAD) * A.sind(M) * (1 + e * A.cosd(M));
  for (var k = 0; k < 10; k++) {
    var dE = (E - (e / A.RAD) * A.sind(E) - M) / (1 - e * A.cosd(E));
    E -= dE;
    if (Math.abs(dE) < 1e-7) break;
  }
  return E;
}

// The Sun's geocentric ecliptic longitude (of date) and distance (AU).
function sunEcliptic(d) {
  var w = 282.9404 + 4.70935e-5 * d;
  var e = 0.016709 - 1.151e-9 * d;
  var M = A.rev(356.0470 + 0.9856002585 * d);
  var E = kepler(M, e);
  var xv = A.cosd(E) - e;
  var yv = Math.sqrt(1 - e * e) * A.sind(E);
  return { lon: A.rev(A.atan2d(yv, xv) + w), r: Math.sqrt(xv * xv + yv * yv) };
}

// Heliocentric ecliptic position of a planet: lon/lat (degrees), r (AU).
function heliocentric(id, d) {
  var el = ELEMENTS[id];
  var N = el[0] + el[1] * d;
  var i = el[2] + el[3] * d;
  var w = el[4] + el[5] * d;
  var a = el[6] + el[7] * d;
  var e = el[8] + el[9] * d;
  var M = A.rev(el[10] + el[11] * d);
  var E = kepler(M, e);
  var xv = a * (A.cosd(E) - e);
  var yv = a * Math.sqrt(1 - e * e) * A.sind(E);
  var v = A.atan2d(yv, xv);
  var r = Math.sqrt(xv * xv + yv * yv);
  var xh = r * (A.cosd(N) * A.cosd(v + w) - A.sind(N) * A.sind(v + w) * A.cosd(i));
  var yh = r * (A.sind(N) * A.cosd(v + w) + A.cosd(N) * A.sind(v + w) * A.cosd(i));
  var zh = r * A.sind(v + w) * A.sind(i);
  var lon = A.atan2d(yh, xh);
  var lat = A.atan2d(zh, Math.sqrt(xh * xh + yh * yh));

  // Mutual perturbations of the giants (Schlyter's main terms).
  var Mj = A.rev(19.8950 + 0.0830853001 * d);
  var Ms = A.rev(316.9670 + 0.0334442282 * d);
  var Mu = A.rev(142.5905 + 0.011725806 * d);
  if (id === 'jupiter') {
    lon += -0.332 * A.sind(2 * Mj - 5 * Ms - 67.6) - 0.056 * A.sind(2 * Mj - 2 * Ms + 21) +
           0.042 * A.sind(3 * Mj - 5 * Ms + 21) - 0.036 * A.sind(Mj - 2 * Ms) +
           0.022 * A.cosd(Mj - Ms) + 0.023 * A.sind(2 * Mj - 3 * Ms + 52) -
           0.016 * A.sind(Mj - 5 * Ms - 69);
  } else if (id === 'saturn') {
    lon += 0.812 * A.sind(2 * Mj - 5 * Ms - 67.6) - 0.229 * A.cosd(2 * Mj - 4 * Ms - 2) +
           0.119 * A.sind(Mj - 2 * Ms - 3) + 0.046 * A.sind(2 * Mj - 6 * Ms - 69) +
           0.014 * A.sind(Mj - 3 * Ms + 32);
    lat += -0.020 * A.cosd(2 * Mj - 4 * Ms - 2) + 0.018 * A.sind(2 * Mj - 6 * Ms - 49);
  } else if (id === 'uranus') {
    lon += 0.040 * A.sind(Ms - 2 * Mu + 6) + 0.035 * A.sind(Ms - 3 * Mu + 33) -
           0.015 * A.sind(Mj - Mu + 20);
  }
  return { lon: lon, lat: lat, r: r };
}

function place(ra, dec, jd, lat, lon) {
  var h = A.eqToHorizon(ra, dec, jd, lat, lon);
  return { az: h.az, alt: h.alt + A.refraction(h.alt), altTrue: h.alt };
}

// Everything at once for one instant and place. Returns
// [{id, name, az, alt, altTrue, mag, distAU (from the Earth), lit (the
// share of the disc we see lit, planets only)}], the Sun first.
function bodies(date, lat, lon) {
  var jd = A.julianDay(date);
  var d = jd - 2451543.5;
  var ecl = A.obliquity(d);
  var sun = sunEcliptic(d);
  var out = [];

  var sq = A.eclToEq(sun.lon, 0, ecl);
  var sp = place(sq.ra, sq.dec, jd, lat, lon);
  out.push({ id: 'sun', name: NAMES.sun, az: sp.az, alt: sp.alt, altTrue: sp.altTrue, mag: -26.7,
             distAU: sun.r });

  var xs = sun.r * A.cosd(sun.lon);
  var ys = sun.r * A.sind(sun.lon);
  Object.keys(ELEMENTS).forEach(function (id) {
    var h = heliocentric(id, d);
    var xh = h.r * A.cosd(h.lon) * A.cosd(h.lat);
    var yh = h.r * A.sind(h.lon) * A.cosd(h.lat);
    var zh = h.r * A.sind(h.lat);
    var xg = xh + xs, yg = yh + ys, zg = zh;
    var R = Math.sqrt(xg * xg + yg * yg + zg * zg);
    var glon = A.rev(A.atan2d(yg, xg));
    var glat = A.atan2d(zg, Math.sqrt(xg * xg + yg * yg));
    var FV = A.acosd((h.r * h.r + R * R - sun.r * sun.r) / (2 * h.r * R));
    var mag = magnitude(id, h.r, R, FV);
    if (id === 'saturn') {
      var ir = 28.06;
      var Nr = 169.51 + 3.82e-5 * d;
      var B = A.asind(A.sind(glat) * A.cosd(ir) - A.cosd(glat) * A.sind(ir) * A.sind(glon - Nr));
      mag += -2.6 * Math.abs(A.sind(B)) + 1.2 * A.sind(B) * A.sind(B);
    }
    var q = A.eclToEq(glon, glat, ecl);
    var p = place(q.ra, q.dec, jd, lat, lon);
    out.push({ id: id, name: NAMES[id], az: p.az, alt: p.alt, altTrue: p.altTrue, mag: mag,
               distAU: R, lit: (1 + A.cosd(FV)) / 2 });
  });
  return out;
}

module.exports = { bodies: bodies, sunEcliptic: sunEcliptic };
