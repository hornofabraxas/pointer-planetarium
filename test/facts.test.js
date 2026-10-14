// Facts: every one fits the watch's fact card, every star and constellation
// named is real, and the worked-out facts say the right thing.
// Run: node test/facts.test.js
var facts = require('../src/pkjs/facts.js');
var stars = require('../src/pkjs/stars.js');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

function bytes(s) {
  return Buffer.byteLength(s, 'utf8');
}

var all = [];
function collect(subject) {
  ['imperial', 'metric'].forEach(function (u) {
    facts.factsFor(subject, { units: u, year: 2026 }).forEach(function (f) { all.push(f); });
  });
}
collect({ kind: 'moon' });
['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'].forEach(function (id) {
  collect({ kind: 'planet', id: id, name: id.charAt(0).toUpperCase() + id.slice(1), distAU: 30.5 });
});
Object.keys(facts.STARS).forEach(function (n) { collect({ kind: 'star', name: n, ly: 2650 }); });
Object.keys(facts.CONSTELLATIONS).forEach(function (c) { collect({ kind: 'constellation', id: c }); });
[25544, 48274, 20580, 99999].forEach(function (id) { collect({ kind: 'sat', id: id }); });
collect({ kind: 'sat', id: 1, train: 'Starlink' });
collect({ kind: 'sat', id: 2, rocket: true });
Object.keys(facts.PLANE_BY_CODE).forEach(function (t) {
  collect({ kind: 'plane', id: t, gs: 480, altFt: 37000 });
});

var long = all.filter(function (f) { return bytes(f) > facts.FACT_MAX; });
check('every fact fits the card (' + facts.FACT_MAX + ' bytes)', !long.length, long.slice(0, 3).join(' / '));
var braces = all.filter(function (f) { return /[{}|]/.test(f); });
check('no unit placeholders left', !braces.length, braces[0]);
check('plain ASCII (the watch font has the basics only)', all.every(function (f) { return /^[\x20-\x7e]*$/.test(f); }),
      all.filter(function (f) { return !/^[\x20-\x7e]*$/.test(f); })[0]);

var names = {};
stars.catalog.forEach(function (s) { if (s.name) names[s.name] = true; });
var unknown = Object.keys(facts.STARS).filter(function (n) { return !names[n]; });
check('every star with facts is in the catalog by its IAU name', !unknown.length, unknown.join(', '));
var cons = Object.keys(stars.CONSTELLATIONS);
check('a fact for each of the 88 constellations',
      cons.length === 88 && cons.every(function (c) { return facts.CONSTELLATIONS[c]; }),
      cons.filter(function (c) { return !facts.CONSTELLATIONS[c]; }).join(', '));

// Worked out.
var jup = facts.factsFor({ kind: 'planet', id: 'jupiter', name: 'Jupiter', distAU: 5 }, { units: 'imperial' });
check('light time from a planet', jup.indexOf('Light from Jupiter takes 42 minutes to reach your eyes.') >= 0,
      jup.join(' / '));
var sat = facts.factsFor({ kind: 'planet', id: 'saturn', name: 'Saturn', distAU: 9.0 }, { units: 'imperial' });
check('light time over an hour', sat.indexOf('Light from Saturn takes 1 hour 15 minutes to reach your eyes.') >= 0,
      sat.join(' / '));
var vega = facts.factsFor({ kind: 'star', name: 'Vega', ly: 25.04 }, { units: 'imperial', year: 2026 });
check('the year a near star\'s light left', vega.indexOf('The light you see from Vega left it in 2001: you see it as it was then.') >= 0,
      vega.join(' / '));
var deneb = facts.factsFor({ kind: 'star', name: 'Deneb', ly: 2615 }, { units: 'imperial', year: 2026 });
check('a far star in years ago', deneb.indexOf('The light you see from Deneb left it about 2,600 years ago.') >= 0,
      deneb.join(' / '));
var plain = facts.factsFor({ kind: 'star', name: null, con: 'Ori' }, { units: 'imperial', year: 2026 });
check('an unnamed star borrows its constellation', plain.length === 1 && /Orion/.test(plain[0]), plain[0]);

var b738 = facts.factsFor({ kind: 'plane', id: 'B738', gs: 450, altFt: 36000 }, { units: 'imperial' });
check('a 737 has its own facts, seats, speed and height',
      b738.some(function (f) { return /1967/.test(f); }) &&
      b738.indexOf('A plane like this carries about 140 to 200 people.') >= 0 &&
      b738.indexOf('Going 518 mph, it could fly all the way around the Earth in about 2 days.') >= 0 &&
      b738.indexOf("It's flying higher than the top of Mount Everest (29,032 ft).") >= 0, b738.join(' / '));
var met = facts.factsFor({ kind: 'plane', id: 'ZZZZ', gs: 450, altFt: 5000 }, { units: 'metric' });
check('an unknown type gets the worked-out facts, in metric',
      met.length === 2 && /^Going 830 km\/h/.test(met[0]) && /3 Empire State/.test(met[1]), met.join(' / '));
check('a slow, low plane with no known type has nothing to say',
      facts.factsFor({ kind: 'plane', id: '', gs: 20, altFt: 800 }, { units: 'imperial' }).length === 0);
check('the ISS in metric', facts.factsFor({ kind: 'sat', id: 25544 }, { units: 'metric' })
  .indexOf('The Space Station flies about 7.7 km every second.') >= 0);

// Turning: consecutive n give different facts, and wrap.
var a = facts.factFor({ kind: 'moon' }, { n: 0 }), b = facts.factFor({ kind: 'moon' }, { n: 1 });
check('the fact turns over', a && b && a !== b && facts.factFor({ kind: 'moon' }, { n: 5 }) === a);
check('nothing known: empty', facts.factFor({ kind: 'constellation', id: 'Xyz' }, { n: 0 }) === '');
check('minutes text', facts.minutesText(1) === '1 minute' && facts.minutesText(61) === '1 hour 1 minute' &&
      facts.minutesText(120) === '2 hours');


// Every star in the catalog, named or not, in both units: nothing broken.
var starFacts = [];
stars.catalog.forEach(function (c, i) {
  ['imperial', 'metric'].forEach(function (u) {
    facts.factsFor({ kind: 'star', index: i, name: c.name, ly: stars.distances[i], con: 'Ori' }, { units: u, year: 2026 })
      .forEach(function (f) { starFacts.push(f); });
  });
});
var broken = starFacts.filter(function (f) { return /null|undefined|NaN|Infinity/.test(f) || bytes(f) > facts.FACT_MAX ||
                                                    !/^[\x20-\x7e]*$/.test(f); });
check('every star\'s facts read right (' + starFacts.length + ')', !broken.length, broken.slice(0, 3).join(' / '));
function starIndex(n) { return stars.catalog.findIndex(function (c) { return c.name === n; }); }
function starSubject(n) {
  var i = n === null ? stars.catalog.findIndex(function (c, k) { return !c.name && stars.distances[k]; }) : starIndex(n);
  return { kind: 'star', index: i, name: n, ly: stars.distances[i], con: 'Ori' };
}
var unnamed = facts.factsFor(starSubject(null), { units: 'imperial', year: 2026 });
check('an unnamed star is "this star"', unnamed.length >= 4 && unnamed.some(function (f) {
  return /^The light you see from this star left it/.test(f);
}) && unnamed.some(function (f) { return /^This star /.test(f); }), unnamed.join(' / '));
var named = stars.catalog.map(function (c, i) { return i; }).filter(function (i) {
  return stars.catalog[i].name && stars.distances[i];
});
var lightLast = named.every(function (i) {
  var all = facts.factsFor(starSubject(stars.catalog[i].name), { units: 'imperial', year: 2026 });
  return all.length >= 4 && /^The light you see/.test(all[all.length - 1]) &&
         all.filter(function (f) { return /^The light you see/.test(f); }).length === 1;
});
check('every named star with a distance: 4 facts or more, the light fact last and once', lightLast);
function has(list, re) { return list.some(function (f) { return re.test(f); }); }
var betel = facts.factsFor(starSubject('Betelgeuse'), { units: 'imperial', year: 2026 });
check('Betelgeuse: a red supergiant', has(betel, /^Betelgeuse is a red supergiant/) &&
      has(betel, /^Betelgeuse is a red star/), betel.join(' / '));
var arct = facts.factsFor(starSubject('Arcturus'), { units: 'metric', year: 2026 });
check('Arcturus: an orange giant, in Celsius', has(arct, /^Arcturus is an orange giant/) &&
      has(arct, /4,200 degrees C/), arct.join(' / '));
var mimosa = facts.factsFor(starSubject('Mimosa'), { units: 'imperial', year: 2026 });
check('Mimosa: thousands of Suns, and our Sun invisible from there', has(mimosa, /gives off about 3,\d00 times/) &&
      has(mimosa, /Seen from Mimosa, our Sun would be too faint to see without (binoculars|a telescope)/), mimosa.join(' / '));
var gacrux = facts.factsFor(starSubject('Gacrux'), { units: 'imperial', year: 2026 });
check('no worked-out fact repeats a written one', gacrux.filter(function (f) { return /giant/.test(f); }).length === 1 &&
      facts.factsFor(starSubject('Naos'), { units: 'imperial', year: 2026 }).filter(function (f) {
        return /degrees/.test(f);
      }).length === 1, gacrux.join(' / '));
var altair = facts.factsFor(starSubject('Altair'), { units: 'imperial', year: 2026 });
check('an A star: a fraction as long, not a tenth', has(altair, /only a fraction as long/) && !has(altair, /a tenth/),
      altair.join(' / '));
var sirius = facts.factsFor(starSubject('Sirius'), { units: 'imperial', year: 2026 });
check('Sirius: our Sun would be a bright star from there', has(sirius, /Seen from Sirius, our Sun would be a bright star/),
      sirius.join(' / '));
var tol = facts.factsFor(starSubject('Toliman'), { units: 'imperial', year: 2026 });
check('Toliman: smaller and cooler than the Sun', has(tol, /^Toliman is smaller and cooler than the Sun/), tol.join(' / '));
check('the bright named stars all have written facts', stars.catalog.every(function (c) {
  return !c.name || c.mag >= 2.5 || facts.STARS[c.name];
}), stars.catalog.filter(function (c) { return c.name && c.mag < 2.5 && !facts.STARS[c.name]; })
  .map(function (c) { return c.name; }).join(', '));
check('every constellation has a list of facts, the busy ones two', Object.keys(facts.CONSTELLATIONS).every(function (c) {
  return Array.isArray(facts.CONSTELLATIONS[c]) && facts.CONSTELLATIONS[c].length >= 1;
}) && ['UMa', 'Ori', 'Cyg', 'Sco', 'Cas', 'Leo'].every(function (c) { return facts.CONSTELLATIONS[c].length >= 2; }));
check('every star pattern has two facts', Object.keys(facts.PATTERNS).every(function (k) {
  return facts.PATTERNS[k].length >= 2;
}));

// Planets now.
var ven = facts.factsFor({ kind: 'planet', id: 'venus', name: 'Venus', distAU: 0.4, lit: 0.3 }, { units: 'imperial' });
check('Venus: its distance and its crescent', has(ven, /^Venus is about 37 million miles away right now\.$/) &&
      has(ven, /Venus is a crescent, only 30% lit/), ven.join(' / '));
var nep = facts.factsFor({ kind: 'planet', id: 'neptune', name: 'Neptune', distAU: 29.1 }, { units: 'metric' });
check('Neptune: billions of km', has(nep, /^Neptune is about 4.4 billion km away right now\.$/), nep.join(' / '));

// The Moon now.
var fm = facts.fullMoonName(new Date('2026-10-26T04:00:00Z'));
check("the October 2026 full Moon is the Hunter's Moon", fm === "Hunter's", fm);
check('the September 2026 full Moon is the Harvest Moon', facts.fullMoonName(new Date('2026-09-26T16:00:00Z')) === 'Harvest');
check('in 2025 the Harvest Moon fell in October, and September\'s was the Corn Moon',
      facts.fullMoonName(new Date('2025-10-07T03:00:00Z')) === 'Harvest' &&
      facts.fullMoonName(new Date('2025-09-07T18:00:00Z')) === 'Corn');
check('the January full Moon is the Wolf Moon', facts.fullMoonName(new Date('2026-01-03T10:00:00Z')) === 'Wolf');
check('no name away from full', facts.fullMoonName(new Date('2026-10-19T00:00:00Z')) === null);
var eq = new Date(facts.septemberEquinox(2026));
check('the 2026 September equinox', Math.abs(eq.getTime() - Date.UTC(2026, 8, 23, 0, 5)) < 30 * 60000, eq.toISOString());
var fullFacts = facts.factsFor({ kind: 'moon', illum: 0.99, distKm: 360000 }, { units: 'imperial',
                                                                               date: new Date('2026-10-26T04:00:00Z') });
check("a full Moon: its name first, near its closest, how far", /Hunter's Moon/.test(fullFacts[0]) &&
      has(fullFacts, /near its closest/) && has(fullFacts, /^The Moon is about 224,000 miles away right now: 28 Earths/),
      fullFacts.join(' / '));
var thin = facts.factsFor({ kind: 'moon', illum: 0.12, distKm: 384000 }, { units: 'metric', date: new Date() });
check('a crescent: earthshine', /earthshine/.test(thin[0]) && has(thin, /384,000 km away right now: 30 Earths/),
      thin.join(' / '));

// A plane's trip.
var trip = facts.factsFor({ kind: 'plane', id: 'B738', gs: 450, altFt: 36000,
                            trip: { from: 'San Jose', to: 'Phoenix', km: 990 } }, { units: 'imperial' });
check('a plane\'s trip: how far, and how long at its speed',
      trip.indexOf('San Jose to Phoenix is about 620 miles as the crow flies: 1 hour 11 minutes at this speed.') >= 0,
      trip.join(' / '));
check('a short hop has no trip fact', !has(facts.factsFor({ kind: 'plane', id: 'C172', gs: 100, altFt: 3000,
  trip: { from: 'Mesa', to: 'Chandler', km: 20 } }, { units: 'imperial' }), /as the crow flies/));
check('more plane types: warbirds, business jets, military', ['B17', 'C56X', 'C17', 'V22', 'DA40', 'A306']
  .every(function (t) { return facts.PLANE_BY_CODE[t]; }));

// Turning over: each subject's next fact, never the last one shown.
var sub = { kind: 'star', index: starIndex('Vega'), name: 'Vega', ly: 25, con: 'Lyr' };
var allVega = facts.factsFor(sub, { units: 'imperial', year: 2026 });
var p0 = facts.pickFact(sub, { units: 'imperial', year: 2026, n: 0 });
var p1 = facts.pickFact(sub, { units: 'imperial', year: 2026, n: p0.n });
check('a subject turns to its next fact', p0.text === allVega[0] && p1.text === allVega[1] && p1.n === 2);
var skip = facts.pickFact(sub, { units: 'imperial', year: 2026, n: 0, last: allVega[0] });
check('never the fact shown just before', skip.text === allVega[1] && skip.n === 2);
check('subjects are told apart', facts.factKey(sub) === 'star:Vega' &&
      facts.factKey({ kind: 'star', name: null, index: 12 }) === 'star:12' &&
      facts.factKey({ kind: 'sat', id: 5, train: 'Starlink' }) === 'train:Starlink' &&
      facts.factKey({ kind: 'planet', id: 'mars' }) === 'planet:mars');

console.log(failures ? failures + ' failed' : 'all passed');
process.exit(failures ? 1 : 0);
