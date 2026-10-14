// Pointer Planetarium phone side. The watch senses and draws; this file does the
// thinking: where the user pointed (attitude + magnetic declination), what
// is there (Moon, planets, stars, satellites, planes), and the result cards
// to show.
//
// Messages (see docs/DESIGN.md section 3.4):
//   watch -> phone  AIM_START (layer)             SELECT tapped
//                   FIND_REQ                      Find it: what's up to find?
//                   FIND_FOUND (target), A_SEQ    Find it: locked on to a target
//                   + EPH_REQ                     (with AIM_START or FIND_REQ) the watch's
//                                                 Moon-and-planets table is missing or
//                                                 running out
//                   A_SEQ .. A_WRIST              one finished aim
//                   + A_TUNE (1, 2, 3)            ... that is a "Tune my aim" aim
//                   PREFS                         your sky and gear (bits 0-5, as the sky
//                                                 frame's last byte), Keep light on (bits
//                                                 6-7: LIGHT), the theme (bits 8-15)
//                                                 and, in bit 16, that those three were
//                                                 just chosen on the watch (that change's
//                                                 number in bits 17-23)
//   phone -> watch  DAYLIGHT, LAYERS, STATUS,     on open and every minute
//                   TUNE_TGT (the Moon, when it
//                   can be tuned on), SKY_FRAME,
//                   PREFS (sky, gear, light, the watch's
//                   theme plus one (0: not heard
//                   yet), the number of the last
//                   change taken from the watch in
//                   bits 17-23), NEW_PLACE (far
//                   from where the sky was set,
//                   after dark: ask again)
//                   FIND_LIST, SKY_FRAME          the targets for Find it (find.js)
//                   SKY_EPH                       when asked, or after a move: the Moon and
//                                                 planets for the days ahead, so the watch
//                                                 can answer with no phone (ephem.js)
//                   R_SEQ, R_DATA                 the cards for one aim (or a found target)
//                   + R_CHART, R_FACT             ... the chart and the fact for the
//                                                 chart and fact cards among them
//                   + TUNE_N                      ... with tune aims accepted so far
//                   + WRIST_Q                     ... "is it on this wrist?" (the aims
//                                                 keep pointing into the ground)
//
// Network use: satellite element sets from CelesTrak, at most daily
// (satellites.js); aircraft around you when an aim starts in PLANES or
// ANYTHING, never polled, plus plane names and routes looked up once and
// kept (planes.js). Everything else is computed on the phone. Storage keys
// all start "sf_" (the Pebble app may share one storage area between apps).

var A = require('./astro.js');
var planets = require('./planets.js');
var moon = require('./moon.js');
var wmm = require('./wmm.js');
var attitude = require('./attitude.js');
var matcher = require('./matcher.js');
var satellites = require('./satellites.js');
var planes = require('./planes.js');
var tune = require('./tune.js');
var facts = require('./facts.js');
var chart = require('./chart.js');
var stars = require('./stars.js');
var find = require('./find.js');
var patterns = require('./patterns.js');
var logbook = require('./logbook.js');
var ephem = require('./ephem.js');
var page = require('./settings_page.js');
var collection = require('./collection.js');
var Diag = require('./diag.js').Diag;

var LOC_KEY = 'sf_location_v1';
var SKY_KEY = 'sf_sky_v1';
var SATS_KEY = 'sf_sats_v1';
var UNITS_KEY = 'sf_units_v1';
var PLANES_KEY = 'sf_planes_v1';
var AIM_KEY = 'sf_aim_v2';         // {"0": left wrist, "1": right}: recent offset samples (tune.js)
var OLD_FINGER_KEY = 'sf_finger_v1';   // v0.6/v0.7 one-target tunes: dropped, learning replaces them
var OLD_DEV_KEY = 'sf_dev_v1';     // before v1.0: a developer's field test switch (dropped)
var OLD_LOG_KEY = 'sf_aimlog_v1';  // before v1.0: a developer's aim log (dropped)
var FACTS_KEY = 'sf_facts_v1';     // fun facts on the answers (true unless turned off)
var SHOW_KEY = 'sf_findshow_v1';   // what Find it shows (find.SHOW): binoculars unless set
var LIGHT_KEY = 'sf_light_v1';     // Keep light on (LIGHT): read30 unless set
var FACTS_SEEN_KEY = 'sf_factseen_v1';   // {n: {subject: facts shown for it}, keys (oldest first), last}
var OLD_FACTN_KEY = 'sf_factn_v1';       // before v0.21: one count for everything
var TYPES_V1_GONE_KEY = 'sf_typesv1gone';  // the v0.21 aircraft-type tables have been dropped
var FACTS_SEEN_MAX = 200;                // subjects remembered
var EPH_KEY = 'sf_eph_v1';         // {lat, lon}: where the watch's table was last made for
var EPH_MOVE_DEG = 0.5;            // a move this far gets the watch a new table
var PLACE_KEY = 'sf_skyplace_v1';  // {lat, lon}: where the sky setting was last chosen
var PLACE_KM = 50;                 // farther than this from there, after dark: the watch asks again
var WTHEME_KEY = 'sf_wtheme_v1';   // the watch's theme (THEME), for the settings page's colours
var BOOK_KEY = 'sf_logbook_v1';    // what you've seen (logbook.js), oldest first
var OLD_BOOK_PLACES_KEY = 'sf_bookplaces_v1';   // before v0.27: places named by hand (now looked up)
var BOOK_WHERE_KEY = 'sf_bookwhere_v1';     // note roughly where things were seen (true unless turned off)
var WSEQ_KEY = 'sf_wseq_v1';       // the number of the last sky-and-gear change taken from the watch
// main.c's themes, by their stored numbers.
var THEME = { AUTO: 0, DAY: 1, NIGHT: 2, STAR: 3, AUTO_STAR: 4, COUNT: 5 };
var SETTINGS_KEYS = [SKY_KEY, SATS_KEY, UNITS_KEY, PLANES_KEY, AIM_KEY, FACTS_KEY, SHOW_KEY, LIGHT_KEY];
// Keep light on, by main.c's numbers (LIGHT_*): while finding and for 30 s
// (or a minute) of reading, only while finding, or the watch's own timing.
var LIGHT = ['read30', 'read60', 'finding', 'watch'];
var LOC_FRESH_MS = 10 * 60 * 1000;
var HTTP_TIMEOUT_MS = 20000;
// The version in package.json (test/pkjs.test.js checks they agree), for
// the diagnostics.
var APP_VERSION = '1.1';
// How long an answer waits for plane data, counted from the aim (the
// request went out at the tap, a couple of seconds before). Abroad and on
// mobile data a feed can take several seconds, so PLANES waits long (the
// watch gives up at 12 s, main.c WAIT_TIMEOUT_MS); ANYTHING has stars and
// planets to give meanwhile, so it waits less, unless the feeds have been
// slow here lately (or haven't been asked yet).
var AIM_WAIT_MS = 9000;
var ANY_WAIT_MS = 2500;
var ANY_SLOW_WAIT_MS = 6000;
var SLOW_FEED_MS = 1500;
// No aircraft at all near you: one wide look (once an hour, for a degree
// of latitude and longitude) tells an empty sky from a place the feeds
// barely cover. Fewer than THIN_N aircraft within COVER_NM: thin.
var COVER_KEY = 'sf_cover_v1';   // {lat, lon (whole degrees), t, thin, n}
var COVER_NM = 200;
var COVER_RECHECK_MS = 3600000;
var COVER_KEEP_MS = 7 * 86400000;
var THIN_N = 10;
var PLANES_STATUS_MS = 10 * 60000;   // "14 planes nearby" is stale after this
var TUNE_SESSION_MS = 10 * 60000;    // a tune left this long starts over
var WEAK_BEFORE_TIP = 3;             // unsure answers in a row before suggesting Tune on the Moon
var WRONG_WRIST_ASK = 2;             // aims in a row into the ground (and at the sky from the other
                                     // wrist) before asking which wrist the watch is on
var GROUND_ALT = -10;
var TUNE_CANT = 255;                 // TUNE_N: tuning can't go on (the watch shows the card and stops)

// Pointing uncertainty (degrees, 1 sigma) by compass state. The night of
// 2026-10-08 (37 aims, measured in the field) came to about 2.7 per axis, 3.8 of
// it left/right; 4 keeps a margin and lost no right answer there.
var SIGMA_CALIBRATED = 4;
var SIGMA_CALIBRATING = 9;

var here = validLocation(loadJSON(LOC_KEY, null));   // {lat, lon, altKm, t}
var daylight = null;
var locating = false;
var satFetching = false;
var satAgain = false;   // settings changed mid-fetch: go round once more
var planesStatus = '';  // the PLANES status line, from the latest plane data
var planesStatusT = 0;
var tuneSession = null; // {wrist, id, name, type, samples, t}
var closestTune = null; // {id, t}: the target a CLOSEST card offered to tune on
var weakRun = 0;        // answers in a row with nothing better than MAYBE
var groundRun = 0;      // aims in a row that look like the wrong wrist
var findList = null;    // the targets last sent for Find it, by id
var ephPending = false; // the watch asked for its table before there was a location
var placePending = false; // the sky was chosen before there was a location: note where, once known

function loadJSON(key, fallback) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

function validLocation(h) {
  return h && typeof h.lat === 'number' && typeof h.lon === 'number' && isFinite(h.lat) &&
         isFinite(h.lon) ? h : null;
}

// What Tune my aim would tune on now (tune.pick), preferring what the
// last CLOSEST card offered, for TUNE_SESSION_MS.
function tuneTarget(date, sky) {
  var mine = closestTune && Date.now() - closestTune.t < TUNE_SESSION_MS ? closestTune.id : null;
  return tune.pick(date, here.lat, here.lon, sky, mine);
}

function skySetting() {
  var s = loadJSON(SKY_KEY, 'suburbs');
  return s === 'city' || s === 'dark' ? s : 'suburbs';
}

// The sky and gear as the sky frame's last byte (find.js), with Keep light
// on in bits 6-7.
function prefsCode() {
  return find.SKY_CODE[skySetting()] | find.SHOW.indexOf(findShow()) << 4 | LIGHT.indexOf(lightSetting()) << 6;
}

// The watch's theme as it last said (THEME), or null.
function watchTheme() {
  var t = loadJSON(WTHEME_KEY, null);
  return typeof t === 'number' && t >= 0 && t < THEME.COUNT ? t : null;
}

// A location from the last few minutes (the stored one can be days old
// until the phone's first fix comes in). One from the future (the clock
// was set back since) isn't fresh.
function freshHere() {
  return !!here && fixAge(here) < LOC_FRESH_MS;
}

function fixAge(h) {
  var age = Date.now() - h.t;
  return age >= 0 ? age : Infinity;
}

// The sky was just chosen (on the watch or the settings page): for here,
// once there's a fresh fix.
function notePlace() {
  if (!freshHere()) {
    placePending = true;
    refreshLocation(false);
    return;
  }
  placePending = false;
  saveJSON(PLACE_KEY, { lat: here.lat, lon: here.lon });
}

// Far from where the sky was chosen, after dark: worth asking again. With
// nowhere noted yet (before v0.16, or a sky chosen before a location
// fix), here is taken as that place, without asking.
function newPlace(dark) {
  if (!freshHere()) return false;
  var at = validLocation(loadJSON(PLACE_KEY, null));
  if (!at || placePending) {
    notePlace();
    return false;
  }
  return dark && A.separation(at.lon, at.lat, here.lon, here.lat) * Math.PI / 180 * 6371 > PLACE_KM;
}

// A watch message with PREFS: the theme always; the sky, gear and light
// when they were chosen there (bit 16), with the change's number (bits 17-23), which
// the status echoes so the watch knows this change arrived.
function prefsFromWatch(v) {
  v = v >>> 0;
  var theme = (v >> 8) & 0xff;
  if (theme < THEME.COUNT) saveJSON(WTHEME_KEY, theme);
  if (v & 0x10000) {
    saveJSON(WSEQ_KEY, (v >>> 17) & 127);
    var sky = ['city', 'suburbs', 'dark'][v & 15];
    var show = find.SHOW[(v >> 4) & 3];
    if (sky) saveJSON(SKY_KEY, sky);
    if (show) saveJSON(SHOW_KEY, show);
    saveJSON(LIGHT_KEY, LIGHT[(v >> 6) & 3]);
    notePlace();
    sendStatus(true);   // the echo is how the watch knows the phone has it
  } else {
    sendStatus(false);
  }
}

// Which satellites to look for: {stations, visual, trains, hidden}.
function satSettings() {
  var s = loadJSON(SATS_KEY, null) || {};
  return { stations: s.stations !== false, visual: s.visual !== false, trains: s.trains !== false,
           hidden: s.hidden === true };
}

function satGroups() {
  var s = satSettings();
  return { stations: s.stations, visual: s.visual, 'last-30-days': s.trains };
}

function satsOn() {
  var s = satSettings();
  return s.stations || s.visual || s.trains;
}

// Planes: {on, minFt (hide planes lower than this above you), maxKm,
// source ('auto'|'lol'|'fi'|'rx'), rx (receiver URL)}.
var MIN_FT_CHOICES = [0, 500, 1000, 2000];
var MAX_KM_CHOICES = [16, 32, 48, 80];
function planeSettings() {
  var s = loadJSON(PLANES_KEY, null) || {};
  var rx = typeof s.rx === 'string' && /^https?:\/\/\S+$/.test(s.rx) ? s.rx : '';
  var source = s.source === 'lol' || s.source === 'fi' || (s.source === 'rx' && rx) ? s.source : 'auto';
  return { on: s.on !== false, minFt: MIN_FT_CHOICES.indexOf(s.minFt) >= 0 ? s.minFt : 500,
           maxKm: MAX_KM_CHOICES.indexOf(s.maxKm) >= 0 ? s.maxKm : 48, source: source, rx: rx };
}

function planePrefs() {
  var s = planeSettings();
  return { source: s.source, rxUrl: s.rx, nm: Math.max(5, Math.round(s.maxKm / 1.852)) };
}

function planeOpts() {
  var s = planeSettings();
  return { maxKm: s.maxKm, minAboveFt: s.minFt, units: units() };
}

function layersEnabled() {
  var L = matcher.LAYER;
  return (1 << L.ANY) | (1 << L.PLANETS) | (1 << L.STARS) | (1 << L.FIND) |
         (satsOn() ? 1 << L.SATELLITES : 0) | (planeSettings().on ? 1 << L.PLANES : 0);
}

// 'imperial' or 'metric'. Auto follows the phone's language: miles for the
// US (and when the phone doesn't say).
function unitsSetting() {
  var u = loadJSON(UNITS_KEY, 'auto');
  return u === 'imperial' || u === 'metric' ? u : 'auto';
}

function units() {
  var u = unitsSetting();
  if (u !== 'auto') return u;
  var lang = (typeof navigator !== 'undefined' && navigator.language) || '';
  return !lang || /^en[-_](US|LR)|^my\b/i.test(lang) ? 'imperial' : 'metric';
}

// The recent offset samples for a wrist (tune.js), newest last.
function aimPool(wrist) {
  var pool = (loadJSON(AIM_KEY, null) || {})[wrist ? '1' : '0'];
  return Array.isArray(pool) ? pool : [];
}

function saveAimPool(wrist, pool) {
  var all = loadJSON(AIM_KEY, null) || {};
  all[wrist ? '1' : '0'] = pool;
  saveJSON(AIM_KEY, all);
}

// The finger offset for a wrist: learned, or the default.
function offsetFor(wrist) {
  return tune.poolOffset(aimPool(wrist)) || attitude.DEFAULT_FINGER;
}

try { localStorage.removeItem(OLD_FINGER_KEY); } catch (e) { /* nothing to do */ }
try { localStorage.removeItem(OLD_BOOK_PLACES_KEY); } catch (e) { /* nothing to do */ }
try { localStorage.removeItem(OLD_FACTN_KEY); } catch (e) { /* nothing to do */ }
try { localStorage.removeItem(OLD_DEV_KEY); } catch (e) { /* nothing to do */ }
try { localStorage.removeItem(OLD_LOG_KEY); } catch (e) { /* nothing to do */ }
// Before v0.22 the aircraft-type tables had names only (planes.js now
// stores v2, with each type's shape): drop the old copies, once.
try {
  if (!localStorage.getItem(TYPES_V1_GONE_KEY)) {
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('').forEach(function (c) {
      localStorage.removeItem('sf_vrs_type_' + c + '_v1');
    });
    localStorage.setItem(TYPES_V1_GONE_KEY, '1');
  }
} catch (e) { /* nothing to do */ }

function factsOn() {
  return loadJSON(FACTS_KEY, true) !== false;
}

// What Find it shows: 'eye', 'binoculars' (the default) or 'all'.
function findShow() {
  var v = loadJSON(SHOW_KEY, 'binoculars');
  return find.SHOW.indexOf(v) >= 0 ? v : 'binoculars';
}

// Keep light on: 'read30' (the default), 'read60', 'finding' or 'watch'.
function lightSetting() {
  var v = loadJSON(LIGHT_KEY, 'read30');
  return LIGHT.indexOf(v) >= 0 ? v : 'read30';
}

var satStore = { load: loadJSON, save: saveJSON };
var planeStore = {
  load: loadJSON, save: saveJSON,
  remove: function (k) { try { localStorage.removeItem(k); } catch (e) { /* nothing to do */ } }
};
var diag = new Diag(planeStore);

// ---------------------------------------------------------------- watch link

// One message in flight at a time. A newer status replaces a queued one,
// and a message that fails three times is dropped, so nothing stale can
// block the queue.
var outbox = [];
var sending = false;
var tries = 0;
var lastStatus = null;

function send(msg) {
  if ('STATUS' in msg) {
    outbox = outbox.filter(function (m, i) { return (i === 0 && sending) || !('STATUS' in m); });
  }
  if (urgent(msg)) {
    // An answer goes ahead of any waiting status: the watch is waiting on it.
    var at = sending ? 1 : 0;
    while (at < outbox.length && urgent(outbox[at])) at++;
    outbox.splice(at, 0, msg);
  } else {
    outbox.push(msg);
  }
  pump();
}

// Answers and Find it lists: the watch is waiting on these.
function urgent(m) {
  return 'R_SEQ' in m || 'FIND_LIST' in m;
}

function pump() {
  if (sending || !outbox.length) return;
  sending = true;
  Pebble.sendAppMessage(outbox[0], function () {
    outbox.shift();
    sending = false;
    tries = 0;
    pump();
  }, function () {
    sending = false;
    var head = outbox[0];
    if (head && !urgent(head) && outbox.some(urgent)) {
      // A status didn't go through but an answer is waiting: answer first.
      outbox.push(outbox.shift());
      tries = 0;
      pump();
      return;
    }
    if (++tries >= 3) {
      var dropped = outbox.shift();
      tries = 0;
      if (dropped && 'STATUS' in dropped) lastStatus = null;   // resend next time
    }
    setTimeout(pump, 1500);
  });
}

// ---------------------------------------------------------------- location

function refreshLocation(force) {
  if (locating) return;
  if (!force && here && fixAge(here) < LOC_FRESH_MS) return;
  if (!navigator.geolocation) return;
  locating = true;
  navigator.geolocation.getCurrentPosition(function (pos) {
    locating = false;
    var c = pos.coords;
    here = { lat: c.latitude, lon: c.longitude,
             altKm: typeof c.altitude === 'number' ? c.altitude / 1000 : 0, t: Date.now() };
    saveJSON(LOC_KEY, here);
    diag.noteLocation({ lat: here.lat, lon: here.lon, altKm: typeof c.altitude === 'number' ? here.altKm : null,
                        acc: c.accuracy });
    sendStatus(false);
    var last = loadJSON(EPH_KEY, null);
    if (ephPending || !last || Math.abs(last.lat - here.lat) > EPH_MOVE_DEG ||
        Math.abs(A.wrap180(last.lon - here.lon)) > EPH_MOVE_DEG) {
      sendEph();
    }
  }, function (e) {
    locating = false;
    diag.noteLocation(null, e && e.code);
    sendStatus(false);
  }, { enableHighAccuracy: false, timeout: 20000, maximumAge: LOC_FRESH_MS });
}

// ---------------------------------------------------------------- satellites

function http(url, cb) {
  var done = false;
  function finish(status, text) {
    if (done) return;
    done = true;
    cb(status, text);
  }
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = HTTP_TIMEOUT_MS;
    xhr.onload = function () { finish(xhr.status, xhr.responseText); };
    xhr.onerror = function () { finish(0, ''); };
    xhr.ontimeout = function () { finish(0, ''); };
    xhr.send();
    setTimeout(function () { finish(0, ''); }, HTTP_TIMEOUT_MS + 5000);   // in case no event ever fires
  } catch (e) {
    finish(0, '');
  }
}

var feeds = new planes.FeedClient({ http: http, store: planeStore });
var standing = new planes.Standing(planeStore, http);

function wantsPlanes(layer) {
  return planeSettings().on && (layer === matcher.LAYER.ANY || layer === matcher.LAYER.PLANES);
}

// Why there's no plane data, in the watch's words.
function planesMissing() {
  return feeds.why === 'slow' ? 'Plane data too slow' : "Can't reach plane data";
}

// No planes kept, in words: the feeds barely cover this place, or none
// are tracked near you.
function planesNone() {
  return coverage() === 'thin' ? 'Few planes tracked here' : 'None tracked nearby';
}

// 'thin', 'ok' or '' (not looked) for here, from the last wide look.
function coverage() {
  var c = loadJSON(COVER_KEY, null);
  if (!c || !here || c.lat !== Math.round(here.lat) || c.lon !== Math.round(here.lon)) return '';
  return Date.now() - c.t < COVER_KEEP_MS ? (c.thin ? 'thin' : 'ok') : '';
}

// A feed answered with no aircraft at all: look wider, once in a while.
function checkCoverage(res) {
  if (!res || res.data.n > 0 || planes.PUBLIC.indexOf(res.feed) < 0) return;
  var c = loadJSON(COVER_KEY, null);
  var lat = Math.round(here.lat), lon = Math.round(here.lon);
  var same = c && c.lat === lat && c.lon === lon;
  if (same && Date.now() - Math.max(c.t, c.asked || 0) < COVER_RECHECK_MS) return;
  // Asked now: not again for an hour, whatever comes back. What was known
  // here stays meanwhile; a new place starts unknown.
  saveJSON(COVER_KEY, { lat: lat, lon: lon, t: same ? c.t : 0, asked: Date.now(), thin: same && !!c.thin,
                        n: same ? c.n : null });
  setTimeout(function () {   // adsb.fi allows a request a second
    if (!feeds.free(res.feed)) return;   // resting (refused) or busy: try again in an hour
    feeds.started[res.feed] = Date.now();   // so the next aim's request keeps its distance
    http(planes.feedUrl(res.feed, here, { nm: COVER_NM }), function (status, text) {
      var d = status === 200 && text ? planes.parseFeed(text, Date.now()) : null;
      if (!d) return;   // can't tell: try again in an hour
      saveJSON(COVER_KEY, { lat: lat, lon: lon, t: Date.now(), thin: d.n < THIN_N, n: d.n });
      if (d.n < THIN_N) {
        planesStatus = planesNone();
        planesStatusT = Date.now();
        sendStatus(false);
      }
    });
  }, 2000);
}

// The count on the PLANES rung, from the latest plane data.
function notePlanes(res) {
  var drops = {};
  if (!res) {
    planesStatus = planesMissing();
  } else {
    var n = planes.positions(res.data, Date.now(), here, planeOpts(), standing, drops).length;
    planesStatus = n ? n + (n === 1 ? ' plane nearby' : ' planes nearby') : planesNone();
    checkCoverage(res);
  }
  diag.notePlanes(feeds.log, res ? { feed: res.feed, n: res.data.n, stale: res.data.stale, kept: n, drops: drops,
                                     cover: coverage() } : { why: feeds.why, cover: coverage() });
  planesStatusT = Date.now();
  sendStatus(false);
}

// SELECT was tapped: start fetching the planes now, during the couple of
// seconds the user spends pointing, and look up their names and routes.
function prefetchPlanes(layer) {
  if (!here || !wantsPlanes(layer)) return;
  feeds.get(here, planePrefs(), function (res) {
    try {
      notePlanes(res);
      if (res) standing.prepare(res.data.ac.filter(function (a) { return !a.ground; }), function () {});
    } catch (e) {
      /* the aim fetches them again */
    }
  });
}

// The planes for one aim, as soon as they and the names of those near the
// aim are in, or at the deadline with whatever there is. cb({planes,
// note, feed}).
function planesForAim(date, aimTrue, waitMs, cb) {
  var done = false, got = null, failed = false;
  function finish() {
    if (done) return;
    done = true;
    var out = { planes: null, note: '', feed: '' };
    try {
      if (got) {
        out.planes = planes.positions(got.data, date.getTime(), here, planeOpts(), standing);
        out.feed = got.feed + ' ' + got.data.ac.length;
        // None at all: whether the feeds cover this place. Some, but none
        // near the aim: the matcher says so.
        if (!out.planes.length) out.note = planesNone();
        out.thin = coverage() === 'thin';
      } else {
        out.note = failed ? planesMissing() : 'Plane data too slow';
        out.feed = failed ? feeds.why || 'failed' : 'slow';
      }
    } catch (e) {
      out = { planes: null, note: "Can't read plane data", feed: 'error' };
    }
    cb(out);
  }
  setTimeout(finish, waitMs);
  feeds.get(here, planePrefs(), function (res) {
    if (done) return;
    if (!res) {
      failed = true;
      finish();
      return;
    }
    got = res;
    try {
      var near = planes.positions(res.data, date.getTime(), here, planeOpts(), standing).filter(function (pl) {
        return A.separation(aimTrue.az, aimTrue.alt, pl.az, pl.altTrue) < 15;
      }).map(function (pl) { return pl.ac; });
      standing.prepare(near, finish);
    } catch (e) {
      finish();
    }
  });
}

function refreshSats() {
  if (satFetching) {
    satAgain = true;
    return;
  }
  if (!satsOn()) return;
  satFetching = true;
  satAgain = false;
  satellites.refresh(satStore, http, satGroups(), Date.now(), function () {
    satFetching = false;
    sendStatus(false);
    if (satAgain) refreshSats();
  });
}

// ---------------------------------------------------------------- sky

// withSats: also place the satellites (about 40 ms with a full catalog).
function skyAt(date, withSats) {
  var bodies = planets.bodies(date, here.lat, here.lon);
  var sky = {
    jd: A.julianDay(date), lat: here.lat, lon: here.lon,
    sunAlt: bodies[0].alt, sky: skySetting(), units: units(),
    bodies: bodies, moon: moon.moonAltAz(date, here.lat, here.lon),
    sats: null, satHidden: satSettings().hidden,
    satsNote: satFetching ? 'Getting satellites...' : 'No satellite data yet'
  };
  if (withSats && satsOn()) {
    // Never let bad stored satellite data break the stars and planets.
    try {
      var cat = satellites.catalog(satStore, satGroups());
      if (cat) {
        var sats = satellites.positions(cat, date, here, units());
        if (sats.usable) sky.sats = sats;
        else if (!satFetching) sky.satsNote = 'Satellite data too old';
      }
    } catch (e) {
      /* no satellites this time */
    }
  }
  return sky;
}

// Day theme above -6 degrees of Sun, with a degree of hysteresis so the
// screen doesn't flicker at dusk.
function isDaylight(sunAlt) {
  if (daylight === null) return sunAlt > -6;
  return daylight ? sunAlt > -7 : sunAlt > -5;
}

// Sent on open and on change; the minute ticker only sends when the
// theme or a status line actually changed.
function sendStatus(force) {
  var wt = watchTheme();
  var msg = { LAYERS: layersEnabled(),
              PREFS: prefsCode() | (wt === null ? 0 : wt + 1) << 8 | (loadJSON(WSEQ_KEY, 0) & 127) << 17,
              NEW_PLACE: 0 };
  if (here) {
    var now = new Date(Date.now());
    var sky = skyAt(now, true);
    daylight = isDaylight(sky.sunAlt);
    msg.DAYLIGHT = daylight ? 1 : 0;
    msg.NEW_PLACE = newPlace(!daylight) ? 1 : 0;
    var fresh = planesStatus && Date.now() - planesStatusT < PLANES_STATUS_MS;
    sky.planesStatus = planeSettings().on ? (fresh ? planesStatus : 'Planes load when you aim') : '';
    var lines = matcher.layerStatus(sky);
    lines[4] = find.starsStatus(now, here, sky.sunAlt, sky.sky, units());
    msg.STATUS = lines.concat([findStatus(now, sky)]).join('\x1f');
    msg.SKY_FRAME = skyFrame(now);
    var tgt = tuneTarget(now, sky);
    msg.TUNE_TGT = tgt ? tgt.name + '\x1f' + tgt.where : '';
  } else {
    msg.STATUS = ['Need your location', planeSettings().on ? 'Need your location' : '',
                  satsOn() ? 'Need your location' : '', 'Need your location',
                  'Need your location', 'Need your location'].join('\x1f');
    msg.TUNE_TGT = '';
  }
  var key = JSON.stringify(msg);
  if (!force && key === lastStatus) return;
  lastStatus = key;
  send(msg);
}

// ---------------------------------------------------------------- Find it

// What the watch needs to turn its sensors into a direction by itself.
function skyFrame(date) {
  var decl = wmm.field(here.lat, here.lon, here.altKm || 0, date).declination;
  return find.encodeFrame({ lat: here.lat, lon: here.lon, decl: decl, fingers: [offsetFor(0), offsetFor(1)],
                            sky: skySetting(), show: findShow() });
}

// The FIND IT rung's status line: what Best now opens on ("Saturn + 4
// more"), or why there's nothing ("Moon, Venus: too near Sun").
function findStatus(date, sky) {
  var list = find.targets(date, here, sky, null, units(), findShow()).list;
  var can = list.filter(function (t) { return t.best && find.findable(t) && !t.start; });
  if (can.length) return can.length === 1 ? can[0].name + ' is up' : can[0].name + ' + ' + (can.length - 1) + ' more';
  if (!list.length) return 'Nothing up to find now';
  var names = list.slice(0, 2).map(function (t) { return t.name.replace(/^The /, ''); }).join(', ');
  var line = names + (list.length > 2 ? ' +' + (list.length - 2) : '') + ': too near Sun';
  return line.length <= 31 ? line : 'All too near the Sun';
}

function satCatalog() {
  try {
    return satsOn() ? satellites.catalog(satStore, satGroups()) : null;
  } catch (e) {
    return null;
  }
}

// The table the watch answers from when the phone isn't there.
function sendEph() {
  if (!here) {
    ephPending = true;
    refreshLocation(true);
    return;
  }
  ephPending = false;
  try {
    send({ SKY_EPH: ephem.encode(new Date(Date.now()), here) });
    saveJSON(EPH_KEY, { lat: here.lat, lon: here.lon });
  } catch (e) {
    /* asked for again when it runs out */
  }
}

function sendFindList() {
  if (!here) {
    send({ FIND_LIST: [2, 0, 0, 0, 0, 0] });   // time 0: "I don't know where you are"
    refreshLocation(true);
    return;
  }
  var now = new Date(Date.now());
  var sky = skyAt(now, false);
  var res = find.targets(now, here, sky, satCatalog(), units(), findShow());
  findList = res.list;
  send({ FIND_LIST: find.encodeList(res, now.getTime()), SKY_FRAME: skyFrame(now) });
}

// Locked on to a Find it target: the answer card for it, with its chart
// and a fact, as for a sure aim.
function foundAnswer(p) {
  var reply = { R_SEQ: p.A_SEQ };
  var t = findList && findList[p.FIND_FOUND];
  if (!t || !here) {
    reply.R_DATA = cardsToWire([{ type: 0, word: 0, l1: 'Found it!', l2: '', l3: '', hint: '' }]);
    send(reply);
    return;
  }
  var date = new Date(Date.now());
  var L = matcher.LAYER;
  var T = matcher.TYPE;
  var top;
  if (t.type === T.CONSTELLATION) {
    // A pattern: no aim to match, its card and its own figure on the chart.
    var sky0 = skyAt(date, false);
    top = patternCard(t, sky0);
    top.hint = '';
    fitCards(addExtras([top], sky0, date, reply), reply);
    send(reply);
    noteSeen(top, 'found', date);
    return;
  }
  var layer = t.type === T.STAR ? L.STARS : t.type === T.SATELLITE ? L.SATELLITES : L.PLANETS;
  var sky = skyAt(date, layer === L.SATELLITES);
  var pos;
  if (t.kind === 0) {
    var h = A.eqToHorizon(t.ra, t.dec, sky.jd, here.lat, here.lon);
    pos = { az: h.az, alt: h.alt + A.refraction(h.alt) };
  } else if (t.type === T.MOON) {   // risen since the list (a moonrise to wait for)
    pos = { az: sky.moon.az, alt: sky.moon.alt };
  } else {
    var s = (sky.sats || []).filter(function (x) { return x.id === t.satId; })[0];
    pos = s ? { az: s.az, alt: s.alt } : { az: t.az, alt: t.alt };
  }
  var result = matcher.match({ az: pos.az, alt: pos.alt, sigma: 1, layer: layer }, sky);
  top = result.cards.filter(function (c) { return c.type !== T.SUN; })[0];
  if (!top || !find.isTarget(top, t, sky)) {
    top = { type: t.type, word: 0, l1: t.name, l2: '', l3: '', hint: '' };
  }
  top.hint = '';   // the watch has just shown "Found it" and an arrow up
  fitCards(addExtras([top], sky, date, reply), reply);
  send(reply);
  noteSeen(top, 'found', date);
}

// The answer card for a found star pattern ("Big Dipper", "In Ursa
// Major"), with a ref for its chart (circling the star it was found by,
// t.anchor) and facts.
function patternCard(t, sky) {
  var p = patterns.byId(t.id.replace(/^pattern:/, ''));
  if (!p) return { type: matcher.TYPE.CONSTELLATION, word: matcher.WORD.THATS, l1: t.name, l2: '', l3: '', hint: '' };
  var at = patterns.place(p, sky.jd, sky.lat, sky.lon, 0);
  return { type: matcher.TYPE.CONSTELLATION, word: matcher.WORD.THATS, l1: p.name, l2: at.caption, l3: '', hint: '',
           name: p.name, az: at.az, alt: at.alt,
           ref: { kind: 'pattern', id: p.id, con: p.con, anchor: typeof t.anchor === 'number' ? t.anchor : null } };
}

// ---------------------------------------------------------------- aims

// At most `max` UTF-8 bytes, cut at a character boundary (the watch's
// buffers count bytes, and names like "Großenhain" have multibyte letters).
function fitBytes(s, max) {
  var out = '', n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    var ch = s.charAt(i), b = c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {   // a surrogate pair: 4 bytes
      ch = s.slice(i, i + 2);
      b = 4;
    }
    if (n + b > max) break;
    out += ch;
    n += b;
    i += ch.length - 1;
  }
  return out;
}

function cardsToWire(cards) {
  return cards.map(function (c) {
    return [c.type, c.word, c.l1, c.l2, c.l3, c.hint].map(function (f) {
      return fitBytes(String(f).replace(/[\x1e\x1f]/g, ' '), 30);
    }).join('\x1f');
  }).join('\x1e');
}

// The pictures and the fact for the first answer, whatever its word (the
// others are alternatives: they keep their words and hints). A star, a
// constellation, nothing there at night, a satellite or a plane: its chart
// goes on the answer's own page (R_CHART with no chart card), its caption
// what else it might be when it isn't sure; a planet: on a chart card
// after it (its picture is on the watch). The Moon: how it's lit (R_MOON).
// Then a fact card. aim: where the user pointed ({az, alt} apparent),
// marked on the chart; none for a found target, nor for THAT'S IT (you
// were on it: the mark would only sit on the answer's circle).
function addExtras(cards, sky, date, msg, aim) {
  var top = cards[0];
  var T = matcher.TYPE;
  if (!top || !top.ref) return cards;
  if (top.word >= matcher.WORD.CLOSEST) return closestExtras(cards, sky, msg, aim);
  if (top.word === matcher.WORD.THATS) aim = null;
  var extra = [];
  var inline = top.type === T.STAR || top.type === T.CONSTELLATION || top.type === T.SATELLITE ||
               top.type === T.PLANE || (top.type === T.NOTHING && !top.hint);
  if (top.type !== T.NOTHING || inline) {
    try {
      var c = chartFor(top, sky, date, aim, inline, rivalText(top, cards.slice(1)));
      if (c) {
        msg.R_CHART = c.bytes;
        if (!inline) {
          extra.push({ type: T.CHART, word: 0, l1: c.label || stars.constellationName(c.con), l2: top.name + ' is circled',
                       l3: '', hint: '' });
        } else if (top.type === T.NOTHING) {
          // Said by the chart and its caption; with no room for the chart,
          // these lines still read right.
          top.l1 = 'Nothing there';
          top.l2 = '';
        }
      }
    } catch (e) {
      /* the answer goes without its chart */
    }
  }
  if (top.type === T.MOON) {
    msg.R_MOON = [Math.round(sky.moon.illum * 100), Math.round(moon.litSide(sky.moon, sky.bodies[0]) / 2) % 180];
  }
  // Nothing there gets its constellation's fact only with the chart.
  if (factsOn() && (top.type !== T.NOTHING || msg.R_CHART)) {
    var seen = factsSeen();
    var key = facts.factKey(top.ref);
    var f = facts.pickFact(top.ref, { units: units(), n: seen.n[key] || 0, last: seen.last,
                                      year: date.getUTCFullYear(), date: date });
    if (f) {
      msg.R_FACT = fitBytes(f.text, facts.FACT_MAX);
      noteFact(seen, key, f);
      extra.push({ type: T.FACT, word: 0, l1: 'Did you know?', l2: '', l3: '', hint: '' });
    }
  }
  return [top].concat(extra, cards.slice(1));
}

// A CLOSEST card's one extra: a chart of where you pointed (the aim's
// mark) and the bright thing nearest it (circled), wide enough for both.
// No fact: it isn't an answer yet.
var CLOSEST_FIELD_PAD = 8;
function closestExtras(cards, sky, msg, aim) {
  var top = cards[0], r = top.ref;
  if (!aim) return cards;
  try {
    var opts = { jd: sky.jd, lat: sky.lat, lon: sky.lon, aim: aim, bare: true, target: { az: top.az, alt: top.alt },
                 minField: Math.max(LANDMARK_BARE_FIELD, 2 * top.d + CLOSEST_FIELD_PAD) };
    opts.planets = [sky.moon].concat(sky.bodies.slice(1)).filter(function (b) {
      return b.alt > 0 && b.mag < 3 && !(r.kind === 'moon' ? b === sky.moon : b.name === top.name);
    });
    if (r.kind === 'star') opts.targetStar = r.index;
    var c = chart.build(opts);
    if (!c) return cards;
    msg.R_CHART = c.bytes;
    return [top, { type: matcher.TYPE.CHART, word: 0, l1: 'Where you pointed', l2: top.planeNote || top.name + ' is circled',
                   l3: '', hint: '' }].concat(cards.slice(1));
  } catch (e) {
    return cards;
  }
}

// Which facts have been shown: each subject turns to its next fact.
function factsSeen() {
  var v = loadJSON(FACTS_SEEN_KEY, null);
  if (!v || typeof v !== 'object' || !v.n || typeof v.n !== 'object' || !Array.isArray(v.keys)) {
    return { n: {}, keys: [], last: '' };
  }
  return v;
}

function noteFact(seen, key, f) {
  seen.n[key] = f.n;
  seen.keys = seen.keys.filter(function (k) { return k !== key; }).concat([key]);
  while (seen.keys.length > FACTS_SEEN_MAX) delete seen.n[seen.keys.shift()];
  seen.last = f.text;
  saveJSON(FACTS_SEEN_KEY, seen);
}

// A chart on the answer's own page is this tall, under its name and over
// its caption (main.c CHART_INLINE_Y); a chart card's is chart.H.
var CHART_INLINE_H = 118;
// A pattern's chart is at least this many degrees across (the Pleiades
// would be a speck at a constellation's).
var PATTERN_MIN_FIELD = 8;
// A satellite's path: where it was and will be, seconds from now.
var TRACK_STEPS = [-20, -10, 0, 10, 20, 30, 40];
// A plane's path is drawn over about this many degrees of sky, taking the
// seconds that needs (within these), the same steps spread to fit; its
// chart is this tall, under its name and route (main.c PLANE_CHART_H).
var PLANE_TRACK_DEG = 30;
var PLANE_TRACK_MIN_S = 6;
var PLANE_TRACK_MAX_S = 60;
var PLANE_CHART_H = 70;
// A planet's chart shows the figure you can make out nearest to it: the
// constellation it's in if you can see that, else one with a star within
// LANDMARK_NEAR_DEG of it ("Near Pisces"), else no figure, just the stars
// around it over LANDMARK_BARE_FIELD degrees. "Can see": at least
// LANDMARK_MIN_SEEN of its stars, and LANDMARK_MIN_SHARE of them, by eye
// knowing where to look (matcher.seeing CLOSE). A chart card's title fits
// about LANDMARK_LABEL_MAX characters (Gothic 24 Bold is about 9 px a
// character: "Near Pegasus" is 110 of its 192).
var LANDMARK_NEAR_DEG = 25;
var LANDMARK_MIN_SEEN = 3;
var LANDMARK_MIN_SHARE = 0.5;
var LANDMARK_BARE_FIELD = 40;
var LANDMARK_LABEL_MAX = 20;

// What else an unsure first answer might be, for under its chart: "or
// Vega", "or Vega and 1 more", "or 3 others close by"; '' when it's sure
// or alone. others: the answers after it.
function rivalText(top, others) {
  var W = matcher.WORD;
  if (top.word !== W.PROBABLY && top.word !== W.MAYBE) return '';
  var rest = others.filter(function (c) { return c.type !== matcher.TYPE.SUN && c.l1; });
  if (!rest.length) return '';
  var one = 'or ' + rest[0].l1;
  if (rest.length === 1 && planes.utf8Len(one) <= 30) return one;
  var more = one + ' and ' + (rest.length - 1) + ' more';
  if (rest.length > 1 && planes.utf8Len(more) <= 30) return more;
  return 'or ' + rest.length + (rest.length === 1 ? ' other' : ' others') + ' close by';
}

// The figure to draw round a planet at {az, alt} (apparent): {con,
// lines (for a pattern), label} or null (none you'd see near it). in: the
// constellation it's in.
function landmarkFor(at, inCon, sky) {
  var ofDate = stars.starsOfDate(sky.jd);
  var cache = {};
  function star(i) {
    if (!cache[i]) {
      var s = ofDate[i];
      var h = A.eqToHorizon(s.ra, s.dec, sky.jd, sky.lat, sky.lon);
      var alt = h.alt + A.refraction(h.alt);
      var see = alt >= 0 ? matcher.seeing(s.mag, alt, sky.sunAlt, sky.sky) : matcher.SEE.TELESCOPE;
      cache[i] = { near: A.separation(h.az, alt, at.az, at.alt), seen: see <= matcher.SEE.CLOSE };
    }
    return cache[i];
  }
  function judge(members) {
    var seen = 0, near = 180;
    members.forEach(function (i) {
      var t = star(i);
      if (t.seen) seen++;
      near = Math.min(near, t.near);
    });
    return { near: near, ok: seen >= LANDMARK_MIN_SEEN && seen >= LANDMARK_MIN_SHARE * members.length, seen: seen };
  }
  function membersOf(lines) {
    var m = [];
    lines.forEach(function (poly) {
      poly.forEach(function (i) { if (i >= 0 && ofDate[i] && m.indexOf(i) < 0) m.push(i); });
    });
    return m;
  }
  var cands = [];
  Object.keys(stars.lines || {}).forEach(function (con) {
    var j = judge(membersOf(stars.lines[con]));
    if (j.ok && (con === inCon || j.near <= LANDMARK_NEAR_DEG)) {
      cands.push({ con: con, near: con === inCon ? -1 : j.near, seen: j.seen, name: stars.constellationName(con) });
    }
  });
  // Shapes drawn by patterns.js (the Great Square, the Teapot), not the
  // whole constellations it takes from the catalog.
  patterns.all().forEach(function (p) {
    if (p.con) return;
    var j = judge(p.members);
    if (j.ok && j.near <= LANDMARK_NEAR_DEG) {
      // "the Big Dipper", "the Teapot", "Orion's Belt", "Cassiopeia".
      var bareName = /'/.test(p.name) || (p.whole && !/ /.test(p.name));
      cands.push({ con: 'pattern', lines: { pattern: p.lines }, near: j.near, seen: j.seen,
                   name: bareName ? p.name : 'the ' + p.name.replace(/^The /, '') });
    }
  });
  if (!cands.length) return null;
  cands.sort(function (a, b) { return a.near - b.near || b.seen - a.seen; });
  var c = cands[0];
  var near = 'Near ' + c.name;
  c.label = c.near < 0 ? c.name : near.length <= LANDMARK_LABEL_MAX ? near : c.name.replace(/^the /, 'The ');
  return c;
}

// A chart card's title for where something is, short enough for its one
// line: "Low in the E", "In the SW", "High in the N".
function whereTitle(az, alt) {
  var d = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(A.rev(az) / 45) % 8];
  return (alt < 30 ? 'Low in the ' : alt < 60 ? 'In the ' : 'High in the ') + d;
}

// The chart for an answer: {bytes, con, label} or null. inline: for the answer's
// own page, with a caption (rival in its place, if given).
function chartFor(top, sky, date, aim, inline, rival) {
  var r = top.ref, T = matcher.TYPE;
  var planetsUp = [sky.moon].concat(sky.bodies.slice(1)).filter(function (b) {
    return b.alt > 0 && b.mag < 3;
  });
  var opts = { jd: sky.jd, lat: sky.lat, lon: sky.lon, planets: planetsUp, aim: aim || null };
  if (inline) opts.h = CHART_INLINE_H;
  // Applied to the caption whatever it would have been (once chosen below).
  function caption(c) {
    opts.caption = rival || c || '';
    opts.rival = !!rival;
  }
  if (r.kind === 'plane') {
    var pl = (sky.planes || []).filter(function (x) { return x.hex === r.hex; })[0];
    var rate = pl && pl.move ? Math.sqrt(pl.move.dx * pl.move.dx + pl.move.dy * pl.move.dy) : 0;
    if (!inline || !(rate > 0)) return null;
    // About PLANE_TRACK_DEG of sky: a near plane's path takes seconds, a
    // far one's up to a minute.
    var span = Math.max(PLANE_TRACK_MIN_S, Math.min(PLANE_TRACK_MAX_S, PLANE_TRACK_DEG / rate));
    var at = date.getTime();
    var pp = planes.path(pl, TRACK_STEPS.map(function (s) { return new Date(at + s / 60 * span * 1000); }), here);
    if (!pp) return null;
    opts.path = pp;
    opts.now = TRACK_STEPS.indexOf(0);
    opts.members = [];
    opts.h = PLANE_CHART_H;
    opts.craft = pl.craft;
    opts.route = pl.strip;
    caption('');
    var pt = chart.track(opts);
    return pt ? { bytes: pt.bytes, con: null } : null;
  }
  if (r.kind === 'sat') {
    var now = date.getTime();
    var path = satellites.path(satCatalog(), r.id, TRACK_STEPS.map(function (s) { return new Date(now + s * 1000); }),
                               here);
    if (!path || !path[TRACK_STEPS.indexOf(0)]) return null;
    var nowAt = TRACK_STEPS.indexOf(0);
    var kept = [];
    path.forEach(function (p, i) {
      if (p) kept.push({ p: p, now: i === nowAt });
    });
    opts.path = kept.map(function (k) { return k.p; });
    opts.now = kept.map(function (k) { return k.now; }).indexOf(true);
    opts.members = r.cluster ? (sky.sats || []).filter(function (s) {
      return s.cluster === r.cluster && s.id !== r.id;
    }) : [];
    // The height and the speed: the line's own direction is the arrow's job.
    var speed = /^[\d,]+ (mph|km\/h)/.exec(top.hint || '');
    caption((top.l3 || '').split(',')[0] + (speed ? ', ' + speed[0] : ''));
    var t = chart.track(opts);
    return t ? { bytes: t.bytes, con: null } : null;
  }
  if (r.kind === 'star') {
    opts.con = r.con;
    opts.target = { az: top.az, alt: top.alt };
    opts.targetStar = r.index;
    caption(top.l2);
  } else if (r.kind === 'planet') {
    var eq = A.horizonToEq(top.az, A.unrefract(top.alt), sky.jd, sky.lat, sky.lon);
    opts.target = { az: top.az, alt: top.alt };
    opts.planets = planetsUp.filter(function (b) { return b.name !== top.name; });
    var lm = landmarkFor(opts.target, stars.constellationAt(eq.ra, eq.dec, sky.jd), sky);
    if (lm) {
      opts.con = lm.con;
      if (lm.lines) opts.lines = lm.lines;
      var pl2 = chart.build(opts);
      if (pl2) return { bytes: pl2.bytes, con: lm.con, label: lm.label };
    }
    // No figure to see near it (or none of it on the chart): the stars
    // around it, titled where it is.
    opts.bare = true;
    opts.minField = LANDMARK_BARE_FIELD;
    var bare = chart.build(opts);
    return bare ? { bytes: bare.bytes, con: null, label: whereTitle(top.az, top.alt) } : null;
  } else if (r.kind === 'pattern') {
    var p = patterns.byId(r.id);
    if (!p) return null;
    opts.lines = { pattern: p.lines };
    opts.con = 'pattern';
    opts.target = null;
    opts.minField = PATTERN_MIN_FIELD;
    // Found by one of its stars: that one circled, and named.
    var anchorName = typeof r.anchor === 'number' && stars.catalog[r.anchor] ? stars.catalog[r.anchor].name : '';
    if (anchorName) opts.targetStar = r.anchor;
    caption(anchorName ? anchorName + ' is circled' : top.l2);
    var pc = chart.build(opts);
    return pc ? { bytes: pc.bytes, con: p.con } : null;
  } else if (r.kind === 'constellation' && (top.type === T.CONSTELLATION || top.type === T.NOTHING)) {
    opts.con = r.id;
    opts.target = null;
    if (top.type === T.NOTHING) opts.caption = top.l3;
  } else {
    return null;
  }
  var c = chart.build(opts);
  // A star whose figure is all under the horizon: the stars around it.
  if (!c && opts.target) {
    opts.bare = true;
    opts.minField = LANDMARK_BARE_FIELD;
    c = chart.build(opts);
  }
  return c ? { bytes: c.bytes, con: opts.con } : null;
}

// The watch's inbox (main.c opens 2048 bytes): a message is a byte, then
// 7 bytes a key plus its value.
var INBOX_BYTES = 2048;

function messageBytes(msg) {
  var n = 1;
  Object.keys(msg).forEach(function (k) {
    var v = msg[k];
    n += 7 + (typeof v === 'string' ? planes.utf8Len(v) + 1 : Array.isArray(v) ? v.length : 4);
  });
  return n;
}

// Sets R_DATA from the cards, dropping the last ones (then the chart) if
// the message wouldn't fit the watch's inbox.
function fitCards(cards, msg) {
  cards = cards.slice();
  for (;;) {
    msg.R_DATA = cardsToWire(cards);
    if (messageBytes(msg) <= INBOX_BYTES - 16) return;
    if (cards.length > 3) {
      cards.pop();
    } else if (msg.R_CHART) {
      delete msg.R_CHART;
      cards = cards.filter(function (c) { return c.type !== matcher.TYPE.CHART; });
    } else {
      cards = cards.slice(0, 1);
      msg.R_DATA = cardsToWire(cards);
      return;
    }
  }
}

// Into the logbook: a sure first answer, or what was just found ('found').
// (After the answer has gone: a failure here is ignored, never sent.)
function noteSeen(card, how, date) {
  try {
    if (!card || card.word >= matcher.WORD.CLOSEST) return;   // not an answer: only what's nearest
    if (how !== 'found') {
      how = card.word === matcher.WORD.THATS ? 'sure' : card.word === matcher.WORD.PROBABLY ? 'likely' : '';
    }
    var e = logbook.entryFor(card, how, date.getTime(), loadJSON(BOOK_WHERE_KEY, true) !== false ? here : null);
    var list = loadJSON(BOOK_KEY, []);
    if (e) saveJSON(BOOK_KEY, logbook.add(Array.isArray(list) ? list : [], e));
  } catch (err) {
    /* not noted */
  }
}

function aimFailed(p) {
  var msg = { R_SEQ: p.A_SEQ, R_DATA: cardsToWire([{ type: 0, word: 0, l1: 'Something went',
                                                      l2: 'wrong', l3: 'Point again', hint: '' }]) };
  if (p.askWrist) msg.WRIST_Q = 1;
  send(msg);
}

function handleAim(p) {
  try {
    answerAim(p);
  } catch (e) {
    aimFailed(p);
  }
}

// A CLOSEST card (matcher.js) says how far off the nearest bright thing
// was. If it's good to tune on, the card offers that (hold SELECT starts
// Tune my aim on it at once: main.c select_long), and the watch is told
// the target with the answer (TUNE_TGT, named as the card is, so the watch
// can tell the two belong together).
function offerClosestTune(cards, date, sky, reply) {
  var c = cards.filter(function (x) { return x.word === matcher.WORD.CLOSEST; })[0];
  if (!c) return;
  var id = tune.idFor(c.ref);
  var tgt = id ? tune.pick(date, here.lat, here.lon, sky, id) : null;
  if (!tgt || tgt.id !== id) {
    c.word = matcher.WORD.CLOSEST_FAR;   // hold SELECT opens the menu, as anywhere
    c.l3 = "Can't tune on it now";   // too low or high, too near the Sun, or too faint at dusk
    return;
  }
  c.l3 = 'Meant it? Hold SELECT';
  closestTune = { id: id, t: Date.now() };
  reply.TUNE_TGT = tgt.name + '\x1f' + tgt.where;
}

// The answer's cards had to be cut to fit the watch: if the CLOSEST card
// offering the tune went, so does the offer.
function keepClosestTune(reply) {
  if (!reply.TUNE_TGT) return;
  var kept = String(reply.R_DATA || '').split('\x1e').some(function (c) {
    return c.split('\x1f')[1] === String(matcher.WORD.CLOSEST);
  });
  if (!kept) {
    delete reply.TUNE_TGT;
    closestTune = null;
  }
}

// ANYTHING found nothing, and the planes didn't come (or the feeds barely
// cover this place): say so, in place of the constellation (the chart
// still shows it), since the user may have pointed at a plane. When the
// answer is CLOSEST, its chart's caption says it instead.
function planeNoteOnNothing(cards, note) {
  var c = cards[0];
  if (c && c.type === matcher.TYPE.NOTHING) c.l3 = note;
  else if (c && c.word >= matcher.WORD.CLOSEST) c.planeNote = note;   // its chart's caption (closestExtras)
}

// The aim's time comes from the watch clock. Satellites move a degree a
// second, so if it disagrees with the phone by more than the trip here
// could take, trust the phone (the aim finished a moment ago).
function aimDate(p) {
  var date = new Date(p.A_T * 1000 + (p.A_MS || 0));
  var lag = Date.now() - date.getTime();
  if (!(lag > -3000 && lag < 15000)) {
    date = new Date(Date.now() - 1000);
  }
  return date;
}

function answerAim(p) {
  var reply = { R_SEQ: p.A_SEQ };
  if (!here) {
    reply.R_DATA = cardsToWire([{ type: 0, word: 0, l1: 'I need to know', l2: 'where you are',
                                  l3: 'Turn on location', hint: '' }]);
    if (p.A_TUNE) reply.TUNE_N = TUNE_CANT;
    send(reply);
    refreshLocation(true);
    return;
  }
  var date = aimDate(p);
  var field = wmm.field(here.lat, here.lon, here.altKm || 0, date);
  checkWrist(p, field.declination);
  if (p.A_TUNE) {
    tuneAim(p, date, field.declination);
    return;
  }
  var wrist = p.A_WRIST ? 1 : 0;
  var finger = offsetFor(wrist);
  var dir = attitude.aimDirection(p.A_HEAD / 100, { x: p.A_AX, y: p.A_AY, z: p.A_AZ }, wrist,
                                  field.declination, finger);
  var base = p.A_CAL === 2 ? SIGMA_CALIBRATED : SIGMA_CALIBRATING;
  var jit = (p.A_JIT || 0) / 100 * A.cosd(dir.alt);
  var aim = { az: dir.az, alt: dir.alt, sigma: Math.sqrt(base * base + jit * jit),
              layer: p.A_LAYER || 0, rollTooFar: dir.rollTooFar };
  function answer(pl) {
    var sky = skyAt(date, aim.layer === matcher.LAYER.ANY || aim.layer === matcher.LAYER.SATELLITES);
    if (pl) {
      sky.planes = pl.planes;
      sky.planesNote = pl.note;
    }
    var result = matcher.match(aim, sky);
    if (pl && aim.layer === matcher.LAYER.ANY && (!pl.planes || pl.thin && !pl.planes.length)) planeNoteOnNothing(result.cards, pl.note);
    offerClosestTune(result.cards, date, sky, reply);
    // Unsure again and again: suggest tuning, if there's something to tune
    // on. Planes and satellites are left out: there, "nothing" is as often
    // the data as the aim.
    var L = matcher.LAYER;
    if (aim.layer === L.ANY || aim.layer === L.PLANETS || aim.layer === L.STARS) {
      weakRun = result.top && result.top.word !== matcher.WORD.MAYBE ? 0 : weakRun + 1;
      var first = result.cards[0];
      var tgt = first.type === matcher.TYPE.NOTHING && !first.hint ? tuneTarget(date, sky) : null;
      var tip = tgt ? 'Hold SELECT: tune on ' + tgt.name : '';
      if (weakRun >= WEAK_BEFORE_TIP && tgt) first.hint = planes.utf8Len(tip) <= 30 ? tip : 'Hold SELECT to tune';
    }
    diag.noteAim(p, aim, dir, finger, result.cards, pl, sky);
    if (p.askWrist) reply.WRIST_Q = 1;
    fitCards(addExtras(result.cards, sky, date, reply, { az: aim.az, alt: aim.alt }), reply);
    keepClosestTune(reply);
    send(reply);
    learnFrom(p, field.declination, dir, finger, result.cards);
    noteSeen(result.cards[0], '', date);
  }
  if (!wantsPlanes(aim.layer) || aim.rollTooFar) {
    answer(null);
    return;
  }
  var typical = feeds.typicalMs();
  var waitMs = aim.layer === matcher.LAYER.PLANES ? AIM_WAIT_MS
             : typical === null || typical > SLOW_FEED_MS ? ANY_SLOW_WAIT_MS : ANY_WAIT_MS;
  planesForAim(date, { az: aim.az, alt: A.unrefract(aim.alt) }, waitMs, function (pl) {
    try {
      answer(pl);
    } catch (e) {
      aimFailed(p);
    }
  });
}

// Two aims in a row into the ground, where the other wrist would point at
// the sky: the wrist is probably set wrong. Marks the aim so its reply asks.
function checkWrist(p, decl) {
  try {
    var accel = { x: p.A_AX, y: p.A_AY, z: p.A_AZ };
    var wrist = p.A_WRIST ? 1 : 0;
    var mine = attitude.aimDirection(p.A_HEAD / 100, accel, wrist, decl);
    var other = attitude.aimDirection(p.A_HEAD / 100, accel, 1 - wrist, decl);
    if (!mine.rollTooFar && mine.alt < GROUND_ALT && other.alt > 0) groundRun++;
    else groundRun = 0;
    if (groundRun >= WRONG_WRIST_ASK) {
      groundRun = 0;
      p.askWrist = true;
    }
  } catch (e) {
    groundRun = 0;   // a malformed aim: the answer path reports it
  }
}

// A confident answer about a fixed object teaches the offset (tune.js).
// Returns whether it did.
function learnFrom(p, decl, dir, inUse, cards) {
  var wrist = p.A_WRIST ? 1 : 0;
  if (!tune.learnable(cards, { cal: p.A_CAL }, dir)) return false;
  var raw = { head: p.A_HEAD / 100, accel: { x: p.A_AX, y: p.A_AY, z: p.A_AZ }, wrist: wrist, decl: decl };
  var smp = tune.sample(raw, cards[0].az, cards[0].alt, inUse, 'auto', Date.now());
  if (!smp) return false;
  saveAimPool(wrist, tune.addToPool(aimPool(wrist), smp));
  return true;
}

// One "Tune my aim" aim. A_TUNE is which of the three the watch thinks
// this is; 1 starts over. The reply carries how many are in so far, and
// until the last one a single card: the note, the target, where it is.
function tuneAim(p, date, decl) {
  var wrist = p.A_WRIST ? 1 : 0;
  // word 1 marks an aim that was kept (the watch buzzes once for it).
  function reply(n, l1, l2, l3, type, word) {
    var msg = { R_SEQ: p.A_SEQ, TUNE_N: n,
                R_DATA: cardsToWire([{ type: type || 0, word: word || 0, l1: l1, l2: l2 || '', l3: l3 || '',
                                       hint: '' }]) };
    if (p.askWrist) msg.WRIST_Q = 1;
    send(msg);
  }
  var s = tuneSession;
  if (p.A_TUNE === 1 || !s || s.wrist !== wrist || Date.now() - s.t > TUNE_SESSION_MS) {
    var tgt = tuneTarget(date);
    if (!tgt) {
      tuneSession = null;
      reply(TUNE_CANT, 'Nothing to tune on', 'No Moon or bright planet', 'up high enough now');
      return;
    }
    s = tuneSession = { wrist: wrist, id: tgt.id, name: tgt.name, type: tgt.type, samples: [], t: 0 };
  }
  s.t = Date.now();
  var pos = tune.position(s.id, date, here.lat, here.lon);
  var raw = { head: p.A_HEAD / 100, accel: { x: p.A_AX, y: p.A_AY, z: p.A_AZ }, wrist: wrist,
              decl: decl, cal: p.A_CAL };
  var gone = !pos || pos.alt < 10;
  var m = gone ? null : tune.measure(raw, pos, s.name);
  if (gone) {
    tuneSession = null;
    reply(TUNE_CANT, 'Lost ' + s.name, 'It is setting', 'Try again later');
    return;
  }
  var at = tune.where(pos.az, pos.alt);
  if (m.reject) {
    reply(s.samples.length, m.reject, s.name, at, s.type);
    return;
  }
  s.samples.push(m.sample);
  var n = s.samples.length;
  if (n < tune.NEEDED) {
    reply(n, 'Got it! ' + (tune.NEEDED - n) + ' more to go', s.name, at, s.type, 1);
    return;
  }
  // Both misses are for aims the offset wasn't fitted to (the old one never
  // saw them; the new one is scored leaving each out), so they compare
  // fairly. If the Moon's offset does better, start learning afresh from it
  // (the compass may have been recalibrated); if not, its aims just join
  // what's been learned.
  var res = tune.finish(s.samples, offsetFor(wrist));
  tuneSession = null;
  weakRun = 0;
  var moonSamples = s.samples.map(function (m) {
    return { yaw: Math.round(m.yaw * 100) / 100, pitch: Math.round(m.pitch * 100) / 100, az: Math.round(m.tgt.az),
             t: Date.now(), src: 'moon' };
  });
  var was = Math.max(1, Math.round(res.before)), now = Math.max(1, Math.round(res.after));
  if (res.after >= res.before) {
    var pool = aimPool(wrist);
    moonSamples.forEach(function (m) { m.src = 'moon+'; pool = tune.addToPool(pool, m); });
    saveAimPool(wrist, pool);
    reply(n, 'All done!', 'You already point well,', 'about ' + was + ' degrees off', s.type);
    return;
  }
  saveAimPool(wrist, moonSamples);
  reply(n, 'Aim tuned!', 'You were ' + was + ' degrees off,', now < was ? 'now about ' + now : 'a little better now',
        s.type);
}

// ---------------------------------------------------------------- events

Pebble.addEventListener('ready', function () {
  sendStatus(true);
  refreshLocation(false);
  refreshSats();
  setInterval(function () { sendStatus(false); }, 60 * 1000);
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload;
  if ('EPH_REQ' in p) sendEph();
  if ('PREFS' in p) prefsFromWatch(p.PREFS);
  if ('FIND_FOUND' in p) {
    try {
      foundAnswer(p);
    } catch (e) {
      aimFailed(p);
    }
  } else if ('FIND_REQ' in p) {
    try {
      sendFindList();
    } catch (e) {
      send({ FIND_LIST: [2, 0, 0, 0, 0, 0] });
    }
  } else if ('A_SEQ' in p) {
    handleAim(p);
  } else if ('AIM_START' in p) {
    refreshLocation(false);
    prefetchPlanes(p.AIM_START);
  }
});

// ---------------------------------------------------------------- settings page

// [text, link]. adsb.fi asks for a link.
var CREDITS = [
  ['Aircraft positions: adsb.lol (ODbL)', 'https://adsb.lol'],
  ['Aircraft positions: adsb.fi', 'https://adsb.fi'],
  ['Airlines, airports, aircraft types and routes: Virtual Radar Server standing data (CC0)',
   'https://github.com/vradarserver/standing-data'],
  'Star positions: Yale Bright Star Catalogue, 5th ed. (Hoffleit and Warren 1991), via CDS VizieR',
  'Star names: IAU Working Group on Star Names (CC BY)',
  'Constellation boundaries: Roman (1987), via CDS VizieR',
  ['Constellation stick figures: Marc van der Sluys, ConstellationLines (CC BY 4.0)',
   'https://doi.org/10.5281/zenodo.10397192'],
  'Star distances: Hipparcos (ESA 1997), via CDS VizieR',
  'Planet positions: after Paul Schlyter, "How to compute planetary positions"',
  'Satellite orbits: CelesTrak (celestrak.org), from Space-Track data',
  'Satellite math: satellite.js (MIT License)',
  'Magnetic declination: World Magnetic Model 2025 (NOAA NCEI / BGS); evaluator after magvar (MIT)',
  ['Place names in the logbook: Natural Earth populated places (public domain)', 'https://www.naturalearthdata.com'],
  'Planet pictures: NASA (public domain)'
];

// "Updated 3 h ago", for the satellite groups on the settings page.
function updated(t) {
  if (!t) return 'Not downloaded yet';
  var m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return 'Updated ' + m + ' min ago';
  if (m < 48 * 60) return 'Updated ' + Math.round(m / 60) + ' h ago';
  return 'Updated ' + Math.round(m / 1440) + ' days ago';
}

// "7:42 PM", or "19:42" for metric units, in the phone's time zone.
function clock(d) {
  var h = d.getHours(), m = d.getMinutes();
  var mm = (m < 10 ? '0' : '') + m;
  if (units() === 'metric') return h + ':' + mm;
  return (h % 12 || 12) + ':' + mm + (h < 12 ? ' AM' : ' PM');
}

// The settings page's line about tonight: when it's dark (the Sun 12
// degrees down, when most stars are out) and the Moon. '' with no location.
var DARK_SUN = -12;
function tonightLine(now) {
  if (!here) return '';
  var t0 = now.getTime(), step = 5 * 60000;
  function sunAlt(t) { return planets.bodies(new Date(t), here.lat, here.lon)[0].alt; }
  var dark = sunAlt(t0) <= DARK_SUN, when = null;
  for (var t = t0 + step; t <= t0 + 24 * 3600000; t += step) {
    if ((sunAlt(t) <= DARK_SUN) !== dark) {
      when = new Date(t);
      break;
    }
  }
  var line = dark ? (when ? 'Dark now, until ' + clock(when) + '.' : 'Dark now.')
                  : (when ? 'Tonight: dark by ' + clock(when) + '.' : '');
  var m = moon.moonAltAz(now, here.lat, here.lon);
  var lit = Math.round(m.illum * 100);
  var moonText = lit < 2 ? 'No Moon to speak of' : lit > 98 ? 'Full Moon' : 'Moon ' + lit + '% lit';
  return (line ? line + ' ' : '') + moonText + (lit < 2 ? '.' : m.alt > 0 ? ', up now.' : ', not up now.');
}

// The page in Stargazer colours when the watch is red now, so the phone
// doesn't undo it. The watch tells its theme (PREFS); until it has, the
// default for the sky.
function pageRed() {
  var t = watchTheme();
  if (t === null) t = skySetting() === 'dark' ? THEME.AUTO_STAR : THEME.AUTO;
  return t === THEME.STAR || (t === THEME.AUTO_STAR && daylight === false);
}

// What the settings page's logbook shows (collection.js, settings_page.js),
// and the logbook as CSV for the About tab.
function bookPage() {
  var list = loadJSON(BOOK_KEY, []);
  if (!Array.isArray(list)) list = [];
  var v = collection.view(list, { metric: units() === 'metric', h12: units() !== 'metric' });
  v.on = loadJSON(BOOK_WHERE_KEY, true) !== false;
  v.csv = logbook.csv(list, v.place);
  delete v.place;
  return v;
}

// The diagnostics for the About tab (diag.js), with what's true now.
function diagText() {
  try {
    var now = new Date(Date.now());
    var extra = { version: APP_VERSION, now: now.getTime() };
    try {
      var w = Pebble.getActiveWatchInfo && Pebble.getActiveWatchInfo();
      if (w) extra.phone = (w.platform || '') + ' watch, firmware ' + (w.firmware ? [w.firmware.major, w.firmware.minor,
                           w.firmware.patch].join('.') : '?') + (w.language ? ', ' + w.language : '');
    } catch (e) {
      /* no watch info */
    }
    if (here) {
      var f = wmm.field(here.lat, here.lon, here.altKm || 0, now);
      extra.field = { decl: f.declination, h: Math.round(f.h) };
    }
    var ps = planeSettings();
    extra.settings = { sky: skySetting(), gear: findShow(), units: units(), planes: ps.on ? 'on' : 'off',
                       source: ps.source, maxKm: ps.maxKm, minFt: ps.minFt, sats: satsOn() ? 'on' : 'off',
                       typicalFeedMs: feeds.typicalMs() };
    extra.aim = [0, 1].map(function (wr) {
      var o = offsetFor(wr), pool = aimPool(wr);
      return (wr ? 'R' : 'L') + ' offset ' + Math.round(o.yaw * 10) / 10 + '/' + Math.round(o.pitch * 10) / 10 +
             ' from ' + pool.length + ' (' + pool.map(function (m) { return m.src; }).join(',') + ')';
    }).join('; ');
    return diag.text(extra);
  } catch (e) {
    return 'Diagnostics failed: ' + e;
  }
}

Pebble.addEventListener('showConfiguration', function () {
  var got = satellites.fetchedAt(satStore, { stations: true, visual: true, 'last-30-days': true });
  function aimLine(wrist) {
    var pool = aimPool(wrist);
    var name = wrist ? 'Right wrist' : 'Left wrist';
    var moonN = pool.filter(function (m) { return /^moon/.test(m.src); }).length;
    var last = pool.length && typeof pool[pool.length - 1].t === 'number'
      ? ', latest ' + new Date(pool[pool.length - 1].t).toLocaleDateString() : '';
    var from = pool.length + (pool.length === 1 ? ' answer' : ' answers') +
               (moonN ? ' (' + moonN + ' from the Moon)' : '');
    if (!tune.poolOffset(pool)) {
      return '<li>' + name + ': still learning, ' + from + ' so far (needs ' + tune.POOL_MIN +
             '); using the default</li>';
    }
    return '<li>' + name + ': learned from the last ' + page.esc(from + last) + '</li>';
  }
  var tonight = '';
  try {
    tonight = tonightLine(new Date(Date.now()));
  } catch (e) {
    /* the page goes without it */
  }
  var book = { sightings: 0, things: 0, where: [], shelves: [], recent: [], on: true, csv: '' };
  try {
    book = bookPage();
  } catch (e) {
    /* an empty logbook */
  }
  var html = page.build({
    logbook: book,
    red: pageRed(), tonight: tonight,
    sky: skySetting(), show: findShow(), light: lightSetting(),
    planes: planeSettings(), minFtChoices: MIN_FT_CHOICES, maxKmChoices: MAX_KM_CHOICES,
    metric: units() === 'metric',
    sats: satSettings(),
    satAgo: { stations: updated(got.stations), visual: updated(got.visual), trains: updated(got['last-30-days']) },
    facts: factsOn(), units: unitsSetting(),
    aimLines: [aimLine(0), aimLine(1)],
    diag: diagText(),
    credits: CREDITS, sunEye: find.SUN_EYE, sunAided: find.SUN_AIDED
  });
  Pebble.openURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
});

Pebble.addEventListener('webviewclosed', function (e) {
  var raw = e && e.response ? e.response : '';
  var cfg = null;
  try { cfg = JSON.parse(raw); } catch (err) { cfg = null; }
  if (!cfg) {
    try { cfg = JSON.parse(decodeURIComponent(raw)); } catch (err2) { cfg = null; }
  }
  if (!cfg || typeof cfg !== 'object') return;
  if (cfg.reset === true) {
    SETTINGS_KEYS.forEach(function (k) { planeStore.remove(k); });
    planesStatus = '';
    refreshSats();
    sendStatus(true);
    return;
  }
  if (cfg.forgetAim === true) planeStore.remove(AIM_KEY);
  if (cfg.logbook && typeof cfg.logbook === 'object') {
    var keepWhere = cfg.logbook.where !== false;
    saveJSON(BOOK_WHERE_KEY, keepWhere);
    if (cfg.logbook.clear === true) {
      planeStore.remove(BOOK_KEY);
    } else if (!keepWhere) {
      // Off: where things were seen is forgotten, not just no longer noted.
      saveJSON(BOOK_KEY, logbook.forgetWhere(loadJSON(BOOK_KEY, [])));
    }
  }
  if (typeof cfg.facts === 'boolean') saveJSON(FACTS_KEY, cfg.facts);
  if (find.SHOW.indexOf(cfg.findShow) >= 0) saveJSON(SHOW_KEY, cfg.findShow);
  if (LIGHT.indexOf(cfg.light) >= 0) saveJSON(LIGHT_KEY, cfg.light);
  if (cfg.sky === 'city' || cfg.sky === 'suburbs' || cfg.sky === 'dark') {
    if (cfg.sky !== skySetting()) notePlace();   // chosen for here
    saveJSON(SKY_KEY, cfg.sky);
  }
  if (cfg.units === 'auto' || cfg.units === 'imperial' || cfg.units === 'metric') saveJSON(UNITS_KEY, cfg.units);
  if (cfg.planes && typeof cfg.planes === 'object') {
    var q = cfg.planes;
    var rx = typeof q.rx === 'string' && q.rx.length <= 300 && /^https?:\/\/\S+$/.test(q.rx) ? q.rx : '';
    saveJSON(PLANES_KEY, {
      on: q.on === true, minFt: MIN_FT_CHOICES.indexOf(q.minFt) >= 0 ? q.minFt : 500,
      maxKm: MAX_KM_CHOICES.indexOf(q.maxKm) >= 0 ? q.maxKm : 48,
      source: ['auto', 'lol', 'fi', 'rx'].indexOf(q.source) >= 0 && (q.source !== 'rx' || rx) ? q.source : 'auto',
      rx: rx
    });
    planesStatus = '';   // a new range or source: the old count no longer applies
  }
  if (cfg.sats && typeof cfg.sats === 'object') {
    saveJSON(SATS_KEY, { stations: cfg.sats.stations === true, visual: cfg.sats.visual === true,
                         trains: cfg.sats.trains === true, hidden: cfg.sats.hidden === true });
    refreshSats();   // a group just turned on is fetched now (if CelesTrak allows)
  }
  sendStatus(true);
});

module.exports = { cardsToWire: cardsToWire, fitBytes: fitBytes, addExtras: addExtras, fitCards: fitCards,
                   messageBytes: messageBytes };
