// Find it: what's offered when, and the bytes the watch reads.
// Run: node test/find.test.js
process.env.TZ = 'America/Phoenix';   // clock times ("Stars out at 6:22 pm") are the phone's: Phoenix here
var A = require('../src/pkjs/astro.js');
var planets = require('../src/pkjs/planets.js');
var moon = require('../src/pkjs/moon.js');
var matcher = require('../src/pkjs/matcher.js');
var S = require('../src/pkjs/satellites.js');
var find = require('../src/pkjs/find.js');
var patterns = require('../src/pkjs/patterns.js');
var stars = require('../src/pkjs/stars.js');
var fx = require('./sat_fixture.json');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

var HERE = { lat: fx.lat, lon: fx.lon, altKm: fx.elevM / 1000 };
function skyAt(date, setting) {
  return { bodies: planets.bodies(date, HERE.lat, HERE.lon), moon: moon.moonAltAz(date, HERE.lat, HERE.lon),
           sky: setting || 'suburbs' };
}

// A clear night in Phoenix (9 pm, 2026-10-08).
var night = new Date('2026-10-09T04:00:00Z');
var res = find.targets(night, HERE, skyAt(night), null, 'imperial');
var names = res.list.map(function (t) { return t.name; });
check('a night list: more than Best now holds, within the most', res.list.length > find.BEST_N + 1 &&
      res.list.length <= find.MAX_TARGETS, names.join(', '));
// Easiest first; among the ones as easy, planets before stars.
var rankOf = find.rank;
var KIND_ORDER = ['moon', 'planet', 'sat', 'pattern', 'star'];
check('easiest first; as easy: the Moon, planets, satellites, patterns, stars', res.list.every(function (t, i) {
  var u = res.list[i + 1];
  return !u || rankOf(t) < rankOf(u) || (rankOf(t) === rankOf(u) &&
    KIND_ORDER.indexOf(find.kindOf(t)) <= KIND_ORDER.indexOf(find.kindOf(u)));
}), res.list.map(function (t) { return t.name + ':' + t.see; }).join(', '));
check('every target is up and clear', res.list.every(function (t) { return t.alt >= (t.id === 'moon' ? 2 : 8); }));
check('stars are named and bright', res.list.filter(function (t) { return t.type === matcher.TYPE.STAR; })
  .every(function (t) { return /^[A-Z]/.test(t.name); }));
// (A pattern from its anchor star: "Vega, high in the W", or "Start at
// Kaus Australis" when that's too long.)
check('each says where', res.list.every(function (t) {
  return /^([A-Z][\w' ]*, )?(low|halfway up|high) in the [NSEW]{1,2}$|^Start at [A-Z]/.test(t.where);
}),
      res.list.map(function (t) { return t.where; }).join('; '));

// The RA/Dec sent turns back into where it is.
var jd = A.julianDay(night);
var worst = 0;
res.list.forEach(function (t) {
  var h = A.eqToHorizon(t.ra, t.dec, jd, HERE.lat, HERE.lon);
  worst = Math.max(worst, A.separation(h.az, h.alt + A.refraction(h.alt), t.az, t.alt));
});
check('positions round-trip through RA/Dec', worst < 0.05, worst.toFixed(3));

// The wire format.
var bytes = find.encodeList(res, night.getTime());
var d = find.decodeList(bytes);
check('list decodes whole', d.length === bytes.length && d.version === 4 && d.time === Math.floor(night.getTime() / 1000));
check('bytes are bytes', bytes.every(function (b) { return b >= 0 && b <= 255 && b === Math.floor(b); }));
check('names and places survive', d.list.every(function (t, i) {
  return t.name === res.list[i].name && t.where === res.list[i].where && t.id === i && t.see === res.list[i].see &&
         t.best === !!res.list[i].best && t.give === res.list[i].give &&
         Math.abs(A.wrap180(t.ra - res.list[i].ra)) < 0.01 && Math.abs(t.dec - res.list[i].dec) < 0.01;
}));
check('fits the watch inbox, with the frame', bytes.length <= find.LIST_BYTES, bytes.length + ' bytes');

// City skies offer fewer stars.
var city = find.targets(night, HERE, skyAt(night, 'city'), null, 'imperial').list;
check('a list in the city too', city.length > 0 && city.length <= res.list.length);

// By day (2026-10-08, the Moon and Venus about 24 degrees from the Sun,
// Mercury 25, Jupiter 54): the Sun's rules and how each can be seen.
var noon = new Date('2026-10-08T19:30:00Z');
var day = find.targets(noon, HERE, skyAt(noon), null, 'imperial');
var sunNow = skyAt(noon).bodies[0];
function sunSep(t) { return A.separation(t.az, t.alt, sunNow.az, sunNow.alt); }
function byName(list, n) { return list.filter(function (t) { return t.name === n; })[0]; }
var dayNames = day.list.map(function (t) { return t.name + ':' + t.see + '@' + sunSep(t).toFixed(0); }).join(', ');
check('by day: the Sun\'s rules hold for every target', day.list.every(function (t) {
  var how = t.see & 3, d = sunSep(t);
  var near = d < find.SUN_EYE || (d < find.SUN_AIDED && how >= matcher.SEE.BINOCULARS);
  return !!(t.see & find.SEE_NEAR_SUN) === near &&
         !!(t.see & find.SEE_BLOCK_SUN) === (!near && d < find.SUN_AIDED);
}), dayNames);
var dVenus = byName(day.list, 'Venus'), dMoon = byName(day.list, 'The Moon'), dJup = byName(day.list, 'Jupiter');
check('by day: Venus by eye, block the Sun first', dVenus && dVenus.see === (matcher.SEE.EASY | find.SEE_BLOCK_SUN),
      dayNames);
check('by day: the thin Moon, look closely, block the Sun', dMoon &&
      dMoon.see === (matcher.SEE.CLOSE | find.SEE_BLOCK_SUN), dayNames);
check('by day: Jupiter, look closely', dJup && dJup.see === matcher.SEE.CLOSE, dayNames);
check('by day: binoculars near the Sun are listed but not findable', day.list.some(function (t) {
  return !find.findable(t) && (t.see & 3) >= matcher.SEE.BINOCULARS && sunSep(t) >= find.SUN_EYE;
}), dayNames);
check('by day: the unfindable come last', day.list.every(function (t, i) {
  return i === 0 || find.findable(t) <= find.findable(day.list[i - 1]);
}), dayNames);
var eyeOnly = find.targets(noon, HERE, skyAt(noon), null, 'imperial', 'eye').list;
check('"by eye" leaves out binocular targets', eyeOnly.length && eyeOnly.every(function (t) {
  return (t.see & 3) <= matcher.SEE.CLOSE;
}) && eyeOnly.length < day.list.length);
var all = find.targets(night, HERE, skyAt(night), null, 'imperial', 'all').list;
check('"everything" can go to telescope targets', all.length >= res.list.length &&
      all.every(function (t) { return (t.see & 3) <= matcher.SEE.TELESCOPE; }));
var sunH = A.eqToHorizon(day.sun.ra, day.sun.dec, A.julianDay(noon), HERE.lat, HERE.lon);
check('the Sun is sent for the safety check', A.separation(sunH.az, sunH.alt, sunNow.az, sunNow.altTrue) < 0.05);


// Star patterns: every star found in the catalog, each once.
var pats = patterns.all();
check('every pattern star is in the catalog', pats.every(function (p) {
  return p.members.length >= 2 && p.lines.every(function (poly) {
    return poly.length >= 2 && poly.every(function (i) { return i >= 0; });
  });
}), pats.filter(function (p) {
  return p.lines.some(function (poly) { return poly.some(function (i) { return i < 0; }); });
}).map(function (p) { return p.id; }).join(', '));
check('pattern stars by place are the bright ones there', patterns.LIST.every(function (p) {
  return !p.lines || p.lines.every(function (poly) {
    return poly.every(function (x) {
      if (typeof x === 'string') return true;
      var i = patterns.resolve(x);
      return i >= 0 && stars.catalog[i].mag < 5.1 &&
             A.separation(stars.catalog[i].ra, stars.catalog[i].dec, x[0], x[1]) < 0.05;
    });
  });
}));
check('patterns have their facts', pats.every(function (p) {
  return require('../src/pkjs/facts.js').factsFor({ kind: 'pattern', id: p.id, con: p.con }, {}).length > 0;
}));
check('pattern names fit the watch', pats.every(function (p) { return p.name.length <= 15; }));
var nightPats = res.list.filter(function (t) { return t.type === matcher.TYPE.CONSTELLATION; });
var npNames = nightPats.map(function (t) { return t.name; });
check('an October evening in Phoenix: the Summer Triangle, Cassiopeia, the Great Square',
      ['Summer Triangle', 'Cassiopeia', 'Great Square'].every(function (n) { return npNames.indexOf(n) >= 0; }),
      npNames.join(', '));
check('... but not Orion (it rises later)', npNames.indexOf('Orion') < 0 && npNames.indexOf("Orion's Belt") < 0);
check('patterns: by eye, up, found by a star (no extra give)', nightPats.every(function (t) {
  return (t.see & 3) <= matcher.SEE.CLOSE && t.alt >= 8 && t.give === 0 && t.kind === 0 && typeof t.anchor === 'number';
}), nightPats.map(function (t) { return t.name + ':' + t.give; }).join(', '));
var tri = nightPats.filter(function (t) { return t.name === 'Summer Triangle'; })[0];
check('the Summer Triangle is found by Vega, its brightest', tri && stars.catalog[tri.anchor].name === 'Vega' &&
      /^Vega, /.test(tri.where), tri && tri.where);
check('a pattern\'s RA/Dec is its anchor star', nightPats.every(function (t) {
  var h = A.eqToHorizon(t.ra, t.dec, jd, HERE.lat, HERE.lon);
  return A.separation(h.az, h.alt + A.refraction(h.alt), t.az, t.alt) < 0.05;
}));
// In the city no more patterns, and more of them need a closer look (at
// this time and place the same ten are listed; Lyra, Aquila and the
// Teapot drop from easy to harder).
var cityPats = city.filter(function (t) { return t.type === matcher.TYPE.CONSTELLATION; });
function hard(list) { return list.filter(function (t) { return (t.see & 3) > 0; }).length; }
check('no more patterns in the city, and more of them hard to see', cityPats.length <= nightPats.length &&
      hard(cityPats) > hard(nightPats), cityPats.length + ' vs ' + nightPats.length + ', hard ' + hard(cityPats) +
      ' vs ' + hard(nightPats));
var later = new Date('2026-10-09T11:00:00Z');   // 4 am: Orion is up
var lateNames = find.targets(later, HERE, skyAt(later), null, 'imperial').list.map(function (t) { return t.name; });
check('before dawn: Orion and its Belt', lateNames.indexOf('Orion') >= 0 && lateNames.indexOf("Orion's Belt") >= 0,
      lateNames.join(', '));
check('finding a pattern: its card', find.isTarget({ ref: { kind: 'pattern', id: 'summer' } }, nightPats.filter(
  function (t) { return t.name === 'Summer Triangle'; })[0]) &&
  !find.isTarget({ ref: { kind: 'constellation', id: 'Lyr' } }, nightPats[0]));

// A found pattern's chart: its own figure, the Pleiades zoomed in.
var chart = require('../src/pkjs/chart.js');
function patternChart(id, date, minField) {
  var p = patterns.byId(id);
  return chart.build({ jd: A.julianDay(date), lat: HERE.lat, lon: HERE.lon, planets: [], lines: { pattern: p.lines },
                       con: 'pattern', target: null, minField: minField, h: 118, caption: 'In Cassiopeia' });
}
var casC = patternChart('cassiopeia', night, 8);
check('a pattern\'s chart: its figure', casC && casC.segs === 4 && chart.decode(casC.bytes).caption === 'In Cassiopeia');
var plC = patternChart('pleiades', night, 8), plWide = patternChart('pleiades', night);
check('the Pleiades zoomed in past a constellation\'s chart', plC && plWide && plC.scale > plWide.scale * 1.3,
      plC && (plC.scale / plWide.scale).toFixed(2));

// Best now: a few, the best of each kind, findable, the rest under More.
function bestOf(list) { return list.filter(function (t) { return t.best; }); }
var best = bestOf(res.list);
var bestNames = best.map(function (t) { return t.name; }).join(', ');
check('Best now: ' + find.BEST_N + ' at night', best.length === find.BEST_N, bestNames);
check('Best now: the Moon when it\'s up and can be found', !res.list.some(function (t) {
  return t.id === 'moon' && find.findable(t);
}) || best.some(function (t) { return t.id === 'moon'; }), bestNames);
function kindsIn(list, eyeOnly) {
  var k = {};
  list.forEach(function (t) { if (find.findable(t) && (!eyeOnly || (t.see & 3) <= matcher.SEE.CLOSE)) k[find.kindOf(t)] = 1; });
  return Object.keys(k).sort().join(',');
}
check('Best now: a mix, one of each kind there is to see by eye', kindsIn(best) === kindsIn(res.list, true),
      bestNames);
check('Best now: never two patterns that share stars', best.every(function (t) {
  return !t.stars || best.every(function (u) {
    return u === t || !u.stars || !u.stars.some(function (i) { return t.stars.indexOf(i) >= 0; });
  });
}), bestNames);
var dawn = find.targets(later, HERE, skyAt(later), null, 'imperial').list;
check('... so not Orion with its Belt', !(dawn.filter(function (t) { return t.best && /^Orion/.test(t.name); }).length > 1),
      bestOf(dawn).map(function (t) { return t.name; }).join(', '));
check('Best now: all findable when there are enough', best.every(find.findable));
check('Best now: the best of the planets', (function () {
  var pl = res.list.filter(function (t) { return find.kindOf(t) === 'planet' && find.findable(t); });
  var inBest = best.filter(function (t) { return find.kindOf(t) === 'planet'; });
  return inBest.every(function (t) {
    return pl.filter(function (u) { return find.score(u) < find.score(t); }).every(function (u) { return u.best; });
  });
})(), bestNames);
check('a faint planet scores below a bright low one', find.score({ type: matcher.TYPE.PLANET, see: 0, alt: 15, mag: 0.6 }) <
      find.score({ type: matcher.TYPE.PLANET, see: 0, alt: 50, mag: 5.7 }));
// A short list is all there, with no More.
var tiny = [
  { id: 'moon', type: matcher.TYPE.MOON, see: 0, alt: 40 },
  { id: 'venus', type: matcher.TYPE.PLANET, see: 0, alt: 30, mag: -4 },
  { id: 'jupiter', type: matcher.TYPE.PLANET, see: 1, alt: 50, mag: -2 },
  { id: 'saturn', type: matcher.TYPE.PLANET, see: 2, alt: 50, mag: 0.6 },
  { id: 'mars', type: matcher.TYPE.PLANET, see: 2, alt: 50, mag: 1.2 },
  { id: 'star:1', type: matcher.TYPE.STAR, see: find.SEE_NEAR_SUN | 2, alt: 50, mag: 1 }];
function marked(list) {
  var l = list.map(function (t) { return Object.assign({}, t); });
  find.markBest(l);
  return l;
}
check('a short list is all in Best now', marked(tiny.slice(0, 4)).every(function (t) { return t.best; }));
check('one left over goes into Best now too (no More for one)', marked(tiny).every(function (t) { return t.best; }));
var seven = marked(tiny.concat([{ id: 'star:2', type: matcher.TYPE.STAR, see: 0, alt: 50, mag: 0.5 }]));
check('two left over: Best now holds ' + find.BEST_N, bestOf(seven).length === find.BEST_N &&
      bestOf(seven).every(find.findable), seven.map(function (t) { return t.id + (t.best ? '*' : ''); }).join(' '));
check('... a star among them, though planets come first in the list', bestOf(seven).some(function (t) {
  return t.id === 'star:2';
}));
var dayBest = bestOf(day.list);
check('by day: Best now never leaves out what can be found for what can\'t', dayBest.length === Math.min(
  day.list.length, find.BEST_N) || dayBest.length === day.list.length, day.list.map(function (t) {
  return t.name + (t.best ? '*' : '');
}).join(', '));
check('by day: no patterns', !day.list.some(function (t) { return t.type === matcher.TYPE.CONSTELLATION; }));

// The Space Station during a visible pass, with its path.
function memStore() {
  var m = {};
  return { load: function (k, f) { return k in m ? m[k] : f; }, save: function (k, v) { m[k] = v; return true; } };
}
var store = memStore();
store.save('sf_sat_stations_v1', { t: 1, sats: [fx.omm] });
var cat = S.catalog(store, { stations: true });
// Look for a visible pass over the days around the elements' epoch.
function scan(want) {
  for (var t = Date.UTC(2026, 8, 29); t < Date.UTC(2026, 9, 16); t += 30000) {
    var p = S.positions(cat, new Date(t), HERE, 'imperial')[0];
    if (!p || p.altTrue < 15) continue;
    var sunAlt = planets.bodies(new Date(t), HERE.lat, HERE.lon)[0].alt;
    if (want(p, sunAlt)) return { utc: t, az: p.az, alt: p.alt };
  }
  return null;
}
var pass = scan(function (p, sunAlt) { return p.lit && sunAlt < -8; });
check('a visible pass in the days around the elements', !!pass);
var pt = new Date(pass.utc);
var withIss = find.targets(pt, HERE, skyAt(pt), cat, 'imperial');
var iss = withIss.list.filter(function (t) { return t.name === 'Space Station'; })[0];
check('the Space Station is offered during a visible pass', !!iss, withIss.list.map(function (t) { return t.name; }).join(', '));
check('with a path from now, a point every 3 s', iss && iss.kind === 1 && iss.track.length > 5 &&
      Math.abs(A.separation(iss.track[0].az, iss.track[0].alt, pass.az, pass.alt)) < 0.3,
      iss && iss.track.length + ' points');
check('that moves', iss && A.separation(iss.track[0].az, iss.track[0].alt, iss.track[1].az, iss.track[1].alt) > 0.5);
var di = find.decodeList(find.encodeList(withIss, pt.getTime()));
var dIss = di.list.filter(function (t) { return t.name === 'Space Station'; })[0];
check('its path decodes', dIss && dIss.kind === 1 && dIss.step === 3 && dIss.track.length === iss.track.length &&
      Math.abs(dIss.track[2].alt - iss.track[2].alt) < 0.01);
// Other bright satellites: Tiangong and Hubble (here on the Station's
// orbit, so they pass together), at most MAX_MOVING, the Station first.
function clone(id, name) {
  var o = JSON.parse(JSON.stringify(fx.omm));
  o.NORAD_CAT_ID = id;
  o.OBJECT_NAME = name;
  return o;
}
var store2 = memStore();
store2.save('sf_sat_stations_v1', { t: 1, sats: [fx.omm] });
store2.save('sf_sat_visual_v1', { t: 1, sats: [clone(20580, 'HST'), clone(48274, 'CSS (TIANHE)')] });
var cat2 = S.catalog(store2, { stations: true, visual: true });
var moving = find.targets(pt, HERE, skyAt(pt), cat2, 'imperial').list.filter(function (t) {
  return t.kind === 1 && !t.start;   // up now (not a pass to come)
});
check('at most ' + find.MAX_MOVING + ' satellites, the Station first, then by rank',
      moving.length === find.MAX_MOVING && moving[0].name === 'Space Station' && moving[1].name === 'Tiangong',
      moving.map(function (t) { return t.name; }).join(', '));
check('each followed by its own id', moving[1].satId === 48274 && moving.every(function (t) { return t.track.length > 5; }));
var trainT = { id: 'sat:5', kind: 1, satId: 5 };
var trainSky = { sats: [{ id: 5, cluster: '2026-123Starlink#2' }] };
check('a found train: its card may be for another member of the same train',
      find.isTarget({ ref: { kind: 'sat', id: 6, cluster: '2026-123Starlink#2' } }, trainT, trainSky) &&
      !find.isTarget({ ref: { kind: 'sat', id: 7, cluster: '2026-124Starlink#0' } }, trainT, trainSky) &&
      find.isTarget({ ref: { kind: 'sat', id: 5 } }, trainT, null));
var bytesSat = find.encodeList(find.targets(pt, HERE, skyAt(pt, 'dark'), cat2, 'imperial'), pt.getTime());
check('two paths and a full list still fit', bytesSat.length <= find.LIST_BYTES, bytesSat.length + ' bytes');
var dark = scan(function (p, sunAlt) { return !p.lit && sunAlt < -8; });
if (dark) {
  var dt = new Date(dark.utc);
  check('not while it is in the shadow', !find.targets(dt, HERE, skyAt(dt), cat, 'imperial').list
    .some(function (t) { return t.name === 'Space Station' && !t.start; }));
}
var dayPass = scan(function (p, sunAlt) { return sunAlt > 0; });
if (dayPass) {
  var dpt = new Date(dayPass.utc);
  check('not by day', !find.targets(dpt, HERE, skyAt(dpt), cat, 'imperial').list
    .some(function (t) { return t.name === 'Space Station' && !t.start; }));
}

// The next pass, when it isn't up: 12 Oct 2026, 5:30 am in Phoenix, the
// Station rises in the SSW at 5:52 (satellites.passes, checked against a
// 5 s scan).
var before = new Date('2026-10-12T12:30:00Z');
var soonL = find.targets(before, HERE, skyAt(before), cat, 'imperial');
var nextP = soonL.list.filter(function (t) { return t.name === 'Space Station'; })[0];
check('a pass to come: its path from where it rises, and when', nextP && nextP.kind === 1 &&
      Math.abs(nextP.start - 1325) <= 5 && nextP.track.length >= 10 && nextP.track.length <= 24 &&
      Math.abs(A.wrap180(nextP.track[0].az - 201)) < 3, nextP && nextP.start + ' s, ' + nextP.track.length + ' points');
check('... said as a time and a way across', nextP && /^\d{1,2}:52 [ap]m, (S|SW) to (NE|E)(, (high|low|halfway up))?$/.test(nextP.where) && find.fits(nextP.where),
      nextP && nextP.where);
check('... and the pass after it', nextP && /^Then \d{1,2}:05 [ap]m, S to E$/.test(nextP.note), nextP && nextP.note);
check('... over 20 minutes away: not Best now', nextP && !nextP.best);
var dp = find.decodeList(find.encodeList(soonL, before.getTime())).list
  .filter(function (t) { return t.name === 'Space Station'; })[0];
check('... decodes with its start, step and note', dp && dp.start === nextP.start && dp.step === nextP.step &&
      dp.note === nextP.note && dp.track.length === nextP.track.length);
var close = new Date('2026-10-12T12:45:00Z');
var closeP = find.targets(close, HERE, skyAt(close), cat, 'imperial').list
  .filter(function (t) { return t.name === 'Space Station'; })[0];
check('a pass 7 minutes off can be Best now', closeP && closeP.best && closeP.start < 600, closeP && closeP.start);
check('found: a pass is its satellite', find.isTarget({ ref: { kind: 'sat', id: 25544 } }, nextP));
// Three on one orbit (as above): all over now, two followed; the third
// isn't offered its next pass while it's passing now.
var three = find.targets(pt, HERE, skyAt(pt), cat2, 'imperial').list;
check('one passing now but not followed: no "next pass" for it', !three.some(function (t) {
  return t.start > 0 && t.satId === 20580;
}), three.filter(function (t) { return t.kind === 1; }).map(function (t) { return t.name + ':' + (t.start || 0); }).join(', '));
var farOff = find.targets(new Date('2026-10-11T18:00:00Z'), HERE, skyAt(new Date('2026-10-11T18:00:00Z')), cat,
                          'imperial').list.filter(function (t) { return t.name === 'Space Station'; });
check('a pass more than 18 h off (past what the watch counts) is left off', farOff.length === 0,
      farOff.map(function (t) { return t.start; }).join(', '));

// The Moon. Phoenix, 2026-10-13, 7 pm: a crescent 5 degrees up in the SW
// after sunset (8 degrees used to hide it).
var dusk = new Date('2026-10-14T02:00:00Z');
var duskMoon = find.targets(dusk, HERE, skyAt(dusk), null, 'imperial').list.filter(function (t) {
  return t.id === 'moon';
})[0];
check('a low Moon at dusk is offered', !!duskMoon && duskMoon.kind === 0 && duskMoon.alt < 8 &&
      duskMoon.alt >= find.MOON_ALT, duskMoon && duskMoon.where);
// 9 pm the same night it has set: offered as a rise to wait for.
var late = new Date('2026-10-14T04:00:00Z');
var lateRes = find.targets(late, HERE, skyAt(late), null, 'imperial');
var rise = lateRes.list.filter(function (t) { return t.id === 'moon'; })[0];
var riseAt = rise && moon.moonAltAz(new Date(late.getTime() + rise.start * 1000), HERE.lat, HERE.lon);
check('a set Moon is offered with when it rises', !!rise && rise.kind === 1 && rise.start > 0 &&
      rise.start <= 65535 && /^Rises \d+:\d\d [ap]m, [NSEW]+$/.test(rise.where) &&
      Math.abs(riseAt.alt - find.MOON_ALT) < 0.2, rise && rise.where + ' / ' + rise.note);
check('... with its path from there, and not in Best now', !!rise && rise.track.length === 24 && rise.step === 240 &&
      rise.track[23].alt > rise.track[0].alt && !rise.best);
var dec = find.decodeList(find.encodeList(lateRes, late.getTime()));
var tracked = dec.list.reduce(function (n, t) { return n + (t.track ? t.track.length : 0); }, 0);
var decMoon = dec.list.filter(function (t) { return t.name === 'The Moon'; })[0];
check('... and it reads back', !!decMoon && decMoon.start === rise.start && decMoon.note === rise.note &&
      decMoon.track.length === 24);
check('paths fit the watch (main.c FIND_TRACK_MAX 224)', tracked <= 224 && 2 * 61 + 3 * 24 + 24 <= 224, tracked);
// A moonrise hours off isn't Best now, nor ahead of what's up now.
var noon26 = new Date('2026-10-26T19:00:00Z');
var l26 = find.targets(noon26, HERE, skyAt(noon26), null, 'imperial').list;
var m26 = l26.filter(function (t) { return t.id === 'moon'; })[0];
check('a moonrise hours off waits behind what\'s up now', !!m26 && m26.start > 20 * 60 && !m26.best &&
      l26.slice(0, l26.indexOf(m26)).every(function (t) { return !t.start && find.findable(t); }) &&
      l26.slice(l26.indexOf(m26) + 1).every(function (t) { return !find.findable(t) || t.start > 20 * 60; }),
      l26.map(function (t) { return t.name + (t.start ? '@' + t.start : ''); }).join(', '));
var bytes = find.encodeList({ list: l26, sun: { ra: 0, dec: 0 } }, noon26.getTime()).length;
check('the list fits the watch\'s inbox', bytes <= find.LIST_BYTES, bytes);
// Where each one is fits one line of the watch's list (wrapped, its second
// line ran into the LOOK CLOSELY label).
var allWhere = res.list.concat(lateRes.list, l26);
check('every "where" fits one line', allWhere.every(function (t) { return find.fits(t.where); }),
      allWhere.filter(function (t) { return !find.fits(t.where); }).map(function (t) { return t.where; }).join(' / '));
check('width estimate matches the watch', Math.abs(find.textPx('halfway up in the SE') - 149) <= 4 &&
      Math.abs(find.textPx('7:42 pm, SW to NE, high') - 173) <= 4,
      find.textPx('halfway up in the SE') + ', ' + find.textPx('7:42 pm, SW to NE, high'));
check('a long pass time drops its height', !find.fits('12:59 pm, NW to SW, high') && find.fits('12:59 pm, NW to SW'));
// No Moon too near the Sun to see: new Moon (2026-10-10) rises with the Sun.
var newMoon = new Date('2026-10-10T04:00:00Z');
check('a new Moon isn\'t offered', !find.targets(newMoon, HERE, skyAt(newMoon), null, 'imperial').list.some(
  function (t) { return t.id === 'moon'; }));

// The STARS rung's status line.
function starsLine(iso, setting) {
  var d = new Date(iso);
  return find.starsStatus(d, HERE, planets.bodies(d, HERE.lat, HERE.lon)[0].alt, setting, 'imperial');
}
var noon = starsLine('2026-10-13T19:00:00Z', 'city');
check('by day: when the stars come out', /^Stars out at 6:2\d pm$/.test(noon), noon);
var first = starsLine('2026-10-14T01:12:00Z', 'city');
check('just after sunset: the first ones', /^Arcturus( \+ \d more out| is out first)$/.test(first), first);
var tw = starsLine('2026-10-14T01:30:00Z', 'suburbs');
check('twilight: more coming', /^\d+ stars out, more coming$/.test(tw), tw);
var dawn = starsLine('2026-10-13T13:00:00Z', 'suburbs');
check('dawn: fading', /^\d+ stars out, fading$/.test(dawn), dawn);
var counts = ['city', 'suburbs', 'dark'].map(function (k) { return starsLine('2026-10-14T05:00:00Z', k); });
check('dark: about how many, by the sky', counts[0] === 'About 70 stars out' && counts[1] === 'About 250 stars out' &&
      /^About 8\d0 stars out$/.test(counts[2]), counts.join(' / '));
check('status lines fit the watch (31)', [noon, first, tw, dawn].concat(counts).every(function (l) {
  return l.length <= 31;
}));

// The sky frame.
var frame = find.encodeFrame({ lat: 33.4512, lon: -112.0701, decl: 9.87, sky: 'dark', show: 'binoculars',
                               fingers: [{ yaw: 9.5, pitch: -2.5 }, { yaw: 11.25, pitch: -1 }] });
function i32(b, k) { return (b[k] | (b[k + 1] << 8) | (b[k + 2] << 16) | (b[k + 3] << 24)); }
function i16(b, k) { var v = b[k] | (b[k + 1] << 8); return v >= 32768 ? v - 65536 : v; }
check('the frame is 19 bytes', frame.length === 19);
check('the frame holds the place, declination, fingers and sky',
      i32(frame, 0) === 3345120 && i32(frame, 4) === -11207010 && i16(frame, 8) === 987 &&
      i16(frame, 10) === 950 && i16(frame, 12) === -250 && i16(frame, 14) === 1125 && i16(frame, 16) === -100 &&
      frame[18] === 2);
check('the frame carries what Find it shows', find.encodeFrame({ lat: 0, lon: 0, decl: 0, sky: 'city', show: 'all',
  fingers: [{ yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0 }] })[18] === (0 | 2 << 4) &&
  find.encodeFrame({ lat: 0, lon: 0, decl: 0, sky: 'suburbs', show: 'eye',
                     fingers: [{ yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0 }] })[18] === (1 | 1 << 4));

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
