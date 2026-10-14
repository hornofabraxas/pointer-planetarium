// Scenarios for src/pkjs/matcher.js on the real sky over Phoenix.
// Run: node test/matcher.test.js
var A = require('../src/pkjs/astro.js');
var planets = require('../src/pkjs/planets.js');
var moon = require('../src/pkjs/moon.js');
var stars = require('../src/pkjs/stars.js');
var M = require('../src/pkjs/matcher.js');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

var LAT = 33.45, LON = -112.07;
function skyAt(date, skySetting) {
  var bodies = planets.bodies(date, LAT, LON);
  return { jd: A.julianDay(date), lat: LAT, lon: LON, sunAlt: bodies[0].alt,
           sky: skySetting || 'suburbs', bodies: bodies, moon: moon.moonAltAz(date, LAT, LON) };
}
function starPos(name, sky) {
  var s = stars.starsOfDate(sky.jd).filter(function (x) { return x.name === name; })[0];
  var h = A.eqToHorizon(s.ra, s.dec, sky.jd, LAT, LON);
  return { az: h.az, alt: h.alt + A.refraction(h.alt) };
}
function aimAt(pos, layer, sigma) {
  return { az: pos.az, alt: pos.alt, sigma: sigma || 5, layer: layer || 0, rollTooFar: false };
}
function summary(r) {
  return r.cards.map(function (c) { return c.l1 + ' ' + Math.round((c.p || 0) * 100) + '%'; }).join(' | ');
}

// 2026-10-08 03:30 UTC = 8:30 pm in Phoenix: dark, Vega high in the west.
var night = new Date(Date.UTC(2026, 9, 8, 3, 30));
var sky = skyAt(night);
check('night: Sun well down', sky.sunAlt < -12, sky.sunAlt.toFixed(1));

var vega = starPos('Vega', sky);
var r = M.match(aimAt(vega), sky);
check('aim at Vega: Vega first', r.cards[0].l1 === 'Vega', summary(r));
check('Vega card says Lyra', r.cards[0].l2 === 'in Lyra');
check('Vega confident', r.cards[0].word === M.WORD.THATS || r.cards[0].word === M.WORD.PROBABLY);
check('no hint when right on it', r.cards[0].hint === '');

// 4 degrees off to one side, Vega still wins and the hint points to it.
var off = { az: vega.az + 4 / A.cosd(vega.alt), alt: vega.alt };
r = M.match(aimAt(off), sky);
check('4 deg right of Vega: still Vega', r.cards[0].l1 === 'Vega', summary(r));
check('hint points left', /left/.test(r.cards[0].hint), r.cards[0].hint);

// Every visible planet, aimed at directly, is the first answer.
sky.bodies.slice(1).forEach(function (b) {
  if (b.alt < 10) return;
  var limit = M.limitingMag(sky.sunAlt, sky.sky);
  if (b.mag > limit) return;
  var res = M.match(aimAt({ az: b.az, alt: b.alt }), sky);
  check('aim at ' + b.name + ': ' + b.name + ' first', res.cards[0].l1 === b.name, summary(res));
});

// Under a city sky (stars to mag 3.5), find a direction above 30 deg with
// no visible star, planet or Moon within the 12 deg search radius: nothing
// may be claimed there.
var city = skyAt(night, 'city');
var limit = M.limitingMag(city.sunAlt, 'city');
var empty = null;
for (var az = 0; az < 360 && !empty; az += 3) {
  for (var alt = 30; alt <= 80 && !empty; alt += 3) {
    var eq = A.horizonToEq(az, A.unrefract(alt), city.jd, LAT, LON);
    var near = stars.starsNear(eq.ra, eq.dec, city.jd, 13).filter(function (n) { return n.star.mag <= limit; });
    var bodiesNear = city.bodies.concat([city.moon]).some(function (o) {
      return o.alt > 0 && A.separation(az, alt, o.az, o.alt) < 15;
    });
    if (!near.length && !bodiesNear) empty = { az: az, alt: alt };
  }
}
check('found an empty patch to test with', !!empty, empty && empty.az + '/' + empty.alt);
r = M.match(aimAt(empty), city);
check('empty patch (ANYTHING): nothing claimed', r.cards[0].type === M.TYPE.NOTHING, summary(r));
check('empty patch names the constellation at night', /^Pointing into /.test(r.cards[0].l3), r.cards[0].l3);
r = M.match(aimAt(empty, M.LAYER.STARS), city);
check('empty patch (STARS): constellation card first', r.cards[0].type === M.TYPE.CONSTELLATION ||
      /^(Hard to see now|Try binoculars|Needs a telescope)$/.test(r.cards[0].l3), summary(r));

// Layers filter.
r = M.match(aimAt(vega, M.LAYER.PLANETS), sky);
check('PLANETS layer ignores Vega', r.cards.every(function (c) { return c.type !== M.TYPE.STAR; }), summary(r));

// Below the horizon: nothing.
r = M.match(aimAt({ az: 90, alt: -30 }), sky);
check('below the horizon: nothing', r.cards[0].type === M.TYPE.NOTHING, summary(r));

// Rolled wrist: coaching card, not a guess.
r = M.match({ az: 10, alt: 30, sigma: 5, layer: 0, rollTooFar: true }, sky);
check('roll too far: turn your hand', /Turn your hand/.test(r.cards[0].l1));

// Probabilities are sane and sorted.
r = M.match(aimAt(vega), sky);
var ps = r.cards.map(function (c) { return c.p; });
check('probabilities in (0,1], sorted, at most 5 cards',
      ps.every(function (p) { return p > 0 && p <= 1; }) &&
      ps.every(function (p, i) { return i === 0 || p <= ps[i - 1]; }) && ps.length <= 5, ps.join(','));

// Daytime: aiming near the Sun warns first. 2026-10-08 19:00 UTC = noon.
var day = skyAt(new Date(Date.UTC(2026, 9, 8, 19, 0)));
var sun = day.bodies[0];
r = M.match(aimAt({ az: sun.az + 5, alt: sun.alt }), day);
check('near the Sun: warning card first', r.cards[0].type === M.TYPE.SUN, summary(r));
check('day: stars not offered in ANYTHING', M.match(aimAt({ az: 0, alt: 40 }), day).cards.every(function (c) {
  return c.type !== M.TYPE.STAR;
}));

// The Moon wins when aimed at, whatever the time.
for (var h = 0; h < 30; h++) {
  var t = new Date(Date.UTC(2026, 9, 15) + h * 3600 * 1000 * 7.3);
  var s2 = skyAt(t);
  if (s2.moon.alt < 15) continue;
  r = M.match(aimAt({ az: s2.moon.az, alt: s2.moon.alt }), s2);
  check('aim at the Moon ' + t.toISOString().slice(0, 13), r.cards.some(function (c) {
    return c.type === M.TYPE.MOON && c.word === M.WORD.THATS;
  }), summary(r));
  break;
}

// ---------------------------------------------------------------- satellites

// Synthetic satellites in the night sky above (positions as
// satellites.positions returns them).
function satAt(pos, extra) {
  var o = { type: 'sat', id: 1, name: 'X', az: pos.az, altTrue: A.unrefract(pos.alt), alt: pos.alt,
            rangeKm: 600, heightKm: 420, lit: true, mag: 2, sigmaObj: 0.5, l1: 'Satellite X',
            l2: 'Satellite', l3: '260 mi up, going NE', cluster: null, clusterSize: 1, train: null };
  for (var k in extra) o[k] = extra[k];
  return o;
}
function withSats(base, sats, hidden) {
  var c = {};
  for (var k in base) c[k] = base[k];
  c.sats = sats;
  c.satHidden = !!hidden;
  return c;
}
var spot = { az: 140, alt: 45 };   // pick a patch of sky and keep the stars out of it
var nsky = withSats(sky, [satAt(spot, { id: 25544, l1: 'Space Station', l2: 'The ISS', mag: -3.5 })]);
r = M.match(aimAt(spot, M.LAYER.SATELLITES), nsky);
check('aim at the ISS (SATELLITES): Space Station, sure', r.cards[0].l1 === 'Space Station' &&
      r.cards[0].type === M.TYPE.SATELLITE && r.cards[0].word === M.WORD.THATS, summary(r));
r = M.match(aimAt(spot), nsky);
check('aim at the ISS (ANYTHING): Space Station first', r.cards[0].l1 === 'Space Station', summary(r));
check('SATELLITES layer status counts the ISS', M.layerStatus(nsky)[2] === 'Space Station is up!',
      M.layerStatus(nsky)[2]);

// A train: 8 lit members a degree apart, one cluster -> one card.
var train = [];
for (var i = 0; i < 8; i++) {
  train.push(satAt({ az: spot.az + (i - 4) / A.cosd(spot.alt), alt: spot.alt }, {
    id: 100 + i, l1: 'Starlink ' + i, mag: 3, train: 'Starlink', cluster: 'T#0', clusterSize: 8 }));
}
r = M.match(aimAt(spot), withSats(sky, train));
check('a train is one card', r.cards.filter(function (c) { return /train/.test(c.l1); }).length === 1 &&
      r.cards[0].l1 === 'Starlink train' && r.cards[0].l2 === '8 satellites in a row', summary(r));
check('the train counts once in the status', M.layerStatus(withSats(sky, train))[2] === '1 satellite up',
      M.layerStatus(withSats(sky, train))[2]);

// In the Earth's shadow: invisible.
var dark = [satAt(spot, { lit: false })];
r = M.match(aimAt(spot), withSats(sky, dark));
check('shadowed satellite not offered in ANYTHING', r.cards.every(function (c) {
  return c.type !== M.TYPE.SATELLITE;
}), summary(r));
r = M.match(aimAt(spot, M.LAYER.SATELLITES), withSats(sky, dark));
check('... nor in SATELLITES by default', r.cards[0].type === M.TYPE.NOTHING, summary(r));
r = M.match(aimAt(spot, M.LAYER.SATELLITES), withSats(sky, dark, true));
check('... but shown, labelled, with "show hidden" on', r.cards[0].type === M.TYPE.SATELLITE &&
      r.cards[0].l3 === "In Earth's shadow", summary(r));

// Daytime: no satellites to see, and the card says why.
var daySats = withSats(day, [satAt({ az: 0, alt: 50 })]);
r = M.match(aimAt({ az: 0, alt: 50 }, M.LAYER.SATELLITES), daySats);
check('day, SATELLITES: nothing, try after dark', r.cards[0].type === M.TYPE.NOTHING &&
      r.cards[0].l3 === 'Try again after dark', summary(r));
check('day status: after dark', M.layerStatus(daySats)[2] === 'Satellites after dark');
r = M.match(aimAt({ az: 0, alt: 50 }, M.LAYER.SATELLITES), withSats(day, null));
check('no data: says so', r.cards[0].l3 === 'No satellite data yet', summary(r));
check('no data status line', M.layerStatus(withSats(sky, null))[2] === 'No satellite data yet');

// A faint satellite near a bright star doesn't steal it.
var nearVega = withSats(sky, [satAt({ az: vega.az + 3 / A.cosd(vega.alt), alt: vega.alt }, { mag: 4 })]);
r = M.match(aimAt(vega), nearVega);
check('faint satellite 3 deg from Vega: Vega still first', r.cards[0].l1 === 'Vega', summary(r));

// A satellite with a big position error is less sure than a sharp one at
// the same miss.
var sharp = M.match(aimAt({ az: spot.az + 3 / A.cosd(spot.alt), alt: spot.alt }, M.LAYER.SATELLITES),
                    withSats(sky, [satAt(spot, { sigmaObj: 0.3 })]));
var fuzzy = M.match(aimAt({ az: spot.az + 3 / A.cosd(spot.alt), alt: spot.alt }, M.LAYER.SATELLITES),
                    withSats(sky, [satAt(spot, { sigmaObj: 6 })]));
check('position error lowers confidence', sharp.cards[0].p > fuzzy.cards[0].p,
      sharp.cards[0].p.toFixed(2) + ' vs ' + fuzzy.cards[0].p.toFixed(2));

// A moving thing's line: its speed and which way it crosses the sky, in
// place of where to look (stale by the time it shows).
var mh = M.motionHint;
check('motion: speed and way', mh(214, { dx: 0.3, dy: 0.01 }, 'imperial') === '480 mph, moving right' &&
      mh(7660, { dx: -0.5, dy: 0.6 }, 'imperial') === '17,100 mph, moving up-left' &&
      mh(214, { dx: 0, dy: -0.2 }, 'metric') === '770 km/h, moving down' &&
      mh(null, { dx: -1, dy: 0 }, 'imperial') === 'Moving left' && mh(214, null, 'imperial') === '480 mph' &&
      mh(null, null) === '' && mh(3, { dx: 0, dy: 0 }) === '10 mph',
      [mh(214, { dx: 0.3, dy: 0.01 }, 'imperial'), mh(7660, { dx: -0.5, dy: 0.6 }, 'imperial'),
       mh(214, { dx: 0, dy: -0.2 }, 'metric'), mh(null, { dx: -1, dy: 0 }), mh(214, null)].join(' | '));
check('the longest motion line fits the watch\'s 30 bytes', mh(7660, { dx: 1, dy: -1 }, 'metric').length <= 30 &&
      mh(7660, { dx: 1, dy: -1 }, 'imperial').length <= 30, mh(7660, { dx: 1, dy: -1 }, 'metric'));

if (failures) {
  console.log(failures + ' FAILED');
  process.exit(1);
}
console.log('PASS');
