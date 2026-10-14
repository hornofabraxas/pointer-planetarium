// Diagnostics: what the last few aims, location fixes and plane requests
// saw, as text the user can copy from the settings page's About tab and
// send in. Kept on the phone only, never sent anywhere by the app.
//
// Privacy: no precise place. The location is rounded to whole degrees
// (about 100 km), enough to tell a country, its magnetic field and its
// plane coverage; times are UTC to the second.
//
// Storage key "sf_diag_v1": {aims: [...], loc: {...}, feeds: [...],
// planes: {...}}.

var KEY = 'sf_diag_v1';
var MAX_AIMS = 12;
var LAYERS = ['ANY', 'PLANES', 'SATS', 'PLANETS', 'STARS', 'FIND'];
var WORDS = ['-', "THAT'S", 'PROBABLY', 'MAYBE', 'CLOSEST', 'CLOSEST-FAR'];

function Diag(store) {
  this.store = store;   // {load(key, fallback), save(key, value)}
}

Diag.prototype.load = function () {
  var d = this.store.load(KEY, null);
  if (!d || typeof d !== 'object') d = {};
  if (!Array.isArray(d.aims)) d.aims = [];
  if (!Array.isArray(d.feeds)) d.feeds = [];
  return d;
};

Diag.prototype.change = function (f) {
  try {
    var d = this.load();
    f(d);
    this.store.save(KEY, d);
  } catch (e) {
    /* diagnostics never get in the way */
  }
};

function r1(x) {
  return typeof x === 'number' && isFinite(x) ? Math.round(x * 10) / 10 : null;
}

// One aim. p: the watch's message; aim: {az, alt, sigma, layer,
// rollTooFar}; dir: attitude.aimDirection's; finger: the offset used;
// cards: the matcher's (top 3 noted); pl: planesForAim's result or null;
// sky: skyAt's.
Diag.prototype.noteAim = function (p, aim, dir, finger, cards, pl, sky) {
  var a = {
    t: Date.now(), layer: aim.layer, cal: p.A_CAL, sigma: r1(aim.sigma), az: r1(aim.az), alt: r1(aim.alt),
    roll: aim.rollTooFar ? 1 : 0, pitch12: r1(dir.twelvePitch), finger: [r1(finger.yaw), r1(finger.pitch)],
    wrist: p.A_WRIST ? 'R' : 'L', sun: r1(sky.sunAlt),
    cards: cards.slice(0, 3).map(function (c) {
      var d = typeof c.az === 'number' ? sep(aim, c) : null;
      return [c.type, c.word, String(c.l1 || '').slice(0, 24), r1(c.p), r1(d)];
    })
  };
  if (pl) a.planes = { feed: pl.feed || '', n: pl.planes ? pl.planes.length : null, note: pl.note || '' };
  this.change(function (d) {
    d.aims = d.aims.concat([a]).slice(-MAX_AIMS);
  });
};

function sep(aim, c) {
  var R = Math.PI / 180;
  var x = Math.sin(aim.alt * R) * Math.sin(c.alt * R) +
          Math.cos(aim.alt * R) * Math.cos(c.alt * R) * Math.cos((aim.az - c.az) * R);
  return Math.acos(Math.max(-1, Math.min(1, x))) / R;
}

// A location fix (ok) or a failure (err: the W3C code, 1 denied, 2
// unavailable, 3 timeout). fix: {lat, lon, altKm, acc (m)}.
Diag.prototype.noteLocation = function (fix, err) {
  this.change(function (d) {
    var loc = d.loc || {};
    if (fix) {
      loc.ok = { t: Date.now(), lat: Math.round(fix.lat), lon: Math.round(fix.lon),
                 altM: typeof fix.altKm === 'number' ? Math.round(fix.altKm * 1000) : null,
                 acc: typeof fix.acc === 'number' ? Math.round(fix.acc) : null };
    } else {
      loc.err = { t: Date.now(), code: err };
    }
    d.loc = loc;
  });
};

// The plane feed's last requests (planes.FeedClient log) and the last
// plane answer: {feed, n (in the answer), stale, kept, drops {why: n},
// why (no answer: slow, failed, resting), cover}.
Diag.prototype.notePlanes = function (log, info) {
  this.change(function (d) {
    d.feeds = (log || []).slice(-8);
    d.planes = info;
    d.planes.t = Date.now();
  });
};

function when(t) {
  return typeof t === 'number' ? new Date(t).toISOString().slice(5, 19).replace('T', ' ') + 'Z' : '?';
}

// The text to copy. extra: {version, settings: {...}, field: {decl, h},
// finger: {...}, pool: {...}, now} from index.js.
Diag.prototype.text = function (extra) {
  var d = this.load();
  var now = extra.now || Date.now();
  var out = ['Pointer Planetarium ' + (extra.version || '?') + ' diagnostics, ' + when(now)];
  if (extra.phone) out.push('Phone: ' + extra.phone);
  var loc = d.loc || {};
  out.push('Location: ' + (loc.ok ? 'about ' + loc.ok.lat + ', ' + loc.ok.lon + ' (rounded), ' +
           Math.round((now - loc.ok.t) / 60000) + ' min old, accuracy ' + (loc.ok.acc === null ? '?' : loc.ok.acc + ' m') +
           ', height ' + (loc.ok.altM === null ? 'none' : loc.ok.altM + ' m') : 'no fix yet') +
           (loc.err ? '; last error ' + loc.err.code + ' at ' + when(loc.err.t) : ''));
  if (extra.field) out.push('Magnetic: declination ' + r1(extra.field.decl) + ', horizontal ' + extra.field.h + ' nT');
  if (extra.settings) {
    out.push('Settings: ' + Object.keys(extra.settings).map(function (k) { return k + '=' + extra.settings[k]; }).join(' '));
  }
  if (extra.aim) out.push('Aim: ' + extra.aim);
  var pl = d.planes;
  if (pl) {
    out.push('Planes ' + when(pl.t) + ': ' + (pl.why ? 'no answer (' + pl.why + ')' :
             pl.feed + ' gave ' + pl.n + ', ' + pl.stale + ' without a recent position, ' + pl.kept + ' kept; dropped ' +
             JSON.stringify(pl.drops || {})) + (pl.cover ? ', coverage ' + pl.cover : ''));
  }
  if (d.feeds.length) {
    out.push('Requests: ' + d.feeds.map(function (f) {
      return f.feed + ' ' + f.status + ' ' + (f.ms / 1000).toFixed(1) + 's' + (f.n === null ? '' : ' n' + f.n);
    }).join(', '));
  }
  out.push('Aims (time, layer, compass, sigma, az/alt, wrist, finger, Sun; answers: type word name p degrees):');
  d.aims.slice().reverse().forEach(function (a) {
    out.push(when(a.t) + ' ' + (LAYERS[a.layer] || a.layer) + ' cal' + a.cal + ' s' + a.sigma + ' ' + a.az + '/' + a.alt +
             (a.roll ? ' ROLL' : '') + ' ' + a.wrist + ' f' + a.finger.join('/') + ' sun' + a.sun +
             (a.planes ? ' planes[' + a.planes.feed + ' ' + a.planes.n + (a.planes.note ? ' ' + a.planes.note : '') + ']' : ''));
    a.cards.forEach(function (c) {
      out.push('   ' + c[0] + ' ' + (WORDS[c[1]] || c[1]) + ' ' + c[2] + ' p' + c[3] + ' d' + c[4]);
    });
  });
  return out.join('\n');
};

module.exports = { Diag: Diag, KEY: KEY };
