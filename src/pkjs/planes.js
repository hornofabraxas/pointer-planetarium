// Planes: live aircraft positions, fetched when an aim starts (never
// polled), moved forward to the moment of the aim, and named from Virtual
// Radar Server's standing data. See docs/DESIGN.md sections 6.1 to 6.3.
//
// Feeds (all the same readsb JSON): adsb.lol (ODbL), adsb.fi (personal,
// non-commercial use, with a link), or the user's own receiver
// (tar1090/readsb aircraft.json). Whichever public feed has been faster is
// asked first; if it hasn't answered in 2.5 s the other is asked too, and
// the first good answer wins. One answer is reused for 10 s. The location
// is rounded to 0.01 degree (about 1 km) before it leaves the phone.
//
// Standing data (CC0, via jsDelivr), fetched the first time it's needed
// and kept on the phone: airline names, routes by callsign (one file per
// airline), airports (one file per two-letter code prefix) and aircraft
// type names (one file per first letter). A route is only shown when the
// plane's position lies along it.
//
// Storage keys all start "sf_".

var A = require('./astro.js');

var FEED_REUSE_MS = 10000;
var FALLBACK_AFTER_MS = 2500;
var FEED_TIMEOUT_MS = 8000;
var MAX_POS_AGE_S = 60;
var STATS_KEY = 'sf_feedstats_v1';
var PUBLIC = ['lol', 'fi'];
var FEED_NAMES = { lol: 'adsb.lol', fi: 'adsb.fi', rx: 'your receiver' };

var VRS = 'https://cdn.jsdelivr.net/gh/vradarserver/standing-data@main/';
var ROUTE_TTL_MS = 7 * 86400000;
var TABLE_TTL_MS = 30 * 86400000;
var RETRY_MS = 30 * 60000;          // after a failed standing-data download
var BUDGET_CHARS = 1000000;         // standing data kept on the phone, all files together
var MAX_FILES = 80;
var MISS_TTL_MS = 86400000;         // "no such file" is believed for a day
var MAX_PARALLEL = 4;
var INDEX_KEY = 'sf_vrs_index_v1';  // {resource: {u: last used ms, n: size}}

var TIME_SIGMA_S = 0.5;   // how far off "when" is (clock, reaction, tracking lag)
var R_EARTH_M = 6371000;
var FT = 0.3048;
var KT = 0.514444;

// ---------------------------------------------------------------- feeds

function round2(x) {
  return (Math.round(x * 100) / 100).toFixed(2);
}

function feedUrl(id, where, opts) {
  var lat = round2(where.lat), lon = round2(where.lon), nm = opts.nm;
  if (id === 'lol') return 'https://api.adsb.lol/v2/point/' + lat + '/' + lon + '/' + nm;
  if (id === 'fi') return 'https://opendata.adsb.fi/api/v3/lat/' + lat + '/lon/' + lon + '/dist/' + nm;
  return opts.rxUrl;
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

// One feed answer -> {t (ms), ac: [...]}, or null. Bad records are
// skipped, never fatal. The feed's own clock ("now") dates the positions
// unless it disagrees with the phone by more than CLOCK_SLACK_MS, or the
// caller says not to trust it (a home receiver's clock may be off).
var CLOCK_SLACK_MS = 10000;
function parseFeed(text, recvMs, trustClock) {
  var d;
  try { d = JSON.parse(text); } catch (e) { return null; }
  if (!d || typeof d !== 'object') return null;
  var list = Array.isArray(d.ac) ? d.ac : Array.isArray(d.aircraft) ? d.aircraft : null;
  if (!list) return null;
  var now = num(d.now);
  if (now !== null && now < 1e11) now *= 1000;   // receivers give seconds, the APIs ms
  if (trustClock === false || now === null || Math.abs(now - recvMs) > CLOCK_SLACK_MS) now = recvMs;
  var ac = [];
  list.forEach(function (a) {
    if (!a || typeof a.hex !== 'string') return;
    var lat = num(a.lat), lon = num(a.lon);
    var seen = num(a.seen_pos);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    if (seen === null || seen < 0 || seen > MAX_POS_AGE_S) return;
    var ground = a.alt_baro === 'ground' || a.ground === true;
    var baro = num(a.alt_baro), geom = num(a.alt_geom);
    if (!ground && baro === null && geom === null) return;
    var track = num(a.track);
    if (track === null) track = num(a.true_heading);
    if (track === null) track = num(a.calc_track);
    ac.push({
      hex: a.hex.toLowerCase(), flight: typeof a.flight === 'string' ? a.flight.trim().toUpperCase() : '',
      r: typeof a.r === 'string' ? a.r.trim() : '', t: typeof a.t === 'string' ? a.t.trim().toUpperCase() : '',
      desc: typeof a.desc === 'string' ? a.desc : '', category: typeof a.category === 'string' ? a.category : '',
      lat: lat, lon: lon, ground: ground, baro: baro, geom: geom, gs: num(a.gs), track: track,
      vrate: num(a.geom_rate) !== null ? num(a.geom_rate) : num(a.baro_rate),
      posMs: now - seen * 1000
    });
  });
  return { t: now, ac: ac };
}

// How long a feed is left alone after it fails: "slow down" or "no" get a
// long rest (adsb.fi counts bad requests toward an IP block), anything else
// a short one.
var REFUSED_REST_MS = 10 * 60000;
var FAILED_REST_MS = 60000;
var REQUEST_LIFE_MS = 25000;   // index.js's http() always answers by then
var FI_SPACING_MS = 1500;      // adsb.fi allows one request a second

// Asks the feeds for the aircraft around a place. opts.http(url, cb(status,
// text)), opts.store ({load, save}), opts.now() and opts.setTimeout are
// injectable for tests.
//
// Rules: one request in flight per feed at a time; a failed answer is
// remembered for 10 s like a good one (so the aim right after a failed tap
// doesn't ask again); a failing feed is rested; a good answer that arrives
// after the 8 s timeout is still kept for the next aim.
function FeedClient(opts) {
  this.http = opts.http;
  this.store = opts.store;
  this.now = opts.now || function () { return Date.now(); };
  this.setTimeout = opts.setTimeout || function (fn, ms) { return setTimeout(fn, ms); };
  this.last = null;      // {key, t, data, feed}, or {key, t, data: null} after a failure
  this.pending = null;   // {key, cbs}
  this.busy = {};        // feed -> ms its request started
  this.rest = {};        // feed -> ms until which it is left alone
  this.started = {};     // feed -> ms of its last request
}

function safeCall(f, arg) {
  try {
    f(arg);
  } catch (e) {
    /* one caller's failure can't stop the others */
  }
}

// Public feeds, fastest first (by a running average of answer times;
// failures count as slow).
FeedClient.prototype.ranked = function () {
  var stats = this.store.load(STATS_KEY, {}) || {};
  return PUBLIC.slice().sort(function (a, b) {
    var sa = stats[a] && num(stats[a].ms) !== null ? stats[a].ms : 1500;
    var sb = stats[b] && num(stats[b].ms) !== null ? stats[b].ms : 1500;
    return sa - sb;
  });
};

FeedClient.prototype.record = function (id, ms) {
  if (id === 'rx') return;
  var stats = this.store.load(STATS_KEY, {}) || {};
  var prev = stats[id] && num(stats[id].ms) !== null ? stats[id].ms : ms;
  stats[id] = { ms: Math.round(0.7 * prev + 0.3 * ms) };
  this.store.save(STATS_KEY, stats);
};

// Can this feed be asked right now?
FeedClient.prototype.free = function (id) {
  var now = this.now();
  if (this.busy[id] && now - this.busy[id] < REQUEST_LIFE_MS) return false;
  if (this.rest[id] && now < this.rest[id]) return false;
  if (id === 'fi' && this.started.fi && now - this.started.fi < FI_SPACING_MS) return false;
  return true;
};

// where: {lat, lon}; prefs: {source: 'auto'|'lol'|'fi'|'rx', rxUrl, nm}.
// cb({data, feed}) or cb(null) when nothing answered in time.
FeedClient.prototype.get = function (where, prefs, cb) {
  var self = this;
  var key = round2(where.lat) + ',' + round2(where.lon) + ',' + prefs.nm + ',' + prefs.source + ',' +
            (prefs.source === 'rx' ? prefs.rxUrl : '');
  var now = this.now();
  if (this.last && this.last.key === key && now - this.last.t >= 0 && now - this.last.t < FEED_REUSE_MS) {
    safeCall(cb, this.last.data ? this.last : null);
    return;
  }
  if (this.pending && this.pending.key === key) {
    this.pending.cbs.push(cb);
    return;
  }
  var order;
  if (prefs.source === 'rx' && prefs.rxUrl) order = ['rx'].concat(this.ranked());
  else if (prefs.source === 'lol' || prefs.source === 'fi') order = [prefs.source];
  else order = this.ranked();
  order = order.filter(function (id) { return self.free(id); });
  if (!order.length) {
    safeCall(cb, null);   // everything is resting or still busy: don't ask
    return;
  }

  var job = { key: key, cbs: [cb], done: false };
  this.pending = job;
  var next = 0, failed = 0;
  function finish(result) {
    if (job.done) return;
    job.done = true;
    if (self.pending === job) self.pending = null;
    self.last = result || { key: key, t: self.now(), data: null };
    job.cbs.forEach(function (f) { safeCall(f, result); });
  }
  function launch() {
    if (job.done || next >= order.length) return;
    var id = order[next++];
    var t0 = self.now();
    self.busy[id] = t0;
    self.started[id] = t0;
    self.http(feedUrl(id, where, prefs), function (status, text) {
      delete self.busy[id];
      var t1 = self.now();
      var data = status === 200 && text ? parseFeed(text, t1, id !== 'rx') : null;
      self.record(id, data ? t1 - t0 : FEED_TIMEOUT_MS);
      if (data) {
        var result = { key: key, t: t1, data: data, feed: id };
        if (job.done) {
          // Too late for this aim, but good for the next one.
          if (!self.last || !self.last.data || self.last.t < t1) self.last = result;
          return;
        }
        finish(result);
      } else {
        self.rest[id] = t1 + (status === 403 || status === 429 ? REFUSED_REST_MS : FAILED_REST_MS);
        if (job.done) return;
        if (++failed >= order.length) finish(null);
        else launch();   // don't wait for the timer: ask the next one now
      }
    });
    if (!job.done && next < order.length) {
      self.setTimeout(function () { if (!job.done && next < order.length) launch(); }, FALLBACK_AFTER_MS);
    }
  }
  this.setTimeout(function () { finish(null); }, FEED_TIMEOUT_MS);
  launch();
};

// ---------------------------------------------------------------- standing data

// One CSV line (quoted fields allowed) -> fields.
function csvFields(line) {
  var out = [], cur = '', q = false;
  for (var i = 0; i < line.length; i++) {
    var c = line.charAt(i);
    if (q) {
      if (c === '"' && line.charAt(i + 1) === '"') { cur += '"'; i++; } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') {
      q = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// CSV text -> rows as objects keyed by the header.
function csvRows(text) {
  var lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  var head = csvFields(lines[0] || '');
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    var f = csvFields(lines[i]);
    var r = {};
    for (var k = 0; k < head.length; k++) r[head[k]] = f[k] === undefined ? '' : f[k];
    rows.push(r);
  }
  return rows;
}

// "American Airlines" -> "American", "Delta Air Lines" -> "Delta"; but a
// place name alone ("China", "Japan") keeps its "Airlines".
var KEEP_WHOLE = /^(China|Japan|British|Qatar|Turkish|Korean|Singapore|Thai|Philippine|Malaysia|Saudi|Kenya|Egypt|Pakistan|Vietnam|Ethiopian)$/;
function shortAirline(name) {
  var s = name.replace(/[,\s]+(Inc\.?|Ltd\.?|LLC|Co\.?|S\.?A\.?)$/i, '').replace(/[,\s]+$/, '').trim();
  var short = s.replace(/\s+(Air ?Lines?|Airways|Airline)$/i, '').trim();
  return short && !KEEP_WHOLE.test(short) ? short : s || name;
}

// Length in UTF-8 bytes (the watch's buffers count bytes).
function utf8Len(s) {
  return unescape(encodeURIComponent(s)).length;
}

// Clean names for the airliners seen most often; everything else comes
// from the VRS table.
var TYPE_NAMES = {
  A19N: 'Airbus A319neo', A20N: 'Airbus A320neo', A21N: 'Airbus A321neo', A318: 'Airbus A318',
  A319: 'Airbus A319', A320: 'Airbus A320', A321: 'Airbus A321', A332: 'Airbus A330-200',
  A333: 'Airbus A330-300', A339: 'Airbus A330-900', A359: 'Airbus A350-900', A35K: 'Airbus A350-1000',
  A388: 'Airbus A380', B712: 'Boeing 717', B737: 'Boeing 737-700', B738: 'Boeing 737-800',
  B739: 'Boeing 737-900', B37M: 'Boeing 737 MAX 7', B38M: 'Boeing 737 MAX 8', B39M: 'Boeing 737 MAX 9',
  B3XM: 'Boeing 737 MAX 10', B752: 'Boeing 757-200', B753: 'Boeing 757-300', B762: 'Boeing 767-200',
  B763: 'Boeing 767-300', B764: 'Boeing 767-400', B772: 'Boeing 777-200', B77L: 'Boeing 777-200LR',
  B77W: 'Boeing 777-300ER', B788: 'Boeing 787-8', B789: 'Boeing 787-9', B78X: 'Boeing 787-10',
  B744: 'Boeing 747-400', B748: 'Boeing 747-8', BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300',
  CRJ2: 'Bombardier CRJ200', CRJ7: 'Bombardier CRJ700', CRJ9: 'Bombardier CRJ900',
  CRJX: 'Bombardier CRJ1000', E170: 'Embraer 170', E75L: 'Embraer 175', E75S: 'Embraer 175',
  E190: 'Embraer 190', E195: 'Embraer 195', E290: 'Embraer E190-E2', E295: 'Embraer E195-E2',
  DH8D: 'Dash 8-400', AT72: 'ATR 72', AT76: 'ATR 72-600', MD11: 'McDonnell Douglas MD-11',
  C152: 'Cessna 152', C172: 'Cessna 172', C182: 'Cessna 182', C208: 'Cessna Caravan',
  P28A: 'Piper Cherokee', PA28: 'Piper Cherokee', SR20: 'Cirrus SR20', SR22: 'Cirrus SR22',
  R22: 'Robinson R22', R44: 'Robinson R44', R66: 'Robinson R66', PC12: 'Pilatus PC-12',
  BE36: 'Beechcraft Bonanza', BE20: 'Beechcraft King Air', GLF4: 'Gulfstream IV',
  GLF5: 'Gulfstream V', GLF6: 'Gulfstream G650', C68A: 'Cessna Citation Latitude',
  E55P: 'Embraer Phenom 300', CL35: 'Challenger 350', EC35: 'Airbus H135', AS50: 'Airbus H125'
};

// The shapes the watch can draw for an aircraft (resources/data/craft.bin,
// tools/make_craft.py), top-down, nose first. Rough on purpose: a 747 and
// a 757 look alike at this size, but neither looks like a fighter.
var CRAFT = { NONE: 0, AIRLINER: 1, JUMBO: 2, REAR_JET: 3, PROPS: 4, LIGHT: 5, HELI: 6, FAST_JET: 7, GLIDER: 8 };

// Jets with their engines at the back (regional and business jets, the
// 717, MD-80s), and fast military jets, by ICAO type code.
var REAR_JETS = /^(CRJ|E135|E35L|E145|E45X|E50P|E55P|GLF|GL5T|GL6T|GL7T|GLEX|CL30|CL35|CL60|C25|C5[0-6]|C650|C68A|C680|C700|C750|LJ|FA[0-9]|F2TH|F900|H25|PRM1|HDJT|B712|B72|MD8|MD9|DC9|F28|F70|F100|BE40|G150|G280|ASTR|WW24|SF50|PC24|EA50)/;
var FAST_JETS = /^(F14|F15|F16|F18[A-Z]?|F22|F35|F4|F5|F104|EUFI|RFAL|GRIF|T38|T45|T7|HAWK|A4|M346|L39|L159|AJET|MIR2|SU\d+|MG\d+)$/;

// The shape for a type from its VRS rows (Engines, EngineTypeCode J/T/P/E,
// SpeciesCode H helicopter G gyrocopter, WakeTurbulenceCode L/M/H/J).
function typeCraft(code, rows) {
  if (FAST_JETS.test(code)) return CRAFT.FAST_JET;
  var r = rows.filter(function (x) { return x.IsActive === '1'; })[0] || rows[0];
  if (!r) return CRAFT.NONE;
  var engines = parseInt(r.Engines, 10) || 0, kind = r.EngineTypeCode, wake = r.WakeTurbulenceCode;
  if (r.SpeciesCode === 'H' || r.SpeciesCode === 'G') return CRAFT.HELI;
  if (kind === 'J') {
    if (engines >= 4 || wake === 'J') return CRAFT.JUMBO;
    if (REAR_JETS.test(code) || wake === 'L') return CRAFT.REAR_JET;
    return engines === 1 ? CRAFT.FAST_JET : CRAFT.AIRLINER;
  }
  if (kind === 'T' || kind === 'P') return engines >= 2 ? CRAFT.PROPS : CRAFT.LIGHT;
  if (kind === 'E') return CRAFT.LIGHT;
  return CRAFT.NONE;
}

// The shape for one aircraft: what it says it is (readsb category: A7
// rotorcraft, B1 glider, A6 high performance) over its type's, then a
// guess from its size class.
function craftOf(a, typeKind) {
  if (a.category === 'A7') return CRAFT.HELI;
  if (a.category === 'B1') return CRAFT.GLIDER;
  if (a.category === 'A6') return CRAFT.FAST_JET;
  if (typeKind) return typeKind;
  if (a.category === 'A1' || a.category === 'B4') return CRAFT.LIGHT;
  if (a.category === 'A3' || a.category === 'A4' || a.category === 'A5') return CRAFT.AIRLINER;
  return CRAFT.NONE;
}

// The name for an ICAO type from its VRS rows: the manufacturer with the
// most rows, then the active model that best matches the code.
function pickTypeName(code, rows) {
  if (TYPE_NAMES[code]) return TYPE_NAMES[code];
  var count = {};
  rows.forEach(function (r) { count[r.Manufacturer] = (count[r.Manufacturer] || 0) + 1; });
  var maker = Object.keys(count).sort(function (a, b) { return count[b] - count[a]; })[0];
  var chars = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  var best = null, bestScore = -1;
  rows.forEach(function (r) {
    if (r.Manufacturer !== maker) return;
    var m = r.Model.toLowerCase(), score = 0;
    for (var i = 0; i < chars.length; i++) if (m.indexOf(chars.charAt(i)) >= 0) score++;
    score = score * 2 + (r.IsActive === '1' ? 1 : 0);
    if (score > bestScore || (score === bestScore && r.Model.length < best.Model.length)) {
      best = r;
      bestScore = score;
    }
  });
  if (!best) return null;
  var model = best.Model.replace(/\s*\(.*\)\s*$/, '').replace(/^([A-Z])-(\d)/, '$1$2');
  var full = maker + ' ' + model;
  return full.length <= 26 ? full : model.slice(0, 30);
}

// Which standing-data file holds a resource, and how to turn it into the
// small map that is kept.
var KINDS = {
  airlines: {
    path: function () { return 'airlines/schema-01/airlines.csv'; }, ttl: TABLE_TTL_MS,
    build: function (rows) {
      var m = {};
      rows.forEach(function (r) { if (/^[A-Z]{3}$/.test(r.ICAO) && r.Name && !m[r.ICAO]) m[r.ICAO] = shortAirline(r.Name); });
      return m;
    }
  },
  route: {
    path: function (k) { return 'routes/schema-01/' + k.charAt(0) + '/' + k + '-all.csv'; }, ttl: ROUTE_TTL_MS,
    build: function (rows) {
      var m = {};
      rows.forEach(function (r) { if (r.Callsign && r.AirportCodes) m[r.Callsign] = r.AirportCodes; });
      return m;
    }
  },
  apt: {
    path: function (k) { return 'airports/schema-01/' + k.charAt(0) + '/' + k + '.csv'; }, ttl: TABLE_TTL_MS,
    build: function (rows) {
      var m = {};
      rows.forEach(function (r) {
        var lat = parseFloat(r.Latitude), lon = parseFloat(r.Longitude);
        if (r.Code && isFinite(lat) && isFinite(lon)) {
          m[r.Code] = [r.Location || r.Name, r.IATA, Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4];
        }
      });
      return m;
    }
  },
  // code -> [name, CRAFT] (v2: v1 had the name alone).
  type: {
    path: function (k) { return 'model-type/schema-01/' + k + '.csv'; }, ttl: TABLE_TTL_MS, v: 2,
    build: function (rows) {
      var by = {};
      rows.forEach(function (r) { if (r.ICAO) (by[r.ICAO] = by[r.ICAO] || []).push(r); });
      var m = {};
      Object.keys(by).forEach(function (c) {
        var n = pickTypeName(c, by[c]);
        if (n) m[c] = [n, typeCraft(c, by[c])];
      });
      return m;
    }
  }
};

// store: {load, save -> true if written, remove}; http(url, cb(status, text)).
function Standing(store, http, now) {
  this.store = store;
  this.http = http;
  this.now = now || function () { return Date.now(); };
  this.memo = {};      // resource -> {t, d, miss} as stored (fresh or not)
  this.failed = {};    // resource -> ms of the last failed download
  this.waiting = {};   // resource -> [callbacks]
  this.queue = [];
  this.active = 0;
  this.index = null;   // resource -> {u: last used ms, n: stored size}; loaded on first use
  this.indexSaved = 0;
}

function resKind(res) { return res.split(':')[0]; }
function resArg(res) { return res.split(':')[1] || ''; }
function storeKey(res) { return 'sf_vrs_' + res.replace(':', '_') + '_v' + (KINDS[resKind(res)].v || 1); }

Standing.prototype.fresh = function (rec, res) {
  var now = this.now();
  var ttl = rec.miss ? MISS_TTL_MS : KINDS[resKind(res)].ttl;
  return typeof rec.t === 'number' && rec.t <= now && now - rec.t < ttl;
};

// The map for a resource if it's on the phone and fresh, else undefined.
Standing.prototype.get = function (res) {
  var rec = this.memo[res];
  if (!rec) {
    rec = this.store.load(storeKey(res), null);
    if (!rec || typeof rec !== 'object' || !rec.d || typeof rec.d !== 'object') return undefined;
    this.memo[res] = rec;   // kept even when stale, so it isn't parsed again on every look
  }
  if (!this.fresh(rec, res)) return undefined;
  this.touch(res, null);
  return rec.d;
};

Standing.prototype.loadIndex = function () {
  if (!this.index) {
    var idx = this.store.load(INDEX_KEY, {});
    this.index = idx && typeof idx === 'object' ? idx : {};
  }
  return this.index;
};

// Note a resource as just used (size n when it was just stored). Keeps the
// files on the phone under BUDGET_CHARS by dropping the least recently used.
Standing.prototype.touch = function (res, n) {
  var idx = this.loadIndex();
  var now = this.now();
  var e = idx[res];
  if (!e || typeof e !== 'object') e = idx[res] = { u: now, n: 0 };
  e.u = now;
  if (n !== null) e.n = n;
  var changed = n !== null;
  var keys = Object.keys(idx);
  var total = 0;
  keys.forEach(function (k) { total += idx[k] && idx[k].n || 0; });
  if (total > BUDGET_CHARS || keys.length > MAX_FILES) {
    keys.sort(function (a, b) { return (idx[a].u || 0) - (idx[b].u || 0); });
    for (var i = 0; i < keys.length && (total > BUDGET_CHARS || keys.length - i > MAX_FILES); i++) {
      if (keys[i] === res) continue;
      total -= idx[keys[i]].n || 0;
      if (this.store.remove) this.store.remove(storeKey(keys[i]));
      delete this.memo[keys[i]];
      delete idx[keys[i]];
      changed = true;
    }
  }
  if (changed || now - this.indexSaved > 60000) {
    this.indexSaved = now;
    this.store.save(INDEX_KEY, idx);
  }
};

// Store a downloaded resource. If storage is full, make room by dropping
// the oldest files and try once more; failing that, it's kept for this
// session only.
Standing.prototype.keep = function (res, rec) {
  this.memo[res] = rec;
  var text = JSON.stringify(rec);
  var ok = this.store.save(storeKey(res), rec) !== false;
  if (!ok) {
    var idx = this.loadIndex();
    var old = Object.keys(idx).filter(function (k) { return k !== res; })
                    .sort(function (a, b) { return (idx[a].u || 0) - (idx[b].u || 0); }).slice(0, 5);
    var self = this;
    old.forEach(function (k) {
      if (self.store.remove) self.store.remove(storeKey(k));
      delete self.memo[k];
      delete idx[k];
    });
    ok = this.store.save(storeKey(res), rec) !== false;
  }
  if (ok) this.touch(res, text.length);
};

// Make sure each resource is on the phone (downloading what's missing),
// then call done(). Never fails: missing data just stays missing.
Standing.prototype.ensure = function (list, done) {
  var self = this, left = 0, called = false;
  function one() {
    if (--left === 0 && !called) {
      called = true;
      safeCall(done);
    }
  }
  var uniq = {};
  list.forEach(function (r) { uniq[r] = true; });
  Object.keys(uniq).forEach(function (res) {
    if (self.get(res) !== undefined) return;
    if (self.failed[res] && self.now() - self.failed[res] < RETRY_MS) return;
    left++;
    if (self.waiting[res]) {
      self.waiting[res].push(one);
      return;
    }
    self.waiting[res] = [one];
    self.queue.push(res);
  });
  if (!left) {
    safeCall(done);
    return;
  }
  this.pump();
};

Standing.prototype.pump = function () {
  var self = this;
  while (this.active < MAX_PARALLEL && this.queue.length) {
    (function (res) {
      self.active++;
      self.http(VRS + KINDS[resKind(res)].path(resArg(res)), function (status, text) {
        self.active--;
        try {
          var d = null;
          if (status === 200) {
            try { d = KINDS[resKind(res)].build(csvRows(text)); } catch (e) { d = null; }
          }
          if (d) {
            self.keep(res, { t: self.now(), d: d });
          } else if (status === 404 && res !== 'airlines') {
            // No such file (an airline with no routes): remember for a day.
            self.keep(res, { t: self.now(), d: {}, miss: true });
          } else {
            self.failed[res] = self.now();
          }
        } catch (e2) {
          self.failed[res] = self.now();
        }
        var cbs = self.waiting[res] || [];
        delete self.waiting[res];
        cbs.forEach(function (f) { safeCall(f); });
        self.pump();
      });
    })(this.queue.shift());
  }
};

// "AAL0123" -> {airline: 'AAL', number: '123', key: 'AAL123'}, or null for
// callsigns that aren't airline flights (registrations, "TRON75").
function parseCallsign(cs) {
  var m = /^([A-Z]{3})(\d[0-9A-Z]{0,4})$/.exec(cs || '');
  if (!m) return null;
  var n = m[2].replace(/^0+(?=\d)/, '');
  return { airline: m[1], number: n, key: m[1] + n };
}

function aptShard(code) {
  return /^[0-9A-Z]{2}/.test(code) ? 'apt:' + code.slice(0, 2) : null;
}

// Standing-data files needed to describe these aircraft. Stage 1: airline
// names, routes and types; stage 2 (once routes are in): airports.
Standing.prototype.needs = function (acs) {
  var out = [];
  var self = this;
  acs.forEach(function (a) {
    var cs = parseCallsign(a.flight);
    if (cs) {
      out.push('airlines');
      out.push('route:' + cs.airline);
      var routes = self.get('route:' + cs.airline);
      var codes = routes && routes[cs.key];
      if (codes) codes.split('-').forEach(function (c) { var s = aptShard(c); if (s) out.push(s); });
    }
    if (/^[0-9A-Z]/.test(a.t)) out.push('type:' + a.t.charAt(0));
  });
  return out;
};

// Fetch what's needed to describe these aircraft, then done().
Standing.prototype.prepare = function (acs, done) {
  var self = this;
  this.ensure(this.needs(acs), function () {
    self.ensure(self.needs(acs), done);   // airports, now that routes are known
  });
};

// ---------------------------------------------------------------- geometry

function ecef(latDeg, lonDeg, hM) {
  var a = 6378137, e2 = 6.69437999014e-3;
  var sl = A.sind(latDeg), cl = A.cosd(latDeg);
  var n = a / Math.sqrt(1 - e2 * sl * sl);
  return [(n + hM) * cl * A.cosd(lonDeg), (n + hM) * cl * A.sind(lonDeg), (n * (1 - e2) + hM) * sl];
}

// Azimuth, elevation (degrees) and range (m) of point p seen from o.
function lookAngles(o, p) {
  var a = ecef(o.lat, o.lon, o.h), b = ecef(p.lat, p.lon, p.h);
  var d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  var sl = A.sind(o.lat), cl = A.cosd(o.lat), so = A.sind(o.lon), co = A.cosd(o.lon);
  var e = -so * d[0] + co * d[1];
  var n = -sl * co * d[0] - sl * so * d[1] + cl * d[2];
  var u = cl * co * d[0] + cl * so * d[1] + sl * d[2];
  var range = Math.sqrt(e * e + n * n + u * u);
  return { az: A.rev(A.atan2d(e, n)), el: A.asind(u / range), range: range };
}

// Move a point `dist` metres along `bearing` (great circle).
function travel(lat, lon, bearing, dist) {
  var d = dist / R_EARTH_M / A.RAD;
  var lat2 = A.asind(A.sind(lat) * A.cosd(d) + A.cosd(lat) * A.sind(d) * A.cosd(bearing));
  var lon2 = lon + A.atan2d(A.sind(bearing) * A.sind(d) * A.cosd(lat),
                            A.cosd(d) - A.sind(lat) * A.sind(lat2));
  return { lat: lat2, lon: A.wrap180(lon2) };
}

function gcDist(lat1, lon1, lat2, lon2) {   // metres
  return A.acosd(A.sind(lat1) * A.sind(lat2) + A.cosd(lat1) * A.cosd(lat2) * A.cosd(lon2 - lon1)) * A.RAD * R_EARTH_M;
}

function gcBearing(lat1, lon1, lat2, lon2) {
  return A.rev(A.atan2d(A.sind(lon2 - lon1) * A.cosd(lat2),
                        A.cosd(lat1) * A.sind(lat2) - A.sind(lat1) * A.cosd(lat2) * A.cosd(lon2 - lon1)));
}

// Does a plane at (lat, lon) heading `track` fly the leg a -> b? Returns
// how far off the leg it is (m), or null if it plainly isn't on it.
function legFit(a, b, lat, lon, track) {
  var len = gcDist(a.lat, a.lon, b.lat, b.lon);
  var d13 = gcDist(a.lat, a.lon, lat, lon);
  if (len < 1000) return null;
  var t13 = gcBearing(a.lat, a.lon, lat, lon), t12 = gcBearing(a.lat, a.lon, b.lat, b.lon);
  var xt = Math.asin(Math.sin(d13 / R_EARTH_M) * A.sind(t13 - t12)) * R_EARTH_M;
  var at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13 / R_EARTH_M) / Math.cos(xt / R_EARTH_M)))) * R_EARTH_M;
  if (A.cosd(t13 - t12) < 0) at = -at;
  // Near the airports planes wander (climbs, approaches), so allow more there.
  var slack = 60000 + 0.1 * len;
  if (Math.abs(xt) > slack || at < -80000 || at > len + 80000) return null;
  if (track !== null) {
    var p = travel(a.lat, a.lon, t12, Math.max(0, Math.min(len, at)));
    var legDir = gcBearing(p.lat, p.lon, b.lat, b.lon);
    if (at < len - 20000 && Math.abs(A.wrap180(track - legDir)) > 75) return null;
  }
  return Math.abs(xt);
}

// ---------------------------------------------------------------- the planes

function commas(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// The route a plane is flying, as {from, to} airport records, if its
// position fits one leg of its callsign's route.
// pos: where the plane is now (moved along its track), or its report.
function routeFor(a, standing, pos) {
  pos = pos || a;
  var cs = parseCallsign(a.flight);
  if (!cs) return null;
  var routes = standing.get('route:' + cs.airline);
  var codes = routes && routes[cs.key];
  if (!codes) return null;
  var apts = codes.split('-').map(function (c) {
    var s = aptShard(c);
    var m = s && standing.get(s);
    var r = m && m[c];
    return r ? { code: c, city: r[0], iata: r[1], lat: r[2], lon: r[3] } : null;
  });
  var best = null, bestXt = Infinity;
  for (var i = 0; i + 1 < apts.length; i++) {
    if (!apts[i] || !apts[i + 1]) continue;
    var xt = legFit(apts[i], apts[i + 1], pos.lat, pos.lon, a.gs !== null && a.gs > 60 ? a.track : null);
    if (xt !== null && xt < bestXt) {
      best = { from: apts[i], to: apts[i + 1] };
      bestXt = xt;
    }
  }
  return best;
}

function routeText(r) {
  var long = r.from.city + ' to ' + r.to.city;
  if (utf8Len(long) <= 30 && r.from.city && r.to.city) return long;
  return (r.from.iata || r.from.code) + ' to ' + (r.to.iata || r.to.code);
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); });
}

// Card lines for one aircraft.
function describe(a, standing, units, altFt, rangeM, pos) {
  var cs = parseCallsign(a.flight);
  var airlines = standing.get('airlines');
  var name = cs && airlines && airlines[cs.airline];
  var l1 = name ? name + ' ' + cs.number : a.flight || a.r || 'A plane';
  var route = routeFor(a, standing, pos);
  var types = a.t ? standing.get('type:' + a.t.charAt(0)) : null;
  var type = types && Array.isArray(types[a.t]) ? types[a.t] : null;
  // What it is, when known ("Boeing 737-800"): the second line with no
  // route, and the logbook's way of counting planes.
  var typeName = (type && type[0]) || TYPE_NAMES[a.t] ||
                 (a.desc ? titleCase(a.desc).replace(/\s*\(.*\)\s*$/, '') : '') ||
                 (a.category === 'A7' ? 'Helicopter' : '');
  var l2 = route ? routeText(route) : typeName || (a.r && a.r !== l1 ? a.r : 'Plane');
  var shown = a.baro !== null ? a.baro : altFt;
  var l3 = units === 'metric'
    ? commas(Math.round(shown * FT / 10) * 10) + ' m, ' + Math.max(1, Math.round(rangeM / 1000)) + ' km away'
    : commas(Math.round(shown / 100) * 100) + ' ft, ' + Math.max(1, Math.round(rangeM / 1609.344)) + ' mi away';
  return { l1: l1, l2: l2, l3: l3, route: !!route, trip: route ? trip(route) : null, typeName: typeName,
           craft: craftOf(a, type ? type[1] : 0), strip: route ? strip(route, pos) : null };
}

// A route for the watch's strip: the airports' codes and how far along
// it the plane is.
function strip(r, pos) {
  var done = gcDist(r.from.lat, r.from.lon, pos.lat, pos.lon), left = gcDist(pos.lat, pos.lon, r.to.lat, r.to.lon);
  return { from: r.from.iata || r.from.code, to: r.to.iata || r.to.code,
           share: done + left > 0 ? done / (done + left) : 0 };
}

// A route's ends and length, for its facts: {from, to (city names, or
// codes where there's no city), km}.
function trip(r) {
  var a = r.from, b = r.to;
  var c = A.sind(a.lat) * A.sind(b.lat) + A.cosd(a.lat) * A.cosd(b.lat) * A.cosd(b.lon - a.lon);
  return { from: a.city || a.iata || a.code, to: b.city || b.iata || b.code,
           km: A.acosd(Math.max(-1, Math.min(1, c))) * A.RAD * 6371 };
}

// GPS altitude for the planes that only report pressure altitude: the
// median gap between the two among nearby planes that report both, at a
// similar height.
function baroOffset(acs, baro) {
  var gaps = [];
  acs.forEach(function (a) {
    if (a.baro !== null && a.geom !== null && Math.abs(a.baro - baro) < 5000) gaps.push(a.geom - a.baro);
  });
  if (!gaps.length) return 0;
  gaps.sort(function (x, y) { return x - y; });
  return gaps[Math.floor(gaps.length / 2)];
}

// Every aircraft in the feed as seen from obs {lat, lon, altKm} at aimMs,
// moved along its track since its position was taken:
//   {type: 'plane', hex, az, altTrue, alt, rangeM, sigmaObj, mag, l1, l2, l3, route, trip, ac, altFt,
//    lat, lon, atMs (where it is, at aimMs), speedMs (ground speed, or null), move ({dx, dy}: degrees a
//    second across the sky, right and up, or null), craft (CRAFT), strip (route's {from, to, share})}
// opts: {maxKm, minAboveFt, units}. Only airborne planes above the horizon,
// in range and above the minimum height come back.
function positions(feed, aimMs, obs, opts, standing) {
  if (!feed) return [];
  var out = [];
  var o = { lat: obs.lat, lon: obs.lon, h: (obs.altKm || 0) * 1000 };
  feed.ac.forEach(function (a) {
    if (a.ground) return;
    var dt = Math.max(0, Math.min(90, (aimMs - a.posMs) / 1000));
    var pos = { lat: a.lat, lon: a.lon };
    var speed = a.gs !== null ? a.gs * KT : 0;
    if (speed > 0 && a.track !== null) pos = travel(a.lat, a.lon, a.track, speed * dt);
    var altFt = a.geom !== null ? a.geom : a.baro + baroOffset(feed.ac, a.baro);
    if (a.vrate !== null) altFt += Math.max(-6000, Math.min(6000, a.vrate)) / 60 * Math.min(dt, 30);
    var hM = altFt * FT;
    if (hM - o.h < (opts.minAboveFt || 0) * FT) return;
    var look = lookAngles(o, { lat: pos.lat, lon: pos.lon, h: hM });
    if (look.el < -1 || look.range > (opts.maxKm || 50) * 1000) return;
    // Where it really is can differ from the dead-reckoned spot: turns and
    // speed changes (5% of the distance moved), the time error, and the
    // position report itself.
    var errM = 30 + 0.05 * speed * dt + speed * TIME_SIGMA_S + (a.geom === null ? 60 : 0);
    // No speed or no direction: it could be anywhere it could have flown
    // since the report (at a typical 250 kt if the speed is unknown).
    if (a.gs === null || a.track === null) errM += (a.gs !== null ? speed : 250 * KT) * (dt + TIME_SIGMA_S);
    var d = describe(a, standing, opts.units, altFt, look.range, pos);
    // Which way it crosses the sky: where it is a second on.
    var move = null;
    if (speed > 0 && a.track !== null) {
      var p1 = travel(pos.lat, pos.lon, a.track, speed);
      var look1 = lookAngles(o, { lat: p1.lat, lon: p1.lon, h: hM + climb(a, 1) });
      move = { dx: A.wrap180(look1.az - look.az) * A.cosd(look.el), dy: look1.el - look.el };
    }
    out.push({
      type: 'plane', hex: a.hex, az: look.az, altTrue: look.el, alt: look.el, rangeM: look.range,
      sigmaObj: Math.atan(errM / look.range) / A.RAD,
      // How noticeable: like a magnitude, brighter (lower) when near.
      mag: -1 + 5 * Math.log10(Math.max(1000, look.range) / 5000),
      l1: d.l1, l2: d.l2, l3: d.l3, route: d.route, trip: d.trip, ac: a, altFt: altFt,
      lat: pos.lat, lon: pos.lon, atMs: aimMs, speedMs: speed > 0 ? speed : null, move: move,
      craft: d.craft, strip: d.strip, typeName: d.typeName
    });
  });
  return out;
}

// Metres climbed (or descended) in dt seconds at its reported rate, the
// rate held at most 30 seconds.
function climb(a, dt) {
  if (a.vrate === null) return 0;
  return Math.max(-6000, Math.min(6000, a.vrate)) / 60 * FT * Math.max(-30, Math.min(30, dt));
}

// Where a plane from positions() is at each of dates (flying straight on
// at its speed, before and after), as {az, alt} for its chart; null with
// no speed or direction.
function path(pl, dates, obs) {
  var a = pl.ac;
  if (!a || a.gs === null || a.track === null || !(a.gs > 0)) return null;
  var o = { lat: obs.lat, lon: obs.lon, h: (obs.altKm || 0) * 1000 };
  return dates.map(function (date) {
    var dt = (date.getTime() - pl.atMs) / 1000;
    var p = travel(pl.lat, pl.lon, a.track, a.gs * KT * dt);
    var look = lookAngles(o, { lat: p.lat, lon: p.lon, h: pl.altFt * FT + climb(a, dt) });
    return { az: look.az, alt: look.el };
  });
}

module.exports = {
  FeedClient: FeedClient, Standing: Standing, parseFeed: parseFeed, positions: positions,
  parseCallsign: parseCallsign, csvRows: csvRows, shortAirline: shortAirline, pickTypeName: pickTypeName,
  routeFor: routeFor, legFit: legFit, path: path, CRAFT: CRAFT, typeCraft: typeCraft, craftOf: craftOf, lookAngles: lookAngles, travel: travel, feedUrl: feedUrl,
  utf8Len: utf8Len, FEED_NAMES: FEED_NAMES, FEED_REUSE_MS: FEED_REUSE_MS, FALLBACK_AFTER_MS: FALLBACK_AFTER_MS,
  FEED_TIMEOUT_MS: FEED_TIMEOUT_MS
};
