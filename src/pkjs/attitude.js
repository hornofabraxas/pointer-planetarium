// Turns one aim's raw watch readings into a direction in the sky.
//
// Watch axes: x to 3 o'clock, y to 12 o'clock, z out of the screen. The
// accelerometer reads the downward gravity direction in those axes (flat,
// face up: z = -1000 mg). The firmware compass reports the tilt-compensated
// magnetic heading of the 12 o'clock axis, increasing counter-clockwise
// (confirmed in the field 2026-10-07).
//
// The forearm runs along 3 o'clock on a left wrist and 9 o'clock on a
// right one. Rather than assume the watch is level across the arm (the
// moon test's "add 90 degrees"), this builds the full attitude from gravity
// plus the 12 o'clock heading, so a rolled wrist still gives the right
// direction.
//
// People point with a finger, not along the forearm bone. The direction
// they mean is a fixed tilt away from the forearm in the hand's own frame,
// so it is modelled as a pointing vector in watch coordinates: yaw toward
// the 12 o'clock edge (the little-finger side on either wrist) and pitch
// out of the screen. The default is fitted to the first two field
// sessions (2026-10-07, one person: 3 aims at the daytime Moon, then 9 at
// stars and Saturn at dusk): yaw 9.5, pitch -2.5. With it the median miss
// is 3.2 degrees and the worst 4.0 (8 and -3, fitted to the Moon alone,
// gave 2.9 and 5.0). "Tune my aim" (tune.js) measures it per person.

var A = require('./astro.js');

function norm(v) {
  var n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// The 12 o'clock axis this close to vertical makes the compass unreliable
// (the firmware stops correcting for roll at 82 degrees).
var MAX_TWELVE_PITCH = 70;

var DEFAULT_FINGER = { yaw: 9.5, pitch: -2.5 };

// headRaw: firmware heading in degrees as reported; accel: {x, y, z} mg;
// wrist: 0 left, 1 right; declination: degrees, east positive; finger:
// {yaw, pitch} offset of the pointing direction from the forearm (degrees;
// omit for the default, {yaw: 0, pitch: 0} for the bare forearm).
// Returns {az (true, clockwise from north), alt (apparent), twelvePitch,
// rollTooFar}.
function aimDirection(headRaw, accel, wrist, declination, finger) {
  finger = finger || DEFAULT_FINGER;
  var w = frame(headRaw, accel, declination);
  var side = wrist ? -1 : 1;   // the forearm is +x on a left wrist, -x on a right one
  var f = [side * A.cosd(finger.pitch) * A.cosd(finger.yaw),
           A.cosd(finger.pitch) * A.sind(finger.yaw),
           A.sind(finger.pitch)];
  var alt = A.asind(dot(f, w.up));
  var az = A.rev(w.heading12 + A.atan2d(dot(f, w.b2), dot(f, w.b1)));
  return { az: az, alt: alt, twelvePitch: w.twelvePitch, rollTooFar: w.twelvePitch > MAX_TWELVE_PITCH };
}

// The world frame in watch coordinates: up, and a horizontal pair where b1
// points where the 12 o'clock axis points (projected level) and b2 is 90
// degrees clockwise of it; heading12 is b1's true azimuth.
function frame(headRaw, accel, declination) {
  var up = norm([-accel.x, -accel.y, -accel.z]);
  var yu = up[1];   // the 12 o'clock axis is y
  var b1 = norm([-yu * up[0], 1 - yu * up[1], -yu * up[2]]);
  return { up: up, b1: b1, b2: cross(b1, up), heading12: A.rev(360 - headRaw + declination),
           twelvePitch: A.asind(Math.abs(yu)) };
}

// The other way round, for "Tune my aim": the finger offset that would put
// this aim exactly on (az true, alt apparent). Returns {yaw, pitch}.
function fingerFor(headRaw, accel, wrist, declination, az, alt) {
  var w = frame(headRaw, accel, declination);
  var rel = az - w.heading12;
  var h = [A.cosd(alt) * A.cosd(rel), A.cosd(alt) * A.sind(rel), A.sind(alt)];
  var f = [0, 1, 2].map(function (k) { return h[0] * w.b1[k] + h[1] * w.b2[k] + h[2] * w.up[k]; });
  var side = wrist ? -1 : 1;
  return { yaw: A.atan2d(f[1], side * f[0]), pitch: A.asind(f[2]) };
}

module.exports = { aimDirection: aimDirection, fingerFor: fingerFor, MAX_TWELVE_PITCH: MAX_TWELVE_PITCH,
                   DEFAULT_FINGER: DEFAULT_FINGER };
