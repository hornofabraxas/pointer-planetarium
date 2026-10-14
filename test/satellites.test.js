// Checks src/pkjs/satellites.js: positions and sunlight against Skyfield
// (test/sat_fixture.json, from tools/make_sat_fixture.py), the CelesTrak
// fetch rules, train grouping and docked ships.
// Run: node test/satellites.test.js
var S = require('../src/pkjs/satellites.js');
var A = require('../src/pkjs/astro.js');
var fx = require('./sat_fixture.json');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

// A fresh store also starts a fresh "session" (the module remembers this
// session's tries in memory too).
function memStore(init, full) {
  var data = init || {};
  S.resetSession();
  return {
    data: data,
    load: function (k, fb) { return k in data ? JSON.parse(data[k]) : fb; },
    save: function (k, v) {
      if (full && /_v1$/.test(k) && k !== 'sf_sat_tries_v1') return false;
      data[k] = JSON.stringify(v);
      return true;
    }
  };
}
var ALL = { stations: true, visual: true, 'last-30-days': true };
var OBS = { lat: fx.lat, lon: fx.lon, altKm: fx.elevM / 1000 };

// ---------------------------------------------------------------- vs Skyfield

var store = memStore();
store.save('sf_sat_stations_v1', { t: 1, sats: [fx.omm] });
var cat = S.catalog(store, { stations: true });
check('catalog built from stored elements', cat && cat.length === 1 && cat[0].l1 === 'Space Station');

var worstUp = 0, worstKm = 0, compared = 0, litWrong = 0, litNear = 0;
fx.rows.forEach(function (r) {
  var date = new Date(r.utc);
  var got = S.positions(cat, date, OBS, 'metric')[0];
  if (r.alt < -1) {
    if (got) worstUp = Math.max(worstUp, 99);
  } else if (got) {
    compared++;
    worstUp = Math.max(worstUp, A.separation(got.az, got.altTrue, r.az, r.alt));
    worstKm = Math.max(worstKm, Math.abs(got.rangeKm - r.km));
  }
  // The shadow test needs no horizon, so check it on every row.
  if (got || r.alt < -1) {
    var lit = got ? got.lit : null;
    if (lit !== null && lit !== r.lit) litWrong++;
  }
});
check('ISS az/alt matches Skyfield above the horizon', compared > 200 && worstUp < 0.05,
      compared + ' rows, worst ' + worstUp.toFixed(4) + ' deg');
check('ISS range matches Skyfield', worstKm < 2, 'worst ' + worstKm.toFixed(2) + ' km');
check('sunlit agrees with Skyfield where above the horizon', litWrong === 0, litWrong + ' disagree');

// The shadow test on its own, over every fixture row (most are below the
// horizon, including a whole orbit through the Earth's shadow).
var sat = require('../src/pkjs/satellite.min.js');
var rec = cat[0].rec;
fx.rows.forEach(function (r) {
  var date = new Date(r.utc);
  var p = sat.propagate(rec, date).position;
  var s = sat.sunPos(A.julianDay(date)).rsun;
  var n = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
  var lit = S.sunlit([p.x, p.y, p.z], [s[0] / n, s[1] / n, s[2] / n]);
  if (lit !== r.lit) {
    // Skyfield's shadow is a cone with a penumbra; a disagreement is fine
    // only right at the edge, within a few seconds of entry or exit.
    var t1 = new Date(date.getTime() + 8000), t0 = new Date(date.getTime() - 8000);
    var flip = [t0, t1].some(function (t) {
      var q = sat.propagate(rec, t).position;
      return S.sunlit([q.x, q.y, q.z], [s[0] / n, s[1] / n, s[2] / n]) === r.lit;
    });
    if (flip) litNear++; else litWrong++;
  }
});
check('sunlit agrees with Skyfield on all ' + fx.rows.length + ' rows (edge seconds aside)',
      litWrong === 0, litNear + ' at the shadow edge');

// Docked: a visiting ship whose own elements put it 18 km along the orbit
// from the ISS (older elements drift like that) disappears into it. A
// cubesat released from it, 3 degrees of orbit (360 km) away, stays.
var ship = JSON.parse(JSON.stringify(fx.omm));
ship.OBJECT_NAME = 'SOYUZ-MS 28';
ship.NORAD_CAT_ID = 99001;
ship.OBJECT_ID = '2026-001A';
ship.MEAN_ANOMALY = A.rev(fx.omm.MEAN_ANOMALY + 0.15);
var cube = JSON.parse(JSON.stringify(fx.omm));
cube.OBJECT_NAME = 'KNACKSAT-2';
cube.NORAD_CAT_ID = 99002;
cube.MEAN_ANOMALY = A.rev(fx.omm.MEAN_ANOMALY + 3);
store.save('sf_sat_stations_v1', { t: 2, sats: S.parseGroup('stations', JSON.stringify([fx.omm, ship, cube])) });
var highs = fx.rows.filter(function (r) { return r.alt > 20; });
var shipSeen = 0, cubeSeen = 0;
highs.forEach(function (r) {
  var up = S.positions(S.catalog(store, { stations: true }), new Date(r.utc), OBS, 'imperial');
  if (up.some(function (o) { return o.id === 99001; })) shipSeen++;
  if (up.some(function (o) { return o.id === 99002; })) cubeSeen++;
});
check('docked ship 18 km off folded into the station at every point of every pass', shipSeen === 0,
      highs.length + ' points, ship seen ' + shipSeen);
check('cubesat 360 km away kept', cubeSeen > 0, cubeSeen);
var pass = highs.filter(function (r) { return r.alt > 30; })[0];
var docked = S.positions(S.catalog(store, { stations: true }), new Date(pass.utc), OBS, 'imperial')
  .filter(function (o) { return o.id === 25544; });
check('height line in miles', /^\d{3} mi up$/.test(docked[0].l3), docked[0].l3);
check('speed in orbit about 7.66 km/s', Math.abs(docked[0].speedMs - 7660) < 60, docked[0].speedMs);
var later = S.positions(S.catalog(store, { stations: true }), new Date(new Date(pass.utc).getTime() + 1000), OBS,
                        'imperial').filter(function (o) { return o.id === 25544; })[0];
var mv = docked[0].move;
check('which way it crosses the sky: where it is a second on', mv &&
      Math.abs(mv.dx - A.wrap180(later.az - docked[0].az) * A.cosd(docked[0].altTrue)) < 0.02 &&
      Math.abs(mv.dy - (later.altTrue - docked[0].altTrue)) < 0.02,
      JSON.stringify(mv));
check('ISS bright overhead', docked[0].mag < -1, docked[0].mag.toFixed(1));

// ---------------------------------------------------------------- trains

// A fresh launch: 20 Starlinks strung along the ISS orbit 0.4 deg of
// anomaly apart, plus the rocket stage and two debris pieces, plus a
// launch of 3 (not a train) and an unrelated payload.
function clone(o, name, id, cat, dM) {
  var c = JSON.parse(JSON.stringify(o));
  c.OBJECT_NAME = name;
  c.OBJECT_ID = id;
  c.NORAD_CAT_ID = cat;
  c.MEAN_ANOMALY = A.rev(c.MEAN_ANOMALY + dM);
  return c;
}
var recent = [];
for (var i = 0; i < 20; i++) recent.push(clone(fx.omm, 'STARLINK-' + (40000 + i), '2026-200' + String.fromCharCode(65 + i), 70000 + i, i * 0.4));
recent.push(clone(fx.omm, 'FALCON 9 R/B', '2026-200V', 70100, 5));
recent.push(clone(fx.omm, 'STARLINK DEB', '2026-200W', 70101, 6));
recent.push(clone(fx.omm, 'OBJECT A', '2026-200X', 70102, 7));
for (var k = 0; k < 3; k++) recent.push(clone(fx.omm, 'TINYSAT-' + k, '2026-201' + 'ABC'[k], 70200 + k, 40 + k));
recent.push(clone(fx.omm, 'SOMESAT 1', '2026-202A', 70300, 90));
// A rideshare (many different satellites, named after the mission) and a
// batch whose members aren't identified yet (a real train).
for (var r6 = 0; r6 < 6; r6++) {
  recent.push(clone(fx.omm, 'TRANSPORTER-18 OBJECT ' + 'ABCDEF'[r6], '2026-204' + 'ABCDEF'[r6], 70500 + r6, 120 + r6));
  recent.push(clone(fx.omm, 'QIANFAN 16 OBJECT ' + 'ABCDEF'[r6], '2026-205' + 'ABCDEF'[r6], 70600 + r6, 150 + r6));
}
var geo = clone(fx.omm, 'GEOSAT 1', '2026-203A', 70400, 0);
geo.MEAN_MOTION = 1.0027;
recent.push(geo);
var parsed = S.parseGroup('last-30-days', JSON.stringify(recent));
check('recent launches: only the 20 Starlinks and 6 Qianfans kept', parsed.length === 26 &&
      parsed.every(function (o) { return /^(STARLINK-\d+|QIANFAN 16 OBJECT [A-F])$/.test(o.OBJECT_NAME); }),
      parsed.length + ' kept');
parsed = parsed.filter(function (o) { return /^STARLINK/.test(o.OBJECT_NAME); });
check('visual: geostationary dropped, others kept',
      S.parseGroup('visual', JSON.stringify(recent)).length === recent.length - 1);
check('bad JSON or not a list is rejected', S.parseGroup('visual', 'GP data has not updated') === null &&
      S.parseGroup('visual', '{"a":1}') === null);
check('microsecond epochs cut to milliseconds', S.parseGroup('stations', JSON.stringify([fx.omm]))[0].EPOCH ===
      '2026-10-07T13:30:47.478');
check('a list where nothing parses is a failed download', S.parseGroup('visual', JSON.stringify([{ a: 1 }])) === null);
check('recent launches with no train are fine (empty, not failed)',
      Array.isArray(S.parseGroup('last-30-days', JSON.stringify([fx.omm]))) &&
      S.parseGroup('last-30-days', JSON.stringify([fx.omm])).length === 0);
check('a malformed element set is skipped, not fatal',
      S.parseGroup('visual', JSON.stringify([{ OBJECT_NAME: 'X', EPOCH: 'nope' }, fx.omm])).length === 1);

var tstore = memStore();
tstore.save('sf_sat_last-30-days_v1', { t: 3, sats: parsed });
var tcat = S.catalog(tstore, ALL);
var lit = fx.rows.filter(function (r) { return r.alt > 25 && r.lit; })[0];
var tpos = S.positions(tcat, new Date(lit.utc), OBS, 'imperial');
var clusters = {};
tpos.forEach(function (o) { if (o.cluster) clusters[o.cluster] = o.clusterSize; });
var sizes = Object.keys(clusters).map(function (k) { return clusters[k]; });
check('train members above the horizon chain into one train', sizes.length === 1 && sizes[0] >= 5,
      tpos.length + ' up, clusters ' + JSON.stringify(sizes));
check('train members named for their family', tpos.every(function (o) {
  return o.train === 'Starlink' && /^Starlink 400\d\d$/.test(o.l1);
}), tpos[0].l1);

check('pretty names', S.prettyName('COSMOS 2251') === 'Cosmos 2251' &&
      S.prettyName('SL-16') === 'SL-16' && S.prettyName('STARLINK-1234') === 'Starlink 1234',
      [S.prettyName('COSMOS 2251'), S.prettyName('SL-16'), S.prettyName('STARLINK-1234')].join(', '));

// Stale elements drop out.
var old = memStore();
old.save('sf_sat_stations_v1', { t: 4, sats: [fx.omm] });
var later = new Date(Date.parse('2026-10-07T13:30:00Z') + 11 * 86400000);
var any = false;
for (var m = 0; m < 200 && !any; m++) {
  any = S.positions(S.catalog(old, { stations: true }), new Date(later.getTime() + m * 60000), OBS).length > 0;
}
check('elements over 10 days old are not used', !any);

// ---------------------------------------------------------------- fetching

function fakeHttp(answers) {
  var calls = [];
  var fn = function (url, cb) {
    calls.push(url);
    var g = /GROUP=([\w-]+)/.exec(url)[1];
    var a = answers[g] || [200, JSON.stringify([fx.omm])];
    cb(a[0], a[1]);
  };
  fn.calls = calls;
  return fn;
}

var fs = memStore();
var T0 = Date.UTC(2026, 9, 8, 2, 0);
var h = fakeHttp({});
var changed = null;
S.refresh(fs, h, ALL, T0, function (c) { changed = c; });
check('first open fetches all three groups', h.calls.length === 3 && changed === true, h.calls.join(' '));
check('requests are JSON from celestrak.org',
      h.calls.every(function (u) { return /^https:\/\/celestrak\.org\/NORAD\/elements\/gp\.php\?FORMAT=json&GROUP=/.test(u); }));

h = fakeHttp({});
S.refresh(fs, h, ALL, T0 + 3 * 3600 * 1000, null);
check('fresh data is not fetched again the same day', h.calls.length === 0);

h = fakeHttp({});
S.refresh(fs, h, ALL, T0 + S.STALE_MS + 1000, null);
check('a day later, everything is fetched again', h.calls.length === 3);

// Failures: keep the old copy, wait at least 2 h, then double the wait.
var es = memStore();
h = fakeHttp({ stations: [403, 'GP data has not updated'] });
S.refresh(es, h, ALL, T0, null);
check('403 leaves no stations data', es.load('sf_sat_stations_v1', null) === null);
h = fakeHttp({ stations: [403, ''] });
S.refresh(es, h, ALL, T0 + 60 * 60 * 1000, null);
check('no retry an hour after a 403', h.calls.length === 0);
S.refresh(es, h, ALL, T0 + S.MIN_GAP_MS + 1000, null);
check('one retry after 2 h', h.calls.length === 1 && /stations/.test(h.calls[0]));
h = fakeHttp({ stations: [403, ''] });
S.refresh(es, h, ALL, T0 + 2 * S.MIN_GAP_MS + 2000, null);
check('second failure: the wait doubles (no retry 2 h later)', h.calls.length === 0);
S.refresh(es, h, ALL, T0 + S.MIN_GAP_MS + 1000 + 2 * S.MIN_GAP_MS + 1000, null);
check('... but a retry 4 h later', h.calls.length === 1);

var ks = memStore();
S.refresh(ks, fakeHttp({}), ALL, T0, null);
var before = ks.data['sf_sat_visual_v1'];
h = fakeHttp({ visual: [500, 'oops'] });
S.refresh(ks, h, ALL, T0 + S.STALE_MS + 1000, null);
check('a failed refresh keeps the old copy', ks.data['sf_sat_visual_v1'] === before);

h = fakeHttp({});
S.refresh(memStore(), h, { stations: true }, T0, null);
check('only enabled groups are fetched', h.calls.length === 1 && /stations/.test(h.calls[0]));

// Storage full: the download counts as failed and backs off.
var full = memStore({}, true);
h = fakeHttp({});
S.refresh(full, h, ALL, T0, null);
h = fakeHttp({});
S.refresh(full, h, ALL, T0 + S.MIN_GAP_MS + 1000, null);
check('storage full: retried after 2 h, not before', h.calls.length === 3);
h = fakeHttp({});
S.refresh(full, h, ALL, T0 + 2 * S.MIN_GAP_MS + 2000, null);
check('storage full: then the wait doubles', h.calls.length === 0);

// Even if the tries can't be stored, one session never asks twice.
var nowrite = memStore();
nowrite.save = function () { return false; };
h = fakeHttp({});
S.refresh(nowrite, h, ALL, T0, null);
S.refresh(nowrite, h, ALL, T0 + 60000, null);
check('unwritable storage: no second request in the same session', h.calls.length === 3, h.calls.length);

// A timestamp in the future (clock was wrong) counts as long ago.
var future = memStore();
future.save('sf_sat_stations_v1', { t: T0 + 30 * 86400000, sats: [fx.omm] });
future.save('sf_sat_tries_v1', { stations: { t: T0 + 30 * 86400000, fails: 0 } });
h = fakeHttp({});
S.refresh(future, h, { stations: true }, T0, null);
check('future timestamps don\'t freeze the refresh', h.calls.length === 1);

// The Sun direction agrees with the app's (PyEphem-checked) Sun in every
// month; satellite.js's own sunPos is up to a degree off.
var worstSun = 0;
var P = require('../src/pkjs/planets.js');
for (var mo = 0; mo < 12; mo++) {
  var dt = new Date(Date.UTC(2026, mo, 15, 12));
  var u = S.sunVector(dt);
  var ra = A.rev(A.atan2d(u[1], u[0])), dec = A.asind(u[2]);
  var h2 = A.eqToHorizon(ra, dec, A.julianDay(dt), 33.5, -112);
  var b0 = P.bodies(dt, 33.5, -112)[0];
  worstSun = Math.max(worstSun, A.separation(h2.az, h2.alt, b0.az, b0.altTrue));
}
check('Sun direction for the shadow test matches the planets Sun', worstSun < 0.01, worstSun.toFixed(4));

if (failures) {
  console.log(failures + ' FAILED');
  process.exit(1);
}
console.log('PASS');
