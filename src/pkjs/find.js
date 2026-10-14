// Find it: the things worth finding right now, and how the watch is told
// where they are. The watch works out where its top points as it moves and
// steers you there on two tapes (main.c), so it needs each target's place
// in the sky and the few numbers that turn its sensors into a direction
// (the sky frame), but nothing streams: one list per pick.
//
// What's offered: the Moon, the planets, star patterns (patterns.js: the
// Big Dipper, Orion's Belt), the brightest named stars that are up, and
// the brightest satellites (the Space Station, Tiangong, Hubble, a train
// of new satellites) during a visible pass, and the next visible pass of
// the Space Station, Tiangong and Hubble when they aren't up (the watch
// points at where it will rise and counts down, then follows it), each
// and the Moon from just above the horizon (it's big and bright: a thin
// crescent low in the west after sunset is a sight), or when it's down,
// where and when it next rises (like a pass: the watch counts down), each
// marked with how it can be seen (matcher.seeing: by eye, by eye knowing
// just where, binoculars, a telescope); the "Find it shows" setting says
// how far down that goes. A pattern is offered only to the eye, and found
// by its brightest star that's up (its anchor: "Vega, high in the W"),
// which its chart circles. While the Sun is up, nothing is
// found within SUN_EYE degrees of it, nor anything that needs binoculars
// or a telescope within SUN_AIDED (they stay on the list, marked, so you
// know why); by eye, closer than SUN_AIDED, it comes with "Block the Sun
// first!".
//
// A few are marked BEST: the watch opens on those ("Best now") with a
// "More" row under them that goes to the rest, by kind.
//
// FIND_LIST (bytes, little-endian):
//   [0] version (4), [1..4] the phone's time (Unix seconds), [5] n targets
//   per target: id, type (matcher.TYPE), kind (0 fixed, 1 moving),
//     see (bits 0-1 matcher.SEE, SEE_BLOCK_SUN, SEE_NEAR_SUN),
//     extra (bit 7 BEST; bits 0-6 how near counts as on it, degrees: 0
//       for the watch's own),
//     name, where, note (each a length byte + text; note: a satellite's
//       next pass after this one, or empty), then
//     kind 0: RA u16 (of 360 degrees in 65536), Dec i16 (centidegrees)
//     kind 1: start u16 (seconds after the phone's time: 0 for one up
//             now), step (s), m points, m x {az u16 (of 360 in 65536),
//             alt i16 (apparent, centidegrees)}
//   then the Sun: RA u16, Dec i16
// SKY_FRAME (bytes, little-endian): lat i32, lon i32 (degrees x 1e5),
//   declination i16, then for the left and the right wrist the finger
//   offset yaw i16 and pitch i16 (centidegrees), then the sky (bits 0-3:
//   0 city, 1 suburbs, 2 dark) and what Find it shows (bits 4-5: SHOW).

var A = require('./astro.js');
var planets = require('./planets.js');
var moon = require('./moon.js');
var stars = require('./stars.js');
var matcher = require('./matcher.js');
var satellites = require('./satellites.js');
var tune = require('./tune.js');
var patterns = require('./patterns.js');

var SEE = matcher.SEE;
var MAX_TARGETS = 28;      // main.c FIND_MAX
var MAX_PATTERNS = 10;
var MAX_MOVING = 2;        // satellites up now, each with its path (main.c FIND_TRACK_MAX) ...
var PASS_IDS = [25544, 48274, 20580];   // ... and the next pass of each of these (ISS, Tiangong, Hubble)
var PASS_HOURS = 24;       // looked for this far ahead ...
var PASS_START_MAX_S = 65535;   // ... but one to find starts within this (the watch's start is 16 bits)
var PASS_PTS = 24;         // points along a pass
var PASS_BEST_S = 20 * 60; // a pass this soon can be Best now
var LIST_BYTES = 1700;     // FIND_LIST at most: it shares the watch's 2,048-byte inbox with the frame
var BEST_N = 5;            // "Best now"
var MIN_ALT = 8;           // lower is behind houses and trees
var MOON_ALT = 2;          // ... but not the Moon
var MOON_STEP_S = 240;     // a rising Moon's path: a point every 4 minutes ...
var MOON_PTS = 24;         // ... for an hour and a half (main.c FIND_TRACK_MAX has room)
var PATTERN_ALT = 12;      // a pattern's middle at least this high ...
var PATTERN_UP = 0.75;     // ... and this share of its stars above MIN_ALT
var TRAIN_MIN = 3;         // satellites in a row to count as a train worth finding
var STAR_MAG = 2.1;        // the brightest named stars (Polaris just makes it)
var SUN_UP = -2;           // the Sun counts as up above this (apparent; a margin for refraction)
var SUN_EYE = 15;          // degrees: never find anything closer to the Sun than this
var SUN_AIDED = 30;        // ... nor anything for binoculars or a telescope closer than this
var SEE_BLOCK_SUN = 4;     // see byte: by eye, but near the Sun: block it first
var SEE_NEAR_SUN = 8;      // ... too near the Sun to find
// What Find it shows (the setting): the kinds of seeing it goes down to.
// The wire code is the setting's index, binoculars first (0, the default).
var SHOW = ['binoculars', 'eye', 'all'];
var SHOW_MAX = { eye: SEE.CLOSE, binoculars: SEE.BINOCULARS, all: SEE.TELESCOPE };
var ISS = 25544;
var BEST = 0x80;           // the extra byte's BEST bit
var TRACK_STEP_S = 3;
var TRACK_S = 180;
var NAME_MAX = 24, WHERE_MAX = 28, NOTE_MAX = 32;
// Where it is fits one line of the watch's list (main.c draws it on one
// line, cut short with "..." past that, 180 pixels): about how wide a
// string is in its font (Gothic 24 Bold), from screenshots ("halfway up in
// the SE" is 149 pixels, "7:42 pm, SW to NE, high" 173), with a little to
// spare.
var WHERE_FIT_PX = 176;
var NARROW = { i: 4, l: 4, j: 4, I: 4, ' ': 5, ',': 4, ':': 4, '.': 4, "'": 3, f: 6, t: 6, r: 6, '-': 6 };
var WIDE = { m: 13, w: 12, M: 13, W: 15, h: 9, n: 9, u: 9, p: 9, b: 9, d: 9, g: 9, q: 9, o: 9, E: 8, S: 9 };
function textPx(s) {
  var px = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    px += NARROW[c] || WIDE[c] || (/[0-9a-z]/.test(c) ? (c >= 'a' ? 8 : 9) : 10);
  }
  return px;
}
function fits(s) {
  return textPx(s) <= WHERE_FIT_PX;
}
var SKY_CODE = { city: 0, suburbs: 1, dark: 2 };
var where = tune.where;
var DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function dir8(az) {
  return DIRS[Math.round(A.rev(az) / 45) % 8];
}

// s and then more, if that still fits one line.
function fitWhere(s, more) {
  return fits(s + more) ? s + more : s;
}

// "7:42 pm" (h12) or "19:42", the phone's time.
function clock(ms, h12) {
  var d = new Date(ms);
  var h = d.getHours(), m = ('0' + d.getMinutes()).slice(-2);
  return h12 ? (h % 12 || 12) + ':' + m + (h < 12 ? ' am' : ' pm') : h + ':' + m;
}

// The targets for now: [{id, type, kind, see, give, best, name, label
// (the matcher's name), where, ra, dec | track [{az, alt}], satId, az,
// alt}], easiest first, the ones too near the Sun last (by kind: the Moon,
// planets, satellites, patterns, stars); plus the Sun. sky: {bodies, moon,
// sky (the sky setting)}; satCat: the satellite catalog
// (satellites.catalog), or null; show: SHOW (default binoculars).
function targets(date, here, sky, satCat, units, show) {
  var jd = A.julianDay(date);
  var lat = here.lat, lon = here.lon;
  var bodies = sky.bodies;
  var sun = bodies[0];
  var most = SHOW_MAX[show] === undefined ? SHOW_MAX.binoculars : SHOW_MAX[show];
  var out = [];
  // The see byte for something at (az, alt) seen as `how`, or null if it
  // isn't offered.
  function seeByte(how, az, alt, minAlt, sunAt) {
    var s = sunAt || sun;
    if (how === null || how > most || alt < (minAlt === undefined ? MIN_ALT : minAlt)) return null;
    if (s.alt <= SUN_UP) return how;
    var d = A.separation(az, alt, s.az, s.alt);
    if (d < SUN_EYE || (d < SUN_AIDED && how >= SEE.BINOCULARS)) return how | SEE_NEAR_SUN;
    return d < SUN_AIDED ? how | SEE_BLOCK_SUN : how;
  }
  function fixed(id, type, name, see, az, altTrue, alt, mag) {
    var eq = A.horizonToEq(az, altTrue, jd, lat, lon);
    out.push({ id: id, type: type, kind: 0, see: see, give: 0, name: name, label: name, where: where(az, alt),
               ra: eq.ra, dec: eq.dec, az: az, alt: alt, mag: mag });
  }
  var m = sky.moon;
  var mSee = seeByte(matcher.moonSeeing(m, sun.alt, sky.sky), m.az, m.alt, MOON_ALT);
  if (mSee !== null) fixed('moon', matcher.TYPE.MOON, 'The Moon', mSee, m.az, m.altTrue, m.alt, m.mag);
  else if (m.alt < MOON_ALT) {
    var rise = moonRise(date, here, units);
    if (rise) {
      var rSee = seeByte(matcher.moonSeeing(rise.moon, rise.sun.alt, sky.sky), rise.moon.az, rise.moon.alt, 0,
                         rise.sun);
      if (rSee !== null && !(rSee & SEE_NEAR_SUN)) {
        rise.target.see = rSee;
        out.push(rise.target);
      }
    }
  }
  bodies.slice(1).sort(function (a, b) { return a.mag - b.mag; }).forEach(function (b) {
    var see = seeByte(matcher.seeing(b.mag, b.alt, sun.alt, sky.sky), b.az, b.alt);
    if (see !== null) fixed(b.id, matcher.TYPE.PLANET, b.name, see, b.az, b.altTrue, b.alt, b.mag);
  });
  var up = satTargets(date, here, sun, satCat, units, sky.sky, most);
  out = out.concat(up, passTargets(date, here, satCat, units, sky.sky, most, up));
  var pats = [];
  var ofDate = stars.starsOfDate(jd);
  patterns.all().forEach(function (p, order) {
    var at = patterns.place(p, jd, lat, lon, MIN_ALT);
    if (at.alt < PATTERN_ALT || at.up < PATTERN_UP) return;
    var how = matcher.seeing(p.seeMag, at.alt, sun.alt, sky.sky);
    if (how > SEE.CLOSE) return;   // a shape is for the eye
    var see = seeByte(how, at.az, at.alt);
    if (see === null) return;
    // Found by its brightest star that's up: one point to steer to, and
    // circled on its chart.
    var anchor = null;
    p.members.forEach(function (i) {
      var st = ofDate[i];
      if (!st) return;
      var h = A.eqToHorizon(st.ra, st.dec, jd, lat, lon);
      if (h.alt + A.refraction(h.alt) < MIN_ALT || (anchor && anchor.mag <= st.mag)) return;
      anchor = { index: i, mag: st.mag, ra: st.ra, dec: st.dec, az: h.az, alt: h.alt + A.refraction(h.alt),
                 name: stars.catalog[i].name };
    });
    if (!anchor) return;
    var w = anchor.name ? anchor.name + ', ' + where(anchor.az, anchor.alt) : where(anchor.az, anchor.alt);
    if (!fits(w)) w = fits('Start at ' + anchor.name) ? 'Start at ' + anchor.name : anchor.name;
    pats.push({ id: 'pattern:' + p.id, type: matcher.TYPE.CONSTELLATION, kind: 0, see: see, give: 0,
                name: p.name, label: p.name, where: w, ra: anchor.ra, dec: anchor.dec, az: anchor.az, alt: anchor.alt,
                mag: p.seeMag, order: order, stars: p.members, anchor: anchor.index });
  });
  // The best known first, when there are more than fit.
  out = out.concat(ranked(pats).slice(0, MAX_PATTERNS));
  var starList = [];
  stars.starsOfDate(jd).filter(function (s) { return s.name && s.mag <= STAR_MAG; })
    .sort(function (a, b) { return a.mag - b.mag; })
    .forEach(function (s) {
      var h = A.eqToHorizon(s.ra, s.dec, jd, lat, lon);
      var alt = h.alt + A.refraction(h.alt);
      var see = seeByte(matcher.seeing(s.mag, alt, sun.alt, sky.sky), h.az, alt);
      if (see === null) return;
      starList.push({ id: 'star:' + s.index, type: matcher.TYPE.STAR, kind: 0, see: see, give: 0, name: s.name,
                      label: s.name, where: where(h.az, alt), ra: s.ra, dec: s.dec, az: h.az, alt: alt, mag: s.mag });
    });
  // Easiest first (keeping the Moon, planets, satellites, patterns, stars
  // order within each), the ones too near the Sun last. Everything but the
  // stars makes the list; the stars fill the rest of it, easiest first, as
  // many as the watch's inbox has room for.
  var list = out.slice(0, MAX_TARGETS);
  var size = LIST_HEAD_BYTES + list.reduce(function (n, t) { return n + targetBytes(t); }, 0);
  // Never more than the inbox holds: the last go first (patterns, then
  // passes), the Moon never.
  while (size > LIST_BYTES && list.length > 1) size -= targetBytes(list.pop());
  ranked(starList).slice(0, MAX_TARGETS - list.length).forEach(function (t) {
    if (size + targetBytes(t) > LIST_BYTES) return;
    size += targetBytes(t);
    list.push(t);
  });
  list = ranked(list);
  markBest(list);
  var sunEq = A.horizonToEq(sun.az, sun.altTrue, jd, lat, lon);
  return { list: list, sun: { ra: sunEq.ra, dec: sunEq.dec } };
}

// Easiest first, too near the Sun last, otherwise in the order given; a
// pass or moonrise more than PASS_BEST_S off after everything up now (you
// can't find it yet), before the ones too near the Sun.
function ranked(list) {
  return list.map(function (t, i) { return { t: t, i: i }; })
    .sort(function (a, b) { return rank(a.t) - rank(b.t) || a.i - b.i; })
    .map(function (x) { return x.t; });
}

// Where a target goes in the list: easiest first, too near the Sun last
// (main.c see_rank too, for the watch's own list, which has no passes).
function rank(t) {
  return (t.see & SEE_NEAR_SUN ? 8 : !soonish(t) ? 4 : 0) + (t.see & 3);
}

function soonish(t) {
  return !(t.start > PASS_BEST_S);
}

// Whether a target can be picked (it isn't too near the Sun).
function findable(t) {
  return !(t.see & SEE_NEAR_SUN);
}

// A target's kind, for picking the best: the Moon, a planet, a satellite,
// a pattern or a star.
function kindOf(t) {
  var T = matcher.TYPE;
  return t.type === T.MOON ? 'moon' : t.type === T.PLANET ? 'planet' : t.type === T.SATELLITE ? 'sat' :
         t.type === T.CONSTELLATION ? 'pattern' : 'star';
}

// How good a pick a target is now (lower is better): what it is (the
// Moon, a passing satellite, a planet, a pattern, then a star), how easily
// it's seen, its height (low ones hide behind trees, the highest are
// awkward to look at), and brightness (for a pattern, how bright the
// stars that make its shape are; the best known first).
var KIND_SCORE = { moon: 0, sat: 0.5, planet: 1, pattern: 1.5, star: 3 };
var BEST_CAP = { moon: 1, sat: 2, planet: 2, pattern: 2, star: 1 };
function score(t) {
  var k = kindOf(t);
  var s = KIND_SCORE[k] + (t.see & 3) * 2 + (t.alt < 20 ? 1 : 0) + (t.alt > 75 ? 0.5 : 0);
  if (k === 'planet') s += Math.max(0, t.mag + 2) * 0.25;   // Uranus is no Saturn
  if (k === 'pattern') s += t.order * 0.05 + t.mag * 0.15;
  if (k === 'star') s += t.mag * 0.2;
  return s;
}

// Marks the targets for "Best now", up to BEST_N: first the best of each
// kind that can be seen by eye (at most BEST_CAP of a kind), then the
// best of the rest that can be found, then, if there's still room, the
// rest in list order (so a short list is all there). A pattern that shares
// stars with one already in (Orion and its Belt) waits for the later
// rounds. With only one left over, that goes in too: a "More" for one
// would be silly.
function markBest(list) {
  var chosen = [], count = {};
  var byScore = list.filter(findable).map(function (t, i) { return { t: t, s: score(t), i: i }; })
    .sort(function (a, b) { return a.s - b.s || a.i - b.i; })
    .map(function (x) { return x.t; });
  function overlaps(t) {
    return !!t.stars && chosen.some(function (c) {
      return !!c.stars && c.stars.some(function (i) { return t.stars.indexOf(i) >= 0; });
    });
  }
  function take(t) {
    if (chosen.length >= BEST_N || chosen.indexOf(t) >= 0) return;
    chosen.push(t);
    count[kindOf(t)] = (count[kindOf(t)] || 0) + 1;
  }
  var soon = soonish;   // a pass or moonrise hours away is on the list, not Best now
  byScore.forEach(function (t) {
    if ((t.see & 3) <= SEE.CLOSE && (count[kindOf(t)] || 0) < BEST_CAP[kindOf(t)] && !overlaps(t) && soon(t)) take(t);
  });
  byScore.forEach(function (t) { if (!overlaps(t) && soon(t)) take(t); });
  list.forEach(function (t) { if (soon(t)) take(t); });
  var rest = list.filter(function (t) { return chosen.indexOf(t) < 0; });
  if ((rest.length <= 1 && rest.every(soon)) || !chosen.length) chosen = list;   // nothing else: what there is
  list.forEach(function (t) { t.best = chosen.indexOf(t) >= 0; });
}

// When the Moon next rises to MOON_ALT (within the 16 bits of seconds the
// watch takes): a target like a pass to come, its path from there for
// MOON_PTS points, where "Rises 11:02 am in the E" and how it's lit; with
// the Moon and the Sun at that time, for how it can be seen. Or null.
function moonRise(date, here, units) {
  var now = date.getTime();
  function at(s) { return moon.moonAltAz(new Date(now + s * 1000), here.lat, here.lon); }
  var step = 600, t0 = -1;
  for (var s = step; s <= PASS_START_MAX_S; s += step) {
    if (at(s).alt >= MOON_ALT) {
      t0 = s;
      break;
    }
  }
  if (t0 < 0) return null;
  var lo = t0 - step, hi = t0;   // down at lo, up at hi
  while (hi - lo > 20) {
    var mid = Math.round((lo + hi) / 2);
    if (at(mid).alt >= MOON_ALT) hi = mid;
    else lo = mid;
  }
  if (hi > PASS_START_MAX_S) return null;
  var m = at(hi);
  var when = new Date(now + hi * 1000);
  var track = [];
  for (var i = 0; i < MOON_PTS; i++) {
    var q = at(hi + i * MOON_STEP_S);
    track.push({ az: q.az, alt: q.alt });
  }
  var pct = Math.round(m.illum * 100);
  var note = matcher.moonPhase(m) + ', ' + pct + '% lit';
  return {
    moon: m, sun: planets.bodies(when, here.lat, here.lon)[0],
    target: { id: 'moon', type: matcher.TYPE.MOON, kind: 1, see: 0, give: 0, name: 'The Moon', label: 'The Moon',
              where: 'Rises ' + clock(when.getTime(), units !== 'metric') + ', ' + dir8(m.az),
              note: note.length <= NOTE_MAX ? note : matcher.moonPhase(m),
              start: hi, step: MOON_STEP_S, track: track, az: m.az, alt: m.alt, mag: m.mag }
  };
}

// The brightest satellites while they're up, sunlit and the sky is dark:
// the stations and Hubble (any rank), and trains of new satellites (one
// member for each), each with its path for the next few minutes (until
// it sets or goes into shadow). The Space Station first, then by rank and
// brightness; at most MAX_MOVING.
function satTargets(date, here, sun, satCat, units, skySetting, most) {
  if (!satCat || sun.alt >= -6) return [];
  var trains = {};
  var picks = [];
  satellites.positions(satCat, date, here, units).forEach(function (s) {
    if (!s.lit || s.altTrue < MIN_ALT) return;
    var train = s.cluster && s.clusterSize >= TRAIN_MIN;
    if (!train && !(s.rank >= 1)) return;
    if (train) {
      if (trains[s.cluster]) return;
      trains[s.cluster] = true;
    }
    var how = s.id === ISS ? SEE.EASY : matcher.seeing(s.mag, s.alt, sun.alt, skySetting);
    if (how > SEE.CLOSE || how > most) return;   // too faint to follow as it moves
    picks.push({ s: s, how: how, train: train });
  });
  picks.sort(function (a, b) {
    return (b.s.id === ISS) - (a.s.id === ISS) || (b.s.rank || 0) - (a.s.rank || 0) || a.s.mag - b.s.mag;
  });
  var out = [];
  picks.forEach(function (p) {
    if (out.length >= MAX_MOVING) return;
    var t = satTarget(date, here, satCat, units, p.s.id, p.train ? p.s.train + ' train' : p.s.l1, p.how);
    if (t) out.push(t);
  });
  return out;
}

// One satellite and its path from now: null if it's gone in a moment.
function satTarget(date, here, satCat, units, id, name, how) {
  var entry = satCat.filter(function (c) { return c.id === id; });
  if (!entry.length) return null;
  var track = [];
  var first = null;
  for (var t = 0; t <= TRACK_S; t += TRACK_STEP_S) {
    var p = satellites.positions(entry, new Date(date.getTime() + t * 1000), here, units)[0];
    if (!p || p.altTrue < 0 || !p.lit) break;
    if (!first) first = p;
    track.push({ az: p.az, alt: p.alt });
  }
  if (!first || first.altTrue < MIN_ALT || track.length < 2) return null;
  return { id: 'sat:' + id, type: matcher.TYPE.SATELLITE, kind: 1, see: how, give: 0, name: name, label: name,
           where: fitWhere(where(first.az, first.alt), ', moving'), track: track, satId: id, az: first.az, alt: first.alt };
}

// The next visible pass (within PASS_HOURS) of each of PASS_IDS that
// isn't passing over now (up: the targets for those that are followed): the watch is given
// its path from where it rises, and when. where: "7:42 pm, SW to NE,
// high"; note: the pass after it ("Then 9:19 pm, W to N"), if any.
var passCache = { key: '', at: 0, list: null };
var PASS_CACHE_MS = 10 * 60 * 1000;
function passTargets(date, here, satCat, units, skySetting, most, up) {
  if (!satCat) return [];
  var now = date.getTime();
  var key = here.lat.toFixed(1) + ',' + here.lon.toFixed(1) + ',' + satCat.length;
  if (passCache.key !== key || now - passCache.at > PASS_CACHE_MS || now < passCache.at) {
    passCache = { key: key, at: now, list: {} };
    PASS_IDS.forEach(function (id) {
      passCache.list[id] = satellites.passes(satCat, id, date, PASS_HOURS, here,
                                             { minAlt: MIN_ALT, max: 2, pts: PASS_PTS }) || [];
    });
  }
  var h12 = units !== 'metric';
  var out = [];
  PASS_IDS.forEach(function (id) {
    if (up.some(function (t) { return t.satId === id; })) return;
    var c = satCat.filter(function (x) { return x.id === id; })[0];
    var all = passCache.list[id] || [];
    // Passing over now but not followed (more are up than the watch
    // follows): its next pass would mislead.
    if (all.some(function (q) { return q.start <= now && q.end >= now; })) return;
    var ps = all.filter(function (q) { return q.start > now; });
    if (!c || !ps.length || ps[0].start - now > PASS_START_MAX_S * 1000) return;
    var q = ps[0];
    var how = id === ISS ? SEE.EASY : matcher.seeing(c.stdMag, q.peak, -18, skySetting);
    if (how > SEE.CLOSE || how > most) return;
    var height = q.peak >= 60 ? 'high' : q.peak >= 30 ? 'halfway up' : 'low';
    var w = fitWhere(clock(q.start, h12) + ', ' + dir8(q.fromAz) + ' to ' + dir8(q.toAz), ', ' + height);
    var next = ps[1];
    out.push({ id: 'pass:' + id, type: matcher.TYPE.SATELLITE, kind: 1, see: how, give: 0, name: c.l1, label: c.l1,
               where: w, note: next ? 'Then ' + clock(next.start, h12) + ', ' + dir8(next.fromAz) + ' to ' +
                                      dir8(next.toAz) : 'No other pass for a day',
               start: Math.round((q.start - now) / 1000), step: q.step, track: q.track, satId: id,
               az: q.track[0].az, alt: q.track[0].alt });
  });
  return out;
}

// The STARS rung's status line: how many stars you can see now (by eye,
// at least STARS_ALT up, as the sky setting allows), or when they come
// out. "About 260 stars out" in the dark, "45 stars out, more coming" (or
// "fading", at dawn) in twilight, "Arcturus is out first" or "Vega + 2
// more out" for the first few, and by day "Stars out at 6:31 pm" (when
// the Sun is next 6 degrees down: the first stars are out by then).
var STARS_ALT = 10;
var STARS_SUN = -6;
function starsStatus(date, here, sunAlt, skySetting, units) {
  var jd = A.julianDay(date);
  var n = 0, first = null;
  stars.starsOfDate(jd).forEach(function (s) {
    var h = A.eqToHorizon(s.ra, s.dec, jd, here.lat, here.lon);
    var alt = h.alt + A.refraction(h.alt);
    if (alt < STARS_ALT || matcher.seeing(s.mag, alt, sunAlt, skySetting) !== SEE.EASY) return;
    n++;
    if (s.name && (!first || s.mag < first.mag)) first = s;
  });
  var t = date.getTime();
  function sunAt(ms) { return planets.bodies(new Date(ms), here.lat, here.lon)[0].alt; }
  if (!n) {
    for (var ms = t + 10 * 60000; ms <= t + 24 * 3600000; ms += 10 * 60000) {
      if (sunAt(ms) > STARS_SUN) continue;
      var lo = ms - 10 * 60000;   // to the half minute
      while (ms - lo > 30000) {
        var mid = (lo + ms) / 2;
        if (sunAt(mid) <= STARS_SUN) ms = mid;
        else lo = mid;
      }
      return 'Stars out at ' + clock(ms, units !== 'metric');
    }
    return 'Too bright for stars';
  }
  if (sunAlt <= -12) return 'About ' + (n < 20 ? n : Math.round(n / 10) * 10) + ' stars out';
  if (n <= 3 && first) return n === 1 ? first.name + ' is out first' : first.name + ' + ' + (n - 1) + ' more out';
  var dawn = sunAt(t + 10 * 60000) > sunAlt;
  return (n < 20 ? n : Math.round(n / 10) * 10) + ' stars out, ' + (dawn ? 'fading' : 'more coming');
}

// The bytes FIND_LIST takes: its head and the Sun, and each target
// (encodeList).
var LIST_HEAD_BYTES = 6 + 4;
function targetBytes(t) {
  return 5 + 1 + ascii(t.name, NAME_MAX).length + 1 + ascii(t.where, WHERE_MAX).length +
         1 + ascii(t.note || '', NOTE_MAX).length + (t.kind === 0 ? 4 : 4 + 4 * t.track.length);
}

// ---------------------------------------------------------------- wire

function ascii(s, max) {
  return String(s).replace(/[^\x20-\x7e]/g, '').slice(0, max);
}

function pushStr(bytes, s, max) {
  s = ascii(s, max);
  bytes.push(s.length);
  for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
}

function pushU16(bytes, v) {
  v = Math.round(v) & 0xffff;
  bytes.push(v & 0xff, v >> 8);
}

function pushI16(bytes, v) {
  pushU16(bytes, Math.max(-32768, Math.min(32767, Math.round(v))));
}

function pushI32(bytes, v) {
  v = Math.round(v) >>> 0;
  bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function angle16(deg) {
  return Math.round(A.rev(deg) / 360 * 65536) % 65536;
}

function encodeList(res, nowMs) {
  var bytes = [4];
  pushI32(bytes, Math.floor(nowMs / 1000));
  bytes.push(res.list.length);
  res.list.forEach(function (t, i) {
    bytes.push(i, t.type, t.kind, t.see, (t.best ? BEST : 0) | Math.min(127, t.give || 0));
    pushStr(bytes, t.name, NAME_MAX);
    pushStr(bytes, t.where, WHERE_MAX);
    pushStr(bytes, t.note || '', NOTE_MAX);
    if (t.kind === 0) {
      pushU16(bytes, angle16(t.ra));
      pushI16(bytes, t.dec * 100);
    } else {
      pushU16(bytes, Math.max(0, Math.min(65535, t.start || 0)));
      bytes.push(Math.max(1, Math.min(255, t.step || TRACK_STEP_S)), t.track.length);
      t.track.forEach(function (p) {
        pushU16(bytes, angle16(p.az));
        pushI16(bytes, p.alt * 100);
      });
    }
  });
  pushU16(bytes, angle16(res.sun.ra));
  pushI16(bytes, res.sun.dec * 100);
  return bytes;
}

// frame: {lat, lon, decl, fingers: [{yaw, pitch} left, right], sky, show}.
function encodeFrame(f) {
  var bytes = [];
  pushI32(bytes, f.lat * 1e5);
  pushI32(bytes, f.lon * 1e5);
  pushI16(bytes, f.decl * 100);
  f.fingers.forEach(function (g) {
    pushI16(bytes, g.yaw * 100);
    pushI16(bytes, g.pitch * 100);
  });
  var show = SHOW.indexOf(f.show);
  bytes.push((SKY_CODE[f.sky] === undefined ? 1 : SKY_CODE[f.sky]) | (show > 0 ? show : 0) << 4);
  return bytes;
}

// Reads FIND_LIST back (tests).
function decodeList(b) {
  var k = 0;
  function u16() { var v = b[k] | (b[k + 1] << 8); k += 2; return v; }
  function i16() { var v = u16(); return v >= 32768 ? v - 65536 : v; }
  function str() { var n = b[k++], s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(b[k++]); return s; }
  var out = { version: b[k++] };
  out.time = (b[k] | (b[k + 1] << 8) | (b[k + 2] << 16) | (b[k + 3] << 24)) >>> 0;
  k += 4;
  var n = b[k++];
  out.list = [];
  for (var i = 0; i < n; i++) {
    var t = { id: b[k++], type: b[k++], kind: b[k++] };
    if (out.version >= 2) t.see = b[k++];
    if (out.version >= 3) {
      t.best = !!(b[k] & BEST);
      t.give = b[k++] & 127;
    }
    t.name = str();
    t.where = str();
    if (out.version >= 4) t.note = str();
    if (t.kind === 0) {
      t.ra = u16() / 65536 * 360;
      t.dec = i16() / 100;
    } else {
      if (out.version >= 4) t.start = u16();
      t.step = b[k++];
      var m = b[k++];
      t.track = [];
      for (var j = 0; j < m; j++) t.track.push({ az: u16() / 65536 * 360, alt: i16() / 100 });
    }
    out.list.push(t);
  }
  out.sun = { ra: u16() / 65536 * 360, dec: i16() / 100 };
  out.length = k;
  return out;
}

// Whether a matcher card (with its ref) is about this target. sky: with
// its satellites, for a train (the card is for its member nearest the
// aim, which may not be the one followed).
function isTarget(card, t, sky) {
  var r = card.ref || {};
  if (t.id === 'moon') return r.kind === 'moon';
  if (t.kind === 1) {
    if (r.kind !== 'sat') return false;
    if (r.id === t.satId) return true;
    var s = ((sky && sky.sats) || []).filter(function (x) { return x.id === t.satId; })[0];
    return !!(s && s.cluster && r.cluster === s.cluster);
  }
  if (/^star:/.test(t.id)) return r.kind === 'star' && 'star:' + r.index === t.id;
  if (/^pattern:/.test(t.id)) return r.kind === 'pattern' && 'pattern:' + r.id === t.id;
  return r.kind === 'planet' && r.id === t.id;
}

module.exports = { targets: targets, findable: findable, rank: rank, isTarget: isTarget, encodeList: encodeList,
                   encodeFrame: encodeFrame, decodeList: decodeList, kindOf: kindOf, score: score, markBest: markBest,
                   MAX_TARGETS: MAX_TARGETS, BEST_N: BEST_N, LIST_BYTES: LIST_BYTES, MAX_MOVING: MAX_MOVING,
                   ISS: ISS, SHOW: SHOW, fits: fits, textPx: textPx, MOON_ALT: MOON_ALT, clock: clock, starsStatus: starsStatus,
                   SKY_CODE: SKY_CODE,
                   SEE_BLOCK_SUN: SEE_BLOCK_SUN, SEE_NEAR_SUN: SEE_NEAR_SUN, SUN_EYE: SUN_EYE, SUN_AIDED: SUN_AIDED };
