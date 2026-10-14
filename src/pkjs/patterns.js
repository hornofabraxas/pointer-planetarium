// Constellations for Find it (the watch's "Constellations"): the shapes
// people go looking for, as stick figures through catalog stars. Some are
// whole constellations (Orion, Leo, Cassiopeia: their own stick figure
// from the catalog, or drawn here); the rest are asterisms, shapes within
// a constellation or across several (the Big Dipper, Orion's Belt, the
// Summer Triangle), drawn here and captioned so: "Part of Ursa Major".
//
// A star is named (IAU) or, where it has no name, given by its J2000
// RA/Dec in degrees; either way it's looked up in the catalog once, the
// brightest star within MATCH_DEG of the place. The figures are written for
// this app; the coordinates are the stars' catalog places.
//
// Each pattern: {id, name (short: the watch's list), lines ([[star, ...]],
// each drawn without lifting the pen), or con (a constellation's own
// figure), whole (a constellation drawn here: lines are its figure),
// seeMag (optional: the magnitude to see to make it out, when "most of
// its stars" is the wrong rule, as for a cluster), caption (optional:
// under its chart; else "A constellation", or the one it's part of)}.

var A = require('./astro.js');
var stars = require('./stars.js');

var MATCH_DEG = 0.3;
var MOST = 0.75;            // the shape can be made out once this share of its stars can

var LIST = [
  { id: 'bigdipper', name: 'Big Dipper',
    lines: [['Alkaid', 'Mizar', 'Alioth', 'Megrez', 'Dubhe', 'Merak', 'Phecda', 'Megrez']] },
  { id: 'littledipper', name: 'Little Dipper',
    lines: [['Polaris', 'Yildun', [251.4925, 82.0373], [236.0146, 77.7945], 'Kochab', 'Pherkad',
             [244.3763, 75.7553], [236.0146, 77.7945]]] },
  { id: 'belt', name: "Orion's Belt", lines: [['Alnitak', 'Alnilam', 'Mintaka']] },
  // Its seven bright stars make the shape; the catalog's figure has more.
  { id: 'orion', name: 'Orion', con: 'Ori', seeMag: 2.2, caption: 'The Hunter' },
  { id: 'cassiopeia', name: 'Cassiopeia', whole: true, caption: 'The Queen',
    lines: [['Caph', 'Schedar', [14.1772, 60.7167], 'Ruchbah', 'Segin']] },
  { id: 'summer', name: 'Summer Triangle', lines: [['Vega', 'Deneb', 'Altair', 'Vega']],
    caption: 'Vega, Deneb and Altair' },
  { id: 'winter', name: 'Winter Triangle', lines: [['Betelgeuse', 'Procyon', 'Sirius', 'Betelgeuse']],
    caption: 'Betelgeuse, Procyon, Sirius' },
  // A small dipper of stars; as a group it shows long before its faint
  // members do.
  { id: 'pleiades', name: 'Pleiades', seeMag: 3.7,
    lines: [['Pleione', 'Atlas', 'Alcyone', 'Merope', 'Electra', 'Maia', 'Alcyone'], ['Maia', 'Taygeta']] },
  { id: 'square', name: 'Great Square', lines: [['Markab', 'Scheat', 'Alpheratz', 'Algenib', 'Markab']] },
  { id: 'cross', name: 'Northern Cross', lines: [['Deneb', 'Sadr', 'Albireo'], ['Fawaris', 'Sadr', 'Aljanah']] },
  { id: 'scorpius', name: 'Scorpius', con: 'Sco', caption: 'The Scorpion' },
  // Alnasl, Kaus Media, Kaus Borealis, phi, Nunki, tau, Ascella, Kaus
  // Australis: spout, lid, handle and body.
  { id: 'teapot', name: 'The Teapot',
    lines: [['Alnasl', [275.2485, -29.8281], [276.9927, -25.4217], [281.4141, -26.9908], 'Nunki',
             [286.7350, -27.6704], 'Ascella', [276.0430, -34.3847], 'Alnasl'],
            [[275.2485, -29.8281], [281.4141, -26.9908], 'Ascella'],
            [[275.2485, -29.8281], [276.0430, -34.3847]]] },
  // Regulus, eta, Algieba, Adhafera, Rasalas, epsilon: a backwards
  // question mark.
  { id: 'sickle', name: 'The Sickle',
    lines: [['Regulus', [151.8331, 16.7627], 'Algieba', 'Adhafera', 'Rasalas', [146.4629, 23.7743]]] },
  // Aldebaran and the Hyades: theta-2, gamma, delta-1, epsilon.
  { id: 'hyades', name: 'V of Taurus',
    lines: [['Aldebaran', 'Chamukuy', [64.9483, 15.6276], [65.7337, 17.5425], 'Ain']] },
  // theta, beta, alpha, gamma, delta, epsilon, iota.
  { id: 'crown', name: 'Northern Crown', whole: true, caption: 'Corona Borealis',
    lines: [[[233.2324, 31.3592], 'Nusakan', 'Alphecca', [235.6857, 26.2956], [237.3985, 26.0684],
             [239.3971, 26.8779], [240.3609, 29.8511]]] },
  { id: 'southerncross', name: 'Southern Cross', whole: true, caption: 'Crux',
    lines: [['Acrux', 'Gacrux'], ['Mimosa', 'Imai']] },
  // Whole constellations, as the catalog draws them.
  { id: 'ursamajor', name: 'Ursa Major', con: 'UMa', caption: 'The Great Bear' },
  { id: 'leo', name: 'Leo', con: 'Leo', caption: 'The Lion' },
  { id: 'cygnus', name: 'Cygnus', con: 'Cyg', caption: 'The Swan' },
  { id: 'lyra', name: 'Lyra', con: 'Lyr', caption: 'The Lyre' },
  { id: 'aquila', name: 'Aquila', con: 'Aql', caption: 'The Eagle' },
  { id: 'bootes', name: 'Bootes', con: 'Boo', caption: 'The Herdsman' },
  { id: 'gemini', name: 'Gemini', con: 'Gem', caption: 'The Twins' },
  { id: 'taurus', name: 'Taurus', con: 'Tau', caption: 'The Bull' },
  { id: 'canismajor', name: 'Canis Major', con: 'CMa', caption: 'The Great Dog' },
  { id: 'auriga', name: 'Auriga', con: 'Aur', caption: 'The Charioteer' }
];

var byName = null;

// The catalog index of a star given by name or [ra, dec] (J2000), or -1.
function resolve(s) {
  if (!byName) {
    byName = {};
    stars.catalog.forEach(function (c, i) { if (c.name) byName[c.name] = i; });
  }
  if (typeof s === 'string') return s in byName ? byName[s] : -1;
  var best = -1;
  stars.catalog.forEach(function (c, i) {
    if (A.separation(c.ra, c.dec, s[0], s[1]) <= MATCH_DEG && (best < 0 || c.mag < stars.catalog[best].mag)) best = i;
  });
  return best;
}

var resolved = null;

// The patterns with their figures as catalog indices: [{id, name, lines
// ([[index, ...]]), members ([index]), seeMag, caption, con, whole (a
// constellation, not an asterism)}], worked out once.
function all() {
  if (resolved) return resolved;
  resolved = LIST.map(function (p) {
    var lines = p.con ? (stars.lines[p.con] || []) : p.lines.map(function (poly) { return poly.map(resolve); });
    var members = [];
    lines.forEach(function (poly) {
      poly.forEach(function (i) { if (i >= 0 && members.indexOf(i) < 0) members.push(i); });
    });
    var mags = members.map(function (i) { return stars.catalog[i].mag; }).sort(function (a, b) { return a - b; });
    var seeMag = p.seeMag !== undefined ? p.seeMag : mags[Math.max(0, Math.ceil(MOST * mags.length) - 1)];
    return { id: p.id, name: p.name, lines: lines, members: members, seeMag: seeMag, caption: p.caption || null,
             con: p.con || null, whole: !!(p.con || p.whole) };
  });
  return resolved;
}

function byId(id) {
  return all().filter(function (p) { return p.id === id; })[0] || null;
}

// Where a pattern is on the given day and place: its middle (RA/Dec of
// date, az/alt apparent), its size (degrees from the middle to its
// farthest star), the share of its stars above minAlt, and the caption.
function place(p, jd, lat, lon, minAlt) {
  var ofDate = stars.starsOfDate(jd);
  var sum = [0, 0, 0];
  p.members.forEach(function (i) {
    var s = ofDate[i];
    sum[0] += A.cosd(s.dec) * A.cosd(s.ra);
    sum[1] += A.cosd(s.dec) * A.sind(s.ra);
    sum[2] += A.sind(s.dec);
  });
  var n = Math.sqrt(sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]);
  var ra = A.rev(A.atan2d(sum[1], sum[0])), dec = A.asind(sum[2] / n);
  var h = A.eqToHorizon(ra, dec, jd, lat, lon);
  var size = 0, up = 0;
  p.members.forEach(function (i) {
    var s = ofDate[i];
    size = Math.max(size, A.separation(s.ra, s.dec, ra, dec));
    if (A.eqToHorizon(s.ra, s.dec, jd, lat, lon).alt >= minAlt) up++;
  });
  var caption = p.caption ||
                (p.whole ? 'A constellation' : 'Part of ' + stars.constellationName(stars.constellationAt(ra, dec, jd)));
  return { ra: ra, dec: dec, az: h.az, altTrue: h.alt, alt: h.alt + A.refraction(h.alt), size: size,
           up: up / p.members.length, caption: caption };
}

module.exports = { all: all, byId: byId, place: place, resolve: resolve, LIST: LIST, MATCH_DEG: MATCH_DEG };
