// Shared by the tests: raw watch readings for a known aim.
var A = require('../src/pkjs/astro.js');
var att = require('../src/pkjs/attitude.js');

// Left wrist, face up, forearm along (az, alt): what the firmware heading
// and the accelerometer would report.
function rawFor(az, alt, decl) {
  var f = [A.sind(az) * A.cosd(alt), A.cosd(az) * A.cosd(alt), A.sind(alt)];
  var up = [-f[2] * f[0], -f[2] * f[1], 1 - f[2] * f[2]];
  var n = Math.sqrt(up[0] * up[0] + up[1] * up[1] + up[2] * up[2]);
  var z = [up[0] / n, up[1] / n, up[2] / n];
  var y = [z[1] * f[2] - z[2] * f[1], z[2] * f[0] - z[0] * f[2], z[0] * f[1] - z[1] * f[0]];
  var mag = A.rev(A.rev(A.atan2d(y[0], y[1])) - decl);
  return { head: A.rev(360 - mag), ax: Math.round(-1000 * f[2]), ay: Math.round(-1000 * y[2]),
           az: Math.round(-1000 * z[2]) };
}

// Readings whose finger (offset `finger`, or the default) lands on (az, alt
// apparent): walk the forearm until it does.
function rawAt(az, alt, decl, finger) {
  var arm = { az: az, alt: alt }, r;
  for (var i = 0; i < 25; i++) {
    r = rawFor(arm.az, arm.alt, decl);
    var got = att.aimDirection(r.head, { x: r.ax, y: r.ay, z: r.az }, 0, decl, finger);
    arm.az += A.wrap180(az - got.az);
    arm.alt += alt - got.alt;
  }
  return r;
}

module.exports = { rawFor: rawFor, rawAt: rawAt };
