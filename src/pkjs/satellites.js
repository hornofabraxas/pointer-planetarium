// Satellites: element sets from CelesTrak, kept on the phone and moved
// forward with SGP4 (satellite.js) to the moment of an aim.
//
// Three CelesTrak groups (docs/DESIGN.md section 6.1):
//   stations       the space stations, and whatever is docked to them
//   visual         about 150 of the brightest satellites and rocket stages
//   last-30-days   recent launches, of which only the batches that fly as a
//                  "train" (Starlink, Kuiper, ...) are kept
//
// CelesTrak updates each group every 2 hours and answers 403 to a second
// download of the same group inside that window. So each group is fetched
// at most once a day, never within 2 hours of the last try, and the gap
// doubles after each failure. A failed fetch keeps the old copy.
//
// Storage keys all start "sf_sat_".

var sat = require('./satellite.min.js');   // satellite.js 6.0.2, MIT (see NOTICE)
var A = require('./astro.js');
var planets = require('./planets.js');

var GROUPS = ['stations', 'visual', 'last-30-days'];
var URL = 'https://celestrak.org/NORAD/elements/gp.php?FORMAT=json&GROUP=';
var DATA_KEY = 'sf_sat_';           // + group + '_v1': {t, sats}
var TRIES_KEY = 'sf_sat_tries_v1';  // {group: {t, fails}}
var STALE_MS = 24 * 3600 * 1000;
var MIN_GAP_MS = (2 * 60 + 5) * 60 * 1000;
var MAX_GAP_MS = 24 * 3600 * 1000;

var MAX_AGE_DAYS = 10;      // older elements are too far off to name anything
var MIN_REVS_PER_DAY = 10;  // low orbits only (below about 2,500 km): nothing higher is seen
var TRAIN_MIN = 5;          // a launch with this many alike payloads flies as a train
var TRAIN_LINK_DEG = 6;     // train members this close together read as one line
var DOCKED_KM = 25;         // stations objects this close to a station are docked to it (a
                            // docked ship's own elements can be older and km off)
var TIME_SIGMA_S = 0.5;     // how far off "when" is: watch clock, reaction, tracking lag
var R_EARTH = 6378.137;

// Friendly names, and standard magnitudes (at 1,000 km, half lit) for the
// prior. Everything else gets a default by group.
var KNOWN = {
  25544: { l1: 'Space Station', l2: 'The ISS', mag: -1.3, rank: 3 },
  48274: { l1: 'Tiangong', l2: 'Chinese space station', mag: 0.5, rank: 2 },
  20580: { l1: 'Hubble', l2: 'Space telescope', mag: 2.5, rank: 1 }
};
var DEFAULT_MAG = { stations: 5, visual: 3, 'last-30-days': 5 };

var FIELDS = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
              'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'NORAD_CAT_ID', 'BSTAR',
              'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];
var NUMERIC = FIELDS.slice(3);

// ---------------------------------------------------------------- fetching

// One element set, cut down to what SGP4 needs, or null if it's unusable
// or in an orbit too high to see.
function trim(o) {
  if (!o || typeof o.OBJECT_NAME !== 'string' || typeof o.EPOCH !== 'string') return null;
  var t = {};
  for (var i = 0; i < FIELDS.length; i++) t[FIELDS[i]] = o[FIELDS[i]];
  for (var j = 0; j < NUMERIC.length; j++) {
    var v = Number(t[NUMERIC[j]]);
    if (!isFinite(v)) return null;
    t[NUMERIC[j]] = v;
  }
  if (typeof t.OBJECT_ID !== 'string') t.OBJECT_ID = '';
  // CelesTrak gives microseconds ("13:30:47.478528"). JavaScript only
  // promises to parse milliseconds, so cut the fraction to 3 digits (here
  // and for satellite.js, which parses the same string).
  t.EPOCH = t.EPOCH.replace(/(\.\d{3})\d+/, '$1');
  if (!isFinite(epochMs(t))) return null;
  if (t.MEAN_MOTION < MIN_REVS_PER_DAY || t.ECCENTRICITY < 0 || t.ECCENTRICITY > 0.2) return null;
  return t;
}

function epochMs(o) {
  return Date.parse(/Z$/.test(o.EPOCH) ? o.EPOCH : o.EPOCH + 'Z');
}

// "STARLINK-11234" -> "STARLINK". Unnamed pieces ("OBJECT A"), debris and
// rocket stages are never train members, nor are rideshare launches (dozens
// of different satellites named after the mission, "TRANSPORTER-18 OBJECT
// C"). A batch not yet identified ("QIANFAN 16 OBJECT A") still counts.
var RIDESHARE = { TRANSPORTER: 1, BANDWAGON: 1 };
function family(name) {
  if (/\bDEB\b|R\/B|^OBJECT\b/.test(name)) return null;
  var m = /^([A-Z]{3,})[- ]?\d/.exec(name);
  return m && !RIDESHARE[m[1]] ? m[1] : null;
}

// From recent launches keep only the train members: payloads of one launch
// that share a name family, at least TRAIN_MIN of them.
function trainsOnly(list) {
  var counts = {};
  list.forEach(function (o) {
    var f = family(o.OBJECT_NAME);
    if (f && o.OBJECT_ID) counts[o.OBJECT_ID.slice(0, 8) + f] = (counts[o.OBJECT_ID.slice(0, 8) + f] || 0) + 1;
  });
  return list.filter(function (o) {
    var f = family(o.OBJECT_NAME);
    return f && o.OBJECT_ID && counts[o.OBJECT_ID.slice(0, 8) + f] >= TRAIN_MIN;
  });
}

// The usable objects in one downloaded group, or null if the download is
// no good. A list where nothing at all parses counts as no good (something
// changed at the source), except for recent launches, which can
// legitimately hold no train.
function parseGroup(group, text) {
  var raw;
  try { raw = JSON.parse(text); } catch (e) { return null; }
  if (!Array.isArray(raw) || !raw.length) return null;
  var list = raw.map(trim).filter(Boolean);
  if (!list.length) return null;
  if (group === 'last-30-days') list = trainsOnly(list);
  return list;
}

// Tries made this session, kept here too so that if storage can't be
// written a session still never asks twice.
var sessionTries = {};

// store: {load(key, fallback), save(key, value) -> true if written}.
// http(url, cb(status, text)).
// enabled: {stations, visual, 'last-30-days'} booleans. Fetches what is due,
// one group at a time, then calls done(changed).
function refresh(store, http, enabled, now, done) {
  var tries = store.load(TRIES_KEY, {}) || {};
  if (typeof tries !== 'object') tries = {};
  Object.keys(sessionTries).forEach(function (g) {
    if (!tries[g] || tries[g].t < sessionTries[g].t) tries[g] = sessionTries[g];
  });
  // A time in the future (the phone's clock was wrong, then fixed) counts
  // as long ago, so a clock change can't freeze the refresh.
  function since(t) { return typeof t === 'number' && t <= now ? now - t : Infinity; }
  var due = GROUPS.filter(function (g) {
    if (!enabled[g]) return false;
    var have = store.load(DATA_KEY + g + '_v1', null);
    if (have && since(have.t) < STALE_MS) return false;
    var tr = tries[g];
    if (!tr) return true;
    var gap = Math.min(MAX_GAP_MS, MIN_GAP_MS * Math.pow(2, Math.max(0, Math.min((tr.fails || 0) - 1, 6))));
    return since(tr.t) >= gap;
  });
  var changed = false;
  (function next() {
    if (!due.length) {
      if (done) done(changed);
      return;
    }
    var g = due.shift();
    var prev = tries[g] || { fails: 0 };
    // Write the try down before asking, so a crash mid-request still counts.
    tries[g] = sessionTries[g] = { t: now, fails: prev.fails || 0 };
    store.save(TRIES_KEY, tries);
    http(URL + g, function (status, text) {
      var list = status === 200 && text ? parseGroup(g, text) : null;
      // Data that can't be stored (storage full) counts as a failure, so
      // the download isn't repeated every time the app opens.
      if (list && store.save(DATA_KEY + g + '_v1', { t: now, sats: list }) !== false) {
        tries[g] = { t: now, fails: 0 };
        changed = true;
      } else {
        tries[g] = { t: now, fails: (prev.fails || 0) + 1 };
      }
      sessionTries[g] = tries[g];
      store.save(TRIES_KEY, tries);
      next();
    });
  })();
}

// When each enabled group was last downloaded (ms), or null.
function fetchedAt(store, enabled) {
  var out = {};
  GROUPS.forEach(function (g) {
    var have = enabled[g] ? store.load(DATA_KEY + g + '_v1', null) : null;
    out[g] = have ? have.t : null;
  });
  return out;
}

// ---------------------------------------------------------------- catalog

function titleWord(w) {
  return /^[A-Z]{4,}$/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w;
}

function prettyName(name) {
  return name.replace(/\s+/g, ' ').trim().split(' ').map(function (w) {
    return w.split('-').map(titleWord).join('-');
  }).join(' ').replace(/^([A-Z][a-z]+)-(\d)/, '$1 $2');
}

// Card lines and brightness for one object.
function describe(o, group) {
  var known = KNOWN[o.NORAD_CAT_ID];
  if (known) return { l1: known.l1, l2: known.l2, mag: known.mag, rank: known.rank };
  var name = o.OBJECT_NAME;
  var mag = DEFAULT_MAG[group];
  if (/R\/B/.test(name)) {
    return { l1: prettyName(name.replace(/\s*R\/B\s*/, ' ')) + ' rocket', l2: 'Used rocket stage',
             mag: mag, rank: 0 };
  }
  if (/\bDEB\b/.test(name)) return { l1: prettyName(name.replace(/\s*DEB\b/, '')), l2: 'Debris', mag: mag, rank: 0 };
  return { l1: prettyName(name), l2: 'Satellite', mag: mag, rank: 0 };
}

var memo = { key: null, cat: null };

// Every usable object from the enabled groups, each with its SGP4 record.
// Rebuilt only when the stored data changes. Returns null if there is no
// data at all yet.
function catalog(store, enabled) {
  var have = {};
  GROUPS.forEach(function (g) { if (enabled[g]) have[g] = store.load(DATA_KEY + g + '_v1', null); });
  var key = GROUPS.map(function (g) { return have[g] ? g + have[g].t : ''; }).join('|');
  if (key === memo.key) return memo.cat;
  var seen = {};
  var cat = [];
  var any = false;
  GROUPS.forEach(function (g) {
    if (!have[g] || !Array.isArray(have[g].sats)) return;
    any = true;
    have[g].sats.forEach(function (o) {
      if (!o || typeof o.OBJECT_NAME !== 'string' || typeof o.OBJECT_ID !== 'string') return;
      if (seen[o.NORAD_CAT_ID]) return;   // the ISS is in both stations and visual
      var rec;
      try { rec = sat.json2satrec(o); } catch (e) { return; }
      if (!rec || rec.error || !isFinite(epochMs(o))) return;
      seen[o.NORAD_CAT_ID] = true;
      var d = describe(o, g);
      var fam = g === 'last-30-days' ? family(o.OBJECT_NAME) : null;
      cat.push({
        id: o.NORAD_CAT_ID, name: o.OBJECT_NAME, group: g, launch: o.OBJECT_ID.slice(0, 8),
        epoch: epochMs(o), rec: rec, l1: d.l1, l2: d.l2, stdMag: d.mag, rank: d.rank,
        train: fam ? titleWord(fam) : null
      });
    });
  });
  memo = { key: key, cat: any ? cat : null };
  return memo.cat;
}

// ---------------------------------------------------------------- positions

function v3(p) { return [p.x, p.y, p.z]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function len(a) { return Math.sqrt(dot(a, a)); }

// Is a satellite at ECI position p (km) in sunlight? A cylinder for the
// Earth's shadow is plenty at these heights. sunU: unit vector to the Sun.
function sunlit(p, sunU) {
  var along = dot(p, sunU);
  if (along >= 0) return true;
  return dot(p, p) - along * along > R_EARTH * R_EARTH;
}

// Brightness from the standard magnitude, the range and the phase angle
// (diffuse sphere).
function magnitude(stdMag, rangeKm, phaseDeg) {
  var ph = phaseDeg * A.RAD;
  var f = Math.max(0.01, Math.sin(ph) + (Math.PI - ph) * Math.cos(ph));
  return stdMag + 5 * Math.log10(rangeKm / 1000) - 2.5 * Math.log10(f);
}

function propagate(rec, date) {
  try {
    var pv = sat.propagate(rec, date);
    return pv && pv.position && isFinite(pv.position.x) ? pv : null;
  } catch (e) {
    return null;
  }
}

// The Sun's direction in the equatorial frame of date, from the app's own
// (PyEphem-checked) Sun. satellite.js's sunPos mixes degrees and radians in
// its mean anomaly and is up to a degree off around January and July.
function sunVector(date) {
  var d = A.julianDay(date) - 2451543.5;
  var s = planets.sunEcliptic(d);
  var q = A.eclToEq(s.lon, 0, A.obliquity(d));
  return [A.cosd(q.dec) * A.cosd(q.ra), A.cosd(q.dec) * A.sind(q.ra), A.sind(q.dec)];
}

// Where everything in the catalog is at `date` for an observer at
// {lat, lon, altKm}. Only objects above the horizon come back. The list's
// `usable` property counts objects whose elements are recent enough, up or
// not (0 means the data is too old to use).
//   {type: 'sat', id, name, az, altTrue, alt, rangeKm, heightKm, lit, mag,
//    sigmaObj, rank, group, launch, eci (km), l1, l2, l3, speedMs, move
//    ({dx, dy}: degrees a second across the sky, right and up), cluster,
//    clusterSize, train}
// units: 'imperial' or 'metric' for the height line.
function positions(cat, date, obs, units) {
  if (!cat) return [];
  var gmst = sat.gstime(date);
  var later = new Date(date.getTime() + 1000);
  var gmst1 = sat.gstime(later);
  var gd = { latitude: obs.lat * A.RAD, longitude: obs.lon * A.RAD, height: obs.altKm || 0 };
  var obsEci = v3(sat.ecfToEci(sat.geodeticToEcf(gd), gmst));
  var sunU = sunVector(date);
  var out = [];
  var usable = 0;

  cat.forEach(function (c) {
    var ageDays = (date.getTime() - c.epoch) / 86400000;
    if (Math.abs(ageDays) > MAX_AGE_DAYS) return;
    usable++;
    var pv = propagate(c.rec, date);
    if (!pv) return;
    var look = sat.ecfToLookAngles(gd, sat.eciToEcf(pv.position, gmst));
    var altTrue = look.elevation / A.RAD;
    if (altTrue < -1) return;
    var az = A.rev(look.azimuth / A.RAD);
    var p = v3(pv.position);
    var range = look.rangeSat;

    // How fast it crosses the sky, and which way as you face it.
    var rate = 0, move = null;
    var pv1 = propagate(c.rec, later);
    if (pv1) {
      var look1 = sat.ecfToLookAngles(gd, sat.eciToEcf(pv1.position, gmst1));
      var az1 = look1.azimuth / A.RAD, alt1 = look1.elevation / A.RAD;
      rate = A.separation(az, altTrue, az1, alt1);
      move = { dx: A.wrap180(az1 - az) * A.cosd(altTrue), dy: alt1 - altTrue };
    }
    // Its speed in orbit (km/s, about 7.7 for the Space Station).
    var vel = pv.velocity;
    var speedKms = vel && isFinite(vel.x) ? Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z) : null;
    var height = sat.eciToGeodetic(pv.position, gmst).height;

    // Element sets drift: about 2 km a day at first, faster after 3 days.
    var age = Math.abs(ageDays);
    var errKm = 1 + (age <= 3 ? 2 * age : 6 + 6 * (age - 3));
    var posDeg = Math.atan(errKm / range) / A.RAD;
    var timeDeg = rate * TIME_SIGMA_S;

    var lit = sunlit(p, sunU);
    var toObs = sub(obsEci, p);
    var phase = A.acosd(dot(toObs, sunU) / len(toObs));
    var hText = units === 'metric' ? Math.round(height) + ' km up' :
                Math.round(height * 0.621371) + ' mi up';
    out.push({
      type: 'sat', id: c.id, name: c.name, az: az, altTrue: altTrue,
      alt: altTrue + A.refraction(altTrue), rangeKm: range, heightKm: height, lit: lit,
      mag: magnitude(c.stdMag, range, phase), sigmaObj: Math.sqrt(posDeg * posDeg + timeDeg * timeDeg),
      rank: c.rank, group: c.group, launch: c.launch, eci: p, l1: c.l1, l2: c.l2,
      l3: hText, speedMs: speedKms ? speedKms * 1000 : null, move: move,
      train: c.train, cluster: null, clusterSize: 1
    });
  });

  // Visiting ships and modules docked at a station sit on top of it: keep
  // the station. (Only the big stations absorb neighbours; two small
  // objects near each other both stay.)
  var stations = out.filter(function (o) { return o.group === 'stations'; });
  var docked = {};
  stations.forEach(function (o) {
    if (o.rank < 2) return;
    stations.forEach(function (q) {
      if (q !== o && q.rank < o.rank && len(sub(q.eci, o.eci)) < DOCKED_KM) docked[q.id] = true;
    });
  });
  out = out.filter(function (o) { return !docked[o.id]; });

  // Trains: sunlit members of one launch, chained by nearness, count as
  // one line of lights.
  var byLaunch = {};
  out.forEach(function (o) {
    if (o.train && o.lit) (byLaunch[o.launch + o.train] = byLaunch[o.launch + o.train] || []).push(o);
  });
  Object.keys(byLaunch).forEach(function (k) {
    var m = byLaunch[k];
    var root = m.map(function (_, i) { return i; });
    function find(i) { return root[i] === i ? i : (root[i] = find(root[i])); }
    for (var i = 0; i < m.length; i++) {
      for (var j = i + 1; j < m.length; j++) {
        if (A.separation(m[i].az, m[i].altTrue, m[j].az, m[j].altTrue) < TRAIN_LINK_DEG) root[find(i)] = find(j);
      }
    }
    var size = {};
    m.forEach(function (o, i) { size[find(i)] = (size[find(i)] || 0) + 1; });
    m.forEach(function (o, i) {
      o.cluster = k + '#' + find(i);
      o.clusterSize = size[find(i)];
    });
  });
  out.usable = usable;
  return out;
}

// Where one object (NORAD id) is over time, for its path on the chart:
// [{az, alt (apparent)}] at each of dates, null where it can't be worked
// out; null if the id isn't in the catalog.
function path(cat, id, dates, obs) {
  var c = (cat || []).filter(function (x) { return x.id === id; })[0];
  if (!c) return null;
  var gd = { latitude: obs.lat * A.RAD, longitude: obs.lon * A.RAD, height: obs.altKm || 0 };
  return dates.map(function (date) {
    var pv = propagate(c.rec, date);
    if (!pv) return null;
    var look = sat.ecfToLookAngles(gd, sat.eciToEcf(pv.position, sat.gstime(date)));
    var altTrue = look.elevation / A.RAD;
    return { az: A.rev(look.azimuth / A.RAD), alt: altTrue + A.refraction(altTrue) };
  });
}

// The Sun's height (degrees, true) for an observer at `date`.
function sunAlt(date, obs) {
  var u = sunVector(date);
  var ra = A.rev(A.atan2d(u[1], u[0])), dec = A.asind(u[2]);
  return A.eqToHorizon(ra, dec, A.julianDay(date), obs.lat, obs.lon).alt;
}

// The visible passes of one object (NORAD id) starting within `hours`
// of `from` (a Date), at most `max`: above minAlt (true), sunlit, with
// the Sun at least 6 degrees down for the observer. Each: {start, end
// (ms), peak (degrees, apparent), fromAz, toAz, track ([{az, alt}]
// apparent, `pts` points evenly from start to end), step (seconds between
// them)}. A pass under way at `from` starts at `from`. Null if the id
// isn't in the catalog or its elements are too old.
var PASS_SCAN_S = 30;      // a pass is looked for this often ...
var PASS_FINE_S = 5;       // ... and its ends found to this
function passes(cat, id, from, hours, obs, opts) {
  var c = (cat || []).filter(function (x) { return x.id === id; })[0];
  if (!c || Math.abs((from.getTime() - c.epoch) / 86400000) > MAX_AGE_DAYS) return null;
  var minAlt = opts.minAlt, max = opts.max || 1, pts = opts.pts || 24;
  var gd = { latitude: obs.lat * A.RAD, longitude: obs.lon * A.RAD, height: obs.altKm || 0 };
  // Where it is at t (ms), and whether it can be seen there (the Sun
  // first: by day there's no need to run the orbit).
  function at(t) {
    var date = new Date(t);
    if (sunAlt(date, obs) > -6) return null;
    var pv = propagate(c.rec, date);
    if (!pv) return null;
    var look = sat.ecfToLookAngles(gd, sat.eciToEcf(pv.position, sat.gstime(date)));
    var altTrue = look.elevation / A.RAD;
    if (altTrue < minAlt || !sunlit(v3(pv.position), sunVector(date))) return null;
    return { az: A.rev(look.azimuth / A.RAD), alt: altTrue + A.refraction(altTrue) };
  }
  // The edge between t0 (seen: want) and t1 (not), to PASS_FINE_S.
  function edge(t0, t1, want) {
    var t = t0;
    var dir = t1 > t0 ? 1 : -1;
    while ((t1 - t) * dir > PASS_FINE_S * 1000 && !!at(t + dir * PASS_FINE_S * 1000) === want) t += dir * PASS_FINE_S * 1000;
    return t;
  }
  var out = [];
  var t0 = from.getTime(), stop = t0 + hours * 3600000;
  var start = at(t0) ? t0 : null;
  for (var t = t0 + PASS_SCAN_S * 1000; t <= stop + 30 * 60000 && out.length < max; t += PASS_SCAN_S * 1000) {
    var seen = !!at(t);
    if (seen && start === null) {
      if (t > stop) break;
      start = edge(t, t - PASS_SCAN_S * 1000, true);
    } else if (!seen && start !== null) {
      var end = edge(t - PASS_SCAN_S * 1000, t, true);
      if (end > start) out.push(passTrack(start, end));
      start = null;
    }
  }
  function passTrack(s, e) {
    var step = Math.max(1, Math.ceil((e - s) / 1000 / (pts - 1)));
    var track = [], peak = -90;
    for (var k = s; k <= e + 1; k += step * 1000) {
      var q = at(k) || at(Math.min(k, e));
      if (!q) break;
      track.push(q);
      peak = Math.max(peak, q.alt);
    }
    return { start: s, end: e, peak: peak, fromAz: track.length ? track[0].az : 0,
             toAz: track.length ? track[track.length - 1].az : 0, track: track, step: step };
  }
  return out.filter(function (q) { return q.track.length >= 2; });
}

module.exports = {
  GROUPS: GROUPS, refresh: refresh, fetchedAt: fetchedAt, catalog: catalog, positions: positions, path: path,
  passes: passes, sunAlt: sunAlt,
  parseGroup: parseGroup, prettyName: prettyName, magnitude: magnitude, sunlit: sunlit,
  sunVector: sunVector, resetSession: function () { sessionTries = {}; },
  STALE_MS: STALE_MS, MIN_GAP_MS: MIN_GAP_MS
};
