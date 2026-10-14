// Sky math for the watch: where the arm points, and where things are in
// the sky, with no phone. A C port of the parts of attitude.js, astro.js
// and matcher.js the watch needs for Find it and for answering without
// the phone (tested against them in test/c/sky_test.c).
//
// No maths library on the watch: trig goes through the SDK's integer
// lookups (sin_lookup, atan2_lookup), which resolve about 0.006 degrees,
// far finer than the compass. Angles are degrees, azimuths clockwise from
// true north, altitudes apparent (with refraction) unless named "true".
#pragma once
#include <pebble.h>

typedef struct {
  double x, y, z;   // east, north, up
} SkyVec;

double sky_rev(double deg);
double sky_wrap180(double deg);
double sky_sind(double deg);
double sky_cosd(double deg);
double sky_atan2d(double y, double x);
double sky_asind(double x);
double sky_sqrt(double x);
double sky_exp(double x);
double sky_log(double x);

SkyVec sky_vec(double az, double alt);
double sky_dot(SkyVec a, SkyVec b);
double sky_separation(double az1, double alt1, double az2, double alt2);

// Where the finger points, from the averaged firmware heading (degrees, as
// reported), the accelerometer (mg), the wrist (0 left, 1 right), the
// magnetic declination (east positive) and the finger offset (degrees).
// face: how much the screen faces up (1 flat, 0 on edge, below 0 face
// down), the sine of the screen's tilt above vertical.
typedef struct {
  double az, alt;
  double twelve_pitch;
  double face;
  bool roll_too_far;
} SkyAim;
SkyAim sky_aim(double head, int16_t ax, int16_t ay, int16_t az, int wrist, double decl, double yaw, double pitch);
// The same for any direction in watch coordinates (x to 3 o'clock, y to 12
// o'clock, z out of the screen): sky_aim_dir(..., (SkyVec){0, 1, 0}) is
// where the top of the watch points, as Find it uses.
SkyAim sky_aim_dir(double head, int16_t ax, int16_t ay, int16_t az, double decl, SkyVec f);

// Local sidereal time (degrees) at a Unix time and east longitude.
double sky_lst(time_t t, uint16_t ms, double lon);
// Equatorial of date <-> horizontal (true altitudes, no refraction).
void sky_eq_to_hor(double ra, double dec, double lst, double lat, double *az, double *alt);
void sky_hor_to_eq(double az, double alt, double lst, double lat, double *ra, double *dec);
double sky_refraction(double h_true);
double sky_unrefract(double h_app);
double sky_extinction(double alt_app);
// Which way the Moon's lit side faces as you look at it, from where the
// Moon and the Sun are: degrees clockwise from straight up (moon.js
// litSide).
double sky_lit_side(double moon_az, double moon_alt, double sun_az, double sun_alt);
