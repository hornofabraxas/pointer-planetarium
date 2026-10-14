// Where a sighting was, in words, worked out on the phone (no lookup goes
// out): "near Phoenix", or "about 100 km N of Flagstaff" out where there's
// no town. From Natural Earth's towns and cities (places_data.js,
// tools/make_places.py). The logbook keeps where to a tenth of a degree
// (about 10 km), so a place is only ever "near" a town, never in one.
//
//   - Within METRO_KM of a big city (or BIG_METRO_KM of a very big one):
//     the biggest such city. A suburb is "near Phoenix".
//   - Else within NEAR_KM of any town: "near" that town.
//   - Else within FAR_KM: "about 80 km NE of" the nearest town, to the
//     nearest 10 (miles with imperial units), from the town to there.
//   - Else (at sea, the far north): latitude and longitude.

var DATA = require('./places_data.js');

var CITY_RANK = 9;        // Natural Earth rank_max: 100,000 people or more
var BIG_RANK = 12;        // ... a million or more
var METRO_KM = 25;
var BIG_METRO_KM = 40;
var NEAR_KM = 20;
var FAR_KM = 500;
var DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

var table = null;

// The places, parsed once (only the settings page asks).
function load() {
  if (table) return table;
  var rows = DATA.split('\n');
  table = { name: [], lat: new Float64Array(rows.length), lon: new Float64Array(rows.length),
            rank: new Uint8Array(rows.length) };
  rows.forEach(function (r, i) {
    var f = r.split('\t');
    table.name.push(f[4] ? f[0] + ', ' + f[4] : f[0]);
    table.lat[i] = +f[1] / 100;
    table.lon[i] = +f[2] / 100;
    table.rank[i] = +f[3];
  });
  return table;
}

var RAD = Math.PI / 180;

function km(lat1, lon1, lat2, lon2) {
  var a = Math.sin((lat2 - lat1) * RAD / 2), b = Math.sin((lon2 - lon1) * RAD / 2);
  var h = a * a + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * b * b;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The compass point from (lat1, lon1) to (lat2, lon2).
function dir(lat1, lon1, lat2, lon2) {
  var y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  var x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) -
          Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  var deg = (Math.atan2(y, x) / RAD + 360) % 360;
  return DIRS[Math.round(deg / 45) % 8];
}

function coords(lat, lon) {
  return Math.abs(lat).toFixed(1) + '° ' + (lat < 0 ? 'S' : 'N') + ', ' +
         Math.abs(lon).toFixed(1) + '° ' + (lon < 0 ? 'W' : 'E');
}

// The words for (lat, lon); metric: kilometres, else miles. '' if there's
// no where.
function label(lat, lon, metric) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return '';
  var t = load();
  var city = -1, near = -1, nearKm = Infinity;
  for (var i = 0; i < t.name.length; i++) {
    if (Math.abs(t.lat[i] - lat) > FAR_KM / 111 + 0.1) continue;   // quick reject: too far north or south
    var d = km(lat, lon, t.lat[i], t.lon[i]);
    if (d < nearKm) {
      near = i;
      nearKm = d;
    }
    var r = t.rank[i];
    if (r >= CITY_RANK && d <= (r >= BIG_RANK ? BIG_METRO_KM : METRO_KM) &&
        (city < 0 || r > t.rank[city] ||
         (r === t.rank[city] && d < km(lat, lon, t.lat[city], t.lon[city])))) {
      city = i;
    }
  }
  if (city >= 0) return 'near ' + t.name[city];
  if (near >= 0 && nearKm <= NEAR_KM) return 'near ' + t.name[near];
  if (near >= 0 && nearKm <= FAR_KM) {
    var n = Math.max(10, Math.round((metric ? nearKm : nearKm / 1.609344) / 10) * 10);
    return 'about ' + n + (metric ? ' km ' : ' mi ') + dir(t.lat[near], t.lon[near], lat, lon) + ' of ' + t.name[near];
  }
  return coords(lat, lon);
}

module.exports = { label: label, NEAR_KM: NEAR_KM, METRO_KM: METRO_KM };
