// The logbook: what you've seen, when, and (if you like) roughly where,
// for the settings page. Kept only on this phone.
//
// A sighting is a sure answer (THAT'S IT or PROBABLY) to an ordinary aim,
// or something found with Find it. Not the Sun, "nothing there", or Tune
// on the Moon aims. Pointing at the same thing again within SAME_MS is
// the same sighting (its word goes up if it's surer, or found).
//
// An entry: {t (ms), k (kind: KINDS), id (the same thing seen again has
// the same id), n (its name), d (a plane's type, if known), c (a plane's
// shape: planes.js CRAFT, if known), w ('likely', 'sure' or 'found'), la,
// lo (where, to WHERE_DEG; none if "roughly where" is off)}.
//
// Where is put into words when shown (places.js: "near Phoenix").

var MAX = 500;                        // entries kept, newest last
var SAME_MS = 30 * 60 * 1000;
var WHERE_DEG = 0.1;                  // about 10 km
var KINDS = ['moon', 'planet', 'star', 'constellation', 'satellite', 'plane'];
var RANK = { likely: 1, sure: 2, found: 3 };
// matcher.TYPE to kinds.
var BY_TYPE = { 1: 'plane', 2: 'satellite', 3: 'planet', 4: 'moon', 5: 'star', 6: 'constellation' };
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// To WHERE_DEG (kept clean of float noise: 33.5, not 33.50000000001).
function round(x) {
  return Math.round(Math.round(x / WHERE_DEG) * WHERE_DEG * 1e6) / 1e6;
}

// The entry for an answer card (matcher's), or null if it isn't one to
// keep. how: 'likely', 'sure' or 'found'; where: {lat, lon} or null.
function entryFor(card, how, t, where) {
  var k = card && BY_TYPE[card.type];
  if (!k || !RANK[how]) return null;
  var r = card.ref || {};
  var id = k === 'moon' ? 'moon'
         : k === 'planet' && r.id ? 'planet:' + r.id
         : k === 'star' && typeof r.index === 'number' ? 'star:' + r.index
         : k === 'constellation' && r.kind === 'pattern' ? 'pattern:' + r.id
         : k === 'constellation' && r.id ? 'con:' + r.id
         : k === 'satellite' && r.id ? 'sat:' + r.id
         : k === 'plane' && r.hex ? 'plane:' + r.hex
         : k + ':' + card.l1;
  var e = { t: t, k: k, id: id, n: k === 'moon' ? 'The Moon' : String(card.l1 || '') };
  if (k === 'plane' && r.typeName) e.d = r.typeName;
  if (k === 'plane' && r.craft > 0) e.c = r.craft;
  e.w = how;
  if (where && isFinite(where.lat) && isFinite(where.lon)) {
    e.la = round(where.lat);
    e.lo = round(where.lon);
  }
  return e;
}

// Adds e to list (in place; the same thing again soon is the same
// sighting) and drops the oldest past MAX. Returns list.
function add(list, e) {
  if (!e) return list;
  for (var i = list.length - 1; i >= 0; i--) {
    var o = list[i];
    if (e.t - o.t > SAME_MS) break;
    if (o.id === e.id) {
      if (RANK[e.w] > RANK[o.w]) o.w = e.w;
      return list;
    }
  }
  list.push(e);
  while (list.length > MAX) list.shift();
  return list;
}

// Every entry without where it was (when "roughly where" is turned off).
function forgetWhere(list) {
  list.forEach(function (e) {
    delete e.la;
    delete e.lo;
  });
  return list;
}

// What's been seen, once each: {kind: [{key, name, first (entry), last
// (entry), n, best ('found', 'sure' or 'likely': the surest)}]}, first
// seen first. Planes go by their type ("Boeing 737-800"), not one by one.
function lifeList(list) {
  var out = {}, at = {};
  KINDS.forEach(function (k) { out[k] = []; });
  list.forEach(function (e) {
    if (!out[e.k]) return;
    var key = e.k === 'plane' ? 'type:' + (e.d || '') : e.id;
    var row = at[key];
    if (row) {
      row.n++;
      row.last = e;
      if (RANK[e.w] > RANK[row.best]) row.best = e.w;
      if (!row.c && e.c) row.c = e.c;
      return;
    }
    row = at[key] = { key: key, name: e.k === 'plane' ? e.d || 'Other planes' : e.n, first: e, last: e, n: 1,
                      best: e.w, c: e.c || 0 };
    out[e.k].push(row);
  });
  return out;
}

// "Sat 11 Oct, 7:15 pm" (h12) or "Sat 11 Oct, 19:15", in the phone's time.
function when(t, h12) {
  var d = new Date(t);
  var h = d.getHours(), m = ('0' + d.getMinutes()).slice(-2);
  var time = h12 ? (h % 12 || 12) + ':' + m + (h < 12 ? ' am' : ' pm') : h + ':' + m;
  return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + time;
}

// "11 Oct 2026".
function day(t) {
  var d = new Date(t);
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

// The logbook as CSV (time in UTC ISO); place(entry): where, in words.
function csv(list, place) {
  function q(s) {
    s = String(s === undefined || s === null ? '' : s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  var rows = ['time,kind,name,type,how,place,lat,lon'];
  list.forEach(function (e) {
    rows.push([new Date(e.t).toISOString(), e.k, e.n, e.d || '', e.w, place ? place(e) : '',
               typeof e.la === 'number' ? e.la : '', typeof e.lo === 'number' ? e.lo : ''].map(q).join(','));
  });
  return rows.join('\n');
}

module.exports = { entryFor: entryFor, add: add, forgetWhere: forgetWhere, lifeList: lifeList, when: when, day: day,
                   csv: csv, KINDS: KINDS, MAX: MAX, SAME_MS: SAME_MS };
