// Learning how one person points (docs/DESIGN.md section 5.2).
//
// The compass calibration fixes the magnetometer, but it can't know how the
// watch sits on this wrist or the angle between this person's finger and
// forearm. For an aim at a known object, the finger offset (attitude.js)
// that would have put it dead on can be worked out; the median of the
// recent ones is the offset used for that wrist. A constant compass bias
// folds into the same offset.
//
// Samples come two ways:
// - Learned: any confident answer about the Moon, a planet or a star
//   (learnable()). Most people can't find Vega on request, but they do
//   point at things they want named, and a confident answer says what it
//   was. The aims come from all round the sky, so a compass error that
//   changes with direction averages out instead of being locked in.
// - Tune my aim: three aims at the Moon or a bright planet (things anyone
//   can find without naming stars), offered in the menu, never required;
//   or at whatever bright thing a CLOSEST card said was nearest the aim,
//   when the user says that was the one they meant (any of targets()).

var A = require('./astro.js');
var planets = require('./planets.js');
var moon = require('./moon.js');
var stars = require('./stars.js');
var attitude = require('./attitude.js');
var matcher = require('./matcher.js');

var NEEDED = 3;
var MIN_ALT = 15;      // lower is awkward to point at and blocked by houses and trees
var MAX_ALT = 65;      // higher tips the 12 o'clock edge up, where the compass gets worse
var SUN_KEEP_OUT = 30; // degrees from the Sun while it's light out
var MAX_MISS = 30;     // farther than this (with the default offset): pointing at something else.
                       // Generous, so a big personal offset (a watch worn turned on the
                       // strap, a steady compass bias) can still be tuned out.
var STAR_MAG = 1.5;    // Vega, Arcturus, Capella, Altair, Deneb, Fomalhaut ...

var DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// "low in the SE", "high in the W": enough to find the target.
function where(az, alt) {
  var d = DIRS[Math.round(A.rev(az) / 45) % 8];
  return (alt < 30 ? 'low in the ' : alt < 50 ? 'halfway up in the ' : 'high in the ') + d;
}

// Where an object is now: {az (true), alt (apparent)}, or null for an
// unknown id. Ids: 'moon', a planet id ('venus'), 'star:<catalog index>'.
function position(id, date, lat, lon) {
  if (id === 'moon') {
    var m = moon.moonAltAz(date, lat, lon);
    return { az: m.az, alt: m.alt };
  }
  if (/^star:\d+$/.test(id)) {
    var jd = A.julianDay(date);
    var s = stars.starsOfDate(jd)[+id.slice(5)];
    if (!s) return null;
    var h = A.eqToHorizon(s.ra, s.dec, jd, lat, lon);
    return { az: h.az, alt: h.alt + A.refraction(h.alt) };
  }
  var b = planets.bodies(date, lat, lon).filter(function (x) { return x.id === id && id !== 'sun'; })[0];
  return b ? { az: b.az, alt: b.alt } : null;
}

// Everything good to tune on right now, best first:
// [{id, name, label, type (matcher.TYPE), az, alt, where}]; label is the
// name the matcher gives it ("Moon"). sky: optional {bodies, moon} already
// worked out for this instant.
function targets(date, lat, lon, sky) {
  var bodies = sky && sky.bodies || planets.bodies(date, lat, lon);
  var sun = bodies[0];
  var out = [];
  function add(id, name, type, az, alt) {
    if (alt < MIN_ALT || alt > MAX_ALT) return;
    if (sun.alt > -6 && A.separation(az, alt, sun.az, sun.alt) < SUN_KEEP_OUT) return;
    out.push({ id: id, name: name, label: id === 'moon' ? 'Moon' : name, type: type, az: az, alt: alt,
               where: where(az, alt) });
  }
  var m = sky && sky.moon || moon.moonAltAz(date, lat, lon);
  if (m.illum >= 0.05) add('moon', 'the Moon', matcher.TYPE.MOON, m.az, m.alt);
  // By day no planet is easy to find; at dusk only the brightest.
  var planetMag = sun.alt < -6 ? 1 : sun.alt < -1 ? -1 : null;
  if (planetMag !== null) {
    bodies.slice(1).filter(function (b) { return b.mag <= planetMag; })
      .sort(function (a, b) { return a.mag - b.mag; })
      .forEach(function (b) { add(b.id, b.name, matcher.TYPE.PLANET, b.az, b.alt); });
  }
  if (sun.alt < -9) {
    var jd = A.julianDay(date);
    stars.starsOfDate(jd).filter(function (s) { return s.name && s.mag <= STAR_MAG; })
      .sort(function (a, b) { return a.mag - b.mag; })
      .forEach(function (s) {
        var h = A.eqToHorizon(s.ra, s.dec, jd, lat, lon);
        add('star:' + s.index, s.name, matcher.TYPE.STAR, h.az, h.alt + A.refraction(h.alt));
      });
  }
  return out;
}

// What to tune on now: preferId (a CLOSEST card's, which the user picked)
// while it's good to tune on; else the Moon; else the brightest planet
// (stars only by choice: most people can't find one by name); else null.
function pick(date, lat, lon, sky, preferId) {
  var all = targets(date, lat, lon, sky);
  var mine = preferId ? all.filter(function (t) { return t.id === preferId; })[0] : null;
  return mine || all.filter(function (t) { return t.type !== matcher.TYPE.STAR; })[0] || null;
}

// The tune id for a card's ref ('moon', a planet id, 'star:<index>'), or
// null for anything that can't be tuned on.
function idFor(ref) {
  if (!ref) return null;
  if (ref.kind === 'moon') return 'moon';
  if (ref.kind === 'planet') return ref.id;
  if (ref.kind === 'star' && typeof ref.index === 'number') return 'star:' + ref.index;
  return null;
}

// ---------------------------------------------------------------- learning

var POOL_MAX = 20;      // the most recent samples per wrist (a recalibrated compass moves on)
var POOL_MIN = 5;       // learned samples before the default offset is replaced ...
var POOL_MIN_MOON = 3;  // ... or this many with a Moon tune among them
var LEARN_P = 0.6;      // an answer this sure, about a fixed object, teaches
var LEARN_RIVAL = 0.2;  // ... unless the second answer is this likely (Altair or Tarazed?)
var LEARN_MAX_DEV = 10; // ... and its offset is within this of the one in use (aims spread about 4)

// Can this answer teach? cards: the matcher's, best first; raw: {cal};
// dir: attitude.aimDirection's result.
function learnable(cards, raw, dir) {
  var top = cards[0], next = cards[1];
  var T = matcher.TYPE;
  // Only what the user could see: an explicit layer also answers about
  // stars too faint or a sky too bright, and those aims say nothing.
  return !!top && raw.cal === 2 && !dir.rollTooFar && top.p >= LEARN_P && typeof top.az === 'number' &&
         top.visible === true &&
         (top.type === T.MOON || top.type === T.PLANET || top.type === T.STAR) &&
         !(next && next.p >= LEARN_RIVAL);
}

// A sample from an aim at (az, alt apparent), or null if it's too far from
// the offset in use to trust (a wrong answer would pull the offset off).
// raw: {head, accel, wrist, decl}.
function sample(raw, az, alt, inUse, src, t) {
  var f = attitude.fingerFor(raw.head, raw.accel, raw.wrist, raw.decl, az, alt);
  if (A.separation(f.yaw, f.pitch, inUse.yaw, inUse.pitch) > LEARN_MAX_DEV) return null;
  return { yaw: Math.round(f.yaw * 100) / 100, pitch: Math.round(f.pitch * 100) / 100,
           az: Math.round(az), t: t, src: src };
}

function addToPool(pool, s) {
  var out = (pool || []).concat([s]);
  return out.slice(Math.max(0, out.length - POOL_MAX));
}

// The offset a pool gives, or null while it's too small to trust. Sample
// src: 'auto' (learned), 'moon' (a Moon tune that beat what there was, so
// the pool restarted from it) or 'moon+' (a Moon tune that didn't, joined
// in like learned ones).
function poolOffset(pool) {
  pool = (pool || []).filter(function (s) { return s && isFinite(s.yaw) && isFinite(s.pitch); });
  var moonN = pool.filter(function (s) { return s.src === 'moon'; }).length;
  if (pool.length < POOL_MIN && !(moonN && pool.length >= POOL_MIN_MOON)) return null;
  return fit(pool);
}

// One aim at the target. raw: {head (degrees as reported), accel {x, y,
// z}, wrist, decl, cal}; tgt: {az, alt}. Returns {sample} or {reject: the
// note for the watch}.
function measure(raw, tgt, name) {
  if (raw.cal !== 2) return { reject: 'Compass not ready: draw an 8' };
  var def = attitude.aimDirection(raw.head, raw.accel, raw.wrist, raw.decl);
  if (def.rollTooFar) return { reject: 'Turn the watch face up more' };
  var miss = A.separation(def.az, def.alt, tgt.az, tgt.alt);
  if (!(miss <= MAX_MISS)) return { reject: 'Too far from ' + name };
  var f = attitude.fingerFor(raw.head, raw.accel, raw.wrist, raw.decl, tgt.az, tgt.alt);
  return { sample: { raw: raw, tgt: tgt, yaw: f.yaw, pitch: f.pitch } };
}

function median(a) {
  var s = a.slice().sort(function (x, y) { return x - y; });
  var n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function fit(samples) {
  return { yaw: median(samples.map(function (s) { return s.yaw; })),
           pitch: median(samples.map(function (s) { return s.pitch; })) };
}

function missWith(s, finger) {
  var d = attitude.aimDirection(s.raw.head, s.raw.accel, s.raw.wrist, s.raw.decl, finger);
  return A.separation(d.az, d.alt, s.tgt.az, s.tgt.alt);
}

// The new offset, and how far off the aims were before (with the offset in
// use until now) and would be after. "After" leaves each aim out of its
// own fit, so it isn't flattered by the aims it was fitted to.
function finish(samples, before) {
  var finger = fit(samples);
  var was = median(samples.map(function (s) { return missWith(s, before); }));
  var now = median(samples.map(function (s, i) {
    return missWith(s, fit(samples.filter(function (x, j) { return j !== i; })));
  }));
  return { finger: { yaw: Math.round(finger.yaw * 10) / 10, pitch: Math.round(finger.pitch * 10) / 10 },
           before: was, after: now };
}

module.exports = { NEEDED: NEEDED, POOL_MAX: POOL_MAX, POOL_MIN: POOL_MIN, LEARN_MAX_DEV: LEARN_MAX_DEV,
                   learnable: learnable, sample: sample, addToPool: addToPool, poolOffset: poolOffset,
                   targets: targets, pick: pick, idFor: idFor, position: position, where: where,
                   measure: measure, fit: fit, finish: finish, missWith: missWith, median: median };
