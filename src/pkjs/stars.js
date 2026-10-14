// Bright stars (to magnitude 5.5) and the 88 constellations.
//
// Positions come J2000 from the catalog and are precessed to the date once
// per day (about 0.37 degrees by 2026; small, but free). Constellation
// membership uses Roman's (1987) table, which is defined in B1875
// coordinates, so a direction is precessed to 1875 before the lookup.

var A = require('./astro.js');
var data = require('./stars_data.js');

var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

var CONSTELLATIONS = {
  And: 'Andromeda', Ant: 'Antlia', Aps: 'Apus', Aqr: 'Aquarius', Aql: 'Aquila', Ara: 'Ara',
  Ari: 'Aries', Aur: 'Auriga', Boo: 'Bootes', Cae: 'Caelum', Cam: 'Camelopardalis',
  Cnc: 'Cancer', CVn: 'Canes Venatici', CMa: 'Canis Major', CMi: 'Canis Minor',
  Cap: 'Capricornus', Car: 'Carina', Cas: 'Cassiopeia', Cen: 'Centaurus', Cep: 'Cepheus',
  Cet: 'Cetus', Cha: 'Chamaeleon', Cir: 'Circinus', Col: 'Columba', Com: 'Coma Berenices',
  CrA: 'Corona Australis', CrB: 'Corona Borealis', Crv: 'Corvus', Crt: 'Crater', Cru: 'Crux',
  Cyg: 'Cygnus', Del: 'Delphinus', Dor: 'Dorado', Dra: 'Draco', Equ: 'Equuleus',
  Eri: 'Eridanus', For: 'Fornax', Gem: 'Gemini', Gru: 'Grus', Her: 'Hercules',
  Hor: 'Horologium', Hya: 'Hydra', Hyi: 'Hydrus', Ind: 'Indus', Lac: 'Lacerta', Leo: 'Leo',
  LMi: 'Leo Minor', Lep: 'Lepus', Lib: 'Libra', Lup: 'Lupus', Lyn: 'Lynx', Lyr: 'Lyra',
  Men: 'Mensa', Mic: 'Microscopium', Mon: 'Monoceros', Mus: 'Musca', Nor: 'Norma',
  Oct: 'Octans', Oph: 'Ophiuchus', Ori: 'Orion', Pav: 'Pavo', Peg: 'Pegasus', Per: 'Perseus',
  Phe: 'Phoenix', Pic: 'Pictor', Psc: 'Pisces', PsA: 'Piscis Austrinus', Pup: 'Puppis',
  Pyx: 'Pyxis', Ret: 'Reticulum', Sge: 'Sagitta', Sgr: 'Sagittarius', Sco: 'Scorpius',
  Scl: 'Sculptor', Sct: 'Scutum', Ser: 'Serpens', Sex: 'Sextans', Tau: 'Taurus',
  Tel: 'Telescopium', Tri: 'Triangulum', TrA: 'Triangulum Australe', Tuc: 'Tucana',
  UMa: 'Ursa Major', UMi: 'Ursa Minor', Vel: 'Vela', Vir: 'Virgo', Vol: 'Volans',
  Vul: 'Vulpecula'
};

function dec64(s, at, n) {
  var v = 0;
  for (var i = 0; i < n; i++) v = v * 64 + B64.indexOf(s.charAt(at + i));
  return v;
}

// J2000 catalog: [{ra, dec, mag, name}], decoded once.
var catalog = (function () {
  var out = [];
  var p = data.packed;
  for (var i = 0; i < data.count; i++) {
    var k = i * 8;
    out.push({
      ra: dec64(p, k, 3) / 262144 * 360,
      dec: dec64(p, k + 3, 3) / 262143 * 180 - 90,
      mag: dec64(p, k + 6, 2) / 100 - 2,
      name: data.names[i] || null
    });
  }
  return out;
})();

// Distances in light years (null where the parallax isn't good enough),
// 2 characters a star: log10(ly) * 800, 0 for unknown.
var distances = (function () {
  var out = [];
  var p = data.dist || '';
  for (var i = 0; i < data.count; i++) {
    var v = p.length >= 2 * (i + 1) ? dec64(p, 2 * i, 2) : 0;
    out.push(v ? Math.pow(10, v / 800) : null);
  }
  return out;
})();

// Each star's type, from its catalog spectral type: {cls ('O', 'B', 'A',
// 'F', 'G', 'K', 'M', or '' for anything else), lum (0 unknown, 1
// supergiant, 2 bright giant, 3 giant, 4 subgiant, 5 main sequence (a
// dwarf, like the Sun), 6 white dwarf)}, or null where there's none.
var SPEC_CLASSES = 'OBAFGKM';
var types = (function () {
  var out = [];
  var p = data.spec || '';
  for (var i = 0; i < data.count; i++) {
    var v = i < p.length ? B64.indexOf(p.charAt(i)) : -1;
    out.push(v < 0 ? null : { cls: SPEC_CLASSES.charAt(v >> 3), lum: v & 7 });
  }
  return out;
})();

// Stick figures: {abbreviation: [[catalog index, ...], ...]}, each list a
// line drawn without lifting the pen ("Ori:1,2,3;4,5|UMa:...").
var lines = (function () {
  var out = {};
  (data.lines || '').split('|').forEach(function (con) {
    var f = con.split(':');
    if (f.length !== 2) return;
    out[f[0]] = f[1].split(';').map(function (poly) {
      return poly.split(',').map(Number).filter(function (i) { return i >= 0 && i < data.count; });
    }).filter(function (poly) { return poly.length > 1; });
  });
  return out;
})();

var roman = data.roman.split(';').map(function (row) {
  var f = row.split(',');
  return { raLo: parseFloat(f[0]), raHi: parseFloat(f[1]), decLo: parseFloat(f[2]), con: f[3] };
});

// Which constellation a direction (ra/dec of the given Julian day) lies in.
// Returns the IAU abbreviation. Roman's table is ordered so the first row
// whose band contains the point wins.
function constellationAt(ra, dec, jd) {
  var p = A.precess(ra, dec, jd, A.JD_B1875);
  var raH = p.ra / 15;
  for (var i = 0; i < roman.length; i++) {
    var r = roman[i];
    if (p.dec >= r.decLo && raH >= r.raLo && raH < r.raHi) return r.con;
  }
  return 'Oct';   // the south pole cap, which the table ends with
}

function constellationName(abbr) {
  return CONSTELLATIONS[abbr] || abbr;
}

// Stars precessed to the given day, cached per day.
var ofDate = null, ofDateDay = null;
function starsOfDate(jd) {
  var day = Math.floor(jd);
  if (ofDateDay === day) return ofDate;
  ofDate = catalog.map(function (s, i) {
    var p = A.precess(s.ra, s.dec, A.JD_J2000, jd);
    return { index: i, ra: p.ra, dec: p.dec, mag: s.mag, name: s.name };
  });
  ofDateDay = day;
  return ofDate;
}

// Stars within maxDeg of a direction (ra/dec of date), each with its
// separation. A cheap dot-product test, so it scans the whole catalog.
function starsNear(ra, dec, jd, maxDeg) {
  var cosMax = Math.cos(maxDeg * A.RAD);
  var sd = A.sind(dec), cd = A.cosd(dec);
  var out = [];
  starsOfDate(jd).forEach(function (s) {
    var c = sd * A.sind(s.dec) + cd * A.cosd(s.dec) * A.cosd(ra - s.ra);
    if (c >= cosMax) out.push({ star: s, sep: A.acosd(c) });
  });
  return out;
}

module.exports = {
  catalog: catalog,
  distances: distances,
  types: types,
  lines: lines,
  starsOfDate: starsOfDate,
  starsNear: starsNear,
  constellationAt: constellationAt,
  constellationName: constellationName,
  CONSTELLATIONS: CONSTELLATIONS
};
