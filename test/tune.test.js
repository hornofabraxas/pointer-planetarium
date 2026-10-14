// Checks src/pkjs/tune.js: the finger offset inverse, the choice of target,
// rejecting bad aims, and the fit, including a cross-session check on the
// real field aims of 2026-10-07. Run: node test/tune.test.js
var tune = require('../src/pkjs/tune.js');
var att = require('../src/pkjs/attitude.js');
var A = require('../src/pkjs/astro.js');
var matcher = require('../src/pkjs/matcher.js');
var planets = require('../src/pkjs/planets.js');

var failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}

// fingerFor undoes aimDirection, over many attitudes, both wrists and
// assorted offsets.
var worst = 0, n = 0, seed = 7;
function rnd() {   // repeatable
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}
for (var i = 0; i < 400; i++) {
  var accel = { x: (rnd() - 0.5) * 2000, y: (rnd() - 0.5) * 1400, z: -200 - rnd() * 900 };
  var head = rnd() * 360, wrist = i % 2, decl = (rnd() - 0.5) * 30;
  var finger = { yaw: (rnd() - 0.5) * 40, pitch: (rnd() - 0.5) * 30 };
  var d = att.aimDirection(head, accel, wrist, decl, finger);
  if (d.rollTooFar) continue;
  var back = att.fingerFor(head, accel, wrist, decl, d.az, d.alt);
  worst = Math.max(worst, Math.abs(back.yaw - finger.yaw), Math.abs(back.pitch - finger.pitch));
  n++;
}
check('fingerFor inverts aimDirection', n > 250 && worst < 1e-9, n + ' cases, worst ' + worst.toExponential(1));

check('where: low in the SE', tune.where(130, 20) === 'low in the SE', tune.where(130, 20));
check('where: high in the N (wraps at 360)', tune.where(355, 60) === 'high in the N', tune.where(355, 60));

// Phoenix, 2026-10-07 18:45 UTC: the daytime Moon of the first field
// session (az 228, alt 54, 10% lit, about 40 degrees from the Sun).
var PHX = { lat: 33.45, lon: -112.07 };   // downtown Phoenix
var day = new Date(Date.UTC(2026, 9, 7, 18, 45, 45));
var t1 = tune.pick(day, PHX.lat, PHX.lon);
check('daytime with the Moon up: the Moon', t1 && t1.id === 'moon' && t1.type === matcher.TYPE.MOON,
      t1 && t1.name + ', ' + t1.where);
var dayAll = tune.targets(day, PHX.lat, PHX.lon);
check('daytime: nothing but the Moon', dayAll.length === 1, dayAll.map(function (t) { return t.name; }).join(', '));

// Three days later the Moon is new, next to the Sun: nothing to tune on.
var newMoon = new Date(Date.UTC(2026, 9, 10, 19, 0, 0));
check('daytime at new moon: nothing', tune.pick(newMoon, PHX.lat, PHX.lon) === null);

// Late evening with no Moon: a planet or a bright star, comfortably high,
// never the Sun.
var night = new Date(Date.UTC(2026, 9, 9, 5, 0, 0));
var nightAll = tune.targets(night, PHX.lat, PHX.lon);
var sun = planets.bodies(night, PHX.lat, PHX.lon)[0];
check('night: several targets, all 15 to 65 degrees up', nightAll.length >= 3 && nightAll.every(function (t) {
  return t.alt >= 15 && t.alt <= 65 && t.id !== 'sun';
}), nightAll.map(function (t) { return t.name + ' ' + t.alt.toFixed(0); }).join(', ') + '; Sun ' + sun.alt.toFixed(0));
var t2 = nightAll[0];
check('night: best first is a planet before any star', t2.type === matcher.TYPE.PLANET ||
      nightAll.every(function (t) { return t.type === matcher.TYPE.STAR; }), t2.name);
var p2 = tune.position(t2.id, night, PHX.lat, PHX.lon);
// (Compared coordinate by coordinate: separation()'s acos is only good to
// about 1e-6 degrees for two identical points.)
check('position() agrees with targets()', Math.abs(p2.az - t2.az) < 1e-9 && Math.abs(p2.alt - t2.alt) < 1e-9);
check('position() of a bad id is null', tune.position('star:999999', night, PHX.lat, PHX.lon) === null &&
      tune.position('sun', night, PHX.lat, PHX.lon) === null);

// The field aims (attitude.test.js has the story). Moon: [head, ax, ay, az,
// moon az, moon alt]; dusk: [name, head, ax, ay, az, az, true alt].
var moonAims = [[227.89, -860, -157, -511, 228.011, 54.181], [226.11, -801, -106, -608, 228.120, 54.128],
                [229.22, -857, -107, -525, 228.172, 54.103]];
var dusk = [
  ['Arcturus', 174.51, -349, -64, -936, 280.4, 19.6], ['Vega', 153.9, -987, -154, -177, 299.7, 77.9],
  ['Altair', 270.22, -951, -27, -355, 168.4, 65.0], ['Antares', 227.67, -326, 3, -948, 221.7, 16.0],
  ['Vega', 120.6, -1006, -34, -148, 299.0, 77.5], ['Vega', 127.18, -1012, -39, -91, 298.9, 77.5],
  ['Saturn', 350.74, -234, 61, -972, 95.4, 11.4], ['Saturn', 351.61, -256, -19, -967, 95.4, 11.4],
  ['Deneb', 40.43, -985, -132, -220, 42.6, 72.5]
];
function raw(head, ax, ay, az, decl) {
  return { head: head, accel: { x: ax, y: ay, z: az }, wrist: 0, decl: decl, cal: 2 };
}
var samples = moonAims.map(function (a) {
  return tune.measure(raw(a[0], a[1], a[2], a[3], 9.61), { az: a[4], alt: a[5] }, 'the Moon').sample;
});
check('all three Moon aims accepted', samples.every(Boolean));
// Tuned with the bare forearm as the "before" offset (what the app had
// before any fitting), the Moon alone should recover most of the offset.
// "After" scores each aim against a fit of the other two, so with three
// aims (one with a rolled wrist) it stays a few degrees.
var res = tune.finish(samples, { yaw: 0, pitch: 0 });
check('Moon tune: before 7 to 11 degrees off, after well under that', res.before > 6 && res.after < 0.6 * res.before,
      'finger ' + res.finger.yaw + '/' + res.finger.pitch + ', before ' + res.before.toFixed(1) +
      ', after ' + res.after.toFixed(1));
var duskMiss = dusk.map(function (a) {
  var r = att.aimDirection(a[1], { x: a[2], y: a[3], z: a[4] }, 0, 9.72, res.finger);
  return A.separation(r.az, A.unrefract(r.alt), a[5], a[6]);
});
duskMiss.sort(function (a, b) { return a - b; });
check('tuned on the Moon by day, the dusk aims hold up (median under 4, worst under 6)',
      duskMiss[4] < 4 && duskMiss[8] < 6, duskMiss.map(function (m) { return m.toFixed(1); }).join(' '));

// Rejections.
var m0 = moonAims[0], tgt0 = { az: m0[4], alt: m0[5] };
check('compass still calibrating: rejected', /draw an 8/.test(tune.measure(
  { head: m0[0], accel: { x: m0[1], y: m0[2], z: m0[3] }, wrist: 0, decl: 9.61, cal: 1 }, tgt0, 'the Moon').reject));
check('pointing somewhere else: rejected', tune.measure(raw(m0[0] + 60, m0[1], m0[2], m0[3], 9.61), tgt0,
                                                        'the Moon').reject === 'Too far from the Moon');
// A big but steady personal offset (25 degrees) can still be tuned out.
var off25 = tune.measure(raw(m0[0] - 25, m0[1], m0[2], m0[3], 9.61), tgt0, 'the Moon');
check('25 degrees off: still taken', !!off25.sample, off25.reject);
check('thumb-up fist: rejected', /face up/.test(tune.measure(raw(m0[0], 0, -1000, 0, 9.61), tgt0, 'the Moon').reject));

// One wild aim out of three barely moves the median.
var wild = samples.slice(0, 2).concat([{ raw: samples[2].raw, tgt: samples[2].tgt, yaw: 30, pitch: -20 }]);
var fw = tune.fit(wild), fs = tune.fit(samples);
check('median shrugs off one wild aim', Math.abs(fw.yaw - fs.yaw) < 3 && Math.abs(fw.pitch - fs.pitch) < 3,
      fw.yaw.toFixed(1) + '/' + fw.pitch.toFixed(1) + ' vs ' + fs.yaw.toFixed(1) + '/' + fs.pitch.toFixed(1));

// The Moon first; with no Moon, the brightest planet, never a star unless
// asked for (a CLOSEST card's target), and only while it's good to tune on.
var nightPick = tune.pick(night, PHX.lat, PHX.lon);
check('pick: the Moon by day', tune.pick(day, PHX.lat, PHX.lon).id === 'moon');
check('pick: a planet on a moonless night, not a star', nightPick && nightPick.type === matcher.TYPE.PLANET,
      nightPick && nightPick.name);
var nightStar = nightAll.filter(function (t) { return t.type === matcher.TYPE.STAR; })[0];
check('pick: a star when a CLOSEST card asked for it', nightStar &&
      tune.pick(night, PHX.lat, PHX.lon, null, nightStar.id).id === nightStar.id, nightStar && nightStar.name);
check('pick: an asked-for target that has set falls back', tune.pick(day, PHX.lat, PHX.lon, null, 'star:0').id === 'moon');
check('idFor: Moon, planet, star, and not a plane', tune.idFor({ kind: 'moon' }) === 'moon' &&
      tune.idFor({ kind: 'planet', id: 'saturn' }) === 'saturn' && tune.idFor({ kind: 'star', index: 12 }) === 'star:12' &&
      tune.idFor({ kind: 'plane' }) === null);

// Learning from sure answers: someone whose finger sits at yaw 14, pitch 0
// (5 degrees from the default) points at stars round the sky with 2.5
// degrees of noise. The pool must find their offset, and wrong answers
// (an offset 25 degrees out) must not get in.
var rawAt = require('./helpers.js').rawAt;
var TRUE_F = { yaw: 14, pitch: 0 }, pool = [], inUse = att.DEFAULT_FINGER, wrongIn = 0;
seed = 5;
function gauss() { return Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()); }
for (var li = 0; li < 40; li++) {
  var tgtL = nightAll[li % nightAll.length];
  var rr = rawAt(tgtL.az + 2.5 * gauss() / A.cosd(tgtL.alt), tgtL.alt + 2.5 * gauss(), 9.7, TRUE_F);
  var rawL = { head: rr.head, accel: { x: rr.ax, y: rr.ay, z: rr.az }, wrist: 0, decl: 9.7 };
  var smp = tune.sample(rawL, tgtL.az, tgtL.alt, inUse, 'auto', li);
  if (smp) pool = tune.addToPool(pool, smp);
  // every fifth a wrong answer: a star 25 degrees from where the finger was
  var bad = tune.sample(rawL, A.rev(tgtL.az + 25 / A.cosd(tgtL.alt)), tgtL.alt, inUse, 'auto', li);
  if (li % 5 === 4 && bad) { wrongIn++; pool = tune.addToPool(pool, bad); }
  inUse = tune.poolOffset(pool) || att.DEFAULT_FINGER;
}
check('learning: finds the offset within 1.5 degrees', Math.abs(inUse.yaw - TRUE_F.yaw) < 1.5 &&
      Math.abs(inUse.pitch - TRUE_F.pitch) < 1.5, inUse.yaw.toFixed(2) + '/' + inUse.pitch.toFixed(2));
check('learning: wrong answers are kept out', wrongIn === 0, wrongIn + ' got in');
check('learning: keeps only the most recent', pool.length === tune.POOL_MAX);
check('pool: 4 learned samples are not enough, 3 from a Moon tune are',
      tune.poolOffset(pool.slice(0, 4)) === null &&
      tune.poolOffset(pool.slice(0, 3).map(function (q) { return { yaw: q.yaw, pitch: q.pitch, src: 'moon' }; })) !== null &&
      tune.poolOffset(pool.slice(0, 3).map(function (q) { return { yaw: q.yaw, pitch: q.pitch, src: 'moon+' }; })) === null);

if (failures) {
  console.log(failures + ' FAILED');
  process.exit(1);
}
console.log('PASS');
