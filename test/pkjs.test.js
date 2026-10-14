// Runs src/pkjs/index.js against stub Pebble / localStorage / geolocation
// objects: status on ready, one aim in and its cards out, the
// settings page and saving the sky setting. Run: node test/pkjs.test.js
var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

var store = {};
global.localStorage = {
  getItem: function (k) { return k in store ? store[k] : null; },
  setItem: function (k, v) { store[k] = String(v); },
  removeItem: function (k) { delete store[k]; }
};
var geoCalls = 0;
Object.defineProperty(global, 'navigator', { configurable: true, value: {
  geolocation: { getCurrentPosition: function (ok) {
    geoCalls++;
    ok({ coords: { latitude: 33.49, longitude: -111.99, altitude: 379, accuracy: 20 } });
  } }
} });

// CelesTrak: stations answers with the fixture's ISS, the others with 403
// (as when another phone on the same address fetched them first).
// adsb.lol: one made-up airliner 15 km north of the stub location, at the
// feed's "now" (set per test). VRS: the airline table only.
var satFx = require('./sat_fixture.json');
var xhrUrls = [];
var feedNow = 0;
var PLANE = { hex: 'a1b2c3', flight: 'AAL1234 ', r: 'N100AA', t: 'A321', alt_baro: 12000, alt_geom: 12300,
              gs: 0, track: 0, lat: 33.49 + 15 / 111.2, lon: -111.99, seen_pos: 0.5 };
global.XMLHttpRequest = function () {
  var x = this;
  x.open = function (method, url) { x.url = url; };
  x.send = function () {
    xhrUrls.push(x.url);
    x.status = 403;
    x.responseText = 'no';
    if (/GROUP=stations/.test(x.url)) {
      x.status = 200;
      x.responseText = JSON.stringify([satFx.omm]);
    } else if (/api\.adsb\.lol/.test(x.url)) {
      x.status = 200;
      x.responseText = JSON.stringify({ now: feedNow, ac: [PLANE] });
    } else if (/airlines\.csv$/.test(x.url)) {
      x.status = 200;
      x.responseText = 'Code,Name,ICAO,IATA\nAA,American Airlines,AAL,AA\n';
    } else if (/jsdelivr/.test(x.url)) {
      x.status = 404;
    }
    x.onload();
  };
};

var handlers = {}, sent = [], opened = null;
global.Pebble = {
  addEventListener: function (name, fn) { handlers[name] = fn; },
  sendAppMessage: function (msg, ok) { sent.push(msg); ok(); },
  openURL: function (url) { opened = url; }
};
var realSetInterval = global.setInterval;
var ticker = null;
global.setInterval = function (fn) { ticker = fn; return 0; };   // the minute ticker, run by hand

// Replayed aims carry their old watch time; the phone checks it against its
// own clock, so pretend the phone's clock reads the aim time (+1.5 s).
var realNow = Date.now;
function atTime(ms, fn) {
  Date.now = function () { return ms + 1500; };
  try { fn(); } finally { Date.now = realNow; }
}

// Left by a developer build before v1.0: dropped on load.
store.sf_dev_v1 = '{"field":true}';
store.sf_aimlog_v1 = '[]';
var index = require('../src/pkjs/index.js');
check('old developer keys dropped on load', !('sf_dev_v1' in store) && !('sf_aimlog_v1' in store));
handlers.ready();
var status = sent.filter(function (m) { return 'STATUS' in m && 'DAYLIGHT' in m; }).pop();
check('status with theme and layers after a location fix', status && status.LAYERS === 63,
      status && status.STATUS.split('\x1f').join(' / '));
check('location stored under an sf_ key', !!store.sf_location_v1);
var ephMsg = sent.filter(function (m) { return 'SKY_EPH' in m; });
check('the Moon-and-planets table goes to the watch', ephMsg.length >= 1 && ephMsg[0].SKY_EPH.length > 600 &&
      ephMsg[0].SKY_EPH[0] === 1, ephMsg.length + ' sent');
check('the sky frame goes with the status', status && Array.isArray(status.SKY_FRAME) && status.SKY_FRAME.length === 19);
check('satellites fetched once per group on open', xhrUrls.length === 3, xhrUrls.length + ' requests');
check('stations stored, refused groups not', !!store['sf_sat_stations_v1'] && !store['sf_sat_visual_v1']);
check('SATELLITES status line sent', status && status.STATUS.split('\x1f')[2].length > 0,
      status && status.STATUS.split('\x1f')[2]);

// One of the field aims from 2026-10-07 (left wrist, daytime Moon).
sent = [];
atTime(Date.UTC(2026, 9, 7, 18, 45, 45, 769), function () {
  handlers.appmessage({ payload: {
    A_SEQ: 3, A_T: Math.floor(Date.UTC(2026, 9, 7, 18, 45, 45) / 1000), A_MS: 769, A_HEAD: 22789,
    A_JIT: 368, A_AX: -860, A_AY: -157, A_AZ: -511, A_CAL: 2, A_NC: 9, A_LAYER: 0, A_WRIST: 0
  } });
});
var reply = sent.filter(function (m) { return 'R_SEQ' in m; })[0];
check('aim answered with its sequence number', reply && reply.R_SEQ === 3);
var cards = reply.R_DATA.split('\x1e').map(function (c) { return c.split('\x1f'); });
check('every card has six fields', cards.every(function (c) { return c.length === 6; }));
check('field aim at the daytime Moon finds the Moon', cards[0][2] === 'The Moon',
      cards.map(function (c) { return c[2] + '/' + c[1]; }).join(' | '));
check('cards fit the watch inbox', reply.R_DATA.length < 700, reply.R_DATA.length + ' chars');
check('a sure answer about the Moon is followed by a fact card', cards[1][0] === '9' &&
      cards[1][2] === 'Did you know?' && typeof reply.R_FACT === 'string' && reply.R_FACT.length > 20,
      cards[1] && cards[1].join('/') + ' ' + reply.R_FACT);
check('no chart for the Moon', !('R_CHART' in reply) && cards.every(function (c) { return c[0] !== '8'; }));
var seenFacts = JSON.parse(store.sf_factseen_v1 || 'null');
check('facts turn over for each subject', seenFacts && seenFacts.n['moon:'] === 1 && seenFacts.last === reply.R_FACT,
      store.sf_factseen_v1);
check('the old single count is gone', !('sf_factn_v1' in store));

// A message too big for the watch drops the last cards, then the chart.
var big = { R_SEQ: 1, R_CHART: new Array(230).join('x').split('').map(function () { return 7; }), R_FACT: 'f' };
var many = [];
for (var bi = 0; bi < 7; bi++) {
  many.push({ type: bi ? 5 : 1, word: 1, l1: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', l2: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              l3: 'cccccccccccccccccccccccccccccccccccc', hint: 'dddddddddddddddddddddddddddddddddd' });
}
many[1].type = 8;
index.fitCards(many, big);
check('a big answer still fits the inbox', index.messageBytes(big) <= 2048 && big.R_DATA.split('\x1e').length >= 3,
      index.messageBytes(big) + ' bytes, ' + big.R_DATA.split('\x1e').length + ' cards');

// The first answer's pictures (addExtras): a star's chart on its own page
// with the aim and a caption; the same for a MAYBE first answer; a planet's
// chart on a chart card; the Moon's lighting; nothing there at night.
(function () {
  var A = require('../src/pkjs/astro.js');
  var M = require('../src/pkjs/matcher.js');
  var chartMod = require('../src/pkjs/chart.js');
  var planetsMod = require('../src/pkjs/planets.js');
  var moonMod = require('../src/pkjs/moon.js');
  var starsMod = require('../src/pkjs/stars.js');
  var when = new Date(Date.UTC(2026, 9, 9, 4, 0, 0));
  var here = { lat: 33.49, lon: -111.99 };
  var bodies = planetsMod.bodies(when, here.lat, here.lon);
  var sky = { jd: A.julianDay(when), lat: here.lat, lon: here.lon, sunAlt: bodies[0].alt, sky: 'suburbs',
              bodies: bodies, moon: moonMod.moonAltAz(when, here.lat, here.lon), sats: null };
  var vi = starsMod.catalog.findIndex(function (st) { return st.name === 'Vega'; });
  var vs = starsMod.starsOfDate(sky.jd)[vi];
  var vh = A.eqToHorizon(vs.ra, vs.dec, sky.jd, here.lat, here.lon);
  var aim = { az: vh.az + 2, alt: vh.alt + A.refraction(vh.alt) + 1 };
  var res = M.match({ az: aim.az, alt: aim.alt, sigma: 4, layer: M.LAYER.STARS }, sky);
  var msg = {};
  var out = index.addExtras(res.cards, sky, when, msg, aim);
  var d = msg.R_CHART && chartMod.decode(msg.R_CHART);
  check('a star answer: its chart on its own page, no chart card', out[0].l1 === 'Vega' && !!d &&
        out.every(function (c) { return c.type !== M.TYPE.CHART; }), out.map(function (c) { return c.type + ' ' + c.l1; }).join(', '));
  check('... with where you pointed and its caption', d && d.aim && d.caption === 'in Lyra' && d.length === msg.R_CHART.length,
        d && JSON.stringify(d.aim) + ' ' + d.caption);
  check('... and its fact card', out[1] && out[1].type === M.TYPE.FACT && !!msg.R_FACT);
  var maybe = res.cards.map(function (c) { return Object.assign({}, c); });
  maybe[0].word = M.WORD.MAYBE;
  var mmsg = {};
  index.addExtras(maybe, sky, when, mmsg, aim);
  check('a MAYBE first answer gets its chart and fact too', !!mmsg.R_CHART && !!mmsg.R_FACT);
  var sure = res.cards.map(function (c) { return Object.assign({}, c); });
  sure[0].word = M.WORD.THATS;
  var smsg = {};
  index.addExtras(sure, sky, when, smsg, aim);
  var sd = smsg.R_CHART && chartMod.decode(smsg.R_CHART);
  check("THAT'S IT: the chart without where you pointed", sd && !sd.aim && sd.caption === 'in Lyra');
  // Unsure, with another answer: what else it might be, in the caption's place.
  var two = [Object.assign({}, res.cards[0], { word: M.WORD.PROBABLY }),
             { type: M.TYPE.STAR, word: M.WORD.MAYBE, l1: 'Sheliak', l2: 'in Lyra', l3: '', hint: '' }];
  var rmsg = {};
  index.addExtras(two, sky, when, rmsg, aim);
  var rd = rmsg.R_CHART && chartMod.decode(rmsg.R_CHART);
  check('PROBABLY with another answer: "or Sheliak" for its caption', rd && rd.rival && rd.caption === 'or Sheliak',
        rd && rd.caption);
  check('... THAT\'S IT keeps its caption', d && !d.rival);
  two.push({ type: M.TYPE.STAR, word: M.WORD.MAYBE, l1: 'Sulafat', l2: '', l3: '', hint: '' });
  var r3 = {};
  index.addExtras(two, sky, when, r3, aim);
  check('... and more', chartMod.decode(r3.R_CHART).caption === 'or Sheliak and 1 more',
        chartMod.decode(r3.R_CHART).caption);

  // A plane: its path with its shape, its speed and way as the hint.
  var P = require('../src/pkjs/planes.js');
  var feed = { t: when.getTime(), ac: [{ hex: 'p1', flight: 'N1', r: 'N1', t: '', desc: '', category: 'A3',
                                         lat: here.lat + 0.15, lon: here.lon, ground: false, baro: 9000, geom: 9000,
                                         gs: 400, track: 90, vrate: 0, posMs: when.getTime() }] };
  var pls = P.positions(feed, when.getTime(), { lat: here.lat, lon: here.lon, altKm: 0.379 },
                        { maxKm: 50, units: 'imperial' }, { get: function () { return undefined; } });
  var psky = Object.assign({}, sky, { planes: pls });
  var pres = M.match({ az: pls[0].az, alt: pls[0].alt, sigma: 4, layer: M.LAYER.PLANES }, psky);
  var plm = {};
  var plOut = index.addExtras(pres.cards, psky, when, plm, { az: pls[0].az, alt: pls[0].alt });
  var pd = plm.R_CHART && chartMod.decode(plm.R_CHART);
  check('a plane answer: its path, with an airliner\'s shape on it', pd && pd.craft && pd.craft.kind === P.CRAFT.AIRLINER &&
        pd.arrow && plOut.every(function (c) { return c.type !== M.TYPE.CHART; }), pd && JSON.stringify(pd.craft));
  check('... flying east north of us: moving right, at its speed', plOut[0].hint === '460 mph, moving right',
        plOut[0].hint);
  var up = bodies.slice(1).filter(function (b) { return b.alt > 15; })[0];
  if (up) {
    var pres = M.match({ az: up.az, alt: up.alt, sigma: 4, layer: M.LAYER.PLANETS }, sky);
    var pmsg = {};
    var pout = index.addExtras(pres.cards, sky, when, pmsg, { az: up.az, alt: up.alt });
    check('a planet answer: its chart on a chart card after it', pout[0].l1 === up.name && pout[1] &&
          pout[1].type === M.TYPE.CHART && /is circled/.test(pout[1].l2) && !!pmsg.R_CHART && !pmsg.R_MOON,
          pout.map(function (c) { return c.type + ' ' + c.l1; }).join(', '));
  } else {
    check('a planet is up for the test', false);
  }
  // A planet's figure is one you can see near it: Saturn rising, 11 Oct
  // 2026 in Phoenix, is just inside Cetus, all of it still down.
  [['2026-10-12T01:30:00Z', 'Near Pegasus'], ['2026-10-12T02:15:00Z', 'Near Pisces'],
   ['2026-10-12T05:00:00Z', 'Cetus']].forEach(function (c) {
    var w = new Date(c[0]);
    var bs = planetsMod.bodies(w, here.lat, here.lon);
    var ssky = { jd: A.julianDay(w), lat: here.lat, lon: here.lon, sunAlt: bs[0].alt, sky: 'suburbs', bodies: bs,
                 moon: moonMod.moonAltAz(w, here.lat, here.lon), sats: null };
    var sat = bs.filter(function (b) { return b.name === 'Saturn'; })[0];
    var sres = M.match({ az: sat.az, alt: sat.alt, sigma: 4, layer: M.LAYER.PLANETS }, ssky);
    var sout = index.addExtras(sres.cards, ssky, w, {}, { az: sat.az, alt: sat.alt });
    check('Saturn at ' + sat.alt.toFixed(0) + ' degrees: ' + c[1], sout[1] && sout[1].type === M.TYPE.CHART &&
          sout[1].l1 === c[1], sout[1] && sout[1].l1);
  });
  // With no figure to see near it (twilight, from the city): the stars
  // around it, titled with where it is.
  var tw = new Date('2026-10-12T01:10:00Z');
  var tb = planetsMod.bodies(tw, here.lat, here.lon);
  var tsky = { jd: A.julianDay(tw), lat: here.lat, lon: here.lon, sunAlt: tb[0].alt, sky: 'city', bodies: tb,
               moon: moonMod.moonAltAz(tw, here.lat, here.lon), sats: null };
  var ts = tb.filter(function (b) { return b.name === 'Saturn'; })[0];
  var tmsg = {};
  var tout = index.addExtras(M.match({ az: ts.az, alt: ts.alt, sigma: 4, layer: M.LAYER.PLANETS }, tsky).cards,
                             tsky, tw, tmsg, null);
  var td = tmsg.R_CHART && chartMod.decode(tmsg.R_CHART);
  check('no figure to see: a bare chart, titled where it is', tout[1] && tout[1].l1 === 'Low in the E' && td &&
        td.segs.length === 0, tout[1] && tout[1].l1 + ' sun ' + tb[0].alt.toFixed(1));
  // (The Moon is down then; how it's lit doesn't care.)
  var mcard = [{ type: M.TYPE.MOON, word: 1, l1: 'The Moon', l2: 'Waning crescent', l3: '3% lit', hint: '',
                 ref: { kind: 'moon' } }];
  var mmsg2 = {};
  var mout = index.addExtras(mcard, sky, when, mmsg2, null);
  check('a Moon answer: how it is lit, no chart', mout[0].type === M.TYPE.MOON && mmsg2.R_MOON &&
        mmsg2.R_MOON.length === 2 && mmsg2.R_MOON[0] >= 0 && mmsg2.R_MOON[0] <= 100 && mmsg2.R_MOON[1] < 180 &&
        !mmsg2.R_CHART, JSON.stringify(mmsg2.R_MOON));
  var nothing = [{ type: M.TYPE.NOTHING, word: 0, l1: 'Nothing I know', l2: 'is there', l3: 'Pointing into Lyra',
                   hint: '', ref: { kind: 'constellation', id: 'Lyr', nothing: true } }];
  var nmsg = {};
  var nout = index.addExtras(nothing, sky, when, nmsg, aim);
  var nd = nmsg.R_CHART && chartMod.decode(nmsg.R_CHART);
  check('nothing there at night: the chart, captioned, and short lines', nd && nd.caption === 'Pointing into Lyra' &&
        nout[0].l1 === 'Nothing there' && nout[0].l2 === '' && nout[0].l3 === 'Pointing into Lyra');
  var tipped = [{ type: M.TYPE.NOTHING, word: 0, l1: 'Nothing I know', l2: 'is there', l3: 'Pointing into Lyra',
                  hint: 'Hold SELECT: tune on the Moon', ref: { kind: 'constellation', id: 'Lyr', nothing: true } }];
  var tmsg = {};
  index.addExtras(tipped, sky, when, tmsg, aim);
  check('... but not when it carries a tip', !tmsg.R_CHART && tipped[0].l1 === 'Nothing I know');
})();

// Find it: the list on request, with the sky frame, and the card for a
// target locked on to (with its fact).
sent = [];
atTime(Date.UTC(2026, 9, 9, 4, 0, 0), function () { handlers.appmessage({ payload: { FIND_REQ: 1 } }); });
var fl = sent.filter(function (m) { return 'FIND_LIST' in m; })[0];
var findMod = require('../src/pkjs/find.js');
var flist = fl && findMod.decodeList(fl.FIND_LIST);
check('Find it list sent with the sky frame', flist && flist.list.length > 3 && fl.SKY_FRAME.length === 19,
      flist && flist.list.map(function (t) { return t.name; }).join(', '));
var vegaId = flist.list.filter(function (t) { return t.name === 'Vega'; })[0].id;
sent = [];
atTime(Date.UTC(2026, 9, 9, 4, 0, 20), function () { handlers.appmessage({ payload: { FIND_FOUND: vegaId, A_SEQ: 90 } }); });
var found = sent.filter(function (m) { return m.R_SEQ === 90; })[0];
var fcards = found && found.R_DATA.split('\x1e').map(function (c) { return c.split('\x1f'); });
check('a found target gets its card, sure, no hint (the watch showed the way)', fcards && fcards[0][2] === 'Vega' &&
      fcards[0][1] === '1' && fcards[0][5] === '', fcards && fcards[0].join('/'));
check('... and a fact card after it', fcards && fcards.some(function (c) { return c[0] === '9'; }) && !!found.R_FACT,
      fcards && fcards.map(function (c) { return c[0]; }).join(','));
// A star pattern: its card, its own figure on the chart, a fact.
var triT = flist.list.filter(function (t) { return t.name === 'Summer Triangle'; })[0];
check('the Find it list has star patterns, and some marked Best now', !!triT &&
      flist.list.some(function (t) { return t.best; }) && flist.list.some(function (t) { return !t.best; }));
sent = [];
atTime(Date.UTC(2026, 9, 9, 4, 0, 30), function () { handlers.appmessage({ payload: { FIND_FOUND: triT.id, A_SEQ: 92 } }); });
var pf = sent.filter(function (m) { return m.R_SEQ === 92; })[0];
var pcards = pf && pf.R_DATA.split('\x1e').map(function (c) { return c.split('\x1f'); });
var pch = pf && pf.R_CHART && require('../src/pkjs/chart.js').decode(pf.R_CHART);
check('a found pattern: its card, sure, with its chart and caption', pcards && pcards[0][0] === '6' &&
      pcards[0][2] === 'Summer Triangle' && pcards[0][1] === '1' && pch && pch.segs.length === 3 &&
      pch.caption === 'Vega is circled', pcards && pcards[0].join('/') + ' ' + (pch && pch.caption));
check('... the star it was found by circled', pch && pch.points.filter(function (q) {
  return q.info & 4;
}).length === 1);
check('... and its fact', !!pf.R_FACT && /Triangle|Vega|Deneb|Altair/.test(pf.R_FACT), pf.R_FACT);
// The Moon by day (as in the field aim above): its own card, phase and all.
sent = [];
atTime(Date.UTC(2026, 9, 7, 18, 45, 0), function () { handlers.appmessage({ payload: { FIND_REQ: 1 } }); });
var dayList = findMod.decodeList(sent.filter(function (m) { return 'FIND_LIST' in m; })[0].FIND_LIST);
var moonT = dayList.list.filter(function (t) { return t.name === 'The Moon'; })[0];
check('the daytime Moon can be found', !!moonT, dayList.list.map(function (t) { return t.name; }).join(', '));
sent = [];
atTime(Date.UTC(2026, 9, 7, 18, 45, 30), function () { handlers.appmessage({ payload: { FIND_FOUND: moonT.id, A_SEQ: 91 } }); });
var mf = sent.filter(function (m) { return m.R_SEQ === 91; })[0];
var mcards = mf.R_DATA.split('\x1e').map(function (c) { return c.split('\x1f'); });
check('a found Moon gets the Moon card with its phase, and a fact', mcards[0][2] === 'The Moon' &&
      /crescent|quarter|gibbous|Moon/.test(mcards[0][3]) && /% lit/.test(mcards[0][4]) && !!mf.R_FACT,
      mcards[0].join('/'));
// What was found goes in the logbook, with roughly where (0.1 degree).
var book = JSON.parse(store.sf_logbook_v1 || '[]');
var foundIds = book.filter(function (e) { return e.w === 'found'; }).map(function (e) { return e.id + ' ' + e.n; });
check('found things go in the logbook', foundIds.some(function (x) { return /^star:\d+ Vega$/.test(x); }) &&
      foundIds.indexOf('pattern:summer Summer Triangle') >= 0 && foundIds.indexOf('moon The Moon') >= 0,
      foundIds.join(', '));
check('... noted roughly where', book.every(function (e) {
  return Math.abs(e.la * 10 - Math.round(e.la * 10)) < 1e-9 && Math.abs(e.la - 33.5) < 0.06;
}), JSON.stringify(book[0]));
handlers.showConfiguration();
var bookHtml = decodeURIComponent(opened.replace('data:text/html;charset=utf-8,', ''));
check('the settings page has a Logbook tab of shelves', /id="t-book"[^>]*>Logbook</.test(bookHtml) &&
      /<h2>Moon and planets <small>1 of 8<\/small>/.test(bookHtml) && /<h2>Constellations <small>1 of 26</.test(bookHtml),
      (bookHtml.match(/<h2>[^<]*<small>[^<]*/g) || []).join(' | '));
check('... the Moon with the watch\'s picture, the planets not seen yet in their places',
      /class="tile" data-n="The Moon"[^>]*><span class="pic"><img src="data:image\/png;base64,/.test(bookHtml) &&
      /class="tile no" data-n="Saturn" data-i="Not seen yet."/.test(bookHtml));
check('... a found constellation drawn as its figure', /data-n="Summer Triangle" data-i="First seen [^"]*near Phoenix\. Found with Find it\."[^>]*><span class="pic"><svg class="fig"/.test(bookHtml),
      (bookHtml.match(/data-n="Summer Triangle"[^>]*/) || [''])[0]);
check('... where it was seen, looked up on the phone', /<span class="chip">near Phoenix \u00b7 \d+<\/span>/.test(bookHtml));
check('... and a star in its colour', /data-n="Vega"[^>]*><span class="pic"><span style="color:#cad7ff">/.test(bookHtml));
check('... and the logbook to copy, with places in words', /<textarea id="book" readonly>time,kind,name,type,how,place,lat,lon\n[^<]*near Phoenix/.test(bookHtml));
handlers.webviewclosed({ response: JSON.stringify({ logbook: { where: false, clear: false } }) });
book = JSON.parse(store.sf_logbook_v1);
check('turning "roughly where" off forgets where', book.length >= 3 && book.every(function (e) {
  return !('la' in e) && !('lo' in e);
}));
handlers.webviewclosed({ response: JSON.stringify({ logbook: { where: true, clear: true } }) });
check('clearing the logbook empties it', !store.sf_logbook_v1);
sent = [];
handlers.appmessage({ payload: { AIM_START: 3, EPH_REQ: 1 } });
check('the watch can ask for its table with an aim', sent.some(function (m) { return 'SKY_EPH' in m; }));
check('status has a FIND IT line', sent.length >= 0 && /\+ \d+ more|is up|Nothing up to find now|too near (the )?Sun/.test(
  status.STATUS.split('\x1f')[5] || ''), status.STATUS.split('\x1f')[5]);

// Separators in text can't break the wire format.
var wire = index.cardsToWire([{ type: 5, word: 1, l1: 'a\x1fb', l2: 'c\x1ed', l3: 'x', hint: '' }]);
check('separators stripped from text', wire.split('\x1e').length === 1 && wire.split('\x1f').length === 6);

// Tune my aim, end to end, with the three field aims at the daytime Moon:
// the status names the target, a calibrating compass is turned away, and
// three good aims store a left-wrist offset.
var tune0 = require('../src/pkjs/tune.js');
var tuneT = Date.UTC(2026, 9, 7, 18, 45, 45, 769);
var moonRaw = [[22789, -860, -157, -511], [22611, -801, -106, -608], [22922, -857, -107, -525]];
function tuneAim(seq, k, n, cal) {
  var r = moonRaw[k];
  var t = tuneT + k * 20000;
  sent = [];
  atTime(t, function () {
    handlers.appmessage({ payload: { A_SEQ: seq, A_T: Math.floor(t / 1000), A_MS: t % 1000, A_HEAD: r[0],
                                     A_JIT: 300, A_AX: r[1], A_AY: r[2], A_AZ: r[3], A_CAL: cal, A_NC: 8,
                                     A_LAYER: 0, A_WRIST: 0, A_TUNE: n } });
  });
  var m = sent.filter(function (x) { return x.R_SEQ === seq; })[0];
  return m ? { n: m.TUNE_N, card: m.R_DATA.split('\x1e')[0].split('\x1f') } : null;
}
var st = null;
atTime(tuneT, function () { sent = []; handlers.ready(); st = sent.filter(function (m) { return 'TUNE_TGT' in m; }).pop(); });
check('status offers the Moon to tune on', st && st.TUNE_TGT === 'the Moon\x1fhigh in the SW', st && st.TUNE_TGT);
var tr = tuneAim(40, 0, 1, 1);
check('tune: calibrating compass turned away, count stays 0', tr && tr.n === 0 && /draw an 8/.test(tr.card[2]) &&
      tr.card[1] === '0' &&
      tr.card[3] === 'the Moon', tr && tr.card.join('/'));
tr = tuneAim(41, 0, 1, 2);
check('tune aim 1 taken, and marked kept', tr && tr.n === 1 && /2 more/.test(tr.card[2]) && tr.card[1] === '1',
      tr && tr.card.join('/'));
tr = tuneAim(42, 1, 2, 2);
check('tune aim 2 taken', tr && tr.n === 2 && /1 more/.test(tr.card[2]), tr && tr.card.join('/'));
tr = tuneAim(43, 2, 3, 2);
// The default offset was fitted to these very aims, so the new fit can't
// beat it: nothing is stored.
function pool0() {
  return (store.sf_aim_v2 && JSON.parse(store.sf_aim_v2)['0']) || [];
}
// The default offset was fitted to these very aims, so the Moon's can't
// beat it: its aims only join the learning pool, which three of them
// don't switch on.
check('tune aim 3: done; already as good as the default, so the default stays', tr && tr.n === 3 &&
      tr.card[2] === 'All done!' && /already/.test(tr.card[3]) &&
      pool0().filter(function (m) { return m.src === 'moon+'; }).length === 3 && pool0().length < 5 &&
      tune0.poolOffset(pool0()) === null, tr && tr.card.join('/') + ', pool ' + pool0().length);
// A stale learned offset (the watch worn another way, say) is replaced:
// the pool starts again from the Moon, and the aims after it use it.
store.sf_aim_v2 = JSON.stringify({ '0': [1, 2, 3, 4, 5].map(function (i) {
  return { yaw: 25, pitch: 8, az: 100, t: i, src: 'auto' };
}) });
tuneAim(45, 0, 1, 2);
tuneAim(46, 1, 2, 2);
tr = tuneAim(47, 2, 3, 2);
var fing = tune0.poolOffset(pool0());
check('a stale learned offset is replaced by the Moon tune', tr && tr.card[2] === 'Aim tuned!' &&
      /You were 2[01] degrees off/.test(tr.card[3]) && pool0().length === 3 && pool0()[0].src === 'moon' &&
      fing && Math.abs(fing.yaw - 8) < 1.5, tr && tr.card.join('/') + ' ' + JSON.stringify(fing));
var r0 = moonRaw[0];
sent = [];
atTime(tuneT, function () {
  handlers.appmessage({ payload: { A_SEQ: 48, A_T: Math.floor(tuneT / 1000), A_MS: tuneT % 1000, A_HEAD: r0[0],
                                   A_JIT: 300, A_AX: r0[1], A_AY: r0[2], A_AZ: r0[3], A_CAL: 2, A_NC: 8,
                                   A_LAYER: 3, A_WRIST: 0 } });
});
var tunedReply = sent.filter(function (m) { return m.R_SEQ === 48; })[0];
check('the next aim, with the learned offset, finds the Moon', tunedReply &&
      tunedReply.R_DATA.split('\x1f')[2] === 'The Moon', tunedReply && tunedReply.R_DATA.split('\x1f').join('/'));
check('a sure answer about the Moon teaches: one more sample', pool0().length === 4 &&
      pool0()[3].src === 'auto', 'pool ' + pool0().length);
// Satellites and planes never teach; neither does a far-off answer.
function card(type, p) { return { type: type, p: p, az: 1, alt: 1, visible: true }; }
check('only the visible Moon, planets and stars teach', !tune0.learnable([card(2, 0.9)], { cal: 2 }, {}) &&
      !tune0.learnable([card(1, 0.9)], { cal: 2 }, {}) &&
      tune0.learnable([card(5, 0.9)], { cal: 2 }, {}) &&
      !tune0.learnable([card(5, 0.7), card(5, 0.25)], { cal: 2 }, {}) &&
      !tune0.learnable([card(5, 0.9)], { cal: 1 }, {}) &&
      !tune0.learnable([{ type: 5, p: 0.9, az: 1, alt: 1, visible: false }], { cal: 2 }, {}));
var newMoonT = Date.UTC(2026, 9, 10, 19, 0, 0);
sent = [];
atTime(newMoonT, function () {
  handlers.appmessage({ payload: { A_SEQ: 44, A_T: Math.floor(newMoonT / 1000), A_MS: 0, A_HEAD: 100, A_JIT: 50,
                                   A_AX: 0, A_AY: -500, A_AZ: -800, A_CAL: 2, A_NC: 8, A_LAYER: 0, A_WRIST: 0,
                                   A_TUNE: 1 } });
});
var none = sent.filter(function (m) { return m.R_SEQ === 44; })[0];
check('tune with no Moon: told so, and stopped', none && none.TUNE_N === 255 &&
      /Nothing to tune on/.test(none.R_DATA), none && none.R_DATA);
handlers.showConfiguration();
var aimHtml = decodeURIComponent(opened.replace('data:text/html;charset=utf-8,', ''));
check('settings page shows what was learned', /Left wrist: learned from the last 4 answers \(3 from the Moon\)/.test(aimHtml) &&
      /Right wrist: still learning, 0 answers so far/.test(aimHtml),
      (aimHtml.match(/<li>(Left|Right) wrist[^<]*/g) || []).join(' | '));
handlers.webviewclosed({ response: JSON.stringify({ sky: 'suburbs', forgetAim: true }) });
check('forget what it has learned', !store.sf_aim_v2);

// The wrong wrist: the same Moon aims with the wrist set to right point
// into the ground. The second in a row asks.
var asks = [];
for (var ww = 0; ww < 3; ww++) {
  var rw0 = moonRaw[ww];
  sent = [];
  atTime(tuneT, function () {
    handlers.appmessage({ payload: { A_SEQ: 70 + ww, A_T: Math.floor(tuneT / 1000), A_MS: tuneT % 1000,
                                     A_HEAD: rw0[0], A_JIT: 300, A_AX: rw0[1], A_AY: rw0[2], A_AZ: rw0[3], A_CAL: 2,
                                     A_NC: 8, A_LAYER: 0, A_WRIST: 1 } });
  });
  asks.push(sent.filter(function (m) { return m.R_SEQ === 70 + ww; })[0].WRIST_Q || 0);
}
check('wrong wrist: asked on the second aim into the ground, then counting starts again', asks.join(',') === '0,1,0',
      asks.join(','));

// Settings page: sky choice, credits. (With an empty logbook,
// so Save is tried without the logbook's "Clear" switch on the page.)
var bookWas = store.sf_logbook_v1;
delete store.sf_logbook_v1;
handlers.showConfiguration();
if (bookWas !== undefined) store.sf_logbook_v1 = bookWas;
var html = decodeURIComponent(opened.replace('data:text/html;charset=utf-8,', ''));
check('settings page has the credits, and no developer tools', !/aim log|seq,t,lat,lon|Developer/i.test(html) &&
      html.indexOf('Bright Star Catalogue') > 0 && html.indexOf('Natural Earth') > 0 &&
      html.indexOf('<option value="suburbs" selected>') > 0 && html.indexOf('<option value="binoculars" selected>') > 0);
check('... sky and gear as dropdowns', /<select id="sky">/.test(html) && /<select id="gear">/.test(html) &&
      !/type="radio"/.test(html));
check('... an empty logbook asks you to start it, and shows the places to fill',
      /Start your collection/.test(html) && /class="tile no" data-n="Mercury"/.test(html) && !/data-k="lc"/.test(html));
check('... settings that undo things are buttons, not switches', /data-k="rs"/.test(html) && /data-k="fa"/.test(html) &&
      !/id="rs"/.test(html) && !/id="fa"/.test(html));
check('settings page says when it gets dark and about the Moon', /(Tonight: dark by|Dark now)[^<]*Moon/.test(html),
      (html.match(/<div class="tonight">[^<]*/) || [''])[0]);
check('settings page in night colours, not red, with the watch theme unknown', html.indexOf('<body>') > 0);
check('settings page: Keep light on, finding and reading 30 s by default',
      html.indexOf('<select id="light"><option value="read30" selected>') > 0);
// The page's Save script runs in a browser: check it parses, and what it sends.
var script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
var savedUrl = null;
var fakeDoc = { getElementById: function (id) {
  // Only what's on the page.
  if (html.indexOf('id="' + id + '"') < 0) return null;
  var vals = { sky: 'city', gear: 'eye', rx: ' ', src: 'auto' };
  return { checked: id === 'pl' || id === 'lw', value: id in vals ? vals[id] : '0' };
} };
new Function('document', 'location', script + ';save()')(fakeDoc, { set href(u) { savedUrl = u; } });
var savedCfg = JSON.parse(decodeURIComponent(savedUrl.replace('pebblejs://close#', '')));
check('Save sends the sky, the gear and the rest', savedCfg.sky === 'city' && savedCfg.findShow === 'eye' &&
      savedCfg.planes.on === true && savedCfg.reset === false, JSON.stringify(savedCfg));
check('... and the logbook: where on, not cleared; nothing undone', savedCfg.logbook.where === true &&
      savedCfg.logbook.clear === false && savedCfg.forgetAim === false && savedCfg.reset === false,
      JSON.stringify(savedCfg.logbook));
// The undo buttons: one tap asks, the second saves with that set.
savedUrl = null;
var timers = [];
var armBtn = { className: 'danger', textContent: 'Put every setting back',
               getAttribute: function (n) { return n === 'data-k' ? 'rs' : 'Put every setting back'; } };
var asked = new Function('document', 'location', 'setTimeout', 'b',
                         script + ';arm(b);var asked=b.textContent;arm(b);return asked')(
  fakeDoc, { set href(u) { savedUrl = u; } }, function (f) { timers.push(f); }, armBtn);
check('... undo asks first, then saves with it set', asked === 'Tap again to confirm' && savedUrl &&
      JSON.parse(decodeURIComponent(savedUrl.replace('pebblejs://close#', ''))).reset === true, asked);
sent = [];
handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ sky: 'dark' })) });
check('sky setting saved', JSON.parse(store.sf_sky_v1) === 'dark');
check('status resent after a settings change', sent.some(function (m) { return 'STATUS' in m; }));
var st2 = sent.filter(function (m) { return 'PREFS' in m; }).pop();
check('the status carries the sky and gear to the watch', st2 && (st2.PREFS & 0x3f) === 2,
      st2 && st2.PREFS.toString(16));
check('a sky chosen on the page is noted for here', JSON.parse(store.sf_skyplace_v1).lat === 33.49);
check('... with Keep light on at its default (0) in bits 6-7', st2 && (st2.PREFS & 0xc0) === 0);
sent = [];
handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ light: 'finding' })) });
st2 = sent.filter(function (m) { return 'PREFS' in m; }).pop();
check('Keep light on chosen on the page goes to the watch', JSON.parse(store.sf_light_v1) === 'finding' &&
      st2 && (st2.PREFS & 0xff) === (2 | 2 << 6), st2 && st2.PREFS.toString(16));
handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ light: 'always' })) });
check('... an unknown light choice is ignored', JSON.parse(store.sf_light_v1) === 'finding');
handlers.webviewclosed({ response: '' });   // closed without saving
check('closing without saving keeps the setting', JSON.parse(store.sf_sky_v1) === 'dark');

// The watch: sky and gear chosen there (bit 16), and its theme.
sent = [];
handlers.appmessage({ payload: { PREFS: 0 | 1 << 4 | 3 << 8 | 1 << 16 | 5 << 17 } });   // city, by eye, Stargazer
check('sky and gear chosen on the watch are kept', JSON.parse(store.sf_sky_v1) === 'city' &&
      JSON.parse(store.sf_findshow_v1) === 'eye' && JSON.parse(store.sf_wtheme_v1) === 3);
var echo = sent.filter(function (m) { return 'PREFS' in m; }).pop();
check('... and echoed back with the theme heard and the change number', echo && echo.PREFS === (0 | 1 << 4 | 4 << 8 | 5 << 17),
      echo && echo.PREFS.toString(16));
handlers.showConfiguration();
var redHtml = decodeURIComponent(opened.replace('data:text/html;charset=utf-8,', ''));
check('settings page red while the watch is in Stargazer', redHtml.indexOf('<body class="red">') > 0);
check('... and shows the light the watch chose (the default: the watch sent 0)',
      JSON.parse(store.sf_light_v1) === 'read30' && redHtml.indexOf('<option value="read30" selected>') > 0);
sent = [];
handlers.appmessage({ payload: { PREFS: 0 | 1 << 4 | 3 << 6 | 3 << 8 | 1 << 16 | 6 << 17 } });   // + Watch's timing
echo = sent.filter(function (m) { return 'PREFS' in m; }).pop();
check('Keep light on chosen on the watch is kept and echoed', JSON.parse(store.sf_light_v1) === 'watch' &&
      echo && echo.PREFS === (0 | 1 << 4 | 3 << 6 | 4 << 8 | 6 << 17), echo && echo.PREFS.toString(16));
sent = [];
handlers.appmessage({ payload: { PREFS: 2 | 0 << 4 | 1 << 8 } });   // just the theme (Day): sky not taken
check('a theme-only message leaves the sky alone', JSON.parse(store.sf_sky_v1) === 'city' &&
      JSON.parse(store.sf_wtheme_v1) === 1);
check('... and the light', JSON.parse(store.sf_light_v1) === 'watch');

// Somewhere new: far from where the sky was chosen, after dark.
store.sf_skyplace_v1 = JSON.stringify({ lat: 36.1, lon: -112.1 });   // the Grand Canyon, 290 km away
var night = Date.UTC(2026, 9, 9, 5, 0, 0), day = Date.UTC(2026, 9, 9, 19, 0, 0);
sent = [];
atTime(night, function () {
  handlers.appmessage({ payload: { AIM_START: 0 } });   // a fresh fix (the stored one is old by then)
  ticker();
});
var np = sent.filter(function (m) { return 'NEW_PLACE' in m; }).pop();
check('somewhere new after dark: the watch asks', np && np.NEW_PLACE === 1);
check('... but not on a stale fix', (function () {
  var r = null;
  atTime(night + 3 * 3600000, function () { sent = []; ticker(); r = sent.filter(function (m) { return 'NEW_PLACE' in m; }).pop(); });
  return !r || r.NEW_PLACE === 0;
})());
sent = [];
atTime(day, function () { ticker(); });
np = sent.filter(function (m) { return 'NEW_PLACE' in m; }).pop();
check('... not by day', np && np.NEW_PLACE === 0);
sent = [];
atTime(night + 60000, function () { handlers.appmessage({ payload: { PREFS: 2 | 0 << 4 | 4 << 8 | 1 << 16 | 6 << 17 } }); });
np = sent.filter(function (m) { return 'NEW_PLACE' in m; }).pop();
check('answered: here is the place now, and no more asking', np && np.NEW_PLACE === 0 &&
      JSON.parse(store.sf_skyplace_v1).lat === 33.49 && JSON.parse(store.sf_sky_v1) === 'dark');
store.sf_sky_v1 = JSON.stringify('dark');

// End to end: point at the ISS (from the fixture, high in the sky) in the
// SATELLITES layer with "show satellites I can't see" on. Raw sensor
// readings are built so the default finger offset lands on it.
var A = require('../src/pkjs/astro.js');
var rawAt = require('./helpers.js').rawAt;
var wmm = require('../src/pkjs/wmm.js');
var row = satFx.rows.filter(function (q) { return q.alt > 40; })[0];
var when = new Date(row.utc);
var decl = wmm.field(33.49, -111.99, 0.379, when).declination;
// The fixture is for a spot about 9 km away (a degree of parallax at the ISS),
// so place it again for the stub's location.
var S = require('../src/pkjs/satellites.js');
var issNow = S.positions(S.catalog({ load: function (k, fb) {
  return k === 'sf_sat_stations_v1' ? { t: 1, sats: [satFx.omm] } : fb;
} }, { stations: true }), when, { lat: 33.49, lon: -111.99, altKm: 0.379 }, 'imperial')[0];
var tgt = { az: issNow.az, alt: issNow.alt };
var rw = rawAt(tgt.az, tgt.alt, decl);   // the default finger lands on it
handlers.webviewclosed({ response: JSON.stringify({ sats: { stations: true, visual: true, trains: true, hidden: true } }) });
check('satellite settings saved', JSON.parse(store.sf_sats_v1).hidden === true);
sent = [];
var issPayload = {
  A_SEQ: 11, A_T: Math.floor(when.getTime() / 1000), A_MS: when.getTime() % 1000,
  A_HEAD: Math.round(rw.head * 100), A_JIT: 50, A_AX: rw.ax, A_AY: rw.ay, A_AZ: rw.az,
  A_CAL: 2, A_NC: 8, A_LAYER: 2, A_WRIST: 0
};
atTime(when.getTime(), function () { handlers.appmessage({ payload: issPayload }); });
var satReply = sent.filter(function (m) { return m.R_SEQ === 11; })[0];
var satCards = satReply.R_DATA.split('\x1e').map(function (c) { return c.split('\x1f'); });
check('aim at the ISS (SATELLITES, hidden on) names it, with its speed and way across the sky',
      satCards[0][0] === '2' && satCards[0][2] === 'Space Station' &&
      /^17,\d00 mph, moving (up|down|left|right|up-left|up-right|down-left|down-right)$/.test(satCards[0][5]),
      satCards.map(function (c) { return c.slice(2).join('/'); }).join(' | '));

// The same aim with the watch clock a minute fast: the phone's time is used.
sent = [];
atTime(when.getTime() - 60000, function () { handlers.appmessage({ payload: issPayload }); });
var lagReply = sent.filter(function (m) { return m.R_SEQ === 11; })[0];
check('watch clock a minute off: phone time used (the ISS is not there yet)', lagReply &&
      lagReply.R_DATA.split('\x1f')[2] !== 'Space Station', lagReply && lagReply.R_DATA.split('\x1f').slice(1, 4).join('/'));

// Corrupt stored satellite data can't break the status or an aim.
store['sf_sat_stations_v1'] = JSON.stringify({ t: Date.now(), sats: [null, 5, { OBJECT_NAME: 'X' }] });
sent = [];
ticker();
handlers.appmessage({ payload: { A_SEQ: 12, A_T: Math.floor(Date.now() / 1000), A_MS: 0, A_HEAD: 100,
                                 A_JIT: 50, A_AX: 0, A_AY: -500, A_AZ: -800, A_CAL: 2, A_NC: 8,
                                 A_LAYER: 0, A_WRIST: 0 } });
check('corrupt satellite data: aims still answered', sent.some(function (m) { return m.R_SEQ === 12; }));

// Planes, end to end: SELECT tapped in PLANES (prefetch), then the aim at
// the airliner.
var planesMod = require('../src/pkjs/planes.js');
var tPlane = Date.UTC(2026, 9, 8, 3, 0, 0);
feedNow = tPlane;
var planeAt = planesMod.lookAngles({ lat: 33.49, lon: -111.99, h: 379 },
                                   { lat: PLANE.lat, lon: PLANE.lon, h: PLANE.alt_geom * 0.3048 });
var declP = wmm.field(33.49, -111.99, 0.379, new Date(tPlane)).declination;
var rwP = rawAt(planeAt.az, planeAt.el + A.refraction(planeAt.el), declP);
xhrUrls = [];
sent = [];
atTime(tPlane, function () {
  handlers.appmessage({ payload: { AIM_START: 1 } });
  handlers.appmessage({ payload: {
    A_SEQ: 20, A_T: Math.floor(tPlane / 1000), A_MS: 0, A_HEAD: Math.round(rwP.head * 100), A_JIT: 50,
    A_AX: rwP.ax, A_AY: rwP.ay, A_AZ: rwP.az, A_CAL: 2, A_NC: 8, A_LAYER: 1, A_WRIST: 0
  } });
});
var planeReply = sent.filter(function (m) { return m.R_SEQ === 20; })[0];
var planeCards = planeReply ? planeReply.R_DATA.split('\x1e').map(function (c) { return c.split('\x1f'); }) : [];
check('aim at a plane (PLANES): named, typed, sure', planeCards.length && planeCards[0][0] === '1' &&
      planeCards[0][2] === 'American 1234' && planeCards[0][3] === 'Airbus A321' && planeCards[0][1] === '1',
      planeCards.map(function (c) { return c.slice(1).join('/'); }).join(' | '));
check('one feed request for the tap and the aim together',
      xhrUrls.filter(function (u) { return /adsb\.lol/.test(u); }).length === 1, xhrUrls.join(' '));
check('the request carries a rounded location', xhrUrls[0] === 'https://api.adsb.lol/v2/point/33.49/-111.99/26',
      xhrUrls[0]);
var planesLine = sent.filter(function (m) { return 'STATUS' in m; }).map(function (m) { return m.STATUS.split('\x1f')[1]; });
check('PLANES status counts the planes', planesLine.indexOf('1 plane nearby') >= 0, planesLine.join(' / '));

// Planes off: no request, no rung.
sent = [];
handlers.webviewclosed({ response: JSON.stringify({ planes: { on: false, minFt: 500, maxKm: 48, source: 'auto', rx: '' } }) });
var off = sent.filter(function (m) { return 'LAYERS' in m; }).pop();
check('planes off: PLANES rung gone', off && (off.LAYERS & 2) === 0 && off.STATUS.split('\x1f')[1] === '',
      off && off.LAYERS);
xhrUrls = [];
handlers.appmessage({ payload: { AIM_START: 0 } });
check('planes off: nothing fetched', xhrUrls.length === 0);
handlers.webviewclosed({ response: JSON.stringify({ planes: { on: true, minFt: 1000, maxKm: 80, source: 'rx',
                                                              rx: 'javascript:alert(1)' } }) });
var ps = JSON.parse(store.sf_planes_v1);
check('bad receiver address refused (source falls back to automatic)', ps.rx === '' && ps.source === 'auto' &&
      ps.minFt === 1000 && ps.maxKm === 80);

// Card text is cut by UTF-8 bytes, at a character boundary.
check('cut by bytes, not letters', index.fitBytes('Eisenhüttenstadt to Großenhain!', 30) === 'Eisenhüttenstadt to Großenha' &&
      index.fitBytes('abc', 30) === 'abc', index.fitBytes('Eisenhüttenstadt to Großenhain!', 30));

// A malformed aim still gets a card back (never a silent "No answer").
sent = [];
handlers.appmessage({ payload: { A_SEQ: 9, A_T: 'x', A_HEAD: null } });
var err = sent.filter(function (m) { return m.R_SEQ === 9; })[0];
check('malformed aim still answered', !!err, err && err.R_DATA.split('\x1f').slice(2, 4).join(' '));

// Reset puts every setting back, and keeps downloaded data.
handlers.webviewclosed({ response: JSON.stringify({ sky: 'city' }) });
handlers.webviewclosed({ response: JSON.stringify({ reset: true, sky: 'dark' }) });
check('reset: settings gone, satellites kept', !store.sf_sky_v1 && !store.sf_planes_v1 &&
      !!store['sf_sat_stations_v1'], Object.keys(store).join(' '));

// The minute ticker only sends when something changed.
sent = [];
ticker();
ticker();
check('ticker quiet when nothing changed', sent.length === 0, sent.length + ' sent');

global.setInterval = realSetInterval;

// A miss too big for an answer: the bright thing nearest the aim comes
// back as CLOSEST, with a chart of the aim and it, and hold SELECT tunes
// on it (TUNE_TGT names it, as the card does). Default offset for this.
var savedPool = store.sf_aim_v2;
delete store.sf_aim_v2;
var satT = Date.UTC(2026, 9, 15, 4, 0, 0);   // Saturn about 42 degrees up in the SE
var planetsMod = require('../src/pkjs/planets.js');
var sat = planetsMod.bodies(new Date(satT), 33.49, -111.99).filter(function (b) { return b.id === 'saturn'; })[0];
var wmmMod = require('../src/pkjs/wmm.js');
var declS = wmmMod.field(33.49, -111.99, 0.379, new Date(satT)).declination;
var rS = require('./helpers.js').rawAt(sat.az - 14 / A.cosd(sat.alt), sat.alt, declS);
sent = [];
atTime(satT, function () {
  handlers.appmessage({ payload: { A_SEQ: 60, A_T: Math.floor(satT / 1000), A_MS: 0, A_HEAD: Math.round(rS.head * 100),
                                   A_JIT: 50, A_AX: rS.ax, A_AY: rS.ay, A_AZ: rS.az, A_CAL: 2, A_NC: 8, A_LAYER: 3,
                                   A_WRIST: 0 } });
});
var rc = sent.filter(function (m) { return m.R_SEQ === 60; })[0];
var rcCards = rc ? rc.R_DATA.split('\x1e').map(function (c) { return c.split('\x1f'); }) : [];
check('14 degrees off Saturn: CLOSEST Saturn, offered for tuning', rcCards[0] && rcCards[0][1] === '4' &&
      rcCards[0][2] === 'Saturn' && /Hold SELECT/.test(rcCards[0][4]) && /^Saturn\x1f/.test(rc.TUNE_TGT || ''),
      rc && rc.R_DATA.split('\x1f').join('/'));
check('... then its chart: where you pointed, Saturn circled', rcCards[1] && rcCards[1][0] === '8' &&
      rcCards[1][2] === 'Where you pointed' && rc.R_CHART && rc.R_CHART.length > 10, rcCards[1] && rcCards[1].join('/'));
check('... not noted in the logbook', !/saturn/i.test(store.sf_logbook_v1 || ''));
sent = [];
atTime(satT + 5000, function () {
  handlers.appmessage({ payload: { A_SEQ: 61, A_T: Math.floor(satT / 1000) + 5, A_MS: 0, A_HEAD: Math.round(rS.head * 100),
                                   A_JIT: 50, A_AX: rS.ax, A_AY: rS.ay, A_AZ: rS.az, A_CAL: 2, A_NC: 8, A_LAYER: 0,
                                   A_WRIST: 0, A_TUNE: 1 } });
});
var rt = sent.filter(function (m) { return m.R_SEQ === 61; })[0];
check('hold SELECT there: the tune is on Saturn, and the aim is kept', rt && rt.TUNE_N === 1 &&
      rt.R_DATA.split('\x1f')[3] === 'Saturn', rt && rt.TUNE_N + ' ' + rt.R_DATA.split('\x1f').join('/'));
handlers.showConfiguration();
var diagHtml = decodeURIComponent(opened.replace('data:text/html;charset=utf-8,', ''));
check('About: diagnostics with the CLOSEST aim, location rounded', /Copy diagnostics/.test(diagHtml) &&
      /CLOSEST Saturn/.test(diagHtml) && /about 33, -112 \(rounded\)/.test(diagHtml) && !/33\.49/.test(diagHtml));
if (savedPool === undefined) delete store.sf_aim_v2;
else store.sf_aim_v2 = savedPool;
var pkgVersion = require('../package.json').version;
check('APP_VERSION matches package.json', new RegExp("var APP_VERSION = '" + pkgVersion.replace('.', '\\.') + "';")
      .test(require('fs').readFileSync(__dirname + '/../src/pkjs/index.js', 'utf8')), pkgVersion);

// The slow path, with real timers: plane data never arrives. The answer
// still comes, exactly once, by the deadline; in ANYTHING the stars and
// planets aren't held up long (2.5 s, or 6 s where the feeds have been
// slow); PLANES waits up to 9 s, then says why there are none.
handlers.webviewclosed({ response: JSON.stringify({ planes: { on: true, minFt: 500, maxKm: 48, source: 'auto', rx: '' } }) });
var realXhr = global.XMLHttpRequest;
global.XMLHttpRequest = function () {
  var x = this;
  x.open = function (method, url) { x.url = url; };
  x.send = function () { xhrUrls.push(x.url); };   // never answers
};
store.sf_location_v1 = JSON.stringify({ lat: 40.1, lon: -105.2, altKm: 1.6, t: Date.now() });
sent = [];
var t0 = Date.now();
handlers.appmessage({ payload: { A_SEQ: 30, A_T: Math.floor(t0 / 1000), A_MS: t0 % 1000, A_HEAD: 10000, A_JIT: 50,
                                 A_AX: -300, A_AY: 0, A_AZ: -950, A_CAL: 2, A_NC: 8, A_LAYER: 1, A_WRIST: 0 } });
handlers.appmessage({ payload: { A_SEQ: 31, A_T: Math.floor(t0 / 1000), A_MS: t0 % 1000, A_HEAD: 10000, A_JIT: 50,
                                 A_AX: -300, A_AY: 0, A_AZ: -950, A_CAL: 2, A_NC: 8, A_LAYER: 0, A_WRIST: 0 } });
setTimeout(function () {
  var r30 = sent.filter(function (m) { return m.R_SEQ === 30; });
  var r31 = sent.filter(function (m) { return m.R_SEQ === 31; });
  check('ANYTHING answered by 6 s while planes are slow', r31.length === 1);
  check('PLANES not yet (waits up to 9 s)', r30.length === 0);
  setTimeout(function () {
    r30 = sent.filter(function (m) { return m.R_SEQ === 30; });
    check('PLANES answered once, saying the data is slow', r30.length === 1 &&
          r30[0].R_DATA.split('\x1f')[4] === 'Plane data too slow', r30[0] && r30[0].R_DATA.split('\x1f').join('/'));
    check('ANYTHING still answered only once', sent.filter(function (m) { return m.R_SEQ === 31; }).length === 1);
    global.XMLHttpRequest = realXhr;
    if (failures) {
      console.log(failures + ' FAILED');
      process.exit(1);
    }
    console.log('PASS');
    process.exit(0);
  }, 3000);
}, 6300);
