// The watch's sky math (src/c/sky.c) against the phone's (test/c/sky_cases.h,
// from tools/make_sky_cases.js). Run: sh tools/check_c.sh
#include <math.h>
#include "pebble.h"
#include "sky.h"
#include "sky_cases.h"

static int failures, checks;

// The Moon's lit side, from moon.js litSide: moon az, alt, Sun az, alt, angle.
static const double LIT[][5] = {
  { 180, 40, 270, -5, 93.8342 },
  { 110, 30, 95, -10, 202.1543 },
  { 200, 60, 300, -12, 87.4357 },
  { 45, 10, 250, -3, 284.0506 },
  { 300, 85, 200, -20, 278.1631 },
  { 0, 90, 180, -8, 0.0 },
};

static void near(const char *what, int i, double got, double want, double tol, bool angle) {
  double d = got - want;
  if (angle) {
    d = fmod(d + 540, 360) - 180;
  }
  checks++;
  if (fabs(d) > tol) {
    failures++;
    printf("FAIL %s[%d]: got %.5f want %.5f\n", what, i, got, want);
  }
}

int main(void) {
  for (size_t i = 0; i < sizeof(AIMS) / sizeof(AIMS[0]); i++) {
    SkyAim a = sky_aim(AIMS[i].head, AIMS[i].ax, AIMS[i].ay, AIMS[i].az, AIMS[i].wrist, AIMS[i].decl,
                       AIMS[i].yaw, AIMS[i].pitch);
    // Near the zenith, azimuth means little: compare the direction.
    double sep = sky_separation(a.az, a.alt, AIMS[i].out_az, AIMS[i].out_alt);
    near("aim", (int)i, sep, 0, 0.02, false);
  }
  // Find it: the top of the watch, tilted up p and rolled r about itself.
  // Roll doesn't move it; its azimuth is the firmware's heading
  // (counter-clockwise) plus the declination.
  static const double TOP[][3] = { { 0, 0, 270 }, { 30, 0, 45 }, { 30, 25, 45 }, { 60, -35, 180 }, { -10, 10, 300 } };
  for (size_t i = 0; i < sizeof(TOP) / sizeof(TOP[0]); i++) {
    double p = TOP[i][0] * M_PI / 180, r = TOP[i][1] * M_PI / 180;
    // Gravity in watch coordinates is minus up.
    int16_t ax = (int16_t)lround(1000 * sin(r) * cos(p)), ay = (int16_t)lround(-1000 * sin(p)),
            az = (int16_t)lround(-1000 * cos(r) * cos(p));
    SkyAim a = sky_aim_dir(TOP[i][2], ax, ay, az, 10, (SkyVec){ 0, 1, 0 });
    near("top alt", (int)i, a.alt, TOP[i][0], 0.1, false);
    near("top az", (int)i, a.az, 370 - TOP[i][2], 0.1, true);
    near("top face", (int)i, a.face, cos(r) * cos(p), 0.002, false);
  }
  for (size_t i = 0; i < sizeof(HOR) / sizeof(HOR[0]); i++) {
    double lst = sky_lst((time_t)HOR[i].t, HOR[i].ms, HOR[i].lon);
    near("lst", (int)i, lst, HOR[i].lst, 0.001, true);
    double az, alt;
    sky_eq_to_hor(HOR[i].ra, HOR[i].dec, lst, HOR[i].lat, &az, &alt);
    near("alt", (int)i, alt, HOR[i].alt, 0.02, false);
    if (HOR[i].alt < 85) near("az", (int)i, az, HOR[i].az, 0.03, true);
    double ra, dec;
    sky_hor_to_eq(az, alt, lst, HOR[i].lat, &ra, &dec);
    if (fabs(HOR[i].dec) < 85) near("ra round trip", (int)i, ra, HOR[i].ra, 0.05, true);
    near("dec round trip", (int)i, dec, HOR[i].dec, 0.02, false);
  }
  for (size_t i = 0; i < sizeof(ATMOS) / sizeof(ATMOS[0]); i++) {
    near("refraction", (int)i, sky_refraction(ATMOS[i].h), ATMOS[i].refr, 0.002, false);
    near("unrefract", (int)i, sky_unrefract(ATMOS[i].h), ATMOS[i].unrefr, 0.002, false);
    near("extinction", (int)i, sky_extinction(ATMOS[i].h), ATMOS[i].ext, 0.01, false);
  }
  for (size_t i = 0; i < sizeof(LIT) / sizeof(LIT[0]); i++) {
    near("lit side", (int)i, sky_lit_side(LIT[i][0], LIT[i][1], LIT[i][2], LIT[i][3]), LIT[i][4], 0.05, true);
  }
  // The building blocks.
  near("sqrt", 0, sky_sqrt(2), sqrt(2), 1e-9, false);
  near("sqrt", 1, sky_sqrt(1e-6), 1e-3, 1e-12, false);
  near("sqrt", 2, sky_sqrt(12345.678), sqrt(12345.678), 1e-9, false);
  near("exp", 0, sky_exp(-3.2), exp(-3.2), 1e-9, false);
  near("exp", 1, sky_exp(7.5), exp(7.5), 1e-6, false);
  near("log", 0, sky_log(0.03), log(0.03), 1e-9, false);
  near("log", 1, sky_log(890.0), log(890.0), 1e-7, false);
  near("sin", 0, sky_sind(33.3), sin(33.3 * M_PI / 180), 2e-5, false);
  near("asin", 0, sky_asind(0.5), 30, 0.01, false);
  near("atan2", 0, sky_atan2d(-1, -1), -135, 0.01, false);
  printf("sky: %d checks, %s\n", checks, failures ? "FAILED" : "all passed");
  return failures ? 1 : 0;
}
