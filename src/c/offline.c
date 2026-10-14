// Answering on the watch with no phone (see offline.h). The numbers and
// words follow matcher.js; test/c/offline_test.c holds the two together.
#include "offline.h"
#include "sky.h"

// matcher.js knobs.
#define SIGMA_REF        4.0
#define MAX_SEARCH       12.0
#define BRIGHTNESS_SLOPE 0.6
#define NONE_WEIGHT      0.05
#define INVISIBLE_PRIOR  0.03
#define MIN_SHOWN        0.15
#define MAX_SHOWN        5
#define MAX_PER_TYPE     3
#define SUN_WARNING_DEG  20
#define MAX_CANDS        48
#define LN10             2.302585093

// ---------------------------------------------------------------- the ephemeris table

static uint8_t *s_eph;      // [EPH_MAX], on the heap from the first table on
static size_t s_eph_len;

#define EPH_HEAD 10

static size_t eph_need(const uint8_t *b) {
  return EPH_HEAD + (size_t)b[6] * 6 + (size_t)b[9] * b[8] * 5;
}

bool eph_set(const uint8_t *b, size_t len) {
  if (len < EPH_HEAD || len > EPH_MAX || b[0] != 1 || b[5] == 0 || b[7] == 0 || b[9] != B_COUNT - 1 ||
      eph_need(b) > len) {
    return false;
  }
  if (!s_eph && !(s_eph = malloc(EPH_MAX))) return false;
  memcpy(s_eph, b, len);
  s_eph_len = len;
  return true;
}

const uint8_t *eph_bytes(size_t *len) {
  *len = s_eph_len;
  return s_eph;
}

const char *eph_name(int body) {
  static const char *names[B_COUNT] = { "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn" };
  return body >= 0 && body < B_COUNT ? names[body] : "";
}

// Linear between samples, RA the short way round.
static double lerp_ra(double a, double b, double f) {
  return sky_rev(a + sky_wrap180(b - a) * f);
}

bool eph_body(int body, time_t t, double *ra, double *dec, double *mag, double *illum, bool *waxing) {
  if (!s_eph_len || body < 0 || body >= B_COUNT) return false;
  const uint8_t *b = s_eph;
  double t0 = (double)rd_u32(b + 1);
  int step_h = body == B_MOON ? b[5] : b[7], n = body == B_MOON ? b[6] : b[8];
  double x = ((double)t - t0) / (step_h * 3600.0);
  if (x < 0 || n < 2) return false;
  int i = (int)x;
  if (i >= n - 1) return false;
  double f = x - i;
  const uint8_t *p, *q;
  if (body == B_MOON) {
    p = b + EPH_HEAD + i * 6;
    q = p + 6;
  } else {
    p = b + EPH_HEAD + b[6] * 6 + ((body - 1) * n + i) * 5;
    q = p + 5;
  }
  *ra = lerp_ra(rd_u16(p) * 360.0 / 65536, rd_u16(q) * 360.0 / 65536, f);
  *dec = (rd_i16(p + 2) + (rd_i16(q + 2) - rd_i16(p + 2)) * f) / 100.0;
  *mag = ((int8_t)p[4] + ((int8_t)q[4] - (int8_t)p[4]) * f) / 10.0;
  if (illum) *illum = body == B_MOON ? (p[5] + (q[5] - p[5]) * f) / 200.0 : 1;
  if (waxing) *waxing = body == B_MOON && q[5] > p[5];
  return true;
}

// The Sun (Schlyter, as planets.js): good to about 0.01 degrees.
void off_sun(time_t t, double *ra, double *dec) {
  double d = ((double)t - 946728000.0) / 86400.0 + 1.5;
  double w = 282.9404 + 4.70935e-5 * d;
  double e = 0.016709 - 1.151e-9 * d;
  double M = sky_rev(356.0470 + 0.9856002585 * d);
  double E = M + e * (180 / 3.14159265358979) * sky_sind(M) * (1 + e * sky_cosd(M));
  double xv = sky_cosd(E) - e, yv = sky_sqrt(1 - e * e) * sky_sind(E);
  double lon = sky_rev(sky_atan2d(yv, xv) + w);
  double ecl = 23.4393 - 3.563e-7 * d;
  double x = sky_cosd(lon), y = sky_sind(lon) * sky_cosd(ecl), z = sky_sind(lon) * sky_sind(ecl);
  *ra = sky_rev(sky_atan2d(y, x));
  *dec = sky_atan2d(z, sky_sqrt(x * x + y * y));
}

// ---------------------------------------------------------------- the star resource

static ResHandle s_res;
static struct {
  bool ok;
  uint16_t nstars, nnames, nrows, ncons;
  uint32_t off_stars, off_names, off_rows, off_cons;
  double rot[9];
} s_cat;

// One buffer for reading the resource (an app has a 4 KB stack), on the
// heap from the first time the catalog is opened.
#define CHUNK 512
static uint8_t *chunk;

static bool cat_open(void) {
  if (s_cat.ok) return true;
  if (!chunk && !(chunk = malloc(CHUNK))) return false;
  s_res = resource_get_handle(RESOURCE_ID_SKY_DATA);
  uint8_t h[84];
  if (!s_res || resource_load_byte_range(s_res, 0, h, sizeof(h)) != sizeof(h) || memcmp(h, "SKY1", 4) != 0) {
    return false;
  }
  s_cat.nstars = rd_u16(h + 4);
  s_cat.nnames = rd_u16(h + 6);
  s_cat.nrows = rd_u16(h + 8);
  s_cat.ncons = rd_u16(h + 10);
  s_cat.off_stars = rd_u32(h + 16);
  s_cat.off_names = rd_u32(h + 20);
  s_cat.off_rows = rd_u32(h + 24);
  s_cat.off_cons = rd_u32(h + 28);
  for (int k = 0; k < 9; k++) s_cat.rot[k] = (int32_t)rd_u32(h + 48 + 4 * k) / 1e9;
  s_cat.ok = true;
  return true;
}

// Walks the names section in star order, calling each(index, name,
// length, ctx) until it returns false.
typedef bool (*NameFn)(int index, const uint8_t *name, int len, void *ctx);
static void each_name(NameFn each, void *ctx) {
  uint32_t at = s_cat.off_names, end = s_cat.off_rows;
  while (at < end) {
    // Never past the names into the boundary rows.
    size_t n = resource_load_byte_range(s_res, at, chunk, end - at < CHUNK ? end - at : CHUNK);
    size_t k = 0;
    while (k + 3 <= n) {
      int idx = rd_u16(chunk + k), len = chunk[k + 2];
      if (k + 3 + (size_t)len > n) break;   // runs past this chunk: read on from here
      if (!each(idx, chunk + k + 3, len, ctx)) return;
      k += 3 + (size_t)len;
    }
    if (k == 0) return;
    at += (uint32_t)k;
  }
}

static void copy_name(char *buf, size_t cap, const uint8_t *name, int len) {
  int c = len < (int)cap - 1 ? len : (int)cap - 1;
  memcpy(buf, name, (size_t)c);
  buf[c] = '\0';
}

typedef struct {
  int index;
  char *buf;
  size_t cap;
} OneName;

static bool one_name(int index, const uint8_t *name, int len, void *ctx) {
  OneName *w = ctx;
  if (index == w->index) copy_name(w->buf, w->cap, name, len);
  return index < w->index;
}

// A star's name into buf ("" if it has none).
static void star_name(int index, char *buf, size_t cap) {
  buf[0] = '\0';
  OneName w = { index, buf, cap };
  each_name(one_name, &w);
}

static void con_name(int index, char *buf, size_t cap) {
  uint8_t b[24];
  buf[0] = '\0';
  if (index < 0 || index >= s_cat.ncons ||
      resource_load_byte_range(s_res, s_cat.off_cons + (uint32_t)index * 24, b, 24) != 24) {
    return;
  }
  b[23] = '\0';
  strncpy(buf, (const char *)b + 4, cap - 1);
  buf[cap - 1] = '\0';
}

// Which constellation a direction (RA/Dec of date) is in: Roman's table,
// in B1875.
static int con_at(double ra, double dec) {
  SkyVec v = { sky_cosd(dec) * sky_cosd(ra), sky_cosd(dec) * sky_sind(ra), sky_sind(dec) };
  const double *R = s_cat.rot;
  double x = R[0] * v.x + R[1] * v.y + R[2] * v.z;
  double y = R[3] * v.x + R[4] * v.y + R[5] * v.z;
  double z = R[6] * v.x + R[7] * v.y + R[8] * v.z;
  double ra_h = sky_rev(sky_atan2d(y, x)) / 15, d = sky_asind(z);
  for (int i = 0; i < s_cat.nrows; i += 32) {
    int n = s_cat.nrows - i < 32 ? s_cat.nrows - i : 32;
    if (resource_load_byte_range(s_res, s_cat.off_rows + (uint32_t)i * 11, chunk, (size_t)n * 11) != (size_t)n * 11) {
      break;
    }
    for (int j = 0; j < n; j++) {
      const uint8_t *r = chunk + j * 11;
      if (d >= rd_i16(r + 8) / 100.0 && ra_h >= rd_u32(r) / 10000.0 && ra_h < rd_u32(r + 4) / 10000.0) return r[10];
    }
  }
  // The south pole cap: the last row.
  uint8_t last[11];
  if (resource_load_byte_range(s_res, s_cat.off_rows + (uint32_t)(s_cat.nrows - 1) * 11, last, 11) == 11) {
    return last[10];
  }
  return 0;
}

// ---------------------------------------------------------------- words

double off_limiting_mag(double sun_alt, int sky) {
  static const double limits[3] = { 3.5, 4.5, 5.5 };
  if (sun_alt > -1) return -3;
  if (sun_alt > -6) return 1;
  if (sun_alt > -12) return 3;
  return limits[sky >= 0 && sky <= 2 ? sky : 1];
}

// The steps past the eye's limit (matcher.js SEE_CLOSE_MAG, SEE_BINOCULARS_MAG).
#define SEE_CLOSE_MAG      1.5
#define SEE_BINOCULARS_MAG 4

int off_seeing(double mag, double alt_app, double limit) {
  double over = mag + sky_extinction(alt_app) - limit;
  return over <= 0 ? SEE_EASY : over <= SEE_CLOSE_MAG ? SEE_CLOSE : over <= SEE_BINOCULARS_MAG ? SEE_BINOCULARS
                                                                                            : SEE_TELESCOPE;
}

static const char *brightness_word(double mag) {
  if (mag < -3) return "Very bright";
  if (mag < -1) return "Bright";
  if (mag < 1.5) return "Easy to see";
  if (mag < 3.5) return "Faint";
  return "Very faint";
}

static const char *moon_phase(double illum, bool waxing) {
  if (illum < 0.03) return "New Moon";
  if (illum > 0.97) return "Full Moon";
  if (illum < 0.47) return waxing ? "Waxing crescent" : "Waning crescent";
  if (illum <= 0.53) return waxing ? "First quarter" : "Last quarter";
  return waxing ? "Waxing gibbous" : "Waning gibbous";
}

static uint8_t word_for(double p) {
  if (p >= 0.75) return W_THATS;
  if (p >= 0.40) return W_PROBABLY;
  if (p >= MIN_SHOWN) return W_MAYBE;
  return W_NONE;
}

// matcher.js offsetHint(), from how far the object is to the right (dx,
// degrees across the sky) and up (dy) of the aim, d degrees in all.
void off_hint_words(double dx, double dy, double d, char *buf, size_t cap) {
  buf[0] = '\0';
  if (d < 2) return;
  const char *horiz = (dx < 0 ? -dx : dx) > 0.4 * d ? (dx > 0 ? "right" : "left") : NULL;
  const char *vert = (dy < 0 ? -dy : dy) > 0.4 * d ? (dy > 0 ? "higher" : "lower") : NULL;
  bool soft = d < 5;
  if (!horiz && !vert) return;
  if (horiz && vert) snprintf(buf, cap, "%s and %s", vert[0] == 'h' ? "Higher" : "Lower", horiz);
  else if (vert) snprintf(buf, cap, soft ? "A bit %s" : "%s", soft ? vert : (vert[0] == 'h' ? "Higher" : "Lower"));
  else snprintf(buf, cap, soft ? "A bit to the %s" : "Further %s", horiz);
}

void off_offset_hint(double aim_az, double aim_alt, double az, double alt, double d, char *buf, size_t cap) {
  off_hint_words(sky_wrap180(az - aim_az) * sky_cosd(aim_alt), alt - aim_alt, d, buf, cap);
}

void off_where(double az, double alt, char *buf, size_t cap) {
  static const char *dirs[8] = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" };
  int k = (int)(sky_rev(az) / 45 + 0.5) % 8;
  snprintf(buf, cap, "%s%s", alt < 30 ? "low in the " : alt < 50 ? "halfway up in the " : "high in the ", dirs[k]);
}

// ---------------------------------------------------------------- matching

// A unit vector component as the catalog stores it (x 32767), rounded.
static int32_t q15(double x) {
  return (int32_t)(x * 32767 + (x < 0 ? -0.5 : 0.5));
}

typedef struct {
  uint8_t type;
  int16_t index;       // the star, or the body
  double az, alt_true, alt, mag, d, score;
  bool visible;
  double illum;
  bool waxing;
} Cand;

// The scan buffers, on the heap from their first use and kept: a Cand
// list for off_match, and the stars (with their catalog indexes) for
// off_bright_stars.
static Cand *s_cands;
static OffStar *s_up;
static int16_t *s_up_index;

typedef struct {
  Cand *cands;
  int n;
  double total;
  double aim_az, aim_alt, sigma, search, limit;
  bool explicit_layer;
} Scoring;

// Scores one object (matcher.js consider()): a Gaussian in its distance
// from the aim, times a prior for how likely someone is to point at it.
// Keeps the best MAX_CANDS; the total counts them all.
static void consider(Scoring *sc, Cand o) {
  o.alt = o.alt_true + sky_refraction(o.alt_true);
  if (o.alt < -0.5) return;
  o.d = sky_separation(sc->aim_az, sc->aim_alt, o.az, o.alt_true);
  if (!(o.d <= sc->search)) return;
  o.visible = o.alt > 0 && o.mag + sky_extinction(o.alt) <= sc->limit;
  if (!o.visible && !sc->explicit_layer) return;
  double m = o.mag < -2 ? -2 : o.mag > 6 ? 6 : o.mag;
  double prior = sky_exp(-0.4 * LN10 * BRIGHTNESS_SLOPE * m) * (o.visible ? 1 : INVISIBLE_PRIOR);
  double s2 = sc->sigma * sc->sigma;
  o.score = sky_exp(-o.d * o.d / (2 * s2)) * (SIGMA_REF * SIGMA_REF) / s2 * prior;
  sc->total += o.score;
  int at;
  if (sc->n < MAX_CANDS) {
    at = sc->n++;
  } else {
    at = MAX_CANDS - 1;
    if (sc->cands[at].score >= o.score) return;
  }
  while (at > 0 && sc->cands[at - 1].score < o.score) {
    sc->cands[at] = sc->cands[at - 1];
    at--;
  }
  sc->cands[at] = o;
}

static void fill(Card *c, uint8_t type, uint8_t word, const char *l1, const char *l2, const char *l3, const char *hint) {
  memset(c, 0, sizeof(*c));
  c->type = type;
  c->word = word;
  strncpy(c->l1, l1, sizeof(c->l1) - 1);
  strncpy(c->l2, l2, sizeof(c->l2) - 1);
  strncpy(c->l3, l3, sizeof(c->l3) - 1);
  strncpy(c->hint, hint, sizeof(c->hint) - 1);
}

bool off_moon_look(time_t t, const OffPlace *at, uint8_t look[2]) {
  double ra, dec, mag, illum = 1, sra, sdec, maz, malt, saz, salt;
  bool waxing = false;
  if (!eph_body(B_MOON, t, &ra, &dec, &mag, &illum, &waxing)) return false;
  off_sun(t, &sra, &sdec);
  double lst = sky_lst(t, 0, at->lon);
  sky_eq_to_hor(ra, dec, lst, at->lat, &maz, &malt);
  sky_eq_to_hor(sra, sdec, lst, at->lat, &saz, &salt);
  int pct = (int)(illum * 100 + 0.5);
  look[0] = (uint8_t)(pct < 0 ? 0 : pct > 100 ? 100 : pct);
  look[1] = (uint8_t)((int)(sky_lit_side(maz, malt, saz, salt) / 2 + 0.5) % 180);
  return true;
}

int off_match(double az, double alt, double sigma, int layer, time_t t, uint16_t ms, const OffPlace *at,
              Card *cards, int max) {
  int n = 0;
  double aim_alt = sky_unrefract(alt);
  double lst = sky_lst(t, ms, at->lon);
  double sra, sdec, saz, salt;
  off_sun(t, &sra, &sdec);
  sky_eq_to_hor(sra, sdec, lst, at->lat, &saz, &salt);
  double limit = off_limiting_mag(salt + sky_refraction(salt), at->sky);
  bool explicit_layer = layer != L_ANY;
  bool want_planets = layer == L_ANY || layer == L_PLANETS;
  bool want_stars = layer == L_ANY || layer == L_STARS;
  double search = 3 * sigma < MAX_SEARCH ? 3 * sigma : MAX_SEARCH;

  if (salt + sky_refraction(salt) > -1 && sky_separation(az, aim_alt, saz, salt) < SUN_WARNING_DEG && n < max) {
    fill(&cards[n++], T_SUN, W_NONE, "Don't look", "at the Sun!", "It can hurt your eyes", "");
  }

  if (!s_cands && !(s_cands = malloc(MAX_CANDS * sizeof(Cand)))) return n;
  Cand *cands = s_cands;
  Scoring sc = { .cands = cands, .total = NONE_WEIGHT, .aim_az = az, .aim_alt = aim_alt, .sigma = sigma,
                 .search = search, .limit = limit, .explicit_layer = explicit_layer };
  if (want_planets) {
    for (int b = 0; b < B_COUNT; b++) {
      double ra, dec, mag, illum = 1, oaz, oalt;
      bool waxing = false;
      if (!eph_body(b, t, &ra, &dec, &mag, &illum, &waxing)) continue;
      sky_eq_to_hor(ra, dec, lst, at->lat, &oaz, &oalt);
      consider(&sc, (Cand){ .type = b == B_MOON ? T_MOON : T_PLANET, .index = (int16_t)b, .az = oaz,
                            .alt_true = oalt, .mag = mag, .illum = illum, .waxing = waxing });
    }
  }
  if (want_stars && cat_open()) {
    double ara, adec;
    sky_hor_to_eq(az, aim_alt, lst, at->lat, &ara, &adec);
    SkyVec a = { sky_cosd(adec) * sky_cosd(ara), sky_cosd(adec) * sky_sind(ara), sky_sind(adec) };
    double cos_max = sky_cosd(search);
    // The cone test first in whole numbers, on the stars' stored int16
    // vectors (x 32767), so only the few stars near the aim are turned into
    // doubles (the watch has no floating-point unit). Rounding the aim
    // moves the dot product by at most 1.5 x 32767; the margin, 1e-4 x
    // 32767^2, is twice that, so no star the exact test keeps is lost.
    int32_t ai[3] = { q15(a.x), q15(a.y), q15(a.z) };
    int64_t cut = (int64_t)((cos_max - 1e-4) * 32767.0 * 32767.0);
    for (int i = 0; i < s_cat.nstars; i += 64) {
      int m = s_cat.nstars - i < 64 ? s_cat.nstars - i : 64;
      if (resource_load_byte_range(s_res, s_cat.off_stars + (uint32_t)i * 8, chunk, (size_t)m * 8) != (size_t)m * 8) {
        break;
      }
      for (int j = 0; j < m; j++) {
        const uint8_t *s = chunk + j * 8;
        if ((int64_t)ai[0] * rd_i16(s) + (int64_t)ai[1] * rd_i16(s + 2) + (int64_t)ai[2] * rd_i16(s + 4) < cut) {
          continue;
        }
        SkyVec v = { rd_i16(s) / 32767.0, rd_i16(s + 2) / 32767.0, rd_i16(s + 4) / 32767.0 };
        if (sky_dot(a, v) < cos_max) continue;
        double ra = sky_rev(sky_atan2d(v.y, v.x)), dec = sky_asind(v.z), oaz, oalt;
        sky_eq_to_hor(ra, dec, lst, at->lat, &oaz, &oalt);
        consider(&sc, (Cand){ .type = T_STAR, .index = (int16_t)(i + j), .az = oaz, .alt_true = oalt,
                              .mag = (int8_t)s[6] / 10.0, .illum = 1 });
      }
    }
  }
  int nc = sc.n;
  double total = sc.total;

  int per_type[16] = { 0 };
  bool found = false;
  for (int i = 0; i < nc && n < max && n < MAX_SHOWN; i++) {
    Cand *c = &cands[i];
    double p = c->score / total;
    if (p < MIN_SHOWN) break;
    if (!explicit_layer && ++per_type[c->type] > MAX_PER_TYPE) continue;
    char hint[32], l1[32], l2[32], l3[32];
    off_offset_hint(az, aim_alt, c->az, c->alt_true, c->d, hint, sizeof(hint));
    if (c->type == T_MOON) {
      strcpy(l1, "The Moon");
      strncpy(l2, moon_phase(c->illum, c->waxing), sizeof(l2) - 1);
      l2[sizeof(l2) - 1] = '\0';
      snprintf(l3, sizeof(l3), "%d%% lit", (int)(c->illum * 100 + 0.5));
    } else if (c->type == T_PLANET) {
      strncpy(l1, eph_name(c->index), sizeof(l1) - 1);
      l1[sizeof(l1) - 1] = '\0';
      strcpy(l2, "Planet");
      strncpy(l3, brightness_word(c->mag), sizeof(l3) - 1);
      l3[sizeof(l3) - 1] = '\0';
    } else {
      star_name(c->index, l1, sizeof(l1));
      if (!l1[0]) strcpy(l1, "A star");
      uint8_t s[8];
      char con[24] = "";
      if (resource_load_byte_range(s_res, s_cat.off_stars + (uint32_t)c->index * 8, s, 8) == 8) {
        con_name(s[7], con, sizeof(con));
      }
      snprintf(l2, sizeof(l2), "in %s", con);
      strncpy(l3, brightness_word(c->mag), sizeof(l3) - 1);
      l3[sizeof(l3) - 1] = '\0';
    }
    if (!c->visible) {   // as matcher.js SEE_WORDS
      static const char *const see_words[] = { "", "Hard to see now", "Try binoculars", "Needs a telescope" };
      strcpy(l3, c->alt <= 0 ? "Below the horizon" : see_words[off_seeing(c->mag, c->alt, limit)]);
    }
    fill(&cards[n++], c->type, word_for(p), l1, l2, l3, hint);
    found = true;
  }
  if (!found && n < max) {
    char con[24] = "", l3[48];
    if (cat_open()) {
      double ara, adec;
      sky_hor_to_eq(az, aim_alt, lst, at->lat, &ara, &adec);
      con_name(con_at(ara, adec), con, sizeof(con));
    }
    if (layer == L_STARS && aim_alt > 0 && con[0]) {
      fill(&cards[n++], T_CONST, W_NONE, con, "Constellation", "You're pointing into it", "");
    } else {
      bool night = salt < -6 && aim_alt > 0 && con[0];
      if (night) snprintf(l3, sizeof(l3), "Pointing into %s", con);
      else strcpy(l3, "Point again, hold still");
      fill(&cards[n++], T_NOTHING, W_NONE, "Nothing I know", "is there", l3, "");
    }
  }
  return n;
}

typedef struct {
  const int16_t *index;
  OffStar *stars;
  int n;
} ManyNames;

static bool many_names(int index, const uint8_t *name, int len, void *ctx) {
  ManyNames *w = ctx;
  for (int k = 0; k < w->n; k++) {
    if (w->index[k] == index) copy_name(w->stars[k].name, sizeof(w->stars[k].name), name, len);
  }
  return true;
}

int off_bright_stars(time_t t, const OffPlace *at, double max_mag, double min_alt, OffStar *out, int max) {
  if (!cat_open()) return 0;
  double lst = sky_lst(t, 0, at->lon);
  // First the bright stars that are up, brightest first; then their names,
  // in one pass (the names are read through the same buffer).
  if (!s_up && !(s_up = malloc(MAX_CANDS * sizeof(OffStar)))) return 0;
  if (!s_up_index && !(s_up_index = malloc(MAX_CANDS * sizeof(int16_t)))) return 0;
  OffStar *up = s_up;
  int16_t *index = s_up_index;
  int n = 0;
  for (int i = 0; i < s_cat.nstars; i += 64) {
    int m = s_cat.nstars - i < 64 ? s_cat.nstars - i : 64;
    if (resource_load_byte_range(s_res, s_cat.off_stars + (uint32_t)i * 8, chunk, (size_t)m * 8) != (size_t)m * 8) {
      break;
    }
    for (int j = 0; j < m; j++) {
      const uint8_t *s = chunk + j * 8;
      double mag = (int8_t)s[6] / 10.0;
      if (mag > max_mag) continue;
      SkyVec v = { rd_i16(s) / 32767.0, rd_i16(s + 2) / 32767.0, rd_i16(s + 4) / 32767.0 };
      double ra = sky_rev(sky_atan2d(v.y, v.x)), dec = sky_asind(v.z), az, alt;
      sky_eq_to_hor(ra, dec, lst, at->lat, &az, &alt);
      alt += sky_refraction(alt);
      if (alt < min_alt) continue;
      int k;
      if (n < MAX_CANDS) {
        k = n++;
      } else {
        k = MAX_CANDS - 1;
        if (up[k].mag <= mag) continue;
      }
      while (k > 0 && up[k - 1].mag > mag) {
        up[k] = up[k - 1];
        index[k] = index[k - 1];
        k--;
      }
      up[k] = (OffStar){ .ra = ra, .dec = dec, .az = az, .alt = alt, .mag = mag };
      index[k] = (int16_t)(i + j);
    }
  }
  for (int k = 0; k < n; k++) up[k].name[0] = '\0';
  ManyNames w = { index, up, n };
  each_name(many_names, &w);
  int got = 0;
  for (int k = 0; k < n && got < max; k++) {
    if (up[k].name[0]) out[got++] = up[k];
  }
  return got;
}

void off_free(void) {
  free(s_eph);
  free(chunk);
  free(s_cands);
  free(s_up);
  free(s_up_index);
  s_eph = chunk = NULL;
  s_cands = NULL;
  s_up = NULL;
  s_up_index = NULL;
  s_eph_len = 0;
  s_cat.ok = false;
}
