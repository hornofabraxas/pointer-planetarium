// Answering on the watch when the phone isn't there: the stars (from the
// sky.bin resource, tools/make_watch_sky.js), the Moon and planets (from
// the table the phone left, ephem.js), and the constellations. A port of
// the matcher (matcher.js) for those, without planes or satellites.
#pragma once
#include <pebble.h>
#include "cards.h"

// Bodies in the ephemeris table.
enum { B_MOON, B_MERCURY, B_VENUS, B_MARS, B_JUPITER, B_SATURN, B_COUNT };

#define EPH_MAX 800

// The table (SKY_EPH, ephem.js). eph_set copies it in; false if malformed.
bool eph_set(const uint8_t *b, size_t len);
const uint8_t *eph_bytes(size_t *len);
// Where a body is at Unix time t (RA/Dec of date, degrees), its magnitude,
// and for the Moon the lit fraction and whether it's waxing. False when t
// is outside the table.
bool eph_body(int body, time_t t, double *ra, double *dec, double *mag, double *illum, bool *waxing);
const char *eph_name(int body);

// Where you are and what you can see: latitude, longitude (east positive),
// sky (0 city, 1 suburbs, 2 dark).
typedef struct {
  double lat, lon;
  int sky;
} OffPlace;

// The answer for an aim (az, apparent alt, sigma degrees) in a layer (L_ANY,
// L_PLANETS, L_STARS) at Unix time t. Fills up to max cards; returns how
// many.
int off_match(double az, double alt, double sigma, int layer, time_t t, uint16_t ms, const OffPlace *at,
              Card *cards, int max);

// How the Moon is lit at Unix time t, for its picture (index.js R_MOON):
// look[0] the lit percentage, look[1] its lit side's angle (sky_lit_side)
// halved. False when t is outside the table.
bool off_moon_look(time_t t, const OffPlace *at, uint8_t look[2]);

// The brightest named stars up now, for Find it with no phone: up to max,
// brightest first, each {name, ra, dec, az, alt (apparent)}.
typedef struct {
  char name[20];
  double ra, dec, az, alt, mag;
} OffStar;
int off_bright_stars(time_t t, const OffPlace *at, double max_mag, double min_alt, OffStar *out, int max);

// Which way to move from an aim (true altitudes) to an object d degrees
// away: "Higher and left", "A bit to the right"; "" within 2 degrees.
void off_offset_hint(double aim_az, double aim_alt, double az, double alt, double d, char *buf, size_t cap);
// The same from how far right (dx) and up (dy) of the aim it is.
void off_hint_words(double dx, double dy, double d, char *buf, size_t cap);

// Words shared with the Find it list: "high in the SW".
void off_where(double az, double alt, char *buf, size_t cap);

// The Sun (RA/Dec of date, degrees) at Unix time t.
void off_sun(time_t t, double *ra, double *dec);

// How faint a star can be seen with the Sun this high, under this sky.
double off_limiting_mag(double sun_alt, int sky);

// How something this bright, this high (apparent) can be seen, with the
// eye's limit off_limiting_mag gives: SEE_EASY to SEE_TELESCOPE
// (matcher.seeing).
int off_seeing(double mag, double alt_app, double limit);

// Frees the buffers this file keeps on the heap (the ephemeris table, the
// resource buffer, the scan lists), when the app exits.
void off_free(void);
