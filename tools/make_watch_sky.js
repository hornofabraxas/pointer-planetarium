// Builds resources/data/sky.bin, the star catalog the watch answers from
// when the phone isn't there (src/c/offline.c), from the phone's catalog
// (src/pkjs/stars.js). Run after tools/make_stars.py: node tools/make_watch_sky.js
//
// Little-endian. Header (48 bytes): "SKY1", u16 stars, u16 names, u16
//   boundary rows, u16 constellations, i32 epoch (Julian day x 10), u32
//   offsets of the stars, names, rows and constellations.
// Then (at 48) the rotation from the catalog's equator and equinox to
//   B1875's: 3 x 3, row by row, i32 x 1e9.
// Stars (8 bytes each, in catalog order): unit vector x, y, z (i16 x 32767,
//   equator and equinox of the epoch), magnitude (i8 x 10), constellation
//   (u8, index into the constellation table).
// Names: u16 star index, u8 length, the name (ASCII), in star order.
// Boundary rows (Roman 1987, B1875, in table order): u32 RA low, u32 RA
//   high (hours x 10000), i16 Dec low (degrees x 100), u8 constellation.
// Constellations: 24 bytes each: 4 for the abbreviation, 20 for the name
//   (both NUL padded), sorted by abbreviation.
var fs = require('fs');
var path = require('path');
var A = require('../src/pkjs/astro.js');
var stars = require('../src/pkjs/stars.js');
var data = require('../src/pkjs/stars_data.js');

var EPOCH_JD = 2461406.5;   // 2027 January 1.0: within 0.15 degrees of the sky until 2036

var abbrs = Object.keys(stars.CONSTELLATIONS).sort();
var conIndex = {};
abbrs.forEach(function (a, i) { conIndex[a] = i; });

function vec(ra, dec) {
  return [A.cosd(dec) * A.cosd(ra), A.cosd(dec) * A.sind(ra), A.sind(dec)];
}

var starBuf = Buffer.alloc(stars.catalog.length * 8);
var nameParts = [];
var nNames = 0;
stars.catalog.forEach(function (s, i) {
  var p = A.precess(s.ra, s.dec, A.JD_J2000, EPOCH_JD);
  var v = vec(p.ra, p.dec);
  var o = i * 8;
  for (var k = 0; k < 3; k++) starBuf.writeInt16LE(Math.round(v[k] * 32767), o + 2 * k);
  starBuf.writeInt8(Math.max(-128, Math.min(127, Math.round(s.mag * 10))), o + 6);
  var con = stars.constellationAt(p.ra, p.dec, EPOCH_JD);
  starBuf.writeUInt8(conIndex[con], o + 7);
  if (s.name) {
    var n = s.name.replace(/[^\x20-\x7e]/g, '');
    var b = Buffer.alloc(3 + n.length);
    b.writeUInt16LE(i, 0);
    b.writeUInt8(n.length, 2);
    b.write(n, 3, 'ascii');
    nameParts.push(b);
    nNames++;
  }
});
var nameBuf = Buffer.concat(nameParts);

var rows = data.roman.split(';').map(function (r) { return r.split(','); });
var rowBuf = Buffer.alloc(rows.length * 11);
rows.forEach(function (r, i) {
  var o = i * 11;
  rowBuf.writeUInt32LE(Math.round(parseFloat(r[0]) * 10000), o);
  rowBuf.writeUInt32LE(Math.round(parseFloat(r[1]) * 10000), o + 4);
  rowBuf.writeInt16LE(Math.round(parseFloat(r[2]) * 100), o + 8);
  rowBuf.writeUInt8(conIndex[r[3]], o + 10);
});

var conBuf = Buffer.alloc(abbrs.length * 24);
abbrs.forEach(function (a, i) {
  conBuf.write(a, i * 24, 'ascii');
  conBuf.write(stars.CONSTELLATIONS[a].slice(0, 19), i * 24 + 4, 'ascii');
});

// Rotation to B1875: each column is where an axis of the epoch's frame goes.
var cols = [[0, 0], [90, 0], [0, 90]].map(function (rd) {
  var p = A.precess(rd[0], rd[1], EPOCH_JD, A.JD_B1875);
  return vec(p.ra, p.dec);
});
var rotBuf = Buffer.alloc(36);
for (var r = 0; r < 3; r++) {
  for (var c = 0; c < 3; c++) rotBuf.writeInt32LE(Math.round(cols[c][r] * 1e9), (r * 3 + c) * 4);
}

var head = Buffer.alloc(48);
head.write('SKY1', 0, 'ascii');
head.writeUInt16LE(stars.catalog.length, 4);
head.writeUInt16LE(nNames, 6);
head.writeUInt16LE(rows.length, 8);
head.writeUInt16LE(abbrs.length, 10);
head.writeInt32LE(Math.round(EPOCH_JD * 10), 12);
var off = 48 + 36;
head.writeUInt32LE(off, 16);
off += starBuf.length;
head.writeUInt32LE(off, 20);
off += nameBuf.length;
head.writeUInt32LE(off, 24);
off += rowBuf.length;
head.writeUInt32LE(off, 28);

var out = Buffer.concat([head, rotBuf, starBuf, nameBuf, rowBuf, conBuf]);
var file = path.join(__dirname, '..', 'resources', 'data', 'sky.bin');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out);
console.log('wrote resources/data/sky.bin: ' + out.length + ' bytes, ' + stars.catalog.length + ' stars, ' +
            nNames + ' names, ' + rows.length + ' boundary rows');
