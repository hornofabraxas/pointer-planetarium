// Checks src/pkjs/planes.js: feed parsing, the feed fallback rules, the
// standing-data cache, route checks, geometry and dead reckoning, and the
// card text. All data here is made up (no real feed is stored).
// Run: node test/planes.test.js
var P = require('../src/pkjs/planes.js');
var A = require('../src/pkjs/astro.js');
var M = require('../src/pkjs/matcher.js');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

function memStore() {
  var data = {};
  return {
    data: data,
    load: function (k, fb) { return k in data ? JSON.parse(data[k]) : fb; },
    save: function (k, v) { data[k] = JSON.stringify(v); return true; },
    remove: function (k) { delete data[k]; }
  };
}

var HOME = { lat: 33.5, lon: -112.0, altKm: 0.35 };
var T = Date.UTC(2026, 9, 8, 3, 0, 0);

// ---------------------------------------------------------------- parsing

function ac(o) {
  var a = { hex: 'abc123', flight: 'AAL1234 ', r: 'N123AA', t: 'A321', alt_baro: 30000, alt_geom: 31000,
            gs: 450, track: 45, lat: 34, lon: -111.5, seen_pos: 1, baro_rate: 0, category: 'A3' };
  for (var k in o) a[k] = o[k];
  return a;
}
var feedText = JSON.stringify({ now: T, msg: 'No error', ac: [
  ac({}), ac({ hex: 'g1', alt_baro: 'ground', alt_geom: undefined }), ac({ hex: 's1', seen_pos: 75 }),
  ac({ hex: 'b1', lat: 'x' }), null, ac({ hex: 'n1', alt_baro: undefined, alt_geom: undefined })
] });
var f = P.parseFeed(feedText, T + 300);
check('feed parsed, bad records skipped', f && f.ac.length === 2 && f.t === T,
      f && f.ac.map(function (a) { return a.hex; }).join(','));
check('callsign trimmed, ground flagged', f.ac[0].flight === 'AAL1234' && f.ac[1].ground === true);
check('position time from now - seen_pos', f.ac[0].posMs === T - 1000);
var rx = P.parseFeed(JSON.stringify({ now: T / 1000, aircraft: [ac({})] }), T + 100);
check('receiver format (aircraft, now in seconds)', rx && rx.ac.length === 1 && rx.t === T);
var skew = P.parseFeed(JSON.stringify({ now: T - 3600000, ac: [ac({})] }), T);
check('a feed clock far off is replaced by the phone\'s', skew.t === T);
check('not JSON / no list -> null', P.parseFeed('<html>', T) === null && P.parseFeed('{"a":1}', T) === null);

// ---------------------------------------------------------------- geometry

// 20 km due north, 3,000 m above the observer: elevation from flat
// geometry less the Earth's curvature drop d^2/2R.
var o = { lat: 33.5, lon: -112, h: 0 };
var north = P.travel(33.5, -112, 0, 20000);
var la = P.lookAngles(o, { lat: north.lat, lon: north.lon, h: 3000 });
var expect = A.atan2d(3000 - 20000 * 20000 / (2 * 6371000), 20000);
check('plane 20 km north, 3 km up: az 0, elevation right', near(A.wrap180(la.az), 0, 0.01) && near(la.el, expect, 0.05),
      la.az.toFixed(2) + ' / ' + la.el.toFixed(3) + ' vs ' + expect.toFixed(3));
var up = P.lookAngles(o, { lat: 33.5, lon: -112, h: 10000 });
check('overhead is straight up', up.el > 89.99 && near(up.range, 10000, 1));
var moved = P.travel(33.5, -112, 0, 1852);
check('travel: one nautical mile north', near((moved.lat - 33.5) * 60, 1, 0.002) && near(moved.lon, -112, 1e-9));

// ---------------------------------------------------------------- dead reckoning

var standing0 = new P.Standing(memStore(), function (u, cb) { cb(404, ''); });
var east = { t: T, ac: [{ hex: 'e1', flight: 'N1', r: 'N1', t: '', desc: '', category: '', lat: 33.5,
                          lon: -111.9, ground: false, baro: 5000, geom: 5000, gs: 360, track: 90, vrate: 0,
                          posMs: T - 10000 }] };
var ps = P.positions(east, T, HOME, { maxKm: 50, minAboveFt: 500, units: 'imperial' }, standing0);
var start = P.lookAngles({ lat: HOME.lat, lon: HOME.lon, h: 350 }, { lat: 33.5, lon: -111.9, h: 5000 * 0.3048 });
var ahead = P.lookAngles({ lat: HOME.lat, lon: HOME.lon, h: 350 },
                         { lat: 33.5, lon: -111.9 + 1852 / (111320 * A.cosd(33.5)), h: 5000 * 0.3048 });
check('moved 10 s along its track (1 nm east at 360 kt)', ps.length === 1 && near(ps[0].rangeM, ahead.range, 30) &&
      ps[0].rangeM > start.range + 1500, ps.length && Math.round(ps[0].rangeM) + ' m vs ' + Math.round(ahead.range));
var low = { t: T, ac: [{ hex: 'l1', flight: '', r: '', t: '', desc: '', category: '', lat: 33.55, lon: -112,
                         ground: false, baro: 1400, geom: 1400, gs: 90, track: 0, vrate: 0, posMs: T }] };
check('hidden when lower than the minimum above you',
      P.positions(low, T, HOME, { maxKm: 50, minAboveFt: 500 }, standing0).length === 0 &&
      P.positions(low, T, HOME, { maxKm: 50, minAboveFt: 0 }, standing0).length === 1);
var far = { t: T, ac: [{ hex: 'f1', flight: '', r: '', t: '', desc: '', category: '', lat: 34.5, lon: -112,
                         ground: false, baro: 30000, geom: 30000, gs: 400, track: 0, vrate: 0, posMs: T }] };
check('beyond the range setting: left out', P.positions(far, T, HOME, { maxKm: 80 }, standing0).length === 0 &&
      P.positions(far, T, HOME, { maxKm: 120 }, standing0).length === 1);

// How fast and which way it crosses the sky: east, seen from the
// south-west of it, it moves right; its speed is its ground speed.
var northEast = { t: T, ac: [{ hex: 'n1', flight: 'N2', r: 'N2', t: '', desc: '', category: '', lat: HOME.lat + 0.2,
                               lon: HOME.lon, ground: false, baro: 9000, geom: 9000, gs: 360, track: 90, vrate: 0,
                               posMs: T }] };
var pn = P.positions(northEast, T, HOME, { maxKm: 50, units: 'imperial' }, standing0)[0];
var mv = pn.move;
check('speed from ground speed (360 kt)', near(pn.speedMs, 360 * 0.514444, 1e-6), pn.speedMs);
check('due north of us flying east: to the right as we face it', mv && mv.dx > 0 && Math.abs(mv.dy) < mv.dx,
      JSON.stringify(mv));
var path1 = P.path(pn, [new Date(T), new Date(T + 1000), new Date(T - 60000)], HOME);
check('its path: now where it is, a second on where move says', near(path1[0].az, pn.az, 1e-6) &&
      near(path1[0].alt, pn.alt, 1e-6) &&
      near(A.wrap180(path1[1].az - path1[0].az) * A.cosd(path1[0].alt), mv.dx, 1e-6) &&
      near(path1[1].alt - path1[0].alt, mv.dy, 1e-6), JSON.stringify(path1));
check('its path goes back too (a minute ago it was further west)', A.wrap180(path1[2].az - path1[0].az) < 0);
check('no speed: no path, no move', P.path({ ac: { gs: null, track: 90 } }, [new Date(T)], HOME) === null &&
      P.positions(lost(null, 90), T, HOME, { maxKm: 50 }, standing0)[0].move === null);

// Its shape: what it says it is, else its type, else its size.
function rows(csv) { return P.csvRows('ICAO,Manufacturer,Model,Engines,EngineTypeCode,EnginePlacementCode,SpeciesCode,' +
                                      'WakeTurbulenceCode,IsActive\n' + csv); }
var C = P.CRAFT;
check('types to shapes', P.typeCraft('B738', rows('B738,Boeing,737-800,2,J,,L,M,1')) === C.AIRLINER &&
      P.typeCraft('B744', rows('B744,Boeing,747-400,4,J,,L,H,1')) === C.JUMBO &&
      P.typeCraft('A388', rows('A388,Airbus,A-380-800,4,J,,L,H,1')) === C.JUMBO &&
      P.typeCraft('CRJ9', rows('CRJ9,Bombardier,CRJ-900,2,J,,L,M,1')) === C.REAR_JET &&
      P.typeCraft('C68A', rows('C68A,Cessna,Citation Latitude,2,J,,L,M,1')) === C.REAR_JET &&
      P.typeCraft('DH8D', rows('DH8D,De Havilland,Dash 8-400,2,T,,L,M,1')) === C.PROPS &&
      P.typeCraft('C172', rows('C172,Cessna,172,1,P,,L,L,1')) === C.LIGHT &&
      P.typeCraft('PC12', rows('PC12,Pilatus,PC-12,1,T,,L,L,1')) === C.LIGHT &&
      P.typeCraft('AS50', rows('AS50,Airbus Helicopters,H-125,1,T,,H,L,1')) === C.HELI &&
      P.typeCraft('F16', rows('F16,General Dynamics,F-16,1,J,,L,M,1')) === C.FAST_JET &&
      P.typeCraft('F18S', rows('')) === C.FAST_JET &&
      P.typeCraft('ZZZZ', rows('')) === C.NONE);
check('what it says it is wins; else a guess from its size', P.craftOf({ category: 'A7' }, C.AIRLINER) === C.HELI &&
      P.craftOf({ category: 'B1' }, 0) === C.GLIDER && P.craftOf({ category: 'A6' }, C.AIRLINER) === C.FAST_JET &&
      P.craftOf({ category: 'A3' }, C.REAR_JET) === C.REAR_JET && P.craftOf({ category: 'A3' }, 0) === C.AIRLINER &&
      P.craftOf({ category: 'A1' }, 0) === C.LIGHT && P.craftOf({ category: 'B2' }, 0) === C.NONE);

// No speed or no direction after 30 s: the error covers where it could be.
function lost(gs, track) {
  return { t: T, ac: [{ hex: 'x1', flight: '', r: '', t: '', desc: '', category: '', lat: 33.55, lon: -112,
                        ground: false, baro: 5000, geom: 5000, gs: gs, track: track, vrate: null, posMs: T - 30000 }] };
}
var sNoGs = P.positions(lost(null, 90), T, HOME, { maxKm: 50 }, standing0)[0].sigmaObj;
var sNoTrack = P.positions(lost(300, null), T, HOME, { maxKm: 50 }, standing0)[0].sigmaObj;
var sBoth = P.positions(lost(300, 90), T, HOME, { maxKm: 50 }, standing0)[0].sigmaObj;
check('missing speed or direction widens the error to the distance it could fly', sNoGs > 20 && sNoTrack > 20 && sBoth < 5,
      sNoGs.toFixed(1) + ', ' + sNoTrack.toFixed(1) + ' vs ' + sBoth.toFixed(1));

// A receiver's clock isn't trusted; a public feed's is, within 10 s.
var skewText = JSON.stringify({ now: (T - 120000) / 1000, aircraft: [ac({ seen_pos: 2 })] });
check('receiver clock 2 min slow: positions dated by the phone', P.parseFeed(skewText, T, false).ac[0].posMs === T - 2000);
check('feed clock within 10 s: used', P.parseFeed(JSON.stringify({ now: T - 4000, ac: [ac({ seen_pos: 1 })] }), T).ac[0].posMs ===
      T - 5000);

// Pressure altitude only: corrected by the gap seen on planes reporting both.
var mixed = { t: T, ac: [
  { hex: 'm1', flight: '', r: '', t: '', desc: '', category: '', lat: 33.6, lon: -112, ground: false,
    baro: 33000, geom: 35000, gs: 0, track: null, vrate: null, posMs: T },
  { hex: 'm2', flight: '', r: '', t: '', desc: '', category: '', lat: 33.6, lon: -112, ground: false,
    baro: 33000, geom: null, gs: 0, track: null, vrate: null, posMs: T }] };
var mp = P.positions(mixed, T, HOME, { maxKm: 50 }, standing0);
check('baro-only plane placed at the GPS height of its neighbours', mp.length === 2 && near(mp[0].altTrue, mp[1].altTrue, 0.01));
check('card height shows pressure altitude', /^33,000 ft, /.test(mp[1].l3), mp[1].l3);

// ---------------------------------------------------------------- standing data

var VRS = {
  'airlines/schema-01/airlines.csv': '﻿Code,Name,ICAO,IATA,PositioningFlightPattern,CharterFlightPattern\n' +
    'AA,American Airlines,AAL,AA,,\nDL,Delta Air Lines,DAL,DL,,\nXX,"Acme Air, Inc",ACM,XX,,\n',
  'routes/schema-01/A/AAL-all.csv': 'Callsign,Code,Number,AirlineCode,AirportCodes\n' +
    'AAL1234,AAL,1234,AAL,KPHX-KORD\nAAL34,AAL,34,AAL,KLAX-KPHX-KORD\nAAL99,AAL,99,AAL,KORD-KPHX\n',
  'airports/schema-01/K/KP.csv': 'Code,Name,ICAO,IATA,Location,CountryISO2,Latitude,Longitude,AltitudeFeet\n' +
    'KPHX,Phoenix Sky Harbor International Airport,KPHX,PHX,Phoenix,US,33.434299,-112.012001,1135\n',
  'airports/schema-01/K/KO.csv': 'Code,Name,ICAO,IATA,Location,CountryISO2,Latitude,Longitude,AltitudeFeet\n' +
    'KORD,"Chicago O\'Hare International Airport",KORD,ORD,Chicago,US,41.9786,-87.9048,672\n',
  'airports/schema-01/K/KL.csv': 'Code,Name,ICAO,IATA,Location,CountryISO2,Latitude,Longitude,AltitudeFeet\n' +
    'KLAX,Los Angeles International Airport,KLAX,LAX,Los Angeles,US,33.942501,-118.407997,125\n',
  'model-type/schema-01/P.csv': 'ICAO,Manufacturer,Model,Engines,EngineTypeCode,EnginePlacementCode,SpeciesCode,WakeTurbulenceCode,IsActive\n' +
    'PA46,Piper,PA-46 Malibu,1,P,,L,L,1\nPA46,Piper,PA-46-500TP Malibu Meridian,1,T,,L,L,1\nPA46,Acme,PA46,1,P,,L,L,1\n'
};
var vrsCalls = [];
function vrsHttp(url, cb) {
  vrsCalls.push(url);
  var path = url.replace('https://cdn.jsdelivr.net/gh/vradarserver/standing-data@main/', '');
  if (path in VRS) cb(200, VRS[path]);
  else cb(404, 'not found');
}
var sstore = memStore();
var nowMs = T;
var st = new P.Standing(sstore, vrsHttp, function () { return nowMs; });

check('airline names shortened', P.shortAirline('American Airlines') === 'American' &&
      P.shortAirline('Delta Air Lines') === 'Delta' && P.shortAirline('Acme Air, Inc') === 'Acme Air' &&
      P.shortAirline('Air Canada') === 'Air Canada' && P.shortAirline('British Airways') === 'British Airways' &&
      P.shortAirline('China Airlines') === 'China Airlines' && P.shortAirline('Air Wisconsin Airlines') === 'Air Wisconsin',
      [P.shortAirline('Acme Air, Inc'), P.shortAirline('British Airways')].join(', '));
check('CSV with BOM and quoted commas', P.csvRows(VRS['airlines/schema-01/airlines.csv'])[2].Name === 'Acme Air, Inc');
check('callsigns: airline flights only, leading zeros dropped',
      P.parseCallsign('AAL0034').key === 'AAL34' && P.parseCallsign('N123AB') === null &&
      P.parseCallsign('TRON75') === null && P.parseCallsign('SWA12A').number === '12A');

// A plane 200 km out of Phoenix toward Chicago, heading along the route.
var b = A.rev(A.atan2d(A.sind(-87.9048 + 112.012) * A.cosd(41.9786),
                       A.cosd(33.4343) * A.sind(41.9786) - A.sind(33.4343) * A.cosd(41.9786) * A.cosd(-87.9048 + 112.012)));
var p200 = P.travel(33.4343, -112.012, b, 200000);
function plane(flight, lat, lon, track, t) {
  return { hex: 'p' + flight, flight: flight, r: 'N1', t: t || 'A321', desc: '', category: 'A3', lat: lat,
           lon: lon, ground: false, baro: 30000, geom: 30500, gs: 450, track: track, vrate: 0, posMs: T };
}
var onRoute = plane('AAL1234', p200.lat, p200.lon, b + 2);
var done = false;
st.prepare([onRoute, plane('AAL0034', p200.lat, p200.lon, b), plane('DAL5', 33, -112, 0, 'PA46')], function () { done = true; });
check('standing data fetched in two stages (routes, then airports)', done &&
      vrsCalls.some(function (u) { return /KP\.csv$/.test(u); }) && vrsCalls.some(function (u) { return /KO\.csv$/.test(u); }),
      vrsCalls.length + ' requests');
check('route on its leg: Phoenix to Chicago', P.routeFor(onRoute, st) && P.routeFor(onRoute, st).to.code === 'KORD');
check('multi-leg route: the leg it is on', P.routeFor(plane('AAL0034', p200.lat, p200.lon, b), st).from.code === 'KPHX');
check('flying the other way: no route', P.routeFor(plane('AAL1234', p200.lat, p200.lon, b + 180), st) === null);
var off = P.travel(p200.lat, p200.lon, b + 90, 300000);
check('300 km off the leg: no route', P.routeFor(plane('AAL1234', off.lat, off.lon, b), st) === null);
check('reversed route number not mixed up', P.routeFor(plane('AAL99', p200.lat, p200.lon, b), st) === null);

var cards = P.positions({ t: T, ac: [plane('AAL1234', 33.6, -112.0, b), plane('DAL5', 33.45, -112.05, 0, 'PA46'),
                                     plane('XYZ9', 33.4, -112, 0, 'ZZZZ')] },
                        T, HOME, { maxKm: 50, units: 'imperial' }, st);
var byFlight = {};
cards.forEach(function (c) { byFlight[c.ac.flight] = c; });
check('card: airline and number, route', byFlight.AAL1234.l1 === 'American 1234' &&
      byFlight.AAL1234.l2 === 'Phoenix to Chicago', byFlight.AAL1234.l1 + ' / ' + byFlight.AAL1234.l2);
check('card: no route file -> aircraft type from VRS', byFlight.DAL5.l1 === 'Delta 5' &&
      byFlight.DAL5.l2 === 'Piper PA-46 Malibu', byFlight.DAL5.l2);
check('card: unknown airline -> callsign, unknown type -> registration', byFlight.XYZ9.l1 === 'XYZ9' &&
      byFlight.XYZ9.l2 === 'N1', byFlight.XYZ9.l2);
check('card: height and distance', /^30,000 ft, \d+ mi away$/.test(byFlight.AAL1234.l3), byFlight.AAL1234.l3);
var metric = P.positions({ t: T, ac: [plane('AAL1234', 33.6, -112.0, b)] }, T, HOME, { maxKm: 50, units: 'metric' }, st);
check('card: metric', /^9,140 m, \d+ km away$/.test(metric[0].l3), metric[0].l3);

// Caching: nothing is fetched again; a 404 is remembered; failures retry
// after half an hour; old route files are refetched after a week.
vrsCalls = [];
st.prepare([onRoute], function () {});
check('cached: no new requests', vrsCalls.length === 0, vrsCalls.join(' '));
var st2 = new P.Standing(sstore, vrsHttp, function () { return nowMs; });
st2.prepare([onRoute], function () {});
check('cached on the phone across sessions', vrsCalls.length === 0);
var flaky = 0;
var st3 = new P.Standing(memStore(), function (u, cb) { flaky++; cb(500, ''); }, function () { return nowMs; });
st3.ensure(['airlines'], function () {});
st3.ensure(['airlines'], function () {});
nowMs = T + 31 * 60000;
st3.ensure(['airlines'], function () {});
check('a failed download waits 30 min before trying again', flaky === 2, flaky);
nowMs = T + 8 * 86400000;
var st4 = new P.Standing(sstore, vrsHttp, function () { return nowMs; });
vrsCalls = [];
st4.ensure(['route:AAL', 'airlines'], function () {});
check('route files refreshed after a week, tables kept a month',
      vrsCalls.length === 1 && /AAL-all/.test(vrsCalls[0]), vrsCalls.join(' '));
nowMs = T;

// The phone keeps at most about 1 MB of standing data, dropping what was
// used longest ago: 30 route files of about 40 KB each don't all fit.
var bigStore = memStore();
var bigCsv = 'Callsign,AirportCodes\n';
for (var j = 0; j < 2000; j++) bigCsv += 'XXX' + j + ',KAAA-KBBB\n';
var st5 = new P.Standing(bigStore, function (u, cb) { cb(200, bigCsv); }, function () { return nowMs++; });
var many = [];
for (var i = 0; i < 70; i++) many.push('route:A' + String.fromCharCode(65 + Math.floor(i / 26)) + String.fromCharCode(65 + i % 26));
st5.ensure(['route:AAA'], function () {});
st5.ensure(many.slice(1, 16), function () {});
st5.get('route:AAA');   // used again: should survive the next downloads
st5.ensure(many.slice(16, 30), function () {});
var keptKeys = Object.keys(bigStore.data).filter(function (k) { return /^sf_vrs_route/.test(k); });
var size = keptKeys.reduce(function (n, k) { return n + bigStore.data[k].length; }, 0);
check('old files pruned to the size budget', keptKeys.length < 30 && size <= 1000000,
      keptKeys.length + ' kept, ' + size + ' chars');
check('a file in use is kept (least recently used goes first)', 'sf_vrs_route_AAA_v1' in bigStore.data &&
      !('sf_vrs_route_AAB_v1' in bigStore.data));

// Storage full: old files make room; if nothing helps, the data still
// works for this session.
var fullStore = memStore();
var room = 0;
fullStore.save = function (k, v) {
  if (/route/.test(k) && room <= 0) return false;
  fullStore.data[k] = JSON.stringify(v);
  return true;
};
var st6 = new P.Standing(fullStore, vrsHttp, function () { return nowMs; });
st6.ensure(['route:AAL'], function () {});
check('storage full: kept for the session anyway', !!st6.get('route:AAL') && !('sf_vrs_route_AAL_v1' in fullStore.data));

// A 404 for the airline table is a failure (never "no airlines"); other
// 404s are believed for a day.
var st7 = new P.Standing(memStore(), function (u, cb) { cb(404, ''); }, function () { return nowMs; });
st7.ensure(['airlines', 'route:QQQ'], function () {});
check('airline table 404: not cached', st7.get('airlines') === undefined && st7.get('route:QQQ') !== undefined);
nowMs = T + 25 * 3600000;
check('other 404s expire after a day', st7.get('route:QQQ') === undefined);
nowMs = T;

check('type name: maker with most rows, best-matching model',
      P.pickTypeName('PA46', P.csvRows(VRS['model-type/schema-01/P.csv'])) === 'Piper PA-46 Malibu');

// ---------------------------------------------------------------- feed client

function rig(behaviour) {
  var timers = [], clock = T, calls = [];
  var client = new P.FeedClient({
    store: memStore(),
    now: function () { return clock; },
    setTimeout: function (fn, ms) { timers.push({ at: clock + ms, fn: fn }); },
    http: function (url, cb) {
      calls.push(url);
      var id = /adsb\.lol/.test(url) ? 'lol' : /adsb\.fi/.test(url) ? 'fi' : 'rx';
      var b = behaviour[id] || 'ok';
      if (b === 'ok') cb(200, feedText);
      else if (b === 'fail') cb(429, 'slow down');
      else if (b === 'hang') rigHang.push(cb);
    }
  });
  var rigHang = [];
  return {
    client: client, calls: calls, hang: rigHang,
    advance: function (ms) {
      clock += ms;
      timers.slice().forEach(function (t) {
        if (t.at <= clock && !t.ran) { t.ran = true; t.fn(); }
      });
    },
    setClock: function (c) { clock = c; }
  };
}
var PREFS = { source: 'auto', rxUrl: '', nm: 26 };
var got = [];
var r1 = rig({});
r1.client.get({ lat: 33.4567, lon: -112.0749 }, PREFS, function (res) { got.push(res); });
check('first choice answers: used', got[0] && got[0].feed === 'lol' && r1.calls.length === 1);
check('location rounded to 0.01 deg in the request', r1.calls[0] === 'https://api.adsb.lol/v2/point/33.46/-112.07/26',
      r1.calls[0]);
r1.advance(5000);
r1.client.get({ lat: 33.4567, lon: -112.0749 }, PREFS, function (res) { got.push(res); });
check('within 10 s: the same answer, no new request', r1.calls.length === 1 && got[1] === got[0]);
r1.advance(6000);
r1.client.get({ lat: 33.4567, lon: -112.0749 }, PREFS, function (res) { got.push(res); });
check('after 10 s: asked again', r1.calls.length === 2);

var r2 = rig({ lol: 'hang' });
got = [];
r2.client.get(HOME, PREFS, function (res) { got.push(res); });
r2.advance(2000);
check('slow first feed: nothing yet at 2 s', got.length === 0 && r2.calls.length === 1);
r2.advance(600);
check('... adsb.fi asked at 2.5 s and its answer used', got.length === 1 && got[0].feed === 'fi' && r2.calls.length === 2);
r2.hang[0](200, feedText);
check('a late answer from the loser changes nothing', got.length === 1);

var r3 = rig({ lol: 'fail' });
got = [];
r3.client.get(HOME, PREFS, function (res) { got.push(res); });
check('first feed errors: the other is asked at once', got.length === 1 && got[0].feed === 'fi');

var r4 = rig({ lol: 'fail', fi: 'fail' });
got = [];
r4.client.get(HOME, PREFS, function (res) { got.push(res); });
check('both fail: null, as failed', got.length === 1 && got[0] === null && r4.client.why === 'failed');
r4.advance(9000);
check('... and only once', got.length === 1);

var r5 = rig({ lol: 'hang', fi: 'hang' });
got = [];
r5.client.get(HOME, PREFS, function (res) { got.push(res); });
r5.client.get(HOME, PREFS, function (res) { got.push(res); });
check('a second request joins the one in flight', r5.calls.length === 1);
r5.advance(P.FEED_TIMEOUT_MS + 1);
check('nobody answers: null after 15 s, for both callers, as slow', got.length === 2 && got[0] === null &&
      got[1] === null && r5.client.why === 'slow');

var r6 = rig({ lol: 'fail' });
r6.client.get(HOME, PREFS, function () {});
check('after a failure the faster feed goes first', r6.client.ranked()[0] === 'fi', r6.client.ranked().join(','));

var r7 = rig({ lol: 'fail' });
got = [];
r7.client.get(HOME, { source: 'lol', nm: 26 }, function (res) { got.push(res); });
check('a chosen feed is the only one asked', got[0] === null && r7.calls.length === 1);

var r9 = rig({ lol: 'fail', fi: 'fail' });
r9.client.get(HOME, PREFS, function () {});
var before = r9.calls.length;
got = [];
r9.client.get(HOME, PREFS, function (res) { got.push(res); });
check('a failure is remembered for 10 s (the aim after a failed tap asks nobody)',
      r9.calls.length === before && got[0] === null);
r9.advance(11000);
r9.client.get(HOME, PREFS, function () {});
check('every feed resting: null, as resting', r9.client.why === 'resting');
check('a feed that said 429 is left alone for 10 minutes', r9.calls.length === before, r9.calls.length - before);
r9.advance(10 * 60000);
r9.client.get(HOME, PREFS, function () {});
check('... then asked again', r9.calls.length > before);

var r10 = rig({ lol: 'hang', fi: 'hang' });
got = [];
r10.client.get(HOME, PREFS, function (res) { got.push(res); });
r10.advance(P.FEED_TIMEOUT_MS + 1);
r10.advance(3000);
var n10 = r10.calls.length;
r10.client.get(HOME, PREFS, function (res) { got.push(res); });
check('no second request to a feed still answering the first', r10.calls.length === n10 && got[1] === null, r10.calls.length);
r10.hang[0](200, feedText);
r10.client.get(HOME, PREFS, function (res) { got.push(res); });
check('a good answer that came after the timeout is used next time', got[2] && got[2].feed === 'lol');

var r11 = rig({});
var order = [];
r11.client.get(HOME, PREFS, function () { throw new Error('boom'); });
r11.advance(11000);
r11.client.get(HOME, PREFS, function () { order.push(1); });
check('a throwing caller doesn\'t break the client', order.length === 1);

var r8 = rig({ rx: 'fail' });
got = [];
r8.client.get(HOME, { source: 'rx', rxUrl: 'http://192.168.1.5/data/aircraft.json', nm: 26 }, function (res) { got.push(res); });
check('receiver first, public feeds when it can\'t be reached',
      r8.calls[0] === 'http://192.168.1.5/data/aircraft.json' && got[0] && got[0].feed === 'lol');

// ---------------------------------------------------------------- matching

var planets = require('../src/pkjs/planets.js');
var moon = require('../src/pkjs/moon.js');
function skyAt(date) {
  var bodies = planets.bodies(date, HOME.lat, HOME.lon);
  return { jd: A.julianDay(date), lat: HOME.lat, lon: HOME.lon, sunAlt: bodies[0].alt, sky: 'suburbs',
           bodies: bodies, moon: moon.moonAltAz(date, HOME.lat, HOME.lon), sats: null };
}
var nightSky = skyAt(new Date(T));
var noon = skyAt(new Date(Date.UTC(2026, 9, 8, 19, 0)));
var pls = P.positions({ t: T, ac: [plane('AAL1234', 33.6, -112.0, b)] }, T, HOME, { maxKm: 50, units: 'imperial' }, st);
var target = pls[0];
nightSky.planes = pls;
noon.planes = pls;
function aimAt(pos, layer) {
  return { az: pos.az, alt: pos.alt, sigma: 5, layer: layer, rollTooFar: false };
}
var r = M.match(aimAt(target, M.LAYER.PLANES), nightSky);
check('aim at a plane (PLANES): it, sure', r.cards[0].type === M.TYPE.PLANE && r.cards[0].l1 === 'American 1234' &&
      r.cards[0].word === M.WORD.THATS, r.cards[0].l1 + ' ' + Math.round(r.cards[0].p * 100) + '%');
r = M.match(aimAt(target, M.LAYER.ANY), noon);
check('planes count in daylight too (ANYTHING)', r.cards[0].type === M.TYPE.PLANE, r.cards[0].l1);
noon.planes = null;
noon.planesNote = "Can't reach plane data";
r = M.match(aimAt(target, M.LAYER.PLANES), noon);
check('no plane data: says so', r.cards[0].type === M.TYPE.NOTHING && r.cards[0].l3 === "Can't reach plane data",
      r.cards[0].l3);
noon.planes = [];
noon.planesNote = '';
r = M.match(aimAt({ az: 200, alt: 40 }, M.LAYER.PLANES), noon);
check('no planes at all: none tracked', r.cards[0].l3 === 'None tracked nearby', r.cards[0].l3);
noon.planesNote = 'Few planes tracked here';
r = M.match(aimAt({ az: 200, alt: 40 }, M.LAYER.PLANES), noon);
check('no planes, thin coverage: says so', r.cards[0].l3 === 'Few planes tracked here', r.cards[0].l3);
noon.planes = pls;
r = M.match(aimAt({ az: 200, alt: 40 }, M.LAYER.PLANES), noon);
check('planes, none there', r.cards[0].l3 === 'No plane right there', r.cards[0].l3);

if (failures) {
  console.log(failures + ' FAILED');
  process.exit(1);
}
console.log('PASS');
