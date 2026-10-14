// The watch's own answers (src/c/offline.c) against the phone's matcher
// for the same aims (test/c/offline_cases.h, from tools/make_sky_cases.js):
// stars, planets and the Moon, with the ephemeris table the phone sends.
// Run: sh tools/check_c.sh (from the repository root: it reads
// resources/data/sky.bin).
#include <math.h>
#include "pebble.h"
#include "offline.h"
#include "sky.h"
#include "offline_cases.h"

static int failures, checks;

static void check(const char *what, bool ok, const char *detail) {
  checks++;
  if (!ok) {
    failures++;
    printf("FAIL %s  (%s)\n", what, detail);
  }
}

int main(void) {
  check("the ephemeris table is taken", eph_set(EPH, sizeof(EPH)), "");
  char detail[160];
  for (size_t i = 0; i < sizeof(CASES) / sizeof(CASES[0]); i++) {
    OffPlace at = { HERE_LAT, HERE_LON, CASES[i].sky };
    Card cards[5];
    int n = off_match(CASES[i].az, CASES[i].alt, CASES[i].sigma, CASES[i].layer, (time_t)CASES[i].t, 0, &at,
                      cards, 5);
    Card *top = n && cards[0].type == T_SUN && n > 1 ? &cards[1] : &cards[0];
    snprintf(detail, sizeof(detail), "case %d: got %s/%d/%s, want %s/%d/%s", (int)i, n ? top->l1 : "-",
             n ? top->word : -1, n ? top->l3 : "-", CASES[i].l1, CASES[i].word, CASES[i].l3);
    // The Moon's "% lit" may round a point apart (the table keeps it to 0.5%).
    bool l3_ok = strncmp(top->l3, CASES[i].l3, 29) == 0 ||
                 (top->type == T_MOON && abs(atoi(top->l3) - atoi(CASES[i].l3)) <= 1);
    check("same answer as the phone", n > 0 && strncmp(top->l1, CASES[i].l1, 31) == 0 && top->word == CASES[i].word &&
          l3_ok, detail);
  }
  // Outside the table: no planets, but stars still answer.
  double ra, dec, mag;
  check("no planets past the table's end", !eph_body(B_JUPITER, (time_t)CASES[0].t + 30 * 86400, &ra, &dec, &mag, NULL, NULL), "");
  check("a malformed table is refused", !eph_set(EPH, 20), "");
  // Bright stars for Find it.
  OffPlace phx = { HERE_LAT, HERE_LON, 1 };
  OffStar list[12];
  int ns = off_bright_stars((time_t)CASES[0].t, &phx, 2.1, 8, list, 12);
  snprintf(detail, sizeof(detail), "%d stars, first %s %.2f", ns, ns ? list[0].name : "-", ns ? list[0].mag : 0);
  bool order = ns >= 6;
  for (int i = 1; i < ns; i++) order = order && list[i - 1].mag <= list[i].mag && list[i].name[0];
  check("bright named stars, brightest first", order, detail);
  // Each one is where its name says: matches the catalog name at its place.
  bool vega = false;
  for (int i = 0; i < ns; i++) {
    if (strcmp(list[i].name, "Vega") == 0) vega = fabs(list[i].dec - 38.8) < 0.2 && fabs(list[i].ra - 279.4) < 0.5;
  }
  check("Vega is where Vega is", vega, "");
  char where[32];
  off_where(225, 55, where, sizeof(where));
  check("where", strcmp(where, "high in the SW") == 0, where);
  printf("offline: %d checks, %s\n", checks, failures ? "FAILED" : "all passed");
  return failures ? 1 : 0;
}
