// Sky math for the watch (see sky.h).
#include "sky.h"

#define DEG_TO_ANGLE (TRIG_MAX_ANGLE / 360.0)

double sky_rev(double deg) {
  while (deg >= 360) deg -= 360;
  while (deg < 0) deg += 360;
  return deg;
}

double sky_wrap180(double deg) {
  deg = sky_rev(deg);
  return deg > 180 ? deg - 360 : deg;
}

// The lookups step every 0.0055 degrees; interpolating between steps keeps
// the error well under that.
double sky_sind(double deg) {
  double a = sky_rev(deg) * DEG_TO_ANGLE;
  int32_t i = (int32_t)a;
  double f = a - i;
  double s0 = sin_lookup(i % TRIG_MAX_ANGLE), s1 = sin_lookup((i + 1) % TRIG_MAX_ANGLE);
  return (s0 + (s1 - s0) * f) / TRIG_MAX_RATIO;
}

double sky_cosd(double deg) {
  return sky_sind(deg + 90);
}

double sky_atan2d(double y, double x) {
  double m = (y < 0 ? -y : y) > (x < 0 ? -x : x) ? (y < 0 ? -y : y) : (x < 0 ? -x : x);
  if (m == 0) return 0;
  int32_t a = atan2_lookup((int16_t)(y / m * 32000), (int16_t)(x / m * 32000));
  double deg = a / DEG_TO_ANGLE;
  return deg > 180 ? deg - 360 : deg;
}

double sky_sqrt(double x) {
  if (x <= 0) return 0;
  // Start from a power of two near the root, then Newton.
  double r = 1;
  while (r * r * 4 < x) r *= 2;
  while (r * r > x * 4) r /= 2;
  for (int i = 0; i < 6; i++) r = (r + x / r) / 2;
  return r;
}

double sky_asind(double x) {
  if (x > 1) x = 1;
  if (x < -1) x = -1;
  return sky_atan2d(x, sky_sqrt(1 - x * x));
}

// e^x by halving into range and a short series.
double sky_exp(double x) {
  if (x < -60) return 0;
  int halvings = 0;
  while (x > 0.5 || x < -0.5) {
    x /= 2;
    halvings++;
  }
  double term = 1, sum = 1;
  for (int k = 1; k < 12; k++) {
    term *= x / k;
    sum += term;
  }
  while (halvings--) sum *= sum;
  return sum;
}

// Natural log, by Newton on sky_exp.
double sky_log(double x) {
  if (x <= 0) return -1e9;
  double y = 0;
  // A start within a factor of e.
  while (x > 2.718281828) {
    x /= 2.718281828;
    y += 1;
  }
  while (x < 1 / 2.718281828) {
    x *= 2.718281828;
    y -= 1;
  }
  double r = x - 1;
  for (int i = 0; i < 8; i++) r -= 1 - x / sky_exp(r);
  return y + r;
}

SkyVec sky_vec(double az, double alt) {
  double ca = sky_cosd(alt);
  return (SkyVec){ ca * sky_sind(az), ca * sky_cosd(az), sky_sind(alt) };
}

double sky_dot(SkyVec a, SkyVec b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

double sky_separation(double az1, double alt1, double az2, double alt2) {
  SkyVec a = sky_vec(az1, alt1), b = sky_vec(az2, alt2);
  SkyVec c = { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x };
  return sky_atan2d(sky_sqrt(sky_dot(c, c)), sky_dot(a, b));
}

static SkyVec norm(SkyVec v) {
  double n = sky_sqrt(sky_dot(v, v));
  return (SkyVec){ v.x / n, v.y / n, v.z / n };
}

// attitude.js aimDirection(): the world frame in watch coordinates from
// gravity and the 12 o'clock heading, then the finger's direction in it.
SkyAim sky_aim(double head, int16_t ax, int16_t ay, int16_t az, int wrist, double decl, double yaw, double pitch) {
  double side = wrist ? -1 : 1;
  SkyVec f = { side * sky_cosd(pitch) * sky_cosd(yaw), sky_cosd(pitch) * sky_sind(yaw), sky_sind(pitch) };
  return sky_aim_dir(head, ax, ay, az, decl, f);
}

SkyAim sky_aim_dir(double head, int16_t ax, int16_t ay, int16_t az, double decl, SkyVec f) {
  SkyVec up = norm((SkyVec){ -ax, -ay, -az });
  double yu = up.y;
  SkyVec b1 = norm((SkyVec){ -yu * up.x, 1 - yu * up.y, -yu * up.z });
  SkyVec b2 = { b1.y * up.z - b1.z * up.y, b1.z * up.x - b1.x * up.z, b1.x * up.y - b1.y * up.x };
  double heading12 = sky_rev(360 - head + decl);
  SkyAim out;
  out.alt = sky_asind(sky_dot(f, up));
  out.az = sky_rev(heading12 + sky_atan2d(sky_dot(f, b2), sky_dot(f, b1)));
  out.twelve_pitch = sky_asind(yu < 0 ? -yu : yu);
  out.face = up.z;
  out.roll_too_far = out.twelve_pitch > 70;
  return out;
}

// astro.js gmst(), split so a double keeps its precision: whole days and
// the seconds into the day are scaled separately.
double sky_lst(time_t t, uint16_t ms, double lon) {
  // 32 bits (to 2038): 64-bit division costs the app image library code.
  int32_t secs = (int32_t)t - 946728000;   // 2000-01-01 12:00 UTC, JD 2451545.0
  int32_t days = secs / 86400;
  double rest = (double)(secs - days * 86400) + ms / 1000.0;
  double g = 280.46061837 + 0.98564736629 * (double)days + 360.98564736629 * rest / 86400.0;
  return sky_rev(sky_rev(g) + lon);
}

void sky_eq_to_hor(double ra, double dec, double lst, double lat, double *az, double *alt) {
  double ha = sky_rev(lst - ra);
  *alt = sky_asind(sky_sind(lat) * sky_sind(dec) + sky_cosd(lat) * sky_cosd(dec) * sky_cosd(ha));
  *az = sky_rev(sky_atan2d(-sky_cosd(dec) * sky_sind(ha),
                           sky_sind(dec) * sky_cosd(lat) - sky_cosd(dec) * sky_sind(lat) * sky_cosd(ha)));
}

void sky_hor_to_eq(double az, double alt, double lst, double lat, double *ra, double *dec) {
  *dec = sky_asind(sky_sind(lat) * sky_sind(alt) + sky_cosd(lat) * sky_cosd(alt) * sky_cosd(az));
  double ha = sky_atan2d(-sky_sind(az) * sky_cosd(alt),
                         sky_cosd(lat) * sky_sind(alt) - sky_sind(lat) * sky_cosd(alt) * sky_cosd(az));
  *ra = sky_rev(lst - ha);
}

static double tand(double deg) {
  return sky_sind(deg) / sky_cosd(deg);
}

// astro.js refraction() (Saemundsson) and unrefract() (Bennett).
double sky_refraction(double h) {
  if (h < -1) return 0;
  return 1.02 / tand(h + 10.3 / (h + 5.11)) / 60;
}

double sky_unrefract(double h) {
  if (h < -1) return h;
  return h - 1 / tand(h + 7.31 / (h + 4.4)) / 60;
}

// matcher.js extinction(): dimming near the horizon, in magnitudes.
double sky_extinction(double alt) {
  if (alt <= 0) return 5;
  double p = sky_exp(1.1 * sky_log(alt));
  double am = 1 / sky_sind(alt + 244 / (165 + 47 * p));
  if (am > 40) am = 40;
  return 0.25 * (am - 1);
}

double sky_lit_side(double moon_az, double moon_alt, double sun_az, double sun_alt) {
  SkyVec m = sky_vec(moon_az, moon_alt), s = sky_vec(sun_az, sun_alt);
  // Right and up across the face of the sky at the Moon; looking straight
  // up, right is east of the azimuth faced.
  double rx = m.y, ry = -m.x, n = sky_sqrt(rx * rx + ry * ry);
  if (n < 1e-4) {
    rx = sky_cosd(moon_az);
    ry = -sky_sind(moon_az);
  } else {
    rx /= n;
    ry /= n;
  }
  SkyVec right = { rx, ry, 0 };
  SkyVec up = { ry * m.z, -rx * m.z, rx * m.y - ry * m.x };
  double k = sky_dot(s, m);
  SkyVec t = { s.x - k * m.x, s.y - k * m.y, s.z - k * m.z };
  return sky_rev(sky_atan2d(sky_dot(t, right), sky_dot(t, up)));
}
