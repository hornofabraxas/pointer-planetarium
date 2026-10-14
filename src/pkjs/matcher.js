// What is the user pointing at? Turns one aim into ranked result cards.
//
// Each object near the aim gets a score: a 2-D Gaussian in its distance
// from the aim (widened by how unsure the aim is), times a prior for how
// likely a person is to point at it (visible now, bright). A constant
// "nothing there" term keeps the answer honest when nothing is close.
// Probabilities become words (THAT'S / PROBABLY / MAYBE), never numbers.
// When nothing is sure, the nearest bright thing is offered as CLOSEST.
// See docs/DESIGN.md section 4.

var A = require('./astro.js');
var stars = require('./stars.js');

var LAYER = { ANY: 0, PLANES: 1, SATELLITES: 2, PLANETS: 3, STARS: 4, FIND: 5 };
var TYPE = { NOTHING: 0, PLANE: 1, SATELLITE: 2, PLANET: 3, MOON: 4, STAR: 5,
             CONSTELLATION: 6, SUN: 7, CHART: 8, FACT: 9 };
// CLOSEST: the bright thing nearest a miss, which Tune my aim can use;
// CLOSEST_FAR: the same, but it can't be tuned on now (index.js decides).
var WORD = { NONE: 0, THATS: 1, PROBABLY: 2, MAYBE: 3, CLOSEST: 4, CLOSEST_FAR: 5 };

// Tuning knobs (section 4.4: field logs will move these).
var SIGMA_REF = 4;          // degrees; scores are relative to a 4 degree aim
var MAX_SEARCH = 12;        // never look further than this from the aim
var BRIGHTNESS_SLOPE = 0.6; // prior falls 10^(0.4*slope) per magnitude
var NONE_WEIGHT = 0.05;     // the "nothing I know is there" hypothesis (a lone
                            // mag 3 star dead on reads THAT'S; mag 4.5, PROBABLY)
var INVISIBLE_PRIOR = 0.03; // explicit layers only: objects you can't see now
var MIN_SHOWN = 0.15;
var MAX_CARDS = 5;
var MAX_PER_TYPE = 3;       // in ANYTHING, so one kind can't fill the list
var SUN_WARNING_DEG = 20;
var DARK_SUN = -6;          // satellites show only once the Sun is this far down
var SAT_MAG_SLACK = 1;      // satellite brightness is a rough estimate: be generous
// Nothing (or only a MAYBE) where you pointed: the bright thing nearest the
// aim, out to this far, is offered as CLOSEST ("Saturn, 14 degrees off").
// People point at what they can see, so a miss this big is far likelier a
// pointing error than an aim at empty sky; the card can start a tune on it.
var CLOSEST_DEG = 25;
var CLOSEST_SIGMA = 10;     // nearer beats brighter, but not by much
var CLOSEST_MAG = 1.5;      // the Moon, the bright planets, the brightest stars
var CLOSEST_LEAD_MAG = 2;   // this much brighter than a MAYBE, and CLOSEST goes first

// How faint a star can be and still be seen, from the Sun's altitude and
// the user's sky (city / suburbs / dark).
var SKY_LIMIT = { city: 3.5, suburbs: 4.5, dark: 5.5 };
function limitingMag(sunAlt, sky) {
  if (sunAlt > -1) return -3;     // daylight: the Moon, Venus, little else
  if (sunAlt > -6) return 1;
  if (sunAlt > -12) return 3;
  return SKY_LIMIT[sky] || SKY_LIMIT.suburbs;
}

// Dimming near the horizon (about 0.25 mag per airmass).
function extinction(altApp) {
  if (altApp <= 0) return 5;
  var am = 1 / A.sind(altApp + 244 / (165 + 47 * Math.pow(altApp, 1.1)));
  return 0.25 * (Math.min(am, 40) - 1);
}

// How something can be seen now: EASY by eye; CLOSE by eye, but only
// knowing just where to look (as Find it does); BINOCULARS; TELESCOPE.
// The steps past the eye's limit are first guesses, for the field
// sessions to tune: in daylight (limit -3) Jupiter is CLOSE and the
// brightest stars BINOCULARS.
var SEE = { EASY: 0, CLOSE: 1, BINOCULARS: 2, TELESCOPE: 3 };
var SEE_CLOSE_MAG = 1.5;
var SEE_BINOCULARS_MAG = 4;

function seeing(mag, altApp, sunAlt, sky) {
  var over = mag + extinction(altApp) - limitingMag(sunAlt, sky);
  if (over <= 0) return SEE.EASY;
  if (over <= SEE_CLOSE_MAG) return SEE.CLOSE;
  if (over <= SEE_BINOCULARS_MAG) return SEE.BINOCULARS;
  return SEE.TELESCOPE;
}

// The Moon: none when it's new (under 3% lit); by day, a crescent under
// a fifth lit is pale against the blue, so CLOSE at best.
function moonSeeing(m, sunAlt, sky) {
  if (m.illum < 0.03) return null;
  var s = seeing(m.mag, m.alt, sunAlt, sky);
  return sunAlt > -1 && m.illum < 0.2 && s < SEE.CLOSE ? SEE.CLOSE : s;
}

// The third line of a card for something you can't just see now.
var SEE_WORDS = ['', 'Hard to see now', 'Try binoculars', 'Needs a telescope'];

function brightnessWord(mag) {
  if (mag < -3) return 'Very bright';
  if (mag < -1) return 'Bright';
  if (mag < 1.5) return 'Easy to see';
  if (mag < 3.5) return 'Faint';
  return 'Very faint';
}

function moonPhase(m) {
  if (m.illum < 0.03) return 'New Moon';
  if (m.illum > 0.97) return 'Full Moon';
  if (m.illum < 0.47) return m.waxing ? 'Waxing crescent' : 'Waning crescent';
  if (m.illum <= 0.53) return m.waxing ? 'First quarter' : 'Last quarter';
  return m.waxing ? 'Waxing gibbous' : 'Waning gibbous';
}

// Where the object is relative to the aim, in words, when it's worth saying.
function offsetHint(aim, obj, d) {
  if (d < 2) return '';
  var dx = A.wrap180(obj.az - aim.az) * A.cosd(aim.alt);
  var dy = obj.alt - aim.alt;
  var horiz = Math.abs(dx) > 0.4 * d ? (dx > 0 ? 'right' : 'left') : '';
  var vert = Math.abs(dy) > 0.4 * d ? (dy > 0 ? 'higher' : 'lower') : '';
  var soft = d < 5;
  if (!horiz && !vert) return '';
  if (horiz && vert) return (vert === 'higher' ? 'Higher' : 'Lower') + ' and ' + horiz;
  if (vert) return soft ? 'A bit ' + vert : (vert === 'higher' ? 'Higher' : 'Lower');
  return soft ? 'A bit to the ' + horiz : 'Further ' + horiz;
}

// A moving thing's line in place of where to look (by the time the answer
// shows, a plane or satellite has moved about as far as an aim misses by):
// how fast it goes and which way it crosses the sky as you face it
// ("480 mph, moving right"). speedMs: metres a second, or null; move:
// {dx, dy} degrees a second, right and up, or null. The watch draws the
// arrow from the words (main.c hint_way).
function motionHint(speedMs, move, units) {
  var words = '';
  var m = move ? Math.sqrt(move.dx * move.dx + move.dy * move.dy) : 0;
  if (m > 1e-4) {
    var horiz = Math.abs(move.dx) > 0.4 * m ? (move.dx > 0 ? 'right' : 'left') : '';
    var vert = Math.abs(move.dy) > 0.4 * m ? (move.dy > 0 ? 'up' : 'down') : '';
    words = 'moving ' + (horiz && vert ? vert + '-' + horiz : horiz || vert);
  }
  var speed = '';
  if (typeof speedMs === 'number' && speedMs > 0) {
    var metric = units === 'metric';
    var n = speedMs * (metric ? 3.6 : 2.236936);
    n = n >= 1000 ? Math.round(n / 100) * 100 : Math.max(10, Math.round(n / 10) * 10);
    speed = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (metric ? ' km/h' : ' mph');
  }
  if (speed && words) return speed + ', ' + words;
  return speed || (words && 'M' + words.slice(1));
}

function wordFor(p) {
  if (p >= 0.75) return WORD.THATS;
  if (p >= 0.40) return WORD.PROBABLY;
  if (p >= MIN_SHOWN) return WORD.MAYBE;
  return WORD.NONE;
}

// sky: {jd, lat, lon, sunAlt, sky ('city'|'suburbs'|'dark'), bodies (from
// planets.bodies), moon (from moon.moonAltAz), sats (from
// satellites.positions, or null with no satellite data), satHidden (show
// satellites that can't be seen right now in the SATELLITES layer),
// satsNote (status line while there is no satellite data), planes (from
// planes.positions, or null when the feed couldn't be reached), planesNote
// (why there are no planes), planesStatus (the PLANES status line),
// units ('metric' or imperial, for a moving thing's speed)}.
// aim: {az, alt (apparent), sigma (degrees), layer, rollTooFar}.
// knobs: optional {noneWeight, brightnessSlope} in place of the defaults
// (for tuning them against measured aims).
// Returns {cards: [{type, word, l1, l2, l3, hint, p, name, az, alt
// (apparent), visible, ref}], top}. ref says what the card is about, for
// its fact and chart: {kind: 'moon'|'planet'|'star'|'sat'|'plane'|
// 'constellation', ...} (see facts.js).
function match(aim, sky, knobs) {
  knobs = knobs || {};
  var noneWeight = typeof knobs.noneWeight === 'number' ? knobs.noneWeight : NONE_WEIGHT;
  var slope = typeof knobs.brightnessSlope === 'number' ? knobs.brightnessSlope : BRIGHTNESS_SLOPE;
  if (aim.rollTooFar) {
    return { cards: [{ type: TYPE.NOTHING, word: WORD.NONE, l1: 'Turn your hand',
                       l2: 'so the watch', l3: 'faces up more', hint: '' }], top: null };
  }

  var aimTrue = { az: aim.az, alt: A.unrefract(aim.alt) };
  var limit = limitingMag(sky.sunAlt, sky.sky);
  var explicit = aim.layer !== LAYER.ANY;
  var wantPlanets = aim.layer === LAYER.ANY || aim.layer === LAYER.PLANETS;
  var wantStars = aim.layer === LAYER.ANY || aim.layer === LAYER.STARS;
  var wantSats = aim.layer === LAYER.ANY || aim.layer === LAYER.SATELLITES;
  var wantPlanes = aim.layer === LAYER.ANY || aim.layer === LAYER.PLANES;
  var objs = [];

  function consider(o) {
    // o: {type, name, az, altTrue, alt (apparent), mag, l1, l2, l3}, and for
    // satellites also sigmaObj (their own position error, degrees), lit,
    // cluster and clusterSize (a train), train (its family name); for
    // satellites and planes moving (true), speedMs and move (motionHint).
    if (o.alt < -0.5) return;   // below the horizon
    var d = A.separation(aimTrue.az, aimTrue.alt, o.az, o.altTrue);
    var sigma = Math.sqrt(aim.sigma * aim.sigma + (o.sigmaObj || 0) * (o.sigmaObj || 0));
    if (!(d <= Math.min(3 * sigma, MAX_SEARCH))) return;   // also rejects NaN
    var effMag = o.mag + extinction(o.alt);
    var isSat = o.type === TYPE.SATELLITE;
    // Planes can be seen by day and (by their lights) by night; their
    // "magnitude" only says how noticeable they are.
    var visible = o.type === TYPE.PLANE ? o.alt > 0 :
                  o.alt > 0 && effMag <= limit + (isSat ? SAT_MAG_SLACK : 0) &&
                  (!isSat || (o.lit && sky.sunAlt < DARK_SUN));
    if (!visible && (!explicit || (isSat && !sky.satHidden))) return;
    var prior = Math.pow(10, -0.4 * slope * Math.max(-2, Math.min(6, o.mag)));
    // A hidden satellite only gets this far when the user asked to see
    // them, so it isn't marked down.
    if (!visible && !isSat) prior *= INVISIBLE_PRIOR;
    var like = Math.exp(-d * d / (2 * sigma * sigma)) * (SIGMA_REF * SIGMA_REF) / (sigma * sigma);
    o.d = d;
    o.visible = visible;
    o.score = like * prior;
    if (!visible) {
      o.l3 = isSat ? (!o.lit ? "In Earth's shadow" : 'Sky too bright now')
                   : o.alt <= 0 ? 'Below the horizon' : SEE_WORDS[seeing(o.mag, o.alt, sky.sunAlt, sky.sky)];
    }
    objs.push(o);
  }

  var sun = sky.bodies[0];
  var cards = [];
  if (sun.alt > -1 && A.separation(aimTrue.az, aimTrue.alt, sun.az, sun.altTrue) < SUN_WARNING_DEG) {
    cards.push({ type: TYPE.SUN, word: WORD.NONE, l1: "Don't look", l2: 'at the Sun!',
                 l3: 'It can hurt your eyes', hint: '', p: 1, name: 'Sun' });
  }

  if (wantPlanets) {
    var m = sky.moon;
    consider({ type: TYPE.MOON, name: 'Moon', az: m.az, altTrue: m.altTrue, alt: m.alt, mag: m.mag,
               l1: 'The Moon', l2: moonPhase(m), l3: Math.round(m.illum * 100) + '% lit',
               ref: { kind: 'moon', illum: m.illum, waxing: m.waxing, distKm: m.distKm } });
    sky.bodies.slice(1).forEach(function (b) {
      consider({ type: TYPE.PLANET, name: b.name, az: b.az, altTrue: b.altTrue, alt: b.alt,
                 mag: b.mag, l1: b.name, l2: 'Planet', l3: brightnessWord(b.mag),
                 ref: { kind: 'planet', id: b.id, name: b.name, distAU: b.distAU, lit: b.lit } });
    });
  }

  if (wantStars) {
    var eq = A.horizonToEq(aimTrue.az, aimTrue.alt, sky.jd, sky.lat, sky.lon);
    stars.starsNear(eq.ra, eq.dec, sky.jd, Math.min(3 * aim.sigma, MAX_SEARCH)).forEach(function (n) {
      var s = n.star;
      var h = A.eqToHorizon(s.ra, s.dec, sky.jd, sky.lat, sky.lon);
      var abbr = stars.constellationAt(s.ra, s.dec, sky.jd);
      var con = stars.constellationName(abbr);
      consider({ type: TYPE.STAR, name: s.name || 'star', az: h.az, altTrue: h.alt,
                 alt: h.alt + A.refraction(h.alt), mag: s.mag, l1: s.name || 'A star',
                 l2: 'in ' + con, l3: brightnessWord(s.mag),
                 ref: { kind: 'star', index: s.index, name: s.name, con: abbr, ly: stars.distances[s.index] } });
    });
  }

  if (wantSats && sky.sats) {
    sky.sats.forEach(function (s) {
      consider({ type: TYPE.SATELLITE, name: s.name, az: s.az, altTrue: s.altTrue, alt: s.alt,
                 mag: s.mag, sigmaObj: s.sigmaObj, lit: s.lit, cluster: s.cluster,
                 clusterSize: s.clusterSize, train: s.train, l1: s.l1, l2: s.l2, l3: s.l3,
                 moving: true, speedMs: s.speedMs, move: s.move,
                 ref: { kind: 'sat', id: s.id, rocket: /rocket/i.test(s.l1 || '') } });
    });
    objs = groupTrains(objs);
  }

  if (wantPlanes && sky.planes) {
    sky.planes.forEach(function (pl) {
      consider({ type: TYPE.PLANE, name: pl.l1, az: pl.az, altTrue: pl.altTrue, alt: pl.alt, mag: pl.mag,
                 sigmaObj: pl.sigmaObj, l1: pl.l1, l2: pl.l2, l3: pl.l3,
                 moving: true, speedMs: pl.speedMs, move: pl.move,
                 ref: { kind: 'plane', id: pl.ac ? pl.ac.t || '' : '', gs: pl.ac ? pl.ac.gs : null,
                        altFt: pl.altFt, trip: pl.trip || null, hex: pl.hex, typeName: pl.typeName || '',
                        craft: pl.craft || 0 } });
    });
  }

  var total = noneWeight;
  objs.forEach(function (o) { total += o.score; });
  objs.forEach(function (o) { o.p = o.score / total; });
  objs.sort(function (a, b) { return b.p - a.p; });

  var perType = {};
  objs.forEach(function (o) {
    if (cards.length >= MAX_CARDS || o.p < MIN_SHOWN) return;
    perType[o.type] = (perType[o.type] || 0) + 1;
    if (!explicit && perType[o.type] > MAX_PER_TYPE) return;
    cards.push({ type: o.type, word: wordFor(o.p), l1: o.l1, l2: o.l2, l3: o.l3,
                 hint: o.moving ? motionHint(o.speedMs, o.move, sky.units)
                                : offsetHint(aimTrue, { az: o.az, alt: o.altTrue }, o.d), p: o.p, name: o.name,
                 az: o.az, alt: o.alt, visible: o.visible, ref: o.ref || null, mag: o.mag });
  });

  var listed = cards.filter(function (c) { return c.type !== TYPE.SUN; });
  var weak = !listed.length || listed[0].word === WORD.MAYBE;
  if (weak && aimTrue.alt > 0 && (wantPlanets || wantStars) && cards.length < MAX_CARDS) {
    var near = closestBright(aimTrue, sky, wantPlanets, wantStars, limit);
    if (near && !listed.some(function (c) { return c.name === near.name; })) {
      // Far brighter than the faint MAYBE where you pointed: that's what
      // you meant, more likely than not, so it comes first.
      var lead = listed.length && near.mag <= listed[0].mag - CLOSEST_LEAD_MAG;
      cards.splice(lead ? cards.indexOf(listed[0]) : cards.length, 0, { type: near.type, word: WORD.CLOSEST, l1: near.name, l2: Math.round(near.d) + ' degrees off',
                   l3: '', hint: offsetHint(aimTrue, { az: near.az, alt: near.altTrue }, near.d), p: 0,
                   name: near.name, az: near.az, alt: near.alt, visible: true, ref: near.ref, d: near.d,
                   mag: near.mag });
    }
  }

  var found = cards.some(function (c) { return c.type !== TYPE.SUN; });
  if (!found) {
    var eqA = A.horizonToEq(aimTrue.az, aimTrue.alt, sky.jd, sky.lat, sky.lon);
    var conAbbr = stars.constellationAt(eqA.ra, eqA.dec, sky.jd);
    var conName = stars.constellationName(conAbbr);
    if (aim.layer === LAYER.STARS && aimTrue.alt > 0) {
      cards.push({ type: TYPE.CONSTELLATION, word: WORD.NONE, l1: conName, l2: 'Constellation',
                   l3: "You're pointing into it", hint: '', p: 0, name: conName,
                   ref: { kind: 'constellation', id: conAbbr } });
    } else {
      var night = sky.sunAlt < -6 && aimTrue.alt > 0;
      var l3 = night ? 'Pointing into ' + conName : 'Point again, hold still';
      if (aim.layer === LAYER.PLANES) {
        l3 = sky.planes ? (sky.planes.length ? 'No plane right there' : sky.planesNote || 'None tracked nearby')
                        : sky.planesNote || "Can't get plane data";
      }
      if (aim.layer === LAYER.SATELLITES) {
        if (!sky.sats) l3 = sky.satsNote || 'No satellite data yet';
        else if (sky.sunAlt >= DARK_SUN && !sky.satHidden) l3 = 'Try again after dark';
      }
      // At night, where you pointed, on the chart of the constellation.
      var where = night && aim.layer !== LAYER.PLANES && aim.layer !== LAYER.SATELLITES;
      cards.push({ type: TYPE.NOTHING, word: WORD.NONE, l1: 'Nothing I know', l2: 'is there',
                   l3: l3, hint: '', p: 0, name: '',
                   ref: where ? { kind: 'constellation', id: conAbbr, nothing: true } : null });
    }
  }

  var top = null;
  cards.forEach(function (c) { if (!top && c.type !== TYPE.SUN && c.p > 0) top = c; });
  // A CLOSEST card isn't an answer (top stays null): it says where the
  // nearest bright thing is, and asks whether that was meant.
  return { cards: cards, top: top };
}

// The bright thing (CLOSEST_MAG or brighter, easy to see now) nearest the
// aim (true), within CLOSEST_DEG: {type, name, az, altTrue, alt, mag, d,
// ref}, or null. Nearer wins over brighter, gently.
function closestBright(aimTrue, sky, planets, starsToo, limit) {
  var best = null;
  function offer(o) {
    if (o.alt <= 0 || o.mag > CLOSEST_MAG || o.mag + extinction(o.alt) > limit) return;
    var d = A.separation(aimTrue.az, aimTrue.alt, o.az, o.altTrue);
    if (!(d <= CLOSEST_DEG)) return;
    o.d = d;
    o.score = Math.pow(10, -0.4 * BRIGHTNESS_SLOPE * Math.max(-2, o.mag)) *
              Math.exp(-d * d / (2 * CLOSEST_SIGMA * CLOSEST_SIGMA));
    if (!best || o.score > best.score) best = o;
  }
  if (planets) {
    var m = sky.moon;
    if (moonSeeing(m, sky.sunAlt, sky.sky) === SEE.EASY) {
      offer({ type: TYPE.MOON, name: 'Moon', az: m.az, altTrue: m.altTrue, alt: m.alt, mag: Math.min(m.mag, -2),
              ref: { kind: 'moon', illum: m.illum, waxing: m.waxing, distKm: m.distKm } });
    }
    sky.bodies.slice(1).forEach(function (b) {
      offer({ type: TYPE.PLANET, name: b.name, az: b.az, altTrue: b.altTrue, alt: b.alt, mag: b.mag,
              ref: { kind: 'planet', id: b.id, name: b.name, distAU: b.distAU, lit: b.lit } });
    });
  }
  if (starsToo) {
    var eq = A.horizonToEq(aimTrue.az, aimTrue.alt, sky.jd, sky.lat, sky.lon);
    stars.starsNear(eq.ra, eq.dec, sky.jd, CLOSEST_DEG).forEach(function (n) {
      var s = n.star;
      if (!s.name || s.mag > CLOSEST_MAG) return;
      var h = A.eqToHorizon(s.ra, s.dec, sky.jd, sky.lat, sky.lon);
      offer({ type: TYPE.STAR, name: s.name, az: h.az, altTrue: h.alt, alt: h.alt + A.refraction(h.alt), mag: s.mag,
              ref: { kind: 'star', index: s.index, name: s.name, con: stars.constellationAt(s.ra, s.dec, sky.jd),
                     ly: stars.distances[s.index] } });
    });
  }
  return best;
}

// Members of one satellite train near the aim become a single card: their
// scores add up (a line of lights is easier to notice than one), and the
// card points to the nearest member.
function groupTrains(objs) {
  var trains = {};
  return objs.filter(function (o) {
    if (!o.cluster || o.clusterSize < 2) return true;
    var t = trains[o.cluster];
    if (!t) {
      trains[o.cluster] = o;
      o.l1 = o.train + ' train';
      o.l2 = o.clusterSize + ' satellites in a row';
      o.ref = { kind: 'sat', id: o.ref ? o.ref.id : 0, train: o.train, cluster: o.cluster };
      return true;
    }
    t.score += o.score;
    if (o.d < t.d) {
      t.az = o.az;
      t.altTrue = o.altTrue;
      t.d = o.d;
      t.l3 = o.l3;
      t.move = o.move;
      if (o.ref) t.ref.id = o.ref.id;   // its path is the nearest member's
    }
    return false;
  });
}

// How many satellites can be seen right now, high enough to notice
// (a train counts once). null with no satellite data.
function satsUp(sky) {
  if (!sky.sats) return null;
  var limit = limitingMag(sky.sunAlt, sky.sky) + SAT_MAG_SLACK;
  var seen = {}, n = 0, station = false;
  sky.sats.forEach(function (s) {
    if (!s.lit || s.altTrue < 10 || s.mag + extinction(s.alt) > limit) return;
    if (s.cluster && s.clusterSize > 1) {
      if (seen[s.cluster]) return;
      seen[s.cluster] = true;
    }
    if (s.id === 25544) station = true;
    n++;
  });
  return { n: n, station: station };
}

// Watch status lines, one per layer (ANY, PLANES, SATELLITES, PLANETS,
// STARS). Cheap: no network, no star scan.
function layerStatus(sky) {
  // Up and to be seen by eye (CLOSE too: Find it shows you where), as
  // Find it counts them.
  var ms = moonSeeing(sky.moon, sky.sunAlt, sky.sky);
  var moonUp = sky.moon.alt > 0 && ms !== null && ms <= SEE.CLOSE;
  var planets = sky.bodies.slice(1).filter(function (b) {
    return b.alt > 0 && seeing(b.mag, b.alt, sky.sunAlt, sky.sky) <= SEE.CLOSE;
  }).length;
  var p;
  if (moonUp && planets) p = 'Moon and ' + planets + (planets === 1 ? ' planet up' : ' planets up');
  else if (moonUp) p = 'The Moon is up';
  else if (planets) p = planets + (planets === 1 ? ' planet up' : ' planets up');
  else p = 'No planets up now';
  var s;
  if (sky.sunAlt > -1) s = 'Too bright for stars';
  else if (sky.sunAlt > -6) s = 'Only the brightest';
  else if (sky.sunAlt > -12) s = 'Stars coming out';
  else s = 'Good for stars';
  var sat;
  var up = satsUp(sky);
  if (!up) sat = sky.satsNote || 'No satellite data yet';
  else if (sky.sunAlt >= DARK_SUN) sat = 'Satellites after dark';
  else if (up.station) sat = up.n > 1 ? 'Space Station + ' + (up.n - 1) + ' more' : 'Space Station is up!';
  else if (up.n) sat = up.n + (up.n === 1 ? ' satellite up' : ' satellites up');
  else sat = 'None up right now';
  return [sky.sunAlt > -6 ? p : 'Point at anything', sky.planesStatus || '', sat, p, s];
}

module.exports = { NONE_WEIGHT: NONE_WEIGHT, BRIGHTNESS_SLOPE: BRIGHTNESS_SLOPE, extinction: extinction,
                   match: match, layerStatus: layerStatus, limitingMag: limitingMag, satsUp: satsUp,
                   seeing: seeing, moonSeeing: moonSeeing, moonPhase: moonPhase, motionHint: motionHint, MIN_SHOWN: MIN_SHOWN,
                   CLOSEST_DEG: CLOSEST_DEG,
                   SEE: SEE, LAYER: LAYER, TYPE: TYPE, WORD: WORD };
