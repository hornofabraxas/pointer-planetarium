// Pointer Planetarium (Pebble Time 2): point at something in the sky with your
// finger, and the watch tells you what it is.
//
// The watch senses, draws and buzzes; the phone does the thinking (see
// docs/DESIGN.md). One aim goes up as about 60 bytes, the answer comes back
// as a few short result cards.
//
// Buttons
//   First run: UP/DOWN answer which wrist; then where you are (city,
//             suburbs, dark sky) and what you look with (eyes, binoculars,
//             telescope): UP/DOWN pick, SELECT chooses, BACK goes back a
//             question; SELECT goes on (the compass coach comes in between
//             only if the compass needs it).
//   Home:     UP/DOWN move along the sky ladder (ANYTHING at the bottom,
//             then PLANES, SATELLITES, PLANETS, STARS, SETTINGS, FIND IT,
//             and round), SELECT aims (SETTINGS: opens the menu), long
//             SELECT opens the menu (sky, gear, theme, light, wrist, Tune
//             on the Moon).
//   Menu:     UP/DOWN pick a row (round), SELECT changes it, BACK goes home.
//   New place (the phone has moved far since the sky was set, and it's
//             dark): "Where are you now?" as in the first run; BACK keeps it.
//   Aiming:   SELECT or BACK cancels.
//   Results:  UP/DOWN go through the answers and their pages (round),
//             SELECT aims again, long SELECT opens the menu, BACK goes home.
//   Find it:  a list (UP/DOWN, SELECT picks, BACK back a step); how to find
//             it until SELECT; then the tapes, and "Found it" while you're
//             on it (off it a second: the tapes again). SELECT (or a tap)
//             there: its card, and BACK from the card goes back to the
//             list (found it: no need to find it again). BACK: the list.
//   Coach:    takes over until the compass is calibrated; BACK leaves the app.
//   Tune:     SELECT aims at the Moon, BACK stops.
//   Wrist question (aims keep pointing into the ground): UP yes, DOWN no
//             (switches the wrist).
//
// Touch (see "touch" below): drag up is DOWN, drag down is UP (Home and
// the lists); on Results up and down go between answers and left and
// right through an answer's pages; a tap is SELECT, picks the row, or on
// the wrist questions picks the answer it's by; drag right is BACK on
// Home, the lists and Tune. The coach, aiming, finding and waiting ignore
// the screen.
//
// Aiming: tap SELECT, raise your arm and point. Once the arm has been
// still for SETTLE_MS the watch records for RECORD_MS, ticks (lower your
// arm), then sends the
// average compass heading and gravity vector to the phone. No buzz until
// the answer, so the motor never shakes the compass mid-recording.

#include <pebble.h>
#include "cards.h"
#include "offline.h"
#include "sky.h"

// ---------------------------------------------------------------- tuning

#define ACCEL_BATCH       5         // 25 Hz in batches of 5 while aiming: every 200 ms
#define ACCEL_FIND_BATCH  1         // ... one at a time while finding: the height tape follows at 25 Hz
#define ACCEL_IDLE_BATCH  25        // ... and of 25 on every other screen: one wake-up a second
#define MOVE_MG           350       // the arm has moved off the tap pose (about 20 deg)
#define RAISED_EL_CD      5000      // arm already up past 50 deg at the tap: no move needed,
#define RAISED_WAIT_MS    800       // but give the user this long to start pointing first
#define STEADY_STEP_MG    45        // batch-to-batch drift that still counts as still
#define STEADY_SPREAD_MG  90        // within-batch wobble that still counts as still
#define RECORD_DRIFT_MG   70        // drift from the recording's start that restarts it
#define SETTLE_MS         600       // the firmware tilt filter lags about 0.3 s
#define RECORD_MS         1200
#define RECORD_BATCHES    (RECORD_MS / 200)   // counted, not timed, so a lagging watch still gets them all
#define RECORD_MAX_BATCHES 12                 // wait this long for a slow compass
#define AIM_TIMEOUT_MS    15000
#define WAIT_TIMEOUT_MS   6000
#define SEND_RETRY_MS     150       // outbox busy (AIM_START still in flight): try again
#define SEND_TRIES        14
#define MIN_COMPASS       3
#define MAX_READINGS      32
#define IDLE_EXIT_MS      (5 * 60 * 1000)
#define COACH_DELAY_MS    1500
#define COACH_TICK_MS     50
#define COACH_DONE_MS     1200
#define MSG_MS            1800
#define LIGHT_READ_MS     30000     // Keep light on: reading, held this long after the last button
#define LIGHT_READ_LONG_MS 60000    // ... or this long (the "1 min" choice); finding, until the watch
                                    // is down this long (LIGHT_READ_MS)
#define LIGHT_BATTERY_MIN 20        // ... and never held at or below this battery (unless charging)
                                    // (settings_page.js and the README say these three)
#define LIGHT_ECHO_MS     1000      // the light's own "on" this soon after letting it go isn't a wake

#define PERSIST_WRIST   1
#define PERSIST_THEME   2
#define PERSIST_LAYER   3
#define PERSIST_LAYERS  4
#define PERSIST_DAY     5
#define PERSIST_SEQ     6
#define PERSIST_INTRO   7   // first run done
#define PERSIST_FRAME   8   // the sky frame from the phone (SKY_FRAME)
#define PERSIST_PREFS   9   // your sky and gear (s_prefs)
#define PERSIST_PREFS_PENDING 10   // ... changed on the watch and not yet confirmed by the phone: the change's number
#define PERSIST_EPH_LEN 19  // the Sun-Moon-planets table from the phone (SKY_EPH): its length,
#define PERSIST_EPH     20  // then its bytes in 256-byte pieces from here

#define TUNE_NEEDED     3
#define TUNE_CANT       255 // TUNE_N from the phone: no tuning now (nothing up, no location)
#define AIM_START_TUNE  255 // AIM_START's layer for a tune aim: no plane fetch
#define MENU_SHOWN      3   // rows on screen; the rest scroll
#define MENU_Y          30  // the first row's top, rows MENU_STEP apart, MENU_H high
#define MENU_STEP       66
#define MENU_H          62
#define PREFS_RETRY_MS  500 // the outbox is busy: send the sky and gear again this soon ...
#define PREFS_TRIES     8   // ... this many times (then on the phone's next status)
#define REVEAL_MS       320 // an answer arriving: a ring closes in on it
#define REVEAL_FRAME_MS 30

// Find it: hold the watch as if reading it and point its top (12 o'clock)
// at the sky. A tape across the top turns you to face the target, one up
// the right tilts you up to it; each goes solid when it's on.
#define FIND_MAX        28        // find.js MAX_TARGETS
#define FIND_STARS      24        // bright stars the no-phone list picks from
#define FIND_TRACK_MAX  224       // paths: two satellites up now, three passes, a moonrise (find.js; track0 is a byte)
#define BEST_N          5         // "Best now" (find.js; the no-phone list takes its first BEST_N)
#define FIND_BEST       0x80      // FIND_LIST's extra byte: Best now; the rest, the give (degrees)
#define CHART_MAX       320       // R_CHART bytes
#define FACT_MAX        128       // R_FACT bytes, with its NUL
#define TAP_MS          40        // one tap: you're facing it now (Find it); got it (an aim)
#define TAP_GAP_MS      1500      // ... at most this often
#define QUIET_MS        120       // compass readings this soon after a buzz are skipped (the motor
                                  // sits beside the compass)
#define ON_DEG          5         // a tape is on within this many degrees of sky (a big pattern
                                  // gives more: its target's give) ...
#define OFF_DEG         7         // ... and stays on until this many more past it
#define FACING_MAX      45        // the heading's give to stay on, at most (near the zenith a little
                                  // sky is a lot of heading)
#define LOCK_MS         700       // both tapes on (overhead: facing it) this long: found it
#define OFF_MS          1000      // ... and held off it this long: back to the tapes
#define HIGH_ALT        65        // a target higher than this isn't tilted to: face it, then look up
                                  // (the compass loses the top of the watch tilted up past ~70) ...
#define OVERHEAD_ALT    80        // ... "Look straight up" past this, "almost" below it
#define TOO_HIGH_PITCH  70        // the top of the watch tilted up past this: the heading is unsure
#define FACE_MIN        0.25      // the screen faces up at least this much (15 deg past on edge)
#define HOLD_PROMPT_MS  600       // not held up to read this long: "Hold your watch"
#define FIND_TIMER_MS   250       // the timeout is checked this often
#define FIND_POS_MS     250       // the target's place is worked out this often
#define FRAME_MS        33        // the tapes glide at about 30 frames a second ...
#define GLIDE           0.3       // ... closing this much of the gap each frame (about 0.1 s)
#define FIND_TIMEOUT_MS (3 * 60 * 1000)   // this long off it (and no button): "Still looking?"
// The Sun (find.js): up above SUN_UP_ALT (apparent); nothing is found
// within SUN_EYE_DEG of it, nor binocular or telescope targets within
// SUN_AIDED_DEG; by eye closer than that, "Block the Sun first!" (on how
// to find it, while finding and on Found it). While finding, you're
// looking at the watch, not the sky, so the top of the watch passing the
// Sun doesn't stop it.
#define SUN_UP_ALT      -2
#define SUN_EYE_DEG     15
#define SUN_AIDED_DEG   30
// ---------------------------------------------------------------- model

// The home ladder's rungs: the sky layers, and Settings (the watch's own,
// never sent to the phone). RUNG_ORDER goes up the ladder and round:
// Settings sits between STARS and FIND IT.
#define RUNG_SETTINGS L_COUNT
#define RUNG_COUNT    (L_COUNT + 1)
static const char *LAYER_NAMES[RUNG_COUNT] = { "ANYTHING", "PLANES", "SATELLITES", "PLANETS", "STARS", "FIND IT",
                                               "SETTINGS" };
static const uint8_t RUNG_ORDER[RUNG_COUNT] = { L_ANY, L_PLANES, L_SATS, L_PLANETS, L_STARS, RUNG_SETTINGS, L_FIND };

// Confidence words (cards.h W_*), as the phone sends them (matcher.js).
static const char *WORDS[4] = { "", "THAT'S IT", "PROBABLY", "MAYBE" };

// The stored numbers (and index.js's) stay as they are: Auto (Stargazer)
// came last. THEME_ORDER is the order the menu goes through them.
enum { THEME_AUTO, THEME_DAY, THEME_NIGHT, THEME_STAR, THEME_AUTO_STAR, THEME_COUNT };
static const char *THEME_NAMES[THEME_COUNT] = { "Auto (Night)", "Day", "Night", "Stargazer", "Auto (Stargazer)" };
static const uint8_t THEME_ORDER[THEME_COUNT] = { THEME_AUTO, THEME_AUTO_STAR, THEME_DAY, THEME_NIGHT, THEME_STAR };

// Your sky (find.js SKY_CODE) and what you look with. The gear is Find
// it's reach (find.js SHOW: 0 binoculars, 1 by eye, 2 everything), listed
// eyes first.
enum { SKY_CITY, SKY_SUBURBS, SKY_DARK, SKY_COUNT };
static const char *SKY_NAMES[SKY_COUNT] = { "City", "Suburbs", "Dark sky" };
// Stars bright enough to see, averaged over a day at 33 degrees north with
// the dimming near the horizon (matcher.js limits 3.5, 4.5 and 5.5).
static const char *SKY_NOTES[SKY_COUNT] = { "see about 80 stars", "see about 260 stars", "see about 900 stars" };
#define GEAR_COUNT 3
static const char *GEAR_NAMES[GEAR_COUNT] = { "My eyes", "Binoculars", "Telescope" };
static const char *GEAR_NOTES[GEAR_COUNT] = { "bright things", "fainter things too", "everything up there" };
static const uint8_t GEAR_SHOW[GEAR_COUNT] = { 1, 0, 2 };
// Keep light on (s_prefs bits 6-7; index.js LIGHT), the default first, so
// a watch from before v0.26 (bits 6-7 clear) gets it.
enum { LIGHT_READ, LIGHT_READ_LONG, LIGHT_FINDING, LIGHT_WATCH, LIGHT_COUNT };
static const char *LIGHT_NAMES[LIGHT_COUNT] = { "Find, read 30 s", "Find, read 1 min", "Only finding",
                                                "Watch's timing" };

typedef enum { SCR_HOME, SCR_AIM, SCR_WAIT, SCR_RESULTS, SCR_COACH, SCR_MENU, SCR_MSG, SCR_INTRO,
               SCR_TUNE, SCR_WRISTQ, SCR_PICK, SCR_FIND, SCR_CHOICE } Screen;
enum { INTRO_WRIST, INTRO_READY };
// The three-way questions (SCR_CHOICE): where you are, what you look with.
enum { CHOICE_SKY, CHOICE_GEAR };
typedef enum { AIM_MOVE, AIM_SETTLE, AIM_RECORD } AimPhase;

typedef struct {
  uint32_t t;
  int32_t v;
  int8_t cal;
} Reading;

// accent: the answer, what's selected; warn: the Sun, and only the Sun;
// line: the edges of boxes that aren't selected; ground: below a chart's
// horizon.
typedef struct {
  GColor bg, fg, dim, accent, warn, line, ground;
} Palette;

static Window *s_window;
static Layer *s_canvas;
static Layer *s_peek;                 // the next answer (or page), coming in beside the one dragged
static Screen s_screen = SCR_HOME;

// Settings and phone state.
static uint8_t s_wrist;               // 0 left, 1 right
static uint8_t s_theme;               // THEME_*: chosen in the menu, else the default for your sky
static bool s_theme_set;              // ... chosen in the menu
static uint8_t s_layer = L_ANY;
static uint8_t s_layers = (1 << L_ANY) | (1 << L_PLANETS) | (1 << L_STARS) | (1 << L_FIND);
static bool s_daylight;
static char (*s_status)[32];         // [L_COUNT]
static bool s_have_status;
static uint16_t s_seq;

// Sensors.
static CompassStatus s_cal = CompassStatusDataInvalid;
static bool s_have_heading;

// The aim in progress.
static AimPhase s_phase;
static uint64_t s_tap_ms, s_settle_ms, s_record_ms;
static int16_t s_tap[3], s_prev[3], s_rec0[3];
static bool s_have_tap, s_have_prev;
static int32_t s_sum[3], s_nsum;
static Reading *s_compass;            // [MAX_READINGS]
static int s_ncompass;
static AppTimer *s_aim_timer;

// The finished aim, kept until it is handed to the outbox.
static struct {
  time_t mid_s;                     // the middle of the recording: the watch's time ...
  uint16_t mid_ms;                  // ... and its milliseconds
  int32_t head_cd, jit_cd;
  int16_t ax, ay, az;
  uint8_t cal;
  uint16_t nc;
} s_out;
static int s_send_tries;
static AppTimer *s_send_timer;

// Results.
static Card *s_cards;                 // [MAX_CARDS]
static uint8_t *s_chart;              // [CHART_MAX] R_CHART, for the chart card (chart.js has the format)
static uint16_t s_chart_len;
static char *s_fact;                  // [FACT_MAX] R_FACT, for the fact card
static bool s_fact_inline;            // ... shown on the first answer's page instead (place_fact)
static uint8_t s_moon_look[2];        // R_MOON (or the watch's own): the Moon's lit percent, lit side / 2
static bool s_have_moon_look;
static int s_ncards, s_card;
static AppTimer *s_wait_timer;
static bool s_no_answer_shown;   // a late reply to s_seq may still replace it
static bool s_offline_shown;     // the cards are the watch's own (no phone)

// Coach, menu, messages, idle.
static uint64_t s_coach_start, s_coach_done;
static uint64_t s_uncal_since;       // the compass stopped being calibrated (0: it is)
static int s_coach_step;
static AppTimer *s_coach_timer;
static int s_menu_row;
// Lists scroll under the finger: s_scroll pixels down the list (its rows
// move up), gliding to s_scroll_to after a flick or a button. A flick
// keeps the chosen row on screen (s_scroll_touch); a button glides to it.
static int16_t s_scroll, s_scroll_to;
static bool s_scroll_touch;
// An answer follows the finger (s_card_off pixels, across or down), then
// goes on to the next or springs back (motion_cb).
static int16_t s_card_off, s_card_to;
static int8_t s_card_go;               // at the end of the way: the answer (or page, across) this far on
static bool s_card_across;
static AppTimer *s_motion_timer;
// Short texts, on the heap (alloc_buffers) like the bigger buffers: the
// session's tune target and "low in the SE", where the Moon is from the
// phone, and a message's two lines.
typedef struct {
  char msg1[32], msg2[32];
  char tune_tgt[32], tune_where[32], tune_note[32];
  char moon_tgt[32], moon_where[32];
} Texts;
static Texts *s_tx;
#define s_msg1 (s_tx->msg1)
#define s_msg2 (s_tx->msg2)
static AppTimer *s_msg_timer, *s_idle_timer;

// First run, Tune on the Moon, the wrist question.
static bool s_intro;
static uint8_t s_intro_step;
static bool s_tune;                   // Tune on the Moon is in progress
static uint8_t s_tune_n;              // tune aims the phone has accepted
#define s_tune_tgt (s_tx->tune_tgt)
#define s_tune_where (s_tx->tune_where)
#define s_tune_note (s_tx->tune_note)
#define s_moon_tgt (s_tx->moon_tgt)
#define s_moon_where (s_tx->moon_where)
static bool s_wrist_ok;               // said yes to "is it on this wrist?" (don't ask again this time)
static int16_t s_pending_tune = -1;   // the TUNE_N held back while the wrist question is up

// Your sky and what you look with, as the sky frame's last byte (find.js:
// the sky in bits 0-3, Find it's reach in bits 4-5), and Keep light on
// (LIGHT_*, bits 6-7; not in the frame). The phone keeps them (its matcher
// and Find it use the sky and reach, its settings page shows all three)
// and sends them in every status (PREFS); a change made on the watch goes
// to the phone, and stays pending until the phone sends it back.
static uint8_t s_prefs = SKY_SUBURBS;  // suburbs, binoculars
static bool s_prefs_pending;
static uint8_t s_prefs_seq;           // the latest change's number (1..127), which the phone echoes
static int s_prefs_tries;
static AppTimer *s_prefs_timer;
static uint8_t s_choice;              // the question on SCR_CHOICE
static int s_choice_row;
static bool s_choice_place;           // ... asked because you're somewhere new
static bool s_place_ask;              // the phone says you're somewhere new: ask on Home
static bool s_place_asked;            // ... asked already this time
static uint64_t s_reveal_start;       // an answer's ring closing in (now_ms(), 0 for none)
static AppTimer *s_reveal_timer;

// The sky frame (find.js SKY_FRAME): where you are, the declination, the
// finger offset for each wrist, your sky. Kept, so it works with no phone.
static struct {
  double lat, lon, decl;
  double yaw[2], pitch[2];
  uint8_t sky;
  uint8_t see_max;                 // what Find it shows: SEE_CLOSE (by eye) to SEE_TELESCOPE
} s_frame = { 0, 0, 0, { 9.5, 9.5 }, { -2.5, -2.5 }, 1, SEE_BINOCULARS };
static bool s_have_frame;

// Find it: the targets (find.js FIND_LIST) and the one being found.
typedef struct {
  uint8_t id, type, kind;          // kind 0: fixed RA/Dec; 1: a path (a satellite)
  uint8_t see;                     // how it can be seen, and near the Sun (cards.h SEE_*)
  bool best;                       // in "Best now"
  uint8_t give;                    // on it within this many degrees (0: ON_DEG)
  char name[25], where[29], note[33];   // note: a satellite's next pass after this one
  double ra, dec;
  uint16_t start;                  // a path: seconds after the list's time it starts (a pass to come)
  uint8_t step, npts;
  uint8_t track0;                  // its first point in s_track
} FindTarget;
static FindTarget *s_find;            // [FIND_MAX]
static int s_nfind;
typedef struct { uint16_t az; int16_t alt; } TrackPoint;
static TrackPoint *s_track;           // [FIND_TRACK_MAX]
static time_t s_find_t0;              // the phone's time when the list was made ...
static int32_t s_skew;                // ... and the phone's clock minus the watch's
static double s_sun_ra, s_sun_dec;
static bool s_wait_list;              // waiting for FIND_LIST
static bool s_quiet_reply;            // the next answer is for a found target: it already buzzed
static int s_pick_row, s_find_cur;
// The Find it list's views: Best now (and More), the kinds (More), or one
// kind's targets. s_rows: what each row is, a target (its index), MORE or a
// kind (ROW_KIND + kind).
enum { VIEW_BEST, VIEW_KINDS, VIEW_KIND };
enum { KIND_SKY, KIND_PATTERN, KIND_STAR, KIND_SAT, KIND_COUNT };
#define ROW_MORE  -1
#define ROW_KIND  -10
#define ROW_NONE  100        // pick_show: no row to look for
static uint8_t s_pick_view, s_pick_kind;
static int8_t s_rows[FIND_MAX + 1];
static int s_nrows;
static int16_t s_fa[3];               // the latest accelerometer reading (while finding, smoothed)
static bool s_have_fa;
static int32_t s_fhead;               // the latest compass heading while finding
static bool s_have_fhead;
static struct {
  bool intro, have, held, too_high, gone, timeout, found;
  bool facing, level;               // the heading, and the tilt, are on the target (level: never
                                    // for one overhead)
  double daz, dalt;                 // degrees: turn (right +), tilt (up +)
  double az, alt, taz, talt;        // where the top of the watch points; where the target is
} s_fs;
// The tapes as drawn: gliding toward s_fs.az and .alt (FRAME_MS, GLIDE).
static double s_show_az, s_show_alt;
static bool s_show_set;
static AppTimer *s_frame_timer;
// The target's place, worked out every FIND_POS_MS.
static struct {
  uint64_t at;
  bool ok;
  double taz, talt;
} s_pos;
static bool s_find_local;             // the list was made on the watch (its ids aren't the phone's)
static uint8_t s_frame_raw[19];       // the frame as last stored
static uint64_t s_find_start, s_lock_start, s_quiet_until, s_tap_ms;   // now_ms() times
static uint64_t s_unheld_at;   // when the watch stopped being held up to read (0: it is)
static uint64_t s_off_at;      // found, then held off it since (0: it's on it, or not held)
static bool s_find_sent;       // this target's card has been made (and asked of the phone)
static bool s_find_back;       // its card is showing: BACK goes back to the list
static AppTimer *s_tick_timer;

static bool parse_frame(const uint8_t *b, size_t len);
static int32_t find_wait_s(const FindTarget *t);
static void motion_reset(void);
static void motion_start(void);
static int menu_rows(void);
static void find_list_received(const uint8_t *b, int len);
static bool answer_offline(void);
static bool find_offline_list(void);
static void save_eph(void);
static bool eph_wanted(void);

// ---------------------------------------------------------------- helpers

// The clock, for what an aim reports to the phone.
static uint64_t wall_ms(void) {
  time_t s;
  uint16_t ms;
  time_ms(&s, &ms);
  return (uint64_t)s * 1000 + ms;
}

// For timing things on the watch (steadiness, recording, ticks, lock-on):
// the clock's steps, except that the clock going back, or forward by a
// minute or more between two readings (a time zone change, the phone
// setting a clock that had drifted), counts as no time, so nothing fires
// early or hangs. Readings come every 200 ms or so while the app is in
// use (sensor events), far inside that minute.
#define CLOCK_JUMP_MS 60000
static uint64_t now_ms(void) {
  static uint64_t last_wall, mono;
  uint64_t w = wall_ms();
  if (!mono) mono = w;
  else if (w >= last_wall && w - last_wall < CLOCK_JUMP_MS) mono += w - last_wall;
  last_wall = w;
  return mono;
}

static uint32_t isqrt64(uint64_t v) {
  uint64_t r = 0, bit = (uint64_t)1 << 62;
  while (bit > v) bit >>= 2;
  while (bit) {
    if (v >= r + bit) {
      v -= r + bit;
      r = (r >> 1) + bit;
    } else {
      r >>= 1;
    }
    bit >>= 2;
  }
  return (uint32_t)r;
}

static int32_t dist2(const int16_t a[3], const int16_t b[3]) {
  int32_t dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

// Forearm elevation in centidegrees from a gravity reading (the moon test's
// formula): the forearm is +x on a left wrist, -x on a right one.
static int32_t forearm_el_cd(const int16_t a[3]) {
  int32_t up = s_wrist ? a[0] : -a[0];
  int32_t horiz = (int32_t)isqrt64((uint64_t)((int64_t)a[1] * a[1] + (int64_t)a[2] * a[2]));
  int32_t ang = atan2_lookup((int16_t)up, (int16_t)horiz);
  if (ang > TRIG_MAX_ANGLE / 2) ang -= TRIG_MAX_ANGLE;
  return ang * 1125 / 2048;   // 36000 / TRIG_MAX_ANGLE, in 32 bits (no 64-bit division in the image)
}

// The theme in use now: the Autos follow the Sun (the phone's DAYLIGHT).
static uint8_t theme_now(void) {
  if (s_theme == THEME_AUTO) return s_daylight ? THEME_DAY : THEME_NIGHT;
  if (s_theme == THEME_AUTO_STAR) return s_daylight ? THEME_DAY : THEME_STAR;
  return s_theme;
}

static Palette palette(void) {
  switch (theme_now()) {
    case THEME_DAY:
      return (Palette){ GColorWhite, GColorBlack, GColorDarkGray, GColorCobaltBlue, GColorDarkCandyAppleRed,
                        GColorDarkGray, GColorLightGray };
    // Under the red backlight only a colour's red shows, so the dim colour
    // keeps full red (dark candy apple red, at two thirds, was hard to
    // read). Folly is red with a little blue: no lighter than the red text,
    // and next to no light outside red. So in this theme colours can't tell
    // things apart: the boxes, fills and sizes have to (and do, in all three).
    // The ground is a third of full red: a dim block under a black sky.
    case THEME_STAR:
      return (Palette){ GColorBlack, GColorRed, GColorFolly, GColorRed, GColorRed, GColorDarkCandyAppleRed,
                        GColorBulgarianRose };
    default:
      return (Palette){ GColorBlack, GColorWhite, GColorLightGray, GColorPictonBlue, GColorChromeYellow,
                        GColorDarkGray, GColorDarkGreen };
  }
}

static bool stargazer(void) {
  return theme_now() == THEME_STAR;
}

// Stargazer's backlight: full red (two thirds, tried in 0.16, made the
// screen too hard to read for what it saved).
#define STAR_LIGHT GColorRed

static void apply_theme(void) {
  light_set_color(stargazer() ? STAR_LIGHT : GColorWhite);
  window_set_background_color(s_window, palette().bg);
  layer_mark_dirty(s_canvas);
}

static void bump_idle(void);

// ---------------------------------------------------------------- light

// Keep light on (the menu's "Keep light on" row): the watch's own light
// goes off after a few seconds, too soon to read a card, and waking it
// again (a tap, a button) jolts a Find it in progress. So the app holds the
// light on while finding (until "Still looking?", or the watch has been
// down LIGHT_READ_MS) and, for LIGHT_READ_MS after the last button, touch
// or answer, on how to find it, on an answer and on the Find it list (those
// two not with Only finding).
//
// Only a light that's already on is held: light_enable(true) would light
// it past the watch's own rules (in daylight, or with the light turned off
// in its settings). Not on a low battery either. Let go, the light goes
// back to the watch's own timing and fade; leaving the app lets it go (the
// firmware does that).
static bool s_light_away;             // a notification (or other modal) is over the app

static int light_mode(void) {
  return (s_prefs >> 6) & 3;
}

static bool s_light_held;
static uint64_t s_read_until;         // reading: held until then (now_ms())
static uint64_t s_light_let_go;       // when it was last let go
static AppTimer *s_read_timer;

static bool light_wanted(void) {
  int m = light_mode();
  if (m == LIGHT_WATCH) return false;
  uint64_t now = now_ms();
  bool reading = now < s_read_until;
  if (s_screen == SCR_FIND) {
    return s_fs.intro ? reading : !s_fs.timeout && (!s_unheld_at || now - s_unheld_at < LIGHT_READ_MS);
  }
  return m != LIGHT_FINDING && (s_screen == SCR_RESULTS || s_screen == SCR_PICK) && reading;
}

// Called whenever what's wanted may have changed (and every tick while
// finding), so a battery running down lets go too.
static void light_update(void) {
  bool want = light_wanted();
  if (want) {
    BatteryChargeState b = battery_state_service_peek();
    want = b.charge_percent > LIGHT_BATTERY_MIN || b.is_charging;
  }
  if (want && !s_light_held) {
    if (!light_is_on()) return;
    light_enable(true);
    s_light_held = true;
  } else if (!want && s_light_held) {
    s_light_held = false;
    s_light_let_go = now_ms();
    light_enable(false);          // straight off, so ...
    light_enable_interaction();   // ... back on the watch's own timer (in the dark), to fade as usual
  }
}

static void read_cb(void *ctx) {
  s_read_timer = NULL;
  s_read_until = 0;   // over, whatever the clock says
  light_update();
}

// A button, a touch, an answer, a new screen: someone's reading.
static void light_read_more(void) {
  if (light_mode() != LIGHT_WATCH) {
    uint32_t ms = light_mode() == LIGHT_READ_LONG ? LIGHT_READ_LONG_MS : LIGHT_READ_MS;
    s_read_until = now_ms() + ms;
    if (s_read_timer) app_timer_cancel(s_read_timer);
    s_read_timer = app_timer_register(ms, read_cb, NULL);
  }
  light_update();
}

// The light came on (a double tap in the dark, a button): hold it from
// here. Its own "on" just after it was let go (light_update) isn't one,
// nor a notification's.
static void light_handler(bool on) {
  if (on && !s_light_away && now_ms() - s_light_let_go >= LIGHT_ECHO_MS) light_read_more();
}

// The system resets the backlight tint whenever something else takes the
// screen, so set it again right before every reveal.
static void reveal_light(void) {
  light_set_color(stargazer() ? STAR_LIGHT : GColorWhite);
  light_enable_interaction();
  light_read_more();
}

// The accelerometer is only read while aiming or finding; on the other
// screens it comes in batches of 25, so the app wakes once a second, not
// five times. (The compass keeps the sensor itself at 25 Hz either way.)
static uint32_t s_accel_batch;
static AppTimer *s_accel_timer;

static uint32_t accel_batch_wanted(void) {
  if (s_screen == SCR_FIND && !s_fs.intro) return ACCEL_FIND_BATCH;   // found too: drifting off is watched
  return s_screen == SCR_AIM ? ACCEL_BATCH : ACCEL_IDLE_BATCH;
}

#define ACCEL_RETRY_MS 100

static void accel_batch_cb(void *ctx) {
  s_accel_timer = NULL;
  uint32_t want = accel_batch_wanted();
  if (want == s_accel_batch) return;
  if (accel_service_set_samples_per_update(want) == 0) {
    s_accel_batch = want;
  } else {
    s_accel_timer = app_timer_register(ACCEL_RETRY_MS, accel_batch_cb, NULL);   // until it takes
  }
}

// Changed from a timer, never straight away: a screen change can come from
// inside accel_handler (finish_aim), and changing the batch under the
// firmware's handler trips its assert (applib accel_service.c consumes the
// old batch's count after the handler returns).
static void accel_follow_screen(void) {
  if (!s_accel_timer && accel_batch_wanted() != s_accel_batch) {
    s_accel_timer = app_timer_register(0, accel_batch_cb, NULL);
  }
}

static void ask_place(void);

static void go(Screen s) {
  // The phone said you're somewhere new: ask before Home (once).
  if (s == SCR_HOME && s_place_ask && !s_intro) {
    ask_place();
    return;
  }
  s_screen = s;
  motion_reset();
  accel_follow_screen();
  if (s == SCR_RESULTS || s == SCR_PICK || s == SCR_FIND) light_read_more();
  else light_update();
  layer_mark_dirty(s_canvas);
}

// ---------------------------------------------------------------- drawing

static void text(GContext *ctx, const char *s, const char *font, GRect box, GColor c, GTextAlignment al) {
  graphics_context_set_text_color(ctx, c);
  graphics_draw_text(ctx, s, fonts_get_system_font(font), box, GTextOverflowModeWordWrap, al, NULL);
}

static int16_t text_h(const char *s, const char *font, int16_t w) {
  return graphics_text_layout_get_content_size(s, fonts_get_system_font(font), GRect(0, 0, w, 200),
                                               GTextOverflowModeWordWrap, GTextAlignmentLeft).h;
}

// The width of s on one line.
static int16_t text_w(const char *s, const char *font) {
  return graphics_text_layout_get_content_size(s, fonts_get_system_font(font), GRect(0, 0, 400, 60),
                                               GTextOverflowModeWordWrap, GTextAlignmentLeft).w;
}

// Type sizes: Gothic 24 Bold is the smallest for anything read as words;
// 18 Bold only for short labels in capitals (chip()). An answer's name is
// in Gothic 36 Bold, which the firmware has but the SDK doesn't list
// (fonts_get_system_font falls back to Gothic 14 without it, so init
// checks it really is bigger than 28: s_have_36).
#define FONT_36 "RESOURCE_ID_GOTHIC_36_BOLD"
static bool s_have_36;

// Whether a big line fits w pixels on one line in Gothic 36 (else 28).
static bool big_fits(const char *s, int16_t w) {
  return s_have_36 && text_w(s, FONT_36) <= w;
}

#define CHIP_H 24

// A short label in capitals in a rounded box at (x, y), CHIP_H high:
// filled in c with the text in ink, or outlined in c with the text in c.
// Returns its width.
static int chip(GContext *ctx, const char *s, int x, int y, bool filled, GColor c, GColor ink) {
  int w = text_w(s, FONT_KEY_GOTHIC_18_BOLD) + 12;
  GRect box = GRect(x, y, w, CHIP_H);
  if (filled) {
    graphics_context_set_fill_color(ctx, c);
    graphics_fill_rect(ctx, box, 6, GCornersAll);
  } else {
    graphics_context_set_stroke_color(ctx, c);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_round_rect(ctx, GRect(x + 1, y + 1, w - 2, CHIP_H - 2), 6);
    graphics_context_set_stroke_width(ctx, 1);
  }
  text(ctx, s, FONT_KEY_GOTHIC_18_BOLD, GRect(x, y, w, CHIP_H), filled ? ink : c, GTextAlignmentCenter);
  return w;
}

// A list row's box: filled in accent when selected, else outlined in line,
// so rows never run into each other.
static void row_box(GContext *ctx, GRect row, bool sel, Palette p) {
  if (sel) {
    graphics_context_set_fill_color(ctx, p.accent);
    graphics_fill_rect(ctx, row, 8, GCornersAll);
  } else {
    graphics_context_set_stroke_color(ctx, p.line);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_round_rect(ctx, GRect(row.origin.x + 1, row.origin.y + 1, row.size.w - 2, row.size.h - 2), 8);
    graphics_context_set_stroke_width(ctx, 1);
  }
}

// A screen's title, at the top.
static void title(GContext *ctx, const char *s, GColor c) {
  text(ctx, s, FONT_KEY_GOTHIC_24_BOLD, GRect(0, 0, 200, 28), c, GTextAlignmentCenter);
}

static void fill_path(GContext *ctx, GPoint *pts, int n) {
  GPath path = { .num_points = (uint32_t)n, .points = pts, .rotation = 0, .offset = GPointZero };
  gpath_draw_filled(ctx, &path);
}

// Icon shapes are drawn in units from their centre, ICON_U units to the radius,
// scaled to the icon's radius and rounded to the nearest pixel (half away
// from zero), so a shape that is symmetric in units stays symmetric in
// pixels at every size.
enum { ICON_U = 24, ICON_SHAPE_MAX = 32 };

static int icon_round(int v, int r) {
  int d = 2 * v * r;
  return (d >= 0 ? d + ICON_U : d - ICON_U) / (2 * ICON_U);
}

static GPoint icon_pt(GPoint c, int x, int y, int r) {
  return GPoint(c.x + icon_round(x, r), c.y + icon_round(y, r));
}

// A dot v units across, at least a pixel.
static void icon_dot(GContext *ctx, GPoint c, int x, int y, int v, int r) {
  int d = icon_round(v, r);
  graphics_fill_circle(ctx, icon_pt(c, x, y, r), (uint16_t)(d > 1 ? d : 1));
}

// The pixels from one corner to the other, both included (so -x to x is
// symmetric about the centre pixel).
static GRect icon_rect(GPoint c, int x0, int y0, int x1, int y1, int r) {
  GPoint a = icon_pt(c, x0, y0, r), b = icon_pt(c, x1, y1, r);
  return GRect(a.x, a.y, b.x - a.x + 1, b.y - a.y + 1);
}

// Plane silhouette, nose up.
static const int8_t PLANE[][2] = {
  { 0, -24 }, { 4, -18 }, { 4, -6 }, { 24, 6 }, { 24, 10 }, { 4, 4 }, { 4, 16 }, { 10, 22 }, { 10, 24 },
  { 0, 22 }, { -10, 24 }, { -10, 22 }, { -4, 16 }, { -4, 4 }, { -24, 10 }, { -24, 6 }, { -4, -6 }, { -4, -18 }
};

// A five-pointed star, its inner points at 0.48 of the outer (plumper than
// a pentagram, so the points keep their shape when small), centred on its
// box rather than on the circle it was drawn in.
static const int8_t STAR[][2] = {
  { 0, -22 }, { 7, -7 }, { 23, -5 }, { 11, 6 }, { 14, 22 }, { 0, 14 }, { -14, 22 }, { -11, 6 }, { -23, -5 }, { -7, -7 }
};

// A cog with eight teeth, one straight up.
static const int8_t COG[][2] = {
  { -5, -16 }, { -4, -24 }, { 4, -24 }, { 5, -16 }, { 8, -15 }, { 14, -19 }, { 19, -14 }, { 15, -8 },
  { 16, -5 }, { 24, -4 }, { 24, 4 }, { 16, 5 }, { 15, 8 }, { 19, 14 }, { 14, 19 }, { 8, 15 },
  { 5, 16 }, { 4, 24 }, { -4, 24 }, { -5, 16 }, { -8, 15 }, { -14, 19 }, { -19, 14 }, { -15, 8 },
  { -16, 5 }, { -24, 4 }, { -24, -4 }, { -16, -5 }, { -15, -8 }, { -19, -14 }, { -14, -19 }, { -8, -15 }
};

enum { ICON_ANY, ICON_PLANE, ICON_SAT, ICON_PLANET, ICON_STAR, ICON_MOON, ICON_CONST, ICON_SUN, ICON_FIND,
       ICON_SETTINGS, ICON_NOTHING };

static int icon_for_layer(int layer) {
  static const int8_t map[RUNG_COUNT] = { ICON_ANY, ICON_PLANE, ICON_SAT, ICON_PLANET, ICON_STAR, ICON_FIND,
                                          ICON_SETTINGS };
  return map[layer];
}

static int icon_for_type(int type) {
  switch (type) {
    case T_PLANE: return ICON_PLANE;
    case T_SAT: return ICON_SAT;
    case T_PLANET: return ICON_PLANET;
    case T_MOON: return ICON_MOON;
    case T_STAR: return ICON_STAR;
    case T_CONST: return ICON_CONST;
    case T_CHART: return ICON_CONST;
    case T_SUN: return ICON_SUN;
    default: return ICON_NOTHING;
  }
}

// A filled shape from a table of points in units, outlined too: the fill
// alone leaves out some edge pixels, which thins the points of small stars
// unevenly.
#define SHAPE_N(shape) ((int)(sizeof(shape) / sizeof((shape)[0])))

static void icon_shape(GContext *ctx, const int8_t (*shape)[2], int n, GPoint c, int r) {
  GPoint pts[ICON_SHAPE_MAX];
  if (n > ICON_SHAPE_MAX) n = ICON_SHAPE_MAX;
  for (int i = 0; i < n; i++) pts[i] = icon_pt(c, shape[i][0], shape[i][1], r);
  GPath path = { .num_points = (uint32_t)n, .points = pts, .rotation = 0, .offset = GPointZero };
  gpath_draw_filled(ctx, &path);
  graphics_context_set_stroke_width(ctx, 1);
  gpath_draw_outline(ctx, &path);
}

// A four-pointed twinkle centred at (x, y) units, s units to its points.
static void icon_twinkle(GContext *ctx, GPoint c, int x, int y, int s, int r) {
  int k = s / 4;
  const int8_t shape[8][2] = {
    { (int8_t)x, (int8_t)(y - s) }, { (int8_t)(x + k), (int8_t)(y - k) }, { (int8_t)(x + s), (int8_t)y },
    { (int8_t)(x + k), (int8_t)(y + k) }, { (int8_t)x, (int8_t)(y + s) }, { (int8_t)(x - k), (int8_t)(y + k) },
    { (int8_t)(x - s), (int8_t)y }, { (int8_t)(x - k), (int8_t)(y - k) }
  };
  icon_shape(ctx, shape, SHAPE_N(shape), c, r);
}

// One icon centred on c, about 2r across, in colour fg on background bg.
static void draw_icon(GContext *ctx, int icon, GPoint c, int r, GColor fg, GColor bg) {
  graphics_context_set_fill_color(ctx, fg);
  graphics_context_set_stroke_color(ctx, fg);
  graphics_context_set_stroke_width(ctx, r >= 16 ? 3 : 2);
  switch (icon) {
    case ICON_PLANE:
      icon_shape(ctx, PLANE, SHAPE_N(PLANE), c, r);
      break;
    case ICON_SAT: {
      // A box between two big solar panels, each split into four, on a mast
      // with a dish on top.
      graphics_context_set_stroke_width(ctx, 1);
      graphics_draw_line(ctx, icon_pt(c, -10, 4, r), icon_pt(c, 10, 4, r));     // the booms
      graphics_draw_line(ctx, icon_pt(c, 0, -2, r), icon_pt(c, 0, -12, r));     // the mast
      icon_dot(ctx, c, 0, -14, 4, r);
      graphics_fill_rect(ctx, icon_rect(c, -5, -3, 5, 11, r), 0, GCornerNone);  // the box
      graphics_fill_rect(ctx, icon_rect(c, -24, -6, -9, 14, r), 0, GCornerNone);
      graphics_fill_rect(ctx, icon_rect(c, 9, -6, 24, 14, r), 0, GCornerNone);
      graphics_context_set_stroke_color(ctx, bg);
      for (int s = -1; s <= 1; s += 2) {
        graphics_draw_line(ctx, icon_pt(c, s * 9, 4, r), icon_pt(c, s * 24, 4, r));
        graphics_draw_line(ctx, icon_pt(c, s * 16, -6, r), icon_pt(c, s * 16, 14, r));
      }
      break;
    }
    case ICON_PLANET: {
      graphics_fill_circle(ctx, c, r * 55 / 100);
      // A tilted ring: an ellipse 1 x 0.3, rotated by -20 degrees.
      GPoint prev = GPointZero;
      for (int i = 0; i <= 24; i++) {
        int32_t a = TRIG_MAX_ANGLE * i / 24;
        int32_t ex = r * cos_lookup(a) / TRIG_MAX_RATIO;
        int32_t ey = r * 3 * sin_lookup(a) / TRIG_MAX_RATIO / 10;
        int32_t rot = -TRIG_MAX_ANGLE * 20 / 360;
        GPoint p = GPoint(c.x + (ex * cos_lookup(rot) - ey * sin_lookup(rot)) / TRIG_MAX_RATIO,
                          c.y + (ex * sin_lookup(rot) + ey * cos_lookup(rot)) / TRIG_MAX_RATIO);
        if (i) graphics_draw_line(ctx, prev, p);
        prev = p;
      }
      break;
    }
    case ICON_STAR:
      icon_shape(ctx, STAR, SHAPE_N(STAR), c, r);
      break;
    case ICON_MOON:
      graphics_fill_circle(ctx, c, r * 8 / 10);
      graphics_context_set_fill_color(ctx, bg);
      graphics_fill_circle(ctx, GPoint(c.x + r * 4 / 10, c.y - r * 2 / 10), r * 7 / 10);
      break;
    case ICON_CONST: {
      static const int8_t P[4][2] = { { -20, 12 }, { -6, -4 }, { 8, 4 }, { 20, -16 } };
      GPoint pts[4];
      for (int i = 0; i < 4; i++) pts[i] = icon_pt(c, P[i][0], P[i][1], r);
      graphics_context_set_stroke_width(ctx, 1);
      for (int i = 0; i < 3; i++) graphics_draw_line(ctx, pts[i], pts[i + 1]);
      for (int i = 0; i < 4; i++) graphics_fill_circle(ctx, pts[i], r >= 16 ? 4 : 2);
      break;
    }
    case ICON_SUN:
      graphics_fill_circle(ctx, c, r * 45 / 100);
      for (int i = 0; i < 8; i++) {
        int32_t a = TRIG_MAX_ANGLE * i / 8;
        graphics_draw_line(ctx,
                           GPoint(c.x + r * 65 / 100 * cos_lookup(a) / TRIG_MAX_RATIO,
                                  c.y + r * 65 / 100 * sin_lookup(a) / TRIG_MAX_RATIO),
                           GPoint(c.x + r * cos_lookup(a) / TRIG_MAX_RATIO,
                                  c.y + r * sin_lookup(a) / TRIG_MAX_RATIO));
      }
      break;
    case ICON_FIND:   // crosshairs
      graphics_draw_circle(ctx, c, r * 7 / 10);
      graphics_draw_line(ctx, GPoint(c.x - r, c.y), GPoint(c.x - r * 4 / 10, c.y));
      graphics_draw_line(ctx, GPoint(c.x + r * 4 / 10, c.y), GPoint(c.x + r, c.y));
      graphics_draw_line(ctx, GPoint(c.x, c.y - r), GPoint(c.x, c.y - r * 4 / 10));
      graphics_draw_line(ctx, GPoint(c.x, c.y + r * 4 / 10), GPoint(c.x, c.y + r));
      graphics_fill_circle(ctx, c, r >= 16 ? 3 : 2);
      break;
    case ICON_SETTINGS: {
      icon_shape(ctx, COG, SHAPE_N(COG), c, r);
      int hole = icon_round(7, r);
      graphics_context_set_fill_color(ctx, bg);
      graphics_fill_circle(ctx, c, (uint16_t)(hole > 1 ? hole : 1));
      break;
    }
    case ICON_ANY:   // twinkles: whatever is up there
      icon_twinkle(ctx, c, -5, 4, 19, r);
      icon_twinkle(ctx, c, 13, -11, 10, r);
      icon_dot(ctx, c, 15, 15, 3, r);
      break;
    default:   // nothing there: a question mark
      graphics_draw_circle(ctx, c, r - 1);
      text(ctx, "?", r >= 16 ? FONT_KEY_GOTHIC_28_BOLD : FONT_KEY_GOTHIC_24_BOLD,
           GRect(c.x - r, c.y - (r >= 16 ? 19 : 16), 2 * r, 2 * r + 8), fg, GTextAlignmentCenter);
      break;
  }
  // Some icons cut shapes out in bg: leave the context as it came in fg.
  graphics_context_set_fill_color(ctx, fg);
  graphics_context_set_stroke_color(ctx, fg);
  graphics_context_set_stroke_width(ctx, 1);
}

// The layer an aim is for: on the Settings rung (an aim again from a tune's
// results, say), ANYTHING.
static uint8_t sky_layer(void) {
  return s_layer == RUNG_SETTINGS ? L_ANY : s_layer;
}

static bool layer_on(int l) {
  return l == RUNG_SETTINGS || ((s_layers >> l) & 1);
}

// The sky ladder down the right edge, beside the buttons: the rung you're
// on, big, by SELECT (which aims with it), and the rungs UP and DOWN go to
// beside those buttons. The ladder goes round (UP from the top is the
// bottom); two dots above and below say there are more rungs than shown.
#define RAIL_X      170
#define RAIL_MID    114     // the SELECT button
#define RAIL_STEP   70      // to the rungs beside UP and DOWN
#define RAIL_CUR_R  27      // the disc of the rung you're on ...
#define RAIL_CUR_IC 18      // ... and its icon
#define RAIL_NB_R   13      // the icons of the rungs either side

// A press slides the ladder one rung (UP moves it down, so the rung above
// comes to SELECT) over SLIDE_MS, easing out, a frame every SLIDE_FRAME_MS:
// about six redraws a press, and none once it stops.
#define SLIDE_MS       180
#define SLIDE_FRAME_MS 30
#define SLIDE_TEXT     16      // pixels the name and status slide in from
static int8_t s_slide_dir;     // +1 up the ladder, -1 down, 0 still
static int s_slide_from;       // rungs to go at the press, in thousandths
static uint64_t s_slide_start;
static AppTimer *s_slide_timer;

// How far the slide has left to go, in thousandths of a rung (1000 at a
// press, more for a press before the last slide ended, 0 when still).
static int slide_left(void) {
  if (!s_slide_dir) return 0;
  uint64_t t = now_ms() - s_slide_start;
  if (t >= SLIDE_MS) return 0;
  int rest = 1000 - (int)t * 1000 / SLIDE_MS;
  return s_slide_from * rest / 1000 * rest / 1000;   // easing out
}

static void slide_cb(void *ctx) {
  s_slide_timer = NULL;
  if (s_screen != SCR_HOME) {   // left Home mid-slide: nothing to move
    s_slide_dir = 0;
    return;
  }
  if (slide_left() != 0) {
    s_slide_timer = app_timer_register(SLIDE_FRAME_MS, slide_cb, NULL);
  } else {
    s_slide_dir = 0;
  }
  layer_mark_dirty(s_canvas);
}

static void slide_start(int dir) {
  // Carry on from where the last slide had got to, so nothing jumps (up
  // to two rungs, which the ladder below draws).
  s_slide_from = 1000 + dir * s_slide_dir * slide_left();
  if (s_slide_from > 2000) s_slide_from = 2000;
  s_slide_dir = (int8_t)dir;
  s_slide_start = now_ms();
  if (!s_slide_timer) s_slide_timer = app_timer_register(SLIDE_FRAME_MS, slide_cb, NULL);
  layer_mark_dirty(s_canvas);
}

// The line between two rungs, from y0 down to y1, kept clear of the disc.
static void rail_line(GContext *ctx, int y0, int y1) {
  int top = RAIL_MID - RAIL_CUR_R - 5, bottom = RAIL_MID + RAIL_CUR_R + 5;
  if (y1 > top && y0 < bottom) {   // they overlap: draw what's outside it
    if (y0 < top) graphics_draw_line(ctx, GPoint(RAIL_X, y0), GPoint(RAIL_X, top));
    if (y1 > bottom) graphics_draw_line(ctx, GPoint(RAIL_X, bottom), GPoint(RAIL_X, y1));
  } else if (y0 < y1) {
    graphics_draw_line(ctx, GPoint(RAIL_X, y0), GPoint(RAIL_X, y1));
  }
}

// left: slide_left() for this frame.
static void draw_ladder(GContext *ctx, Palette p, int left) {
  int rungs[RUNG_COUNT], n = 0, at = 0;
  for (int i = 0; i < RUNG_COUNT; i++) {
    int l = RUNG_ORDER[i];
    if (!layer_on(l)) continue;
    if (l == s_layer) at = n;
    rungs[n++] = l;
  }
  if (n == 0) return;
  graphics_context_set_fill_color(ctx, p.dim);
  if (n > 3) {
    for (int i = 0; i < 2; i++) {
      int d = RAIL_STEP + RAIL_NB_R + 6 + 6 * i;
      graphics_fill_circle(ctx, GPoint(RAIL_X, RAIL_MID - d), 2);
      graphics_fill_circle(ctx, GPoint(RAIL_X, RAIL_MID + d), 2);
    }
  }
  // Rung k steps up the ladder from the one you're on, part way back to
  // where it was before the press while sliding; the disc stays by SELECT
  // and the icons slide through it, growing as they near it.
  int reach = n < 2 ? 0 : left ? 3 : 1;
  int ys[7], rs[7];
  for (int k = -reach; k <= reach; k++) {
    int pos = k * 1000 + s_slide_dir * left;
    int a = pos < 0 ? -pos : pos;
    rs[k + 3] = a >= 1000 ? RAIL_NB_R : RAIL_CUR_IC - (RAIL_CUR_IC - RAIL_NB_R) * a / 1000;
    ys[k + 3] = RAIL_MID - pos * RAIL_STEP / 1000;
  }
  graphics_context_set_stroke_color(ctx, p.dim);
  for (int k = -reach; k < reach; k++) {
    rail_line(ctx, ys[k + 4] + rs[k + 4] + 5, ys[k + 3] - rs[k + 3] - 5);
  }
  graphics_context_set_fill_color(ctx, p.accent);
  graphics_fill_circle(ctx, GPoint(RAIL_X, RAIL_MID), RAIL_CUR_R);
  for (int k = -reach; k <= reach; k++) {
    int y = ys[k + 3], r = rs[k + 3];
    int off = y > RAIL_MID ? y - RAIL_MID : RAIL_MID - y;
    if (off >= RAIL_CUR_R + r + 2) {   // clear of the disc: over the dots, not through them
      graphics_context_set_fill_color(ctx, p.bg);
      graphics_fill_circle(ctx, GPoint(RAIL_X, y), (uint16_t)(r + 2));
    }
    // Lit once it's mostly on the disc; its cut-outs take the colour of
    // what's under its middle.
    bool lit = 2 * off < RAIL_CUR_R;
    draw_icon(ctx, icon_for_layer(rungs[((at + k) % n + n) % n]), GPoint(RAIL_X, y), r, lit ? p.bg : p.dim,
              off < RAIL_CUR_R ? p.accent : p.bg);
  }
}

static const char *home_status(void) {
  if (s_layer == RUNG_SETTINGS) return "Sky, gear, theme";
  if (!connection_service_peek_pebble_app_connection()) return "Phone not connected";
  if (!s_have_status) return "Getting ready...";
  return s_status[s_layer][0] ? s_status[s_layer] : "";
}

// Left of the ladder: the rung's name and its status, level with the disc,
// and the hint at the bottom.
#define HOME_X 8
#define HOME_W (RAIL_X - RAIL_CUR_R - 6 - HOME_X)

static void draw_home(GContext *ctx, Palette p) {
  int left = slide_left();
  draw_ladder(ctx, p, left);
  const char *name = LAYER_NAMES[s_layer];
  const char *font = FONT_KEY_GOTHIC_28_BOLD;
  int hn = text_h(name, font, HOME_W);
  if (hn > 40) {   // too wide for one line
    font = FONT_KEY_GOTHIC_24_BOLD;
    hn = text_h(name, font, HOME_W);
  }
  const char *st = home_status();
  int hs = st[0] ? text_h(st, FONT_KEY_GOTHIC_24_BOLD, HOME_W) : 0;
  const char *hint = s_layer == L_FIND ? "Tap to choose" : s_layer == RUNG_SETTINGS ? "Tap to open" : "Tap to aim";
  int hh = text_h(hint, FONT_KEY_GOTHIC_24_BOLD, HOME_W);
  int hint_y = 228 - 6 - hh;
  // Level with the disc (Gothic sits a few pixels low in its box), but
  // clear of the hint.
  int y = RAIL_MID - (hn + hs) / 2 - 4;
  y -= s_slide_dir * (left < 1000 ? left : 1000) * SLIDE_TEXT / 1000;   // in from the way the ladder moves
  if (y > hint_y - hn - hs) y = hint_y - hn - hs;
  if (y < 4) y = 4;
  text(ctx, name, font, GRect(HOME_X, y, HOME_W, hn + 4), p.fg, GTextAlignmentLeft);
  bool trouble = s_layer != RUNG_SETTINGS &&
                 (!connection_service_peek_pebble_app_connection() || s_cal != CompassStatusCalibrated);
  text(ctx, st, FONT_KEY_GOTHIC_24_BOLD, GRect(HOME_X, y + hn, HOME_W, hs + 4), trouble ? p.accent : p.fg,
       GTextAlignmentLeft);
  text(ctx, hint, FONT_KEY_GOTHIC_24_BOLD, GRect(HOME_X, hint_y, HOME_W, hh + 4), p.dim, GTextAlignmentLeft);
}

static void draw_aim(GContext *ctx, Palette p) {
  title(ctx, s_tune ? "TUNE MY AIM" : LAYER_NAMES[sky_layer()], p.dim);
  GPoint c = GPoint(100, 96);
  graphics_context_set_stroke_color(ctx, p.dim);
  graphics_context_set_stroke_width(ctx, 3);
  graphics_draw_circle(ctx, c, 44);
  if (s_phase == AIM_RECORD) {
    uint32_t done = (uint32_t)(now_ms() - s_record_ms);
    if (done > RECORD_MS) done = RECORD_MS;
    graphics_context_set_fill_color(ctx, p.accent);
    graphics_fill_radial(ctx, GRect(c.x - 46, c.y - 46, 92, 92), GOvalScaleModeFitCircle, 8, 0,
                         (int32_t)(TRIG_MAX_ANGLE * done / RECORD_MS));
  }
  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_fill_color(ctx, p.fg);
  graphics_fill_circle(ctx, c, 6);
  const char *big = s_phase == AIM_MOVE ? "POINT" : "HOLD STILL";
  const char *small = s_phase == AIM_MOVE ? "with your finger" :
                      s_phase == AIM_SETTLE ? "keep it steady" : "wait for the tick";
  text(ctx, big, FONT_KEY_GOTHIC_28_BOLD, GRect(0, 150, 200, 34), p.fg, GTextAlignmentCenter);
  text(ctx, small, FONT_KEY_GOTHIC_24_BOLD, GRect(0, 184, 200, 30), p.dim, GTextAlignmentCenter);
}

// The chart (chart.js has the format, with byte offsets X_OFF, Y_OFF): on
// a chart card under its title, or on the first answer's own page under
// its name and over its caption.
#define CHART_X        4
#define CHART_Y        62
#define CHART_W        192
#define CHART_H        140
#define CHART_INLINE_Y 80
#define CHART_INLINE_H 118       // index.js CHART_INLINE_H
#define CHART_X_OFF    32
#define CHART_Y_OFF    58
#define CAPTION_Y      198       // a chart's caption, or the Moon's phase
#define PICTURE_Y      80        // a planet's photo or the Moon, from here down
// A plane's first answer: its name, its route (or type), its chart, then
// how high and far and how fast and which way, a line each.
#define ROUTE_Y        80
#define PLANE_CHART_Y  106
#define PLANE_CHART_H  70        // index.js PLANE_CHART_H
#define PLANE_LINE_Y   172
enum { CHART_TAG_AIM = 1, CHART_TAG_ARROW, CHART_TAG_CAPTION, CHART_TAG_CRAFT, CHART_TAG_ROUTE, CHART_TAG_RIVAL,
       CHART_TAG_DIR };
// The way you face at a chart's middle (chart.js TAG.DIR), for its ground.
static const char *const DIR_WORDS[8] = { "NORTH", "NORTHEAST", "EAST", "SOUTHEAST", "SOUTH", "SOUTHWEST", "WEST",
                                          "NORTHWEST" };

// chart.js's wire format. A plane's chart also has its shape (craft: a
// CRAFT_DATA shape, at point 0, nose from point craft_ab[0] to [1]) and
// its route's airports (route: from, to, and how far along, of 255).
// dir: which way the chart faces (DIR_WORDS), if it has a horizon.
typedef struct {
  const uint8_t *pts, *segs, *hz;
  int n, m, h;
  bool aim, arrow, rival, route, has_dir;
  uint8_t aim_at[2], arrow_ab[2], craft, craft_ab[2], route_share, dir;
  char caption[32], from[5], to[5];
} Chart;

// A short text from b (len bytes, then the text) into out (cap bytes);
// the bytes it took, or 0 if it runs past end.
static int chart_text(const uint8_t *b, const uint8_t *end, char *out, int cap) {
  if (b >= end || b + 1 + b[0] > end) return 0;
  int n = b[0] < cap - 1 ? b[0] : cap - 1;
  memcpy(out, b + 1, (size_t)n);
  out[n] = '\0';
  return 1 + b[0];
}

// Reads s_chart; false if it's malformed or missing.
static bool chart_parse(Chart *c) {
  const uint8_t *b = s_chart;
  int len = s_chart_len, k = 0;
  memset(c, 0, sizeof(*c));
  if (len < 3) return false;
  c->n = b[k++];
  if (k + 3 * c->n + 1 > len) return false;
  c->pts = b + k;
  k += 3 * c->n;
  c->m = b[k++];
  if (k + 2 * c->m + 1 > len) return false;
  c->segs = b + k;
  k += 2 * c->m;
  c->h = b[k++];
  if (k + 2 * c->h > len) return false;
  c->hz = b + k;
  k += 2 * c->h;
  const uint8_t *end = b + len;
  while (k < len) {
    uint8_t tag = b[k++];
    int used = 0;
    if ((tag == CHART_TAG_AIM || tag == CHART_TAG_ARROW) && k + 2 <= len) {
      memcpy(tag == CHART_TAG_AIM ? c->aim_at : c->arrow_ab, b + k, 2);
      if (tag == CHART_TAG_AIM) c->aim = true;
      else c->arrow = b[k] < c->n && b[k + 1] < c->n;
      used = 2;
    } else if (tag == CHART_TAG_CAPTION || tag == CHART_TAG_RIVAL) {
      used = chart_text(b + k, end, c->caption, sizeof(c->caption));
      c->rival = tag == CHART_TAG_RIVAL;
    } else if (tag == CHART_TAG_CRAFT && k + 3 <= len) {
      if (c->n > 0 && b[k + 1] < c->n && b[k + 2] < c->n && b[k + 1] != b[k + 2]) {
        c->craft = b[k];
        memcpy(c->craft_ab, b + k + 1, 2);
      }
      used = 3;
    } else if (tag == CHART_TAG_ROUTE && k + 1 < len) {
      int a = chart_text(b + k + 1, end, c->from, sizeof(c->from));
      int z = a ? chart_text(b + k + 1 + a, end, c->to, sizeof(c->to)) : 0;
      if (z) {
        c->route = true;
        c->route_share = b[k];
        used = 1 + a + z;
      }
    } else if (tag == CHART_TAG_DIR && k + 1 <= len) {
      c->has_dir = b[k] < 8;
      c->dir = b[k];
      used = 1;
    }
    if (!used) break;
    k += used;
  }
  return true;
}

static GPoint chart_point(const uint8_t *b, int y0) {
  return GPoint(CHART_X + b[0] - CHART_X_OFF, y0 + b[1] - CHART_Y_OFF);
}

static void draw_arrow(GContext *ctx, GPoint c, double ux, double uy, int len, int width, GColor col);

// Where the user pointed: crosshairs, or at the chart's edge an arrow the
// way it is, when it's off the chart.
static void draw_aim_mark(GContext *ctx, Palette p, const Chart *c, int y0, int h) {
  int x = CHART_X + c->aim_at[0] - CHART_X_OFF, y = y0 + c->aim_at[1] - CHART_Y_OFF;
  if (x >= CHART_X && x < CHART_X + CHART_W && y >= y0 && y < y0 + h) {
    // Outlined in the background colour, so it stands apart from the
    // figure's lines.
    for (int pass = 0; pass < 2; pass++) {
      graphics_context_set_stroke_color(ctx, pass ? p.fg : p.bg);
      graphics_context_set_stroke_width(ctx, pass ? 3 : 7);
      graphics_draw_line(ctx, GPoint(x - 13, y), GPoint(x - 5, y));
      graphics_draw_line(ctx, GPoint(x + 5, y), GPoint(x + 13, y));
      graphics_draw_line(ctx, GPoint(x, y - 13), GPoint(x, y - 5));
      graphics_draw_line(ctx, GPoint(x, y + 5), GPoint(x, y + 13));
    }
    graphics_context_set_stroke_width(ctx, 1);
    return;
  }
  double cx = CHART_X + CHART_W / 2.0, cy = y0 + h / 2.0, dx = x - cx, dy = y - cy;
  double d = sky_sqrt(dx * dx + dy * dy);
  if (d < 1) return;
  // Pulled in to just inside the edge, along the line from the middle.
  double kx = (CHART_W / 2.0 - 10) / (dx < 0 ? -dx : dx), ky = (h / 2.0 - 10) / (dy < 0 ? -dy : dy);
  double k = dx == 0 ? ky : dy == 0 ? kx : kx < ky ? kx : ky;
  double ux = dx / d, uy = dy / d;
  GPoint tip = GPoint((int16_t)(cx + dx * k), (int16_t)(cy + dy * k));
  draw_arrow(ctx, GPoint(tip.x - (int)(ux * 14), tip.y - (int)(uy * 14)), ux, uy, 8, 3, p.fg);
}

// ---------------------------------------------------------------- aircraft

// The aircraft shapes (resources/data/craft.bin, made by
// tools/make_craft.py): a count, each shape's offset (u16), then the
// shapes. A shape: its part count, then parts: CRAFT_MIRROR {n, n x (x,
// y)} the right half of an outline from nose to tail (mirrored for the
// left), CRAFT_PAIR {n, n x (x, y)} a right-hand piece and its mirror (an
// engine), CRAFT_RING {x, y, r} a circle's outline (a rotor). Units are
// signed bytes, CRAFT_UNITS nose to tail, y toward the tail.
enum { CRAFT_MIRROR, CRAFT_PAIR, CRAFT_RING };
#define CRAFT_UNITS     120
#define CRAFT_PTS_MAX   24
#define CRAFT_BYTES_MAX 160
#define CRAFT_LEN       44        // pixels nose to tail on a plane's chart

// A shape's point (x, y) on the screen. (ax, ay): the nose's way, scaled
// by pixels a unit, times 1024. Right of the nose is (-ay, ax) on the
// screen; the tail is -(ax, ay).
static GPoint craft_point(GPoint c, int x, int y, int32_t ax, int32_t ay) {
  return GPoint((int16_t)(c.x + ((-x * ay - y * ax + 512) >> 10)), (int16_t)(c.y + ((x * ax - y * ay + 512) >> 10)));
}

// Shape `kind` (CRAFT in planes.js) at c, its nose along (ux, uy), len
// pixels long, filled in col and edged in bg so it stands off the lines
// under it. False if there's no such shape.
static bool draw_craft(GContext *ctx, uint8_t kind, GPoint c, double ux, double uy, int len, GColor col,
                       GColor bg) {
  ResHandle h = resource_get_handle(RESOURCE_ID_CRAFT_DATA);
  size_t size = resource_size(h);
  uint8_t head[3];
  if (!kind || resource_load_byte_range(h, 0, head, 1) != 1 || kind > head[0]) return false;
  if (resource_load_byte_range(h, 1 + 2 * (kind - 1), head + 1, 2) != 2) return false;
  size_t at = rd_u16(head + 1), stop = size;
  if (kind < head[0] && resource_load_byte_range(h, 1 + 2 * kind, head + 1, 2) == 2) stop = rd_u16(head + 1);
  uint8_t b[CRAFT_BYTES_MAX];
  int n = (int)(stop - at);
  if (stop <= at || n > CRAFT_BYTES_MAX || resource_load_byte_range(h, at, b, (size_t)n) != (size_t)n) return false;
  int32_t ax = (int32_t)(ux * len * 1024 / CRAFT_UNITS), ay = (int32_t)(uy * len * 1024 / CRAFT_UNITS);
  GPoint pts[CRAFT_PTS_MAX];
  for (int pass = 0; pass < 2; pass++) {
    // The edge first, all round, then the fill over it.
    graphics_context_set_fill_color(ctx, col);
    graphics_context_set_stroke_color(ctx, pass ? col : bg);
    graphics_context_set_stroke_width(ctx, pass ? 1 : 3);
    for (int part = 0, i = 1; part < b[0] && i < n; part++) {
      uint8_t type = b[i++];
      if (type == CRAFT_RING && i + 3 <= n) {
        GPoint q = craft_point(c, (int8_t)b[i], (int8_t)b[i + 1], ax, ay);
        graphics_draw_circle(ctx, q, (uint16_t)((b[i + 2] * len + CRAFT_UNITS / 2) / CRAFT_UNITS));
        i += 3;
        continue;
      }
      int m = i < n ? b[i++] : 0;
      bool mirror = type == CRAFT_MIRROR;
      if (m < 2 || i + 2 * m > n || (mirror ? 2 * m - 2 : m) > CRAFT_PTS_MAX) break;
      for (int side = 0; side < (type == CRAFT_PAIR ? 2 : 1); side++) {
        int np = 0, sx = side ? -1 : 1;
        for (int j = 0; j < m; j++) {
          pts[np++] = craft_point(c, sx * (int8_t)b[i + 2 * j], (int8_t)b[i + 2 * j + 1], ax, ay);
        }
        for (int j = m - 2; mirror && j >= 1; j--) {
          pts[np++] = craft_point(c, -(int8_t)b[i + 2 * j], (int8_t)b[i + 2 * j + 1], ax, ay);
        }
        GPath path = { .num_points = (uint32_t)np, .points = pts, .rotation = 0, .offset = GPointZero };
        if (pass) gpath_draw_filled(ctx, &path);
        else gpath_draw_outline(ctx, &path);
      }
      i += 2 * m;
    }
  }
  graphics_context_set_stroke_width(ctx, 1);
  return true;
}

// A plane's nose on its chart: the way along its path at point 0.
static bool craft_way(const Chart *c, int y0, double *ux, double *uy) {
  if (!c->craft) return false;
  GPoint a = chart_point(c->pts + 3 * c->craft_ab[0], y0), z = chart_point(c->pts + 3 * c->craft_ab[1], y0);
  double dx = z.x - a.x, dy = z.y - a.y, d = sky_sqrt(dx * dx + dy * dy);
  if (d < 1) return false;
  *ux = dx / d;
  *uy = dy / d;
  return true;
}

// One star, planet or path dot; the answer circled.
static void draw_chart_point(GContext *ctx, Palette p, const uint8_t *q, int y0) {
  GPoint at = chart_point(q, y0);
  uint8_t info = q[2];
  int r = 1 + (info & 3);
  graphics_context_set_fill_color(ctx, (info & 8) ? p.accent : p.fg);
  graphics_fill_circle(ctx, at, (uint16_t)r);
  if (info & 4) {
    graphics_context_set_stroke_color(ctx, p.accent);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_circle(ctx, at, (uint16_t)(r + 6));
    graphics_context_set_stroke_width(ctx, 1);
  }
}

// The horizon's height at x: between its points (left to right), level
// past its ends.
static int horizon_y(const Chart *c, int y0, int x) {
  GPoint a = chart_point(c->hz, y0);
  if (x <= a.x) return a.y;
  for (int i = 1; i < c->h; i++) {
    GPoint b = chart_point(c->hz + 2 * i, y0);
    if (x <= b.x) return b.x == a.x ? b.y : a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
    a = b;
  }
  return a.y;
}

// The ground below the horizon, filled, edged and named for the way it
// faces (when there's room for the word).
#define GROUND_WORD_H  22
#define HZ_MAX         5         // chart.js horizonLine sends at most this many points
static void draw_ground(GContext *ctx, Palette p, const Chart *c, int y0, int h) {
  if (c->h < 2) return;
  // The horizon left to right, level out to the screen's edges, then the
  // chart's bottom.
  GPoint poly[HZ_MAX + 4];
  int n = 0, last = c->h < HZ_MAX ? c->h : HZ_MAX;
  poly[n++] = GPoint(0, chart_point(c->hz, y0).y);
  for (int i = 0; i < last; i++) poly[n++] = chart_point(c->hz + 2 * i, y0);
  int right = poly[n - 1].y;
  poly[n++] = GPoint(199, right);
  poly[n++] = GPoint(199, y0 + h - 1);
  poly[n++] = GPoint(0, y0 + h - 1);
  graphics_context_set_fill_color(ctx, p.ground);
  fill_path(ctx, poly, n);
  graphics_context_set_stroke_color(ctx, p.dim);
  graphics_context_set_stroke_width(ctx, 2);
  for (int i = 1; i < c->h; i++) {
    graphics_draw_line(ctx, chart_point(c->hz + 2 * (i - 1), y0), chart_point(c->hz + 2 * i, y0));
  }
  graphics_context_set_stroke_width(ctx, 1);
  int y = horizon_y(c, y0, CHART_X + CHART_W / 2);
  if (c->has_dir && y >= y0 && y0 + h - y >= GROUND_WORD_H) {
    text(ctx, DIR_WORDS[c->dir], FONT_KEY_GOTHIC_18_BOLD, GRect(CHART_X, y + 1, CHART_W, GROUND_WORD_H), p.fg,
         GTextAlignmentCenter);
  }
}

// The stick figure as it stands in the sky (up is up), the answer circled
// (or a satellite's or plane's path, with its arrowhead, a plane drawn as
// its shape), the ground, and where the user pointed.
static void draw_chart(GContext *ctx, Palette p, const Chart *c, int y0, int h) {
  draw_ground(ctx, p, c, y0, h);
  graphics_context_set_stroke_color(ctx, p.dim);
  graphics_context_set_stroke_width(ctx, 2);
  for (int i = 0; i < c->m; i++) {
    int a = c->segs[2 * i], b = c->segs[2 * i + 1];
    if (a < c->n && b < c->n) graphics_draw_line(ctx, chart_point(c->pts + 3 * a, y0), chart_point(c->pts + 3 * b, y0));
  }
  graphics_context_set_stroke_width(ctx, 1);
  if (c->arrow) {
    GPoint a = chart_point(c->pts + 3 * c->arrow_ab[0], y0), b = chart_point(c->pts + 3 * c->arrow_ab[1], y0);
    double dx = b.x - a.x, dy = b.y - a.y, d = sky_sqrt(dx * dx + dy * dy);
    if (d >= 1) {
      double ux = dx / d, uy = dy / d;
      GPoint head[3] = { GPoint(b.x + (int)(ux * 15), b.y + (int)(uy * 15)),
                         GPoint(b.x + (int)(ux * 4 - uy * 6), b.y + (int)(uy * 4 + ux * 6)),
                         GPoint(b.x + (int)(ux * 4 + uy * 6), b.y + (int)(uy * 4 - ux * 6)) };
      graphics_context_set_fill_color(ctx, p.accent);
      fill_path(ctx, head, 3);
    }
  }
  // Under the stars, so the answer's circle stays whole.
  if (c->aim) draw_aim_mark(ctx, p, c, y0, h);
  // A plane's shape goes over its path's dots, in place of its own.
  double ux = 0, uy = -1;
  bool craft = craft_way(c, y0, &ux, &uy);
  for (int i = craft ? 1 : 0; i < c->n; i++) draw_chart_point(ctx, p, c->pts + 3 * i, y0);
  if (craft && !draw_craft(ctx, c->craft, chart_point(c->pts, y0), ux, uy, CRAFT_LEN, p.fg, p.bg)) {
    draw_chart_point(ctx, p, c->pts, y0);
  }
}

// ---------------------------------------------------------------- pictures

// The planets' photos and the Moon's (tools/make_art.py), by the names the
// phone and offline.c give them.
static const char *const PLANET_NAMES[] = { "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune" };

static uint32_t planet_res(const char *name) {
  static const uint32_t res[] = { RESOURCE_ID_PLANET_MERCURY, RESOURCE_ID_PLANET_VENUS, RESOURCE_ID_PLANET_MARS,
                                  RESOURCE_ID_PLANET_JUPITER, RESOURCE_ID_PLANET_SATURN, RESOURCE_ID_PLANET_URANUS,
                                  RESOURCE_ID_PLANET_NEPTUNE };
  for (unsigned i = 0; i < sizeof(res) / sizeof(res[0]); i++) {
    if (strcmp(name, PLANET_NAMES[i]) == 0) return res[i];
  }
  return 0;
}

// One picture at a time on the heap: the one on screen, as the theme and
// (for the Moon) its lighting need it.
static GBitmap *s_art;
static uint32_t s_art_res;
static bool s_art_red;
static uint8_t s_art_look[2];

static void art_free(void) {
  if (s_art) gbitmap_destroy(s_art);
  s_art = NULL;
  s_art_res = 0;
}

static int palette_bits(GBitmapFormat f) {
  return f == GBitmapFormat1BitPalette ? 1 : f == GBitmapFormat2BitPalette ? 2 : f == GBitmapFormat4BitPalette ? 4 : 0;
}

// Stargazer: each colour becomes the red as bright as it (make_art.py red_for).
static GColor red_of(GColor c) {
  int r = (c.argb >> 4) & 3, g = (c.argb >> 2) & 3, b = c.argb & 3;
  int level = ((r * 299 + g * 587 + b * 114) * 85 / 1000 + 42) / 85;
  return (GColor){ .argb = (uint8_t)((c.argb & 0xC0) | (level << 4)) };
}

// The Moon's unlit part becomes transparent: look[0] percent lit, its lit
// side toward look[1] x 2 degrees clockwise from up. Lit where the
// distance u along the lit side passes the terminator, an ellipse
// u = k w with k = 1 - 2 lit and w the disc's half-width across.
static void moon_phase(GBitmap *bmp, int bits, const GColor *pal, const uint8_t *look) {
  int clear = -1;
  for (int i = 0; i < (1 << bits); i++) {
    if (!(pal[i].argb >> 6)) clear = i;
  }
  if (clear < 0 || look[0] >= 100) return;
  GRect bounds = gbitmap_get_bounds(bmp);
  int w = bounds.size.w, h = bounds.size.h, r = (w < h ? w : h);   // the radius, in half pixels
  int32_t a = TRIG_MAX_ANGLE * (look[1] * 2) / 360;
  int32_t ux = sin_lookup(a), uy = -cos_lookup(a);   // the lit side, screen y down, x 65535
  int32_t k = 256 - 512 * (look[0] > 100 ? 100 : look[0]) / 100;   // x 256
  uint8_t *data = gbitmap_get_data(bmp);
  int stride = gbitmap_get_bytes_per_row(bmp), per = 8 / bits, mask = (1 << bits) - 1;
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      int64_t dx = 2 * x + 1 - w, dy = 2 * y + 1 - h;
      int64_t u = (dx * ux + dy * uy) / 65536, v = (-dx * uy + dy * ux) / 65536;
      int64_t w2 = (int64_t)r * r - v * v;
      if (w2 < 0) w2 = 0;
      int64_t uu = u * 256 * u * 256, kw = (int64_t)k * k * w2;
      bool dark = k >= 0 ? (u < 0 || uu <= kw) : (u < 0 && uu >= kw);
      if (!dark) continue;
      uint8_t *at = data + y * stride + x / per;
      int shift = 8 - bits * (x % per + 1);
      *at = (uint8_t)((*at & ~(mask << shift)) | (clear << shift));
    }
  }
}

// The picture for res (look: the Moon's, else NULL), loaded if it isn't
// already; NULL if it can't be.
static GBitmap *art(uint32_t res, const uint8_t *look) {
  bool red = stargazer();
  if (s_art && s_art_res == res && s_art_red == red && (!look || memcmp(look, s_art_look, 2) == 0)) return s_art;
  art_free();
  GBitmap *b = gbitmap_create_with_resource(res);
  if (!b) return NULL;
  int bits = palette_bits(gbitmap_get_format(b));
  GColor *pal = gbitmap_get_palette(b);
  if (bits && pal) {
    if (look) moon_phase(b, bits, pal, look);
    if (red) {
      for (int i = 0; i < (1 << bits); i++) {
        if (pal[i].argb >> 6) pal[i] = red_of(pal[i]);
      }
    }
  }
  s_art = b;
  s_art_res = res;
  s_art_red = red;
  if (look) memcpy(s_art_look, look, 2);
  return b;
}

// A picture centred in the box; by day on a black window, as it would be
// seen at night. ring: the whole disc's edge, faint, so a thin Moon still
// shows its circle.
static void draw_picture(GContext *ctx, Palette p, GBitmap *b, GRect box, bool ring) {
  if (theme_now() == THEME_DAY) {
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, box, 10, GCornersAll);
  }
  GRect bb = gbitmap_get_bounds(b);
  GRect at = GRect(box.origin.x + (box.size.w - bb.size.w) / 2, box.origin.y + (box.size.h - bb.size.h) / 2,
                   bb.size.w, bb.size.h);
  if (ring) {
    graphics_context_set_stroke_color(ctx, p.line);
    graphics_draw_circle(ctx, GPoint(at.origin.x + bb.size.w / 2, at.origin.y + bb.size.h / 2),
                         (uint16_t)(bb.size.w / 2));
  }
  graphics_context_set_compositing_mode(ctx, GCompOpSet);
  graphics_draw_bitmap_in_rect(ctx, b, at);
  graphics_context_set_compositing_mode(ctx, GCompOpAssign);
}

// Answers and their pages: an answer card is followed by its own chart and
// fact cards (index.js addExtras), so the cards fall into groups, one an
// answer. UP and DOWN go from one answer to the next (and round), and
// through an answer's pages in turn.
static bool is_page(int i) {
  return s_cards[i].type == T_CHART || s_cards[i].type == T_FACT;
}

static int group_start(int i) {
  while (i > 0 && is_page(i)) i--;
  return i;
}

static int group_len(int start) {
  int n = 1;
  while (start + n < s_ncards && is_page(start + n)) n++;
  return n;
}

// Which answer the group at start is (from 0), and how many there are.
static int group_index(int start) {
  int k = 0;
  for (int i = 1; i <= start && i < s_ncards; i++) {
    if (!is_page(i)) k++;
  }
  return k;
}

// The first answer: after a Sun warning, the card after it.
static int first_answer(void) {
  return s_ncards > 1 && s_cards[0].type == T_SUN ? 1 : 0;
}

static int group_count(void) {
  return s_ncards ? group_index(s_ncards - 1) + 1 : 0;
}

// An arrow from c, len pixels the way (ux, uy) points (screen y runs down),
// with a head.
static void draw_arrow(GContext *ctx, GPoint c, double ux, double uy, int len, int width, GColor col) {
  GPoint tip = GPoint(c.x + (int)(ux * len), c.y + (int)(uy * len));
  graphics_context_set_stroke_color(ctx, col);
  graphics_context_set_stroke_width(ctx, width);
  graphics_draw_line(ctx, c, tip);
  int hl = width + 3, hw = width * 2;
  GPoint head[3] = { GPoint(tip.x + (int)(ux * hl), tip.y + (int)(uy * hl)),
                     GPoint(tip.x - (int)(uy * hw), tip.y + (int)(ux * hw)),
                     GPoint(tip.x + (int)(uy * hw), tip.y - (int)(ux * hw)) };
  graphics_context_set_fill_color(ctx, col);
  fill_path(ctx, head, 3);
  graphics_context_set_stroke_width(ctx, 1);
}

// The way a hint says to move ("Higher and left", "A bit to the right",
// off_hint_words and matcher.js), or a plane or satellite is going ("480
// mph, moving up-right", matcher.js motionHint): an arrow beside it.
// False for none.
// Where w first is in s, or NULL (strstr would bring 860 bytes of libc).
static const char *find_in(const char *s, const char *w) {
  for (; *s; s++) {
    const char *a = s, *b = w;
    while (*b && *a == *b) {
      a++;
      b++;
    }
    if (!*b) return s;
  }
  return NULL;
}

static bool hint_way(const char *h, double *ux, double *uy) {
  int dx = find_in(h, "left") ? -1 : find_in(h, "right") ? 1 : 0;
  int dy = find_in(h, "igher") || find_in(h, " up") ? -1 : find_in(h, "ower") || find_in(h, "down") ? 1 : 0;
  if (!dx && !dy) return false;
  double k = dx && dy ? 0.7071 : 1;
  *ux = dx * k;
  *uy = dy * k;
  return true;
}

// The band across the top: what it is, how sure ("THAT'S IT",
// "PROBABLY", "MAYBE"), and this answer's pages as dots (or NO PHONE, for
// the watch's own answers, which have no pages). The first answer's band
// is filled, the others' outlined: UP and DOWN go to them.
static void draw_result_head(GContext *ctx, Palette p, int start, int icon_type) {
  bool first = start == 0;
  GRect band = GRect(2, 2, 196, 34);
  GColor ink = first ? p.bg : p.fg;
  if (first) {
    graphics_context_set_fill_color(ctx, p.accent);
    graphics_fill_rect(ctx, band, 8, GCornersAll);
  } else {
    graphics_context_set_stroke_color(ctx, p.line);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_round_rect(ctx, GRect(3, 3, 194, 32), 8);
    graphics_context_set_stroke_width(ctx, 1);
  }
  draw_icon(ctx, icon_for_type(icon_type), GPoint(21, 19), 12, ink, first ? p.accent : p.bg);
  int right = 196;   // where the dots or the chip start
  int len = group_len(start);
  if (len > 1) {
    for (int i = 0; i < len; i++) {
      bool on = start + i == s_card;
      graphics_context_set_fill_color(ctx, ink);
      graphics_fill_circle(ctx, GPoint(186 - (len - 1 - i) * 16, 19), on ? 5 : 2);
    }
    right = 186 - (len - 1) * 16 - 8;
  } else if (s_offline_shown) {
    int w = text_w("NO PHONE", FONT_KEY_GOTHIC_18_BOLD) + 12;
    chip(ctx, "NO PHONE", 192 - w, 7, false, ink, ink);
    right = 192 - w;
  }
  uint8_t word = s_cards[start].word;
  if (word > 0 && word < 4) {
    // The answers after the first are what else it might be: "or MAYBE".
    char said[16];
    snprintf(said, sizeof(said), "%s%s", start > first_answer() ? "or " : "", WORDS[word]);
    // Smaller beside NO PHONE, where the big one doesn't fit.
    bool big = 40 + text_w(said, FONT_KEY_GOTHIC_24_BOLD) <= right - 4;
    text(ctx, said, big ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD, GRect(40, big ? 2 : 6, right - 40, 30),
         ink, GTextAlignmentLeft);
  }
}

// An answer arriving: a ring closes in on its icon, easing out, like a
// sight locking on.
static void draw_reveal(GContext *ctx, Palette p) {
  if (!s_reveal_start) return;
  uint64_t t = now_ms() - s_reveal_start;
#if defined(SKY_SHOT) && SKY_SHOT == 36
  t = 110;   // harness: hold the ring part way in
#endif
  if (t >= REVEAL_MS) return;
  int rest = REVEAL_MS - (int)t;
  int r = 15 + 220 * rest / REVEAL_MS * rest / REVEAL_MS;
  graphics_context_set_stroke_color(ctx, p.accent);
  graphics_context_set_stroke_width(ctx, 3);
  graphics_draw_circle(ctx, GPoint(21, 19), (uint16_t)r);
  graphics_context_set_stroke_width(ctx, 1);
}

// The first answer's own page shows a picture when it has one (index.js
// addExtras): its chart (R_CHART with no chart card after it), a planet's
// photo, the Moon as it's lit now; else the fact, when it fits under the
// name (place_fact). Other answers are words: what, where, and which way.
enum { VIS_NONE, VIS_CHART, VIS_PHOTO, VIS_MOON, VIS_FACT };

static bool chart_here(void) {
  if (!s_chart_len || s_ncards == 0) return false;
  uint8_t t = s_cards[0].type;
  if (t != T_STAR && t != T_CONST && t != T_NOTHING && t != T_SAT && t != T_PLANE) return false;
  for (int i = 1; i < group_len(0); i++) {
    if (s_cards[i].type == T_CHART) return false;
  }
  return true;
}

static int answer_visual(int i) {
  if (i != 0 || s_ncards == 0) return VIS_NONE;
  const Card *c = &s_cards[0];
  if (chart_here()) return VIS_CHART;
  if (c->type == T_PLANET && planet_res(c->l1)) return VIS_PHOTO;
  if (c->type == T_MOON && s_have_moon_look) return VIS_MOON;
  if (s_fact_inline) return VIS_FACT;
  return VIS_NONE;
}

// An answer's name over a picture: one line, as big as fits.
static void draw_name_line(GContext *ctx, Palette p, const char *s) {
  int size = big_fits(s, 192) ? 36 : text_w(s, FONT_KEY_GOTHIC_28_BOLD) <= 192 ? 28 : 24;
  const char *font = size == 36 ? FONT_36 : size == 28 ? FONT_KEY_GOTHIC_28_BOLD : FONT_KEY_GOTHIC_24_BOLD;
  // Gothic sits low in its box: up a little, more for the bigger font.
  int lift = size == 36 ? 6 : size == 28 ? 2 : 0;
  graphics_context_set_text_color(ctx, p.fg);
  graphics_draw_text(ctx, s, fonts_get_system_font(font), GRect(4, 40 - lift, 192, 42),
                     GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
}

// An answer's name, big, wrapping if it must; returns the y under it.
static int draw_name(GContext *ctx, Palette p, const Card *c, int y) {
  bool big = big_fits(c->l1, 192);
  const char *font = big ? FONT_36 : FONT_KEY_GOTHIC_28_BOLD;
  int h = text_h(c->l1, font, 192);
  int lift = big ? 6 : 4;
  text(ctx, c->l1, font, GRect(4, y - lift, 192, h + 4), c->type == T_SUN ? p.warn : p.fg, GTextAlignmentLeft);
  return y + h - lift + 2;
}

// One line of text, cut short with "..." if it's too long.
static void text_line_al(GContext *ctx, const char *s, GRect box, GColor c, GTextAlignment al) {
  graphics_context_set_text_color(ctx, c);
  graphics_draw_text(ctx, s, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD), box, GTextOverflowModeTrailingEllipsis,
                     al, NULL);
}

static void text_line(GContext *ctx, const char *s, GRect box, GColor c) {
  text_line_al(ctx, s, box, c, GTextAlignmentLeft);
}

// A hint with its arrow (which way to look, or which way it's going) at
// y. One line only: "480 mph, moving right"
// keeps its speed when the words don't fit beside the arrow.
static int draw_hint(GContext *ctx, Palette p, const char *hint, int y, bool one_line) {
  double ux, uy;
  int x = 4;
  if (hint_way(hint, &ux, &uy)) {
    draw_arrow(ctx, GPoint(16 - (int)(ux * 9), y + 14 - (int)(uy * 9)), ux, uy, 10, 3, p.fg);
    x = 34;
  }
  char cut[32];
  const char *comma = find_in(hint, ", ");
  if (one_line && comma && text_w(hint, FONT_KEY_GOTHIC_24_BOLD) > 196 - x) {
    int n = comma - hint < (int)sizeof(cut) - 1 ? comma - hint : (int)sizeof(cut) - 1;
    memcpy(cut, hint, (size_t)n);
    cut[n] = '\0';
    hint = cut;
  }
  int h = one_line ? 28 : text_h(hint, FONT_KEY_GOTHIC_24_BOLD, 196 - x) + 4;
  text(ctx, hint, FONT_KEY_GOTHIC_24_BOLD, GRect(x, y - 2, 196 - x, h), p.fg, GTextAlignmentLeft);
  return y - 2 + (h > 30 ? h : 30);
}

// A plane's route between its airports' codes, how far along it is
// filled in.
static void draw_route(GContext *ctx, Palette p, const Chart *ch, int y) {
  int wa = chip(ctx, ch->from, 4, y, false, p.dim, p.bg);
  int wz = text_w(ch->to, FONT_KEY_GOTHIC_18_BOLD) + 12;
  chip(ctx, ch->to, 196 - wz, y, false, p.dim, p.bg);
  int x0 = 4 + wa + 6, x1 = 196 - wz - 6, my = y + CHIP_H / 2;
  if (x1 - x0 < 10) return;
  int xs = x0 + (x1 - x0) * ch->route_share / 255;
  graphics_context_set_stroke_width(ctx, 3);
  graphics_context_set_stroke_color(ctx, p.line);
  graphics_draw_line(ctx, GPoint(x0, my), GPoint(x1, my));
  graphics_context_set_stroke_color(ctx, p.accent);
  graphics_draw_line(ctx, GPoint(x0, my), GPoint(xs, my));
  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_fill_color(ctx, p.accent);
  graphics_fill_circle(ctx, GPoint(xs, my), 5);
}

// The last line of an answer's last page, when there's room (the page's
// own lines end at or above FOOTER_Y): on the first answer's, what else
// it might be ("or Vega, Sheliak", below); on the last page of all, how
// to aim again.
#define FOOTER_Y       198
#define FOOTER_W       170       // "or ..." beside its arrow

// What the footer says on this page (out, cap bytes); false for none.
// is_or: it's the "or ..." line (the answers after the first, by name).
static bool footer_text(char *out, int cap, bool *is_or) {
  int fa = first_answer(), first = fa + group_len(fa);   // the first answer's pages end before `first`
  *is_or = false;
  if (s_tune || s_card != group_start(s_card) + group_len(group_start(s_card)) - 1) return false;
  if (s_card == first - 1 && s_ncards > first) {
    *is_or = true;
    int n = 0;
    const char *names[2] = { NULL, NULL };
    for (int i = first; i < s_ncards; i++) {
      if (is_page(i)) continue;
      if (n < 2) names[n] = s_cards[i].l1;
      n++;
    }
    if (n == 0) return false;
    snprintf(out, cap, n == 2 ? "or %s, %s" : "or %s", names[0], names[1]);
    if (n > 2 || text_w(out, FONT_KEY_GOTHIC_24_BOLD) > FOOTER_W) {
      snprintf(out, cap, "or %s and %d more", names[0], n - 1);
    }
    if (n > 1 && text_w(out, FONT_KEY_GOTHIC_24_BOLD) > FOOTER_W) snprintf(out, cap, "%d more answers", n);
    return true;
  }
  if (s_card != s_ncards - 1) return false;
  snprintf(out, cap, "Tap to point again");
  return true;
}

// The footer, if this page has one and its lines end by FOOTER_Y (bottom).
static void draw_footer(GContext *ctx, Palette p, int bottom) {
  char line[64];
  bool is_or;
  if (bottom > FOOTER_Y || !footer_text(line, sizeof(line), &is_or)) return;
  if (!is_or) {
    text(ctx, line, FONT_KEY_GOTHIC_24_BOLD, GRect(4, FOOTER_Y, 192, 30), p.dim, GTextAlignmentLeft);
    return;
  }
  // An arrow down: the way to them.
  GPoint tri[3] = { GPoint(5, FOOTER_Y + 11), GPoint(19, FOOTER_Y + 11), GPoint(12, FOOTER_Y + 19) };
  graphics_context_set_fill_color(ctx, p.accent);
  fill_path(ctx, tri, 3);
  text_line(ctx, line, GRect(24, FOOTER_Y, 200 - 24 - 2, 30), p.accent);
}

static void draw_results(GContext *ctx, Palette p) {
  if (s_ncards == 0) return;
  Card *c = &s_cards[s_card];
  int start = group_start(s_card);
  int y = 40, w = 192;
  int vis = answer_visual(s_card);
  Chart ch;
  if ((c->type == T_CHART || vis == VIS_CHART) && chart_parse(&ch)) {
    bool here = vis == VIS_CHART, plane = here && c->type == T_PLANE;
    int y0 = plane ? PLANE_CHART_Y : here ? CHART_INLINE_Y : CHART_Y;
    int h = plane ? PLANE_CHART_H : here ? CHART_INLINE_H : CHART_H;
    // The figure's lines can run off the chart: the band, the name and the
    // caption go on top.
    draw_chart(ctx, p, &ch, y0, h);
    graphics_context_set_fill_color(ctx, p.bg);
    graphics_fill_rect(ctx, GRect(0, 0, 200, here ? y0 - 2 : 38), 0, GCornerNone);
    if (plane) graphics_fill_rect(ctx, GRect(0, y0 + h, 200, 228 - y0 - h), 0, GCornerNone);
    else if (here && ch.caption[0]) graphics_fill_rect(ctx, GRect(0, CAPTION_Y + 4, 200, 24), 0, GCornerNone);
    draw_result_head(ctx, p, start, s_cards[start].type);
    // What else it might be stands out from a plain caption.
    GColor cap = ch.rival ? p.accent : p.dim;
    if (plane) {
      draw_name_line(ctx, p, c->l1);
      if (ch.route) draw_route(ctx, p, &ch, ROUTE_Y);
      else text_line(ctx, c->l2, GRect(4, ROUTE_Y - 6, w, 30), p.dim);
      text_line(ctx, ch.caption[0] ? ch.caption : c->l3, GRect(4, PLANE_LINE_Y, w, 30), ch.caption[0] ? cap : p.dim);
      if (c->hint[0]) draw_hint(ctx, p, c->hint, PLANE_LINE_Y + 26, true);
    } else if (here) {
      draw_name_line(ctx, p, c->l1);
      text(ctx, ch.caption, FONT_KEY_GOTHIC_24_BOLD, GRect(4, CAPTION_Y, w, 30), cap, GTextAlignmentLeft);
      if (!ch.caption[0]) draw_footer(ctx, p, y0 + h);
    } else {
      text(ctx, c->l1, FONT_KEY_GOTHIC_24_BOLD, GRect(4, 34, w, 28), p.fg, GTextAlignmentLeft);
      text(ctx, c->l2, FONT_KEY_GOTHIC_24_BOLD, GRect(4, 198, w, 30), p.dim, GTextAlignmentLeft);
    }
    return;
  }
  if (vis == VIS_CHART) vis = VIS_NONE;   // a chart that can't be read: the words
  // A chart or fact page shows the icon of the answer it's about.
  draw_result_head(ctx, p, start, s_cards[start].type);
  if (c->type == T_CHART) return;
  if (c->type == T_FACT) {
    // "Did you know?" gives way to a fact that needs the room; so does the
    // footer.
    int h = text_h(s_fact, FONT_KEY_GOTHIC_24_BOLD, w);
    char line[64];
    bool is_or;
    int end = footer_text(line, sizeof(line), &is_or) && y - 2 + h <= FOOTER_Y ? FOOTER_Y : 228;
    if (h <= end - 66) {
      text(ctx, "Did you know?", FONT_KEY_GOTHIC_24_BOLD, GRect(4, 34, w, 28), p.accent, GTextAlignmentLeft);
      y = 64;
    }
    text(ctx, s_fact, FONT_KEY_GOTHIC_24_BOLD, GRect(4, y - 2, w, 228 - y + 2), p.fg, GTextAlignmentLeft);
    draw_footer(ctx, p, y - 2 + h);
    return;
  }
  if (vis == VIS_PHOTO || vis == VIS_MOON) {
    bool moon = vis == VIS_MOON;
    GBitmap *b = art(moon ? RESOURCE_ID_MOON : planet_res(c->l1), moon ? s_moon_look : NULL);
    if (b) {
      draw_name_line(ctx, p, c->l1);
      int bottom = moon ? CAPTION_Y : 226;
      draw_picture(ctx, p, b, GRect(4, PICTURE_Y, 192, bottom - PICTURE_Y), moon);
      if (moon) text(ctx, c->l2, FONT_KEY_GOTHIC_24_BOLD, GRect(4, CAPTION_Y, w, 30), p.dim, GTextAlignmentLeft);
      // Which way to look, as the hint's arrow in the corner (a disc
      // leaves the corners clear).
      double ux, uy;
      if (hint_way(c->hint, &ux, &uy)) {
        GPoint at = GPoint(22 - (int)(ux * 9), bottom - 20 - (int)(uy * 9));
        draw_arrow(ctx, at, ux, uy, 10, 3, theme_now() == THEME_DAY ? GColorWhite : p.fg);
      }
      return;
    }
  }
  y = draw_name(ctx, p, c, y);
  if (vis == VIS_FACT) {
    if (c->l2[0]) {
      int h = text_h(c->l2, FONT_KEY_GOTHIC_24_BOLD, w);
      text(ctx, c->l2, FONT_KEY_GOTHIC_24_BOLD, GRect(4, y - 2, w, h + 4), p.dim, GTextAlignmentLeft);
      y += h;
    }
    text(ctx, s_fact, FONT_KEY_GOTHIC_24_BOLD, GRect(4, y + 2, w, 228 - y - 2), p.fg, GTextAlignmentLeft);
    draw_footer(ctx, p, y + 2 + text_h(s_fact, FONT_KEY_GOTHIC_24_BOLD, w));
    return;
  }
  // Too much for the screen (a long name on two lines, say): the third
  // line goes.
  int rest = (c->l2[0] ? text_h(c->l2, FONT_KEY_GOTHIC_24_BOLD, w) : 0) +
             (c->l3[0] ? text_h(c->l3, FONT_KEY_GOTHIC_24_BOLD, w) : 0) + 6 +
             (c->hint[0] ? text_h(c->hint, FONT_KEY_GOTHIC_24_BOLD, 162) : 0);
  bool drop3 = y + rest > 226;
  const char *more[2] = { c->l2, drop3 ? "" : c->l3 };
  for (int i = 0; i < 2; i++) {
    if (!more[i][0]) continue;
    int h = text_h(more[i], FONT_KEY_GOTHIC_24_BOLD, w);
    text(ctx, more[i], FONT_KEY_GOTHIC_24_BOLD, GRect(4, y - 2, w, h + 4), p.dim, GTextAlignmentLeft);
    y += h;
  }
  y += 6;
  if (c->hint[0]) y = draw_hint(ctx, p, c->hint, y, false);
  draw_footer(ctx, p, y);
}

// Two big words, centred, one under the other (Gothic 36 if they fit).
static void big_words(GContext *ctx, const char *a, const char *b, int y, GColor c) {
  const char *f = big_fits(a, 200) && big_fits(b, 200) ? FONT_36 : FONT_KEY_GOTHIC_28_BOLD;
  text(ctx, a, f, GRect(0, y, 200, 44), c, GTextAlignmentCenter);
  text(ctx, b, f, GRect(0, y + 34, 200, 44), c, GTextAlignmentCenter);
}

// While the phone works, something moves (motion_cb redraws), so it's
// plainly working. After an aim: a moon going round a planet, CHECKING
// THE CHARTS. Opening Find it: a line sweeping the sky, SCANNING THE SKY.
#define WAIT_TURN_MS 2400
#define ORBIT_Y      62
static void draw_wait(GContext *ctx, Palette p) {
  int32_t a = (int32_t)((uint32_t)now_ms() % WAIT_TURN_MS) * TRIG_MAX_ANGLE / WAIT_TURN_MS;   // 32-bit: no 64-bit division linked
#ifdef SKY_SHOT
  a = TRIG_MAX_ANGLE * 5 / 8;   // the same picture every time
#endif
  int32_t sn = sin_lookup(a), cs = cos_lookup(a);
  if (s_wait_list) {
    graphics_context_set_stroke_color(ctx, p.line);
    graphics_context_set_stroke_width(ctx, 3);
    graphics_draw_arc(ctx, GRect(28, 14, 144, 144), GOvalScaleModeFitCircle, -TRIG_MAX_ANGLE / 4, TRIG_MAX_ANGLE / 4);
    graphics_context_set_fill_color(ctx, p.ground);
    graphics_fill_rect(ctx, GRect(12, 85, 176, 4), 0, GCornerNone);
    // The sweep swings across and back, east to west.
    int32_t sw = sn * (TRIG_MAX_ANGLE / 4) / TRIG_MAX_RATIO;
    GPoint tip = GPoint(100 + 66 * sin_lookup(sw) / TRIG_MAX_RATIO, 86 - 66 * cos_lookup(sw) / TRIG_MAX_RATIO);
    graphics_context_set_stroke_color(ctx, p.accent);
    graphics_draw_line(ctx, GPoint(100, 86), tip);
    graphics_context_set_stroke_width(ctx, 1);
    static const GPoint STARS[4] = { { 62, 50 }, { 128, 34 }, { 82, 30 }, { 146, 64 } };
    graphics_context_set_fill_color(ctx, p.fg);
    for (int i = 0; i < 4; i++) graphics_fill_circle(ctx, STARS[i], i == 3 ? 3 : 2);
    big_words(ctx, "SCANNING", "THE SKY", 112, p.fg);
    return;
  }
  // The orbit: dots round a tilted ring, the moon behind the planet on
  // the far side.
  graphics_context_set_fill_color(ctx, p.line);
  for (int i = 0; i < 20; i++) {
    int32_t b = i * TRIG_MAX_ANGLE / 20;
    graphics_fill_circle(ctx, GPoint(100 + 56 * cos_lookup(b) / TRIG_MAX_RATIO,
                                     ORBIT_Y + 16 * sin_lookup(b) / TRIG_MAX_RATIO), 1);
  }
  GPoint moon = GPoint(100 + 56 * cs / TRIG_MAX_RATIO, ORBIT_Y + 16 * sn / TRIG_MAX_RATIO);
  for (int pass = 0; pass < 2; pass++) {
    if ((sn < 0) == (pass == 0)) {
      graphics_context_set_fill_color(ctx, p.fg);
      graphics_fill_circle(ctx, moon, 6);
    }
    if (pass == 0) {
      graphics_context_set_fill_color(ctx, p.accent);
      graphics_fill_circle(ctx, GPoint(100, ORBIT_Y), 16);
    }
  }
  big_words(ctx, "CHECKING", "THE CHARTS", 112, p.fg);
}

// ---------------------------------------------------------------- Find it: drawing

// Where a target goes in the Find it list (find.js rank).
static int see_rank(uint8_t see) {
  return (see & SEE_NEAR_SUN ? 4 : 0) + (see & SEE_HOW);
}

// The Sun flags for something seen as `how` at (az, alt), the Sun at
// (sun_az, sun_alt), all apparent.
static uint8_t sun_flags(int how, double az, double alt, double sun_az, double sun_alt) {
  if (sun_alt <= SUN_UP_ALT) return 0;
  double d = sky_separation(az, alt, sun_az, sun_alt);
  if (d < SUN_EYE_DEG || (d < SUN_AIDED_DEG && how >= SEE_BINOCULARS)) return SEE_NEAR_SUN;
  return d < SUN_AIDED_DEG ? SEE_BLOCK_SUN : 0;
}

// A target's kind, for More: the Moon and planets, constellations, bright
// stars, satellites.
static int kind_of(uint8_t type) {
  return type == T_CONST ? KIND_PATTERN : type == T_STAR ? KIND_STAR : type == T_SAT ? KIND_SAT : KIND_SKY;
}

// With no Best now from the phone (the list made on the watch, or an older
// phone): the first BEST_N, easiest first; with one left over, all of them.
static void mark_best(void) {
  for (int i = 0; i < s_nfind; i++) {
    if (s_find[i].best) return;
  }
  for (int i = 0; i < s_nfind; i++) s_find[i].best = i < BEST_N || s_nfind <= BEST_N + 1;
}

// The rows of the view shown: Best now and More (when there's more), the
// kinds there are, or one kind's targets (Best now's too), in list order.
static void pick_build(void) {
  s_nrows = 0;
  bool more = false;
  for (int k = 0; k < KIND_COUNT && s_pick_view == VIEW_KINDS; k++) {
    for (int i = 0; i < s_nfind; i++) {
      if (kind_of(s_find[i].type) == k) {
        s_rows[s_nrows++] = (int8_t)(ROW_KIND - k);
        break;
      }
    }
  }
  for (int i = 0; i < s_nfind && s_pick_view != VIEW_KINDS; i++) {
    if (s_pick_view == VIEW_BEST ? s_find[i].best : kind_of(s_find[i].type) == s_pick_kind) s_rows[s_nrows++] = (int8_t)i;
    else more = true;
  }
  if (s_pick_view == VIEW_BEST && more) s_rows[s_nrows++] = ROW_MORE;
  if (s_pick_row >= s_nrows) s_pick_row = s_nrows ? s_nrows - 1 : 0;
}

// Shows a view of the list, on its row `row`; on the row of `what` (a
// target, ROW_MORE or a kind) instead, if it's there (ROW_NONE: none).
static void pick_show(uint8_t view, uint8_t kind, int row, int what) {
  s_pick_view = view;
  s_pick_kind = kind;
  s_pick_row = row;
  pick_build();
  for (int r = 0; r < s_nrows && what != ROW_NONE; r++) {
    if (s_rows[r] == what) s_pick_row = r;
  }
  motion_reset();
  layer_mark_dirty(s_canvas);
}

// A Find it target's note under where it is: the Sun first, then how to
// see it. NULL for one you can just see.
static const char *see_note(uint8_t see) {
  static const char *const how[4] = { NULL, "LOOK CLOSELY", "BINOCULARS", "TELESCOPE" };
  if (see & SEE_NEAR_SUN) return "TOO NEAR THE SUN";
  if (see & SEE_BLOCK_SUN) return "BLOCK THE SUN FIRST!";
  return how[see & SEE_HOW];
}

// Two targets on screen: the name, where it is, and how to see it (a
// label, filled in the Sun's colour for the Sun's warnings); More below
// Best now. The kinds (More) are rows as the menu's: three on screen.
#define PICK_SHOWN 2
#define PICK_Y     30
#define PICK_STEP  98
#define PICK_H     94

static const char *const KIND_NAMES[KIND_COUNT] = { "Moon and planets", "Constellations", "Bright stars",
                                                    "Satellites" };

// The list on screen (the menu, Find it's): its first row's top, rows
// `step` apart and `h` high, `n` of them, `shown` fitting on screen.
typedef struct { int16_t y0, step, h, n, shown; } ListGeom;
static bool list_geom(ListGeom *g) {
  bool menu_like = s_screen == SCR_MENU || s_pick_view == VIEW_KINDS;
  if (s_screen != SCR_MENU && s_screen != SCR_PICK) return false;
  *g = menu_like ? (ListGeom){ MENU_Y, MENU_STEP, MENU_H, 0, MENU_SHOWN }
                 : (ListGeom){ PICK_Y, PICK_STEP, PICK_H, 0, PICK_SHOWN };
  g->n = (int16_t)(s_screen == SCR_MENU ? menu_rows() : s_nrows);
  return true;
}

static int *list_sel(void) {
  return s_screen == SCR_MENU ? &s_menu_row : &s_pick_row;
}

// How far the list can scroll: to its last row at the bottom.
static int list_max(const ListGeom *g) {
  return g->n > g->shown ? (g->n - g->shown) * g->step : 0;
}

// The scroll that shows row `sel`, moving as little as it can from `from`.
static int scroll_showing(const ListGeom *g, int sel, int from) {
  int top = sel * g->step, span = (g->shown - 1) * g->step;
  return top < from ? top : top > from + span ? top - span : from;
}

// The scroll to draw at, kept within the list (it can shrink under it).
static int list_scroll(const ListGeom *g) {
  int max = list_max(g);
  if (s_scroll > max) s_scroll = (int16_t)max;
  if (s_scroll_to > max) s_scroll_to = (int16_t)max;
  if (s_scroll < 0) s_scroll = 0;
  if (s_scroll_to < 0) s_scroll_to = 0;
  return s_scroll;
}

// The list's title, over any rows scrolled up under it.
static void list_title(GContext *ctx, const char *s, GColor c, Palette p) {
  graphics_context_set_fill_color(ctx, p.bg);
  graphics_fill_rect(ctx, GRect(0, 0, 200, MENU_Y - 2), 0, GCornerNone);
  title(ctx, s, c);
}

// A name in Gothic 28, or 24 if it's too wide for that.
static void row_name(GContext *ctx, const char *s, int x, int y, int w, GColor c) {
  bool fits = text_w(s, FONT_KEY_GOTHIC_28_BOLD) <= w;
  text(ctx, s, fits ? FONT_KEY_GOTHIC_28_BOLD : FONT_KEY_GOTHIC_24_BOLD, GRect(x, y + (fits ? -2 : 2), w, 34), c,
       GTextAlignmentLeft);
}

// A kind's row under More: how many are up now and how many come up
// later ("1 up now, 2 later": a pass or a moonrise to wait for), or when
// the first of them does ("Next at 4:12 am").
static void kind_line(char *out, int cap, int kind) {
  int up = 0, later = 0;
  int32_t next = 0;
  for (int j = 0; j < s_nfind; j++) {
    if (kind_of(s_find[j].type) != kind) continue;
    int32_t w = find_wait_s(&s_find[j]);
    if (!w) {
      up++;
    } else {
      later++;
      if (!next || w < next) next = w;
    }
  }
  if (!later) {
    snprintf(out, cap, "%d up now", up);
  } else if (up) {
    snprintf(out, cap, "%d up now, %d later", up, later);
  } else {
    time_t at = time(NULL) + next;
    struct tm *tm = localtime(&at);
    if (clock_is_24h_style()) snprintf(out, cap, "Next at %d:%02d", tm->tm_hour, tm->tm_min);
    else snprintf(out, cap, "Next at %d:%02d %s", (tm->tm_hour + 11) % 12 + 1, tm->tm_min, tm->tm_hour < 12 ? "am" : "pm");
  }
}

static void draw_pick(GContext *ctx, Palette p) {
  static const char *const TITLES[KIND_COUNT] = { "MOON AND PLANETS", "CONSTELLATIONS", "BRIGHT STARS",
                                                  "SATELLITES" };
  bool kinds = s_pick_view == VIEW_KINDS;
  ListGeom g;
  list_geom(&g);
  int sc = list_scroll(&g);
  for (int r = 0; r < s_nrows; r++) {
    int ry = g.y0 + r * g.step - sc;
    if (ry + g.h <= g.y0 - 2 || ry >= 228) continue;
    GRect row = GRect(4, ry, 192, g.h);
    bool sel = r == s_pick_row;
    row_box(ctx, row, sel, p);
    GColor c = sel ? p.bg : p.fg, dim = sel ? p.bg : p.dim;
    int x = row.origin.x, y = row.origin.y, i = s_rows[r];
    if (i < 0) {
      // More (how many of the rest can be found), or a kind (how many of
      // it are up, and to come).
      char line[24];
      if (i == ROW_MORE) {
        int n = 0;
        for (int j = 0; j < s_nfind; j++) n += !s_find[j].best && !(s_find[j].see & SEE_NEAR_SUN);
        if (n == 0) strncpy(line, "Too near the Sun", sizeof(line));
        else snprintf(line, sizeof(line), "%d more to find", n);
      } else {
        kind_line(line, sizeof(line), ROW_KIND - i);
      }
      row_name(ctx, i == ROW_MORE ? "More" : KIND_NAMES[ROW_KIND - i], x + 10, y, 176, c);
      text(ctx, line, FONT_KEY_GOTHIC_24_BOLD, GRect(x + 10, y + 28, 176, 30), dim, GTextAlignmentLeft);
      continue;
    }
    FindTarget *t = &s_find[i];
    draw_icon(ctx, icon_for_type(t->type), GPoint(x + 20, y + 19), 12, c, sel ? p.accent : p.bg);
    row_name(ctx, t->name, x + 38, y, 150, c);
    text_line(ctx, t->where, GRect(x + 8, y + 30, 180, 30), dim);   // one line: the label goes under it
    const char *note = see_note(t->see);
    if (note) {
      bool sun = t->see & (SEE_NEAR_SUN | SEE_BLOCK_SUN);
      // The Sun's label is filled; on the chosen row, in the background
      // colour with the Sun's on it (in Stargazer the row and the Sun's
      // colour are the same red).
      if (sun) chip(ctx, note, x + 8, y + 62, true, sel ? p.bg : p.warn, sel ? p.warn : p.bg);
      else chip(ctx, note, x + 8, y + 62, false, c, c);
    }
  }
  list_title(ctx, s_pick_view == VIEW_BEST ? "BEST NOW" : kinds ? "MORE TO FIND" : TITLES[s_pick_kind], p.dim, p);
}

// The tapes. Across the top: the compass, where the top of the watch
// points under the pointer. Up the right: height above the horizon. The
// target is a diamond on each (a chevron at the end, past it); a tape
// that's on fills in.
#define TAPE_PX     2             // pixels per degree
#define HTAPE       GRect(4, 4, 192, 34)
#define VTAPE       GRect(164, 84, 32, 140)

static void draw_diamond(GContext *ctx, GPoint c, int r, GColor col) {
  GPoint pts[4] = { { c.x, c.y - r }, { c.x + r, c.y }, { c.x, c.y + r }, { c.x - r, c.y } };
  graphics_context_set_fill_color(ctx, col);
  fill_path(ctx, pts, 4);
}

// The target on a tape: off is its offset in pixels from the pointer
// (along the tape, right or up +), half the room each way.
static void draw_tape_mark(GContext *ctx, GPoint mid, bool across, int off, int half, GColor col) {
  if (off > -half && off < half) {
    draw_diamond(ctx, across ? GPoint(mid.x + off, mid.y) : GPoint(mid.x, mid.y - off), 7, col);
    return;
  }
  int k = off > 0 ? 1 : -1;
  GPoint pts[3];
  if (across) {
    int x = mid.x + k * (half + 2);
    pts[0] = GPoint(x - k * 10, mid.y - 9); pts[1] = GPoint(x, mid.y); pts[2] = GPoint(x - k * 10, mid.y + 9);
  } else {
    int y = mid.y - k * (half + 2);
    pts[0] = GPoint(mid.x - 9, y + k * 10); pts[1] = GPoint(mid.x, y); pts[2] = GPoint(mid.x + 9, y + k * 10);
  }
  graphics_context_set_fill_color(ctx, col);
  fill_path(ctx, pts, 3);
}

static void draw_tapes(GContext *ctx, Palette p, double az, double alt) {
  static const char *POINTS[8] = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" };
  for (int v = 0; v < 2; v++) {
    bool on = v ? s_fs.level : s_fs.facing;
    GRect r = v ? VTAPE : HTAPE;
    GColor ink = on ? p.bg : p.dim;
    if (on) {
      graphics_context_set_fill_color(ctx, p.accent);
      graphics_fill_rect(ctx, r, 6, GCornersAll);
    } else {
      graphics_context_set_stroke_color(ctx, p.line);
      graphics_context_set_stroke_width(ctx, 2);
      graphics_draw_round_rect(ctx, r, 6);
    }
    graphics_context_set_stroke_color(ctx, ink);
    graphics_context_set_stroke_width(ctx, 2);
    int half = (v ? r.size.h : r.size.w) / 2 - 8;
    double now = v ? alt : az;
    double toff = v ? s_fs.talt - alt : sky_wrap180(s_fs.taz - az);
    int mark = (int)(toff * TAPE_PX);   // the target, from the pointer
    int lo = (int)(now - half / TAPE_PX) / 10 * 10 - 10, hi = (int)(now + half / TAPE_PX) + 10;
    for (int d = lo; d <= hi; d += 10) {
      if (v && (d < -10 || d > 90)) continue;
      int off = (int)((d - now) * TAPE_PX);
      if (off <= -half || off >= half) continue;
      int deg = v ? d : (int)sky_rev(d);
      bool major = v ? deg % 30 == 0 : deg % 90 == 0;
      if (v) {
        int y = r.origin.y + r.size.h / 2 - off;
        graphics_draw_line(ctx, GPoint(r.origin.x + (major ? 22 : 25), y), GPoint(r.origin.x + 30, y));
        // Clear of a chevron at the end.
        if (major && !(mark >= half && off > half - 14) && !(mark <= -half && off < -half + 14)) {
          char n[4];
          snprintf(n, sizeof(n), "%d", deg);
          text(ctx, n, FONT_KEY_GOTHIC_18_BOLD, GRect(r.origin.x, y - 12, 22, 20), ink, GTextAlignmentCenter);
        }
      } else {
        int x = r.origin.x + r.size.w / 2 + off;
        graphics_draw_line(ctx, GPoint(x, major ? 26 : 30), GPoint(x, 36));
      }
    }
    if (!v) {
      // The eight points, where they fit.
      for (int k = 0; k < 8; k++) {
        int off = (int)(sky_wrap180(k * 45 - now) * TAPE_PX);
        if (off > -half + 6 && off < half - 6) {
          text(ctx, POINTS[k], FONT_KEY_GOTHIC_18_BOLD, GRect(100 + off - 16, 3, 32, 22), ink, GTextAlignmentCenter);
        }
      }
    }
    graphics_context_set_stroke_width(ctx, 1);
    GPoint mid = v ? GPoint(r.origin.x + 22, r.origin.y + r.size.h / 2) : GPoint(100, 29);
    draw_tape_mark(ctx, mid, !v, mark, half, on ? p.bg : p.accent);
  }
  // The pointers: where the top of the watch points.
  graphics_context_set_fill_color(ctx, p.fg);
  GPoint top[3] = { { 100, 38 }, { 93, 47 }, { 107, 47 } };
  fill_path(ctx, top, 3);
  GPoint side[3] = { { 164, 154 }, { 155, 147 }, { 155, 161 } };
  fill_path(ctx, side, 3);
}

// "Look straight up" for a target higher than OVERHEAD_ALT, "almost" below.
static const char *look_up(double alt) {
  return alt >= OVERHEAD_ALT ? "Look straight up" : "Look almost straight up";
}

// "Rises in 12 min" (or "in under a minute"), into out.
static void rises_in(char *out, int cap, int32_t wait) {
  if (wait < 60) snprintf(out, cap, "Rises in under a minute");
  else snprintf(out, cap, "Rises in %d min", (int)((wait + 30) / 60));
}

// On it, while you stay on it: its name; "Found it" and an arrow up past
// the top of the watch, or for one high up, "Look up" (you still have to
// find it up there); a pattern's chart, its star circled, once the phone
// has sent it; a pass to come, "Wait here" and when it rises. A tap
// shows its card.
static void draw_found(GContext *ctx, Palette p, FindTarget *t) {
  int32_t wait = find_wait_s(t);
  bool high = s_fs.talt > HIGH_ALT, sun = t->see & SEE_BLOCK_SUN;
  const char *f = wait ? "Wait here" : high ? "Look up" : "Found it";
  Chart ch;
  bool chart = !wait && t->type == T_CONST && s_cards[0].type == T_CONST && chart_here() && chart_parse(&ch);
  if (chart) {
    // The figure's lines can run off the chart: the words go on top.
    draw_chart(ctx, p, &ch, CHART_INLINE_Y, CHART_INLINE_H);
    graphics_context_set_fill_color(ctx, p.bg);
    graphics_fill_rect(ctx, GRect(0, 0, 200, CHART_INLINE_Y - 2), 0, GCornerNone);
    graphics_fill_rect(ctx, GRect(0, CAPTION_Y + 4, 200, 24), 0, GCornerNone);
  }
  // Now you look up: near the Sun, the warning in place of the name.
  text(ctx, sun ? "Block the Sun first!" : t->name, FONT_KEY_GOTHIC_28_BOLD, GRect(0, 2, 200, 34),
       sun ? p.warn : p.dim, GTextAlignmentCenter);
  text(ctx, f, big_fits(f, 200) ? FONT_36 : FONT_KEY_GOTHIC_28_BOLD, GRect(0, 34, 200, 44), p.fg,
       GTextAlignmentCenter);
  const char *bottom = "Tap for more";
  if (chart) {
    bottom = ch.caption;
  } else if (wait) {
    char line[28];
    rises_in(line, sizeof(line), wait);
    text(ctx, line, FONT_KEY_GOTHIC_28_BOLD, GRect(0, 96, 200, 70), p.fg, GTextAlignmentCenter);
    return;
  } else {
    draw_arrow(ctx, GPoint(100, high ? 150 : 186), 0, -1, high ? 56 : 90, 9, p.accent);
    // "straight up" or "almost straight up", under "Look up".
    if (high) text(ctx, look_up(s_fs.talt) + 5, FONT_KEY_GOTHIC_24_BOLD, GRect(0, 152, 200, 30), p.fg,
                   GTextAlignmentCenter);
  }
  text(ctx, bottom, FONT_KEY_GOTHIC_24_BOLD, GRect(0, CAPTION_Y, 200, 30), p.dim, GTextAlignmentCenter);
}

// How to find it, before starting: until a tap or SELECT.
static void draw_find_intro(GContext *ctx, Palette p, FindTarget *t) {
  text(ctx, t->name, FONT_KEY_GOTHIC_28_BOLD, GRect(0, 2, 200, 34), p.fg, GTextAlignmentCenter);
  bool sun = (t->see & SEE_BLOCK_SUN) && !t->start;   // a rise to wait for: when and where first
  text_line_al(ctx, sun ? "Block the Sun first!" : t->where, GRect(0, 32, 200, 30), sun ? p.warn : p.dim,
               GTextAlignmentCenter);
  if (t->start) {
    // A pass to come: the one after it, and what happens.
    text(ctx, t->note, FONT_KEY_GOTHIC_24_BOLD, GRect(0, 58, 200, 30), p.dim, GTextAlignmentCenter);
    text(ctx, t->type == T_MOON ? "Point the top of your watch where it will rise. Then follow it up."
                                : "Point the top of your watch where it will rise. Then follow it across.",
         FONT_KEY_GOTHIC_24_BOLD,
         GRect(6, 92, 188, 104), p.fg, GTextAlignmentLeft);
  } else {
    text(ctx, "Hold your watch as if reading it and point its top at the sky. Turn, then tilt, as the screen says.",
         FONT_KEY_GOTHIC_24_BOLD, GRect(6, 66, 188, 130), p.fg, GTextAlignmentLeft);
  }
  text(ctx, "Tap to start", FONT_KEY_GOTHIC_24_BOLD, GRect(0, 196, 200, 30), p.accent, GTextAlignmentCenter);
}

// "Hold your watch" once it's been needed a moment: not in the instant
// between the tap and the first reading, nor for a wobble while turning
// (it used to flash up as finding started).
static bool hold_prompt(void) {
  if (s_fs.have && s_fs.held) return false;
  uint64_t since = s_fs.have ? s_unheld_at : s_find_start;
  return since && now_ms() - since >= HOLD_PROMPT_MS;
}

static void draw_find(GContext *ctx, Palette p) {
  FindTarget *t = &s_find[s_find_cur];
  if (s_fs.intro) {
    draw_find_intro(ctx, p, t);
    return;
  }
  if (s_fs.found) {
    draw_found(ctx, p, t);
    return;
  }
  const char *big = NULL, *small = NULL;
  if (s_fs.gone) {
    big = "It's gone";
    small = "It set or went dark";
  } else if (s_fs.timeout) {
    big = "Still looking?";
    small = "SELECT: keep going";
  } else if (hold_prompt()) {
    big = "Hold your watch";
    small = "as if reading it, then turn";
  } else if (s_fs.have && s_fs.held && s_fs.too_high) {
    big = s_fs.alt > 0 ? "Tilt down" : "Tilt up";
    small = "a little";
  }
  // Before the first reading, only what it's finding (the tapes need one).
  if (big || !s_fs.have) {
    if (t->see & SEE_BLOCK_SUN) title(ctx, "Block the Sun first!", p.warn);
    else title(ctx, "FIND IT", p.dim);
    text(ctx, t->name, FONT_KEY_GOTHIC_28_BOLD, GRect(0, 24, 200, 34), p.fg, GTextAlignmentCenter);
    text_line_al(ctx, t->where, GRect(0, 54, 200, 30), p.dim, GTextAlignmentCenter);
    if (!big) return;
    text(ctx, big, FONT_KEY_GOTHIC_28_BOLD, GRect(0, 90, 200, 34), p.fg, GTextAlignmentCenter);
    text(ctx, small, FONT_KEY_GOTHIC_24_BOLD, GRect(0, 124, 200, 60), p.dim, GTextAlignmentCenter);
    return;
  }
  // One step at a time: face it, then tilt up to it (or, overhead, look up).
  bool high = s_fs.talt > HIGH_ALT;
  draw_tapes(ctx, p, s_show_az, s_show_alt);
  text(ctx, t->name, FONT_KEY_GOTHIC_28_BOLD, GRect(0, 44, 200, 34), p.fg, GTextAlignmentCenter);
  const char *step = "Hold it";
  double by = 0;
  bool plus = false;   // right or up
  // The way from the latest reading; how far as the tapes show it, gliding.
  if (!s_fs.facing) {
    plus = s_fs.daz > 0;
    step = plus ? "Turn right" : "Turn left";
    by = sky_wrap180(s_fs.taz - s_show_az);
  } else if (!high && !s_fs.level) {
    plus = s_fs.dalt > 0;
    step = plus ? "Tilt up" : "Tilt down";
    by = s_fs.talt - s_show_alt;
  }
  text(ctx, step, FONT_KEY_GOTHIC_28_BOLD, GRect(0, 92, 156, 34), p.fg, GTextAlignmentCenter);
  if (plus ? by >= 0.5 : by <= -0.5) {   // none for "Hold it", nor while gliding past
    char n[8];
    snprintf(n, sizeof(n), "%d\xc2\xb0", (int)(by < 0 ? -by + 0.5 : by + 0.5));
    bool b36 = big_fits(n, 156);
    text(ctx, n, b36 ? FONT_36 : FONT_KEY_GOTHIC_28_BOLD, GRect(0, 124, 156, 44), p.fg, GTextAlignmentCenter);
  }
  int32_t wait = find_wait_s(t);
  if (wait) {
    char line[28];
    rises_in(line, sizeof(line), wait);
    text(ctx, line, FONT_KEY_GOTHIC_24_BOLD, GRect(0, 166, 156, 60), p.dim, GTextAlignmentCenter);
  } else if (high) {
    text(ctx, s_fs.facing ? look_up(s_fs.talt) : "then look up", FONT_KEY_GOTHIC_24_BOLD, GRect(0, 166, 156, 60),
         p.dim, GTextAlignmentCenter);
  } else if (t->see & SEE_BLOCK_SUN) {
    chip(ctx, "BLOCK THE SUN", 6, 196, false, p.warn, p.warn);
  }
}

// A figure 8 (lemniscate) traced by a dot, about 140 x 60 px.
static GPoint coach_point(int step) {
  int32_t a = TRIG_MAX_ANGLE * step / 64;
  int32_t s = sin_lookup(a), c = cos_lookup(a);
  // Halves first, so the products fit 32 bits.
  int32_t s2 = s / 2, c2 = c / 2;
  int32_t den = TRIG_MAX_RATIO + s2 * s2 / (TRIG_MAX_RATIO / 4);
  int32_t x = 70 * c / den;
  int32_t y = 70 * (s2 * c2 / (TRIG_MAX_RATIO / 4)) / den;
  return GPoint(100 + x, 84 + y);
}

static void draw_coach(GContext *ctx, Palette p) {
  title(ctx, "CALIBRATE COMPASS", p.dim);
  if (s_coach_done) {
    text(ctx, "Compass ready!", FONT_KEY_GOTHIC_28_BOLD, GRect(0, 90, 200, 34), p.accent, GTextAlignmentCenter);
    return;
  }
  graphics_context_set_stroke_color(ctx, p.dim);
  graphics_context_set_stroke_width(ctx, 3);
  GPoint prev = coach_point(0);
  for (int i = 1; i <= 64; i++) {
    GPoint q = coach_point(i);
    graphics_draw_line(ctx, prev, q);
    prev = q;
  }
  graphics_context_set_stroke_width(ctx, 1);
  graphics_context_set_fill_color(ctx, p.accent);
  graphics_fill_circle(ctx, coach_point(s_coach_step), 9);

  uint32_t secs = (uint32_t)(now_ms() - s_coach_start) / 1000;
  const char *tip = s_cal == CompassStatusUnavailable ? "Compass not responding" :
                    secs < 10 ? "Draw a big 8 in the air with your watch" :
                    secs < 20 ? "Keep drawing the 8" :
                    secs < 30 ? "Bigger loops!" : "Step away from cars and metal";
  text(ctx, tip, FONT_KEY_GOTHIC_28_BOLD, GRect(4, 140, 192, 80), p.fg, GTextAlignmentCenter);
}

// The menu's rows, the ones changed most often first.
enum { MENU_SKY, MENU_GEAR, MENU_THEME, MENU_LIGHT, MENU_WRIST, MENU_TUNE, MENU_COUNT };

static int menu_rows(void) {
  return MENU_COUNT;
}

static int sky_code(void) {
  int k = s_prefs & 15;
  return k < SKY_COUNT ? k : SKY_SUBURBS;
}

// The gear row (GEAR_NAMES) for the reach in s_prefs.
static int gear_row(void) {
  int show = (s_prefs >> 4) & 3;
  for (int i = 0; i < GEAR_COUNT; i++) {
    if (GEAR_SHOW[i] == show) return i;
  }
  return 1;   // binoculars
}

static void draw_menu(GContext *ctx, Palette p) {
  const char *labels[MENU_COUNT] = { "Sky", "Gear", "Theme", "Keep light on", "Wrist", "Tune on the Moon" };
  const char *values[MENU_COUNT] = { SKY_NAMES[sky_code()], GEAR_NAMES[gear_row()], THEME_NAMES[s_theme],
                                     LIGHT_NAMES[light_mode()], s_wrist ? "Right" : "Left",
                                     s_moon_tgt[0] ? "Moon is up" : "Moon not up" };
  ListGeom g;
  list_geom(&g);
  int sc = list_scroll(&g);
  for (int i = 0; i < g.n; i++) {
    int ry = MENU_Y + i * MENU_STEP - sc;
    if (ry + MENU_H <= MENU_Y - 2 || ry >= 228) continue;
    GRect row = GRect(4, ry, 192, MENU_H);
    bool sel = i == s_menu_row;
    row_box(ctx, row, sel, p);
    GColor c = sel ? p.bg : p.fg;
    text(ctx, labels[i], FONT_KEY_GOTHIC_24_BOLD, GRect(row.origin.x + 10, row.origin.y + 2, 170, 28),
         sel ? p.bg : p.dim, GTextAlignmentLeft);
    // Too wide for Gothic 28 on one line ("Auto (Stargazer)"): 24, as low.
    bool fits = text_w(values[i], FONT_KEY_GOTHIC_28_BOLD) <= 170;
    text(ctx, values[i], fits ? FONT_KEY_GOTHIC_28_BOLD : FONT_KEY_GOTHIC_24_BOLD,
         GRect(row.origin.x + 10, row.origin.y + (fits ? 24 : 28), 170, 34), c, GTextAlignmentLeft);
  }
  list_title(ctx, "SETTINGS", p.dim, p);
}

// A three-way question (first run, a new place): the question at the top,
// then the answers, each with a line on what it means; the one chosen
// filled.
static void draw_choice(GContext *ctx, Palette p) {
  bool sky = s_choice == CHOICE_SKY;
  title(ctx, sky ? (s_choice_place ? "Where are you now?" : "Where are you?") : "What do you look with?", p.fg);
  for (int i = 0; i < 3; i++) {
    GRect row = GRect(4, MENU_Y + i * MENU_STEP, 192, MENU_H);
    bool sel = i == s_choice_row;
    row_box(ctx, row, sel, p);
    text(ctx, sky ? SKY_NAMES[i] : GEAR_NAMES[i], FONT_KEY_GOTHIC_28_BOLD,
         GRect(row.origin.x + 10, row.origin.y - 2, 176, 34), sel ? p.bg : p.fg, GTextAlignmentLeft);
    text(ctx, sky ? SKY_NOTES[i] : GEAR_NOTES[i], FONT_KEY_GOTHIC_24_BOLD,
         GRect(row.origin.x + 10, row.origin.y + 28, 176, 30), sel ? p.bg : p.dim, GTextAlignmentLeft);
  }
}

// A label beside a button on the right edge, with a small pointer to it.
static void draw_action(GContext *ctx, const char *label, int cy, Palette p) {
  text(ctx, label, FONT_KEY_GOTHIC_28_BOLD, GRect(40, cy - 19, 140, 34), p.accent, GTextAlignmentRight);
  GPoint tri[3] = { GPoint(186, cy - 8), GPoint(197, cy), GPoint(186, cy + 8) };
  graphics_context_set_fill_color(ctx, p.accent);
  fill_path(ctx, tri, 3);
}

#define ACTION_UP_Y    34
#define ACTION_DOWN_Y  192

static void draw_intro(GContext *ctx, Palette p) {
  switch (s_intro_step) {
    case INTRO_WRIST:
      draw_action(ctx, "Left wrist", ACTION_UP_Y, p);
      text(ctx, "Which wrist is your watch on?", FONT_KEY_GOTHIC_28_BOLD, GRect(4, 70, 176, 100), p.fg,
           GTextAlignmentLeft);
      draw_action(ctx, "Right wrist", ACTION_DOWN_Y, p);
      break;
    default:
      draw_icon(ctx, ICON_STAR, GPoint(100, 46), 24, p.accent, p.bg);
      text(ctx, "All set!", FONT_KEY_GOTHIC_28_BOLD, GRect(0, 78, 200, 34), p.fg, GTextAlignmentCenter);
      text(ctx, "Tap, point at the sky, and hold still until it ticks", FONT_KEY_GOTHIC_24_BOLD,
           GRect(8, 116, 184, 90), p.fg, GTextAlignmentCenter);
      break;
  }
}

// Two aims in a row pointed into the ground, as a watch on the other wrist
// would: ask rather than guess.
static void draw_wristq(GContext *ctx, Palette p) {
  draw_action(ctx, "Yes", ACTION_UP_Y, p);
  text(ctx, s_wrist ? "Is your watch on your RIGHT wrist?" : "Is your watch on your LEFT wrist?",
       FONT_KEY_GOTHIC_28_BOLD, GRect(4, 58, 176, 100), p.fg, GTextAlignmentLeft);
  text(ctx, "Aims point at the ground", FONT_KEY_GOTHIC_24_BOLD, GRect(4, 122, 176, 56), p.dim,
       GTextAlignmentLeft);
  draw_action(ctx, "No", ACTION_DOWN_Y, p);
}

static void draw_tune(GContext *ctx, Palette p) {
  title(ctx, "TUNE MY AIM", p.dim);
  static char line[48];
  snprintf(line, sizeof(line), "Point at %s", s_tune_tgt);
  int y = 32, w = 192;
  int h = text_h(line, FONT_KEY_GOTHIC_28_BOLD, w);
  text(ctx, line, FONT_KEY_GOTHIC_28_BOLD, GRect(4, y, w, h + 4), p.fg, GTextAlignmentCenter);
  y += h + 4;
  if (s_tune_where[0]) {
    h = text_h(s_tune_where, FONT_KEY_GOTHIC_24_BOLD, w);
    text(ctx, s_tune_where, FONT_KEY_GOTHIC_24_BOLD, GRect(4, y, w, h + 4), p.dim, GTextAlignmentCenter);
    y += h + 4;
  }
  // One dot per aim, filled once the phone has it.
  y += 14;
  for (int i = 0; i < TUNE_NEEDED; i++) {
    GPoint d = GPoint(100 + (i - 1) * 30, y);
    graphics_context_set_fill_color(ctx, p.accent);
    graphics_context_set_stroke_color(ctx, p.accent);
    graphics_context_set_stroke_width(ctx, 2);
    if (i < s_tune_n) graphics_fill_circle(ctx, d, 9);
    else graphics_draw_circle(ctx, d, 8);
  }
  graphics_context_set_stroke_width(ctx, 1);
  y += 18;
  if (s_tune_note[0]) {
    text(ctx, s_tune_note, FONT_KEY_GOTHIC_24_BOLD, GRect(4, y, w, 228 - y), p.accent, GTextAlignmentCenter);
  } else {
    text(ctx, "Tap to aim", FONT_KEY_GOTHIC_24_BOLD, GRect(0, 196, 200, 30), p.dim, GTextAlignmentCenter);
  }
}

static void draw_msg(GContext *ctx, Palette p) {
  text(ctx, s_msg1, FONT_KEY_GOTHIC_28_BOLD, GRect(4, 70, 192, 70), p.fg, GTextAlignmentCenter);
  text(ctx, s_msg2, FONT_KEY_GOTHIC_24_BOLD, GRect(4, 136, 192, 60), p.dim, GTextAlignmentCenter);
}

static void canvas_update(Layer *layer, GContext *ctx) {
  Palette p = palette();
  graphics_context_set_fill_color(ctx, p.bg);
  graphics_fill_rect(ctx, layer_get_bounds(layer), 0, GCornerNone);
  switch (s_screen) {
    case SCR_HOME: draw_home(ctx, p); break;
    case SCR_AIM: draw_aim(ctx, p); break;
    case SCR_WAIT: draw_wait(ctx, p); break;
    case SCR_RESULTS:
      draw_results(ctx, p);
      draw_reveal(ctx, p);   // on top of it all
      break;
    case SCR_COACH: draw_coach(ctx, p); break;
    case SCR_MENU: draw_menu(ctx, p); break;
    case SCR_MSG: draw_msg(ctx, p); break;
    case SCR_INTRO: draw_intro(ctx, p); break;
    case SCR_TUNE: draw_tune(ctx, p); break;
    case SCR_WRISTQ: draw_wristq(ctx, p); break;
    case SCR_PICK: draw_pick(ctx, p); break;
    case SCR_FIND: draw_find(ctx, p); break;
    case SCR_CHOICE: draw_choice(ctx, p); break;
  }
}

// ---------------------------------------------------------------- your sky and gear

// Unless a theme was chosen in the menu, a dark sky gets Auto (Stargazer):
// out there, a red screen after dark keeps your eyes used to the dark.
static void theme_default(void) {
  if (!s_theme_set) s_theme = sky_code() == SKY_DARK ? THEME_AUTO_STAR : THEME_AUTO;
}

// s_prefs into what the watch's own answers and Find it use, and the
// theme that goes with the sky.
static void apply_prefs(void) {
  s_frame.sky = (uint8_t)sky_code();
  static const uint8_t see_max[4] = { SEE_BINOCULARS, SEE_CLOSE, SEE_TELESCOPE, SEE_BINOCULARS };
  s_frame.see_max = see_max[(s_prefs >> 4) & 3];
  theme_default();
  if (s_canvas) apply_theme();
  light_update();
}

static void prefs_try(void);

static void prefs_retry_cb(void *ctx) {
  s_prefs_timer = NULL;
  prefs_try();
}

static void prefs_try(void) {
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) {   // busy: again shortly
    if (++s_prefs_tries < PREFS_TRIES && !s_prefs_timer) {
      s_prefs_timer = app_timer_register(PREFS_RETRY_MS, prefs_retry_cb, NULL);
    }
    return;
  }
  dict_write_int32(it, MESSAGE_KEY_PREFS, (int32_t)(s_prefs | (uint32_t)s_theme << 8 |
                                                    (s_prefs_pending ? 1u << 16 | (uint32_t)s_prefs_seq << 17 : 0u)));
  app_message_outbox_send();
}

// To the phone: your sky, gear and light, the theme (the settings page
// takes its colours from it), and in bit 16 that they were changed here,
// with the change's number in bits 17-23.
static void prefs_send(void) {
  if (s_prefs_timer) {
    app_timer_cancel(s_prefs_timer);
    s_prefs_timer = NULL;
  }
  s_prefs_tries = 0;
  prefs_try();
}

// The prefs byte for a sky (SKY_*), a reach (find.js SHOW) and the light
// (LIGHT_*), kept in range so the phone can always take them.
static uint8_t prefs_byte(uint32_t v) {
  int sky = (int)(v & 15), show = (int)((v >> 4) & 3);
  return (uint8_t)((sky < SKY_COUNT ? sky : SKY_SUBURBS) | (show <= 2 ? show : 0) << 4 | (v & 0xc0));
}

// A change made on the watch (the first run, the menu, a new place).
static void set_prefs(uint8_t v) {
  s_prefs = prefs_byte(v);
  s_prefs_pending = true;
  s_prefs_seq = (uint8_t)(s_prefs_seq % 127 + 1);
  s_place_ask = false;   // just chosen, for here
  persist_write_int(PERSIST_PREFS, s_prefs);
  persist_write_int(PERSIST_PREFS_PENDING, s_prefs_seq);
  apply_prefs();
  prefs_send();
}

// PREFS from the phone (in every status): its sky, gear and light (bits 0-7), the
// theme it last heard from the watch (bits 8-15, plus one; 0 for none) and
// the number of the last watch change it took (bits 17-23). A change made
// here is sent until the phone has taken that very change (a status sent
// before it did can't clear it); otherwise the phone's (from its settings
// page) is taken.
static void prefs_received(uint32_t v) {
#ifdef SKY_SHOT
  return;   // harness: keep the seeded screen
#endif
  uint8_t phone = prefs_byte(v);
  int theme = (int)((v >> 8) & 0xff) - 1;
  if (s_prefs_pending && phone == s_prefs && ((v >> 17) & 127) == s_prefs_seq) {
    s_prefs_pending = false;
    persist_delete(PERSIST_PREFS_PENDING);
  } else if (!s_prefs_pending && phone != s_prefs) {
    s_prefs = phone;
    persist_write_int(PERSIST_PREFS, s_prefs);
    apply_prefs();
  }
  if (s_prefs_pending || theme != s_theme) prefs_send();
}

// ---------------------------------------------------------------- reveal

static void reveal_cb(void *ctx) {
  s_reveal_timer = NULL;
  if (s_screen != SCR_RESULTS || now_ms() - s_reveal_start >= REVEAL_MS) s_reveal_start = 0;
  else s_reveal_timer = app_timer_register(REVEAL_FRAME_MS, reveal_cb, NULL);
  layer_mark_dirty(s_canvas);
}

static void reveal_start(void) {
  s_reveal_start = now_ms();
  if (!s_reveal_timer) s_reveal_timer = app_timer_register(REVEAL_FRAME_MS, reveal_cb, NULL);
}

// ---------------------------------------------------------------- messages

static void msg_timer_cb(void *ctx) {
  s_msg_timer = NULL;
  if (s_screen == SCR_MSG) go(s_tune ? SCR_TUNE : SCR_HOME);
}

static void show_msg(const char *a, const char *b) {
  strncpy(s_msg1, a, sizeof(s_msg1) - 1);
  strncpy(s_msg2, b, sizeof(s_msg2) - 1);
  s_msg1[sizeof(s_msg1) - 1] = s_msg2[sizeof(s_msg2) - 1] = '\0';
  if (s_msg_timer) app_timer_cancel(s_msg_timer);
  s_msg_timer = app_timer_register(MSG_MS, msg_timer_cb, NULL);
  go(SCR_MSG);
}

// What goes with the cards (chart, fact, the Moon's lighting): none yet.
static void clear_extras(void) {
  s_chart_len = 0;
  s_fact[0] = '\0';
  s_fact_inline = false;
  s_have_moon_look = false;
}

// The fact on the first answer's page, in place of its fact page: for a
// star or constellation with no chart there, when it fits under the name
// and the card has no hint (which way to look matters more).
static void place_fact(void) {
  s_fact_inline = false;
  int len = group_len(0);
  if (!s_fact[0] || (s_cards[0].type != T_STAR && s_cards[0].type != T_CONST) || s_cards[0].hint[0] || chart_here()) {
    return;
  }
  int at = -1;
  for (int i = 1; i < len; i++) {
    if (s_cards[i].type == T_FACT) at = i;
  }
  if (at < 0) return;
  const Card *c = &s_cards[0];
  int h = text_h(c->l1, big_fits(c->l1, 192) ? FONT_36 : FONT_KEY_GOTHIC_28_BOLD, 192) +
          (c->l2[0] ? text_h(c->l2, FONT_KEY_GOTHIC_24_BOLD, 192) : 0) + text_h(s_fact, FONT_KEY_GOTHIC_24_BOLD, 192);
  if (40 + h > 224) return;
  memmove(&s_cards[at], &s_cards[at + 1], (size_t)(s_ncards - at - 1) * sizeof(Card));
  s_ncards--;
  s_fact_inline = true;
}

// A single card made on the watch, for answers the phone can't give.
static void show_local_card(const char *l1, const char *l2, const char *l3) {
  memset(&s_cards[0], 0, sizeof(Card));
  strncpy(s_cards[0].l1, l1, sizeof(s_cards[0].l1) - 1);
  strncpy(s_cards[0].l2, l2, sizeof(s_cards[0].l2) - 1);
  strncpy(s_cards[0].l3, l3, sizeof(s_cards[0].l3) - 1);
  s_ncards = 1;
  s_card = 0;
  clear_extras();
  s_no_answer_shown = false;
  s_offline_shown = false;
  vibes_double_pulse();
  reveal_light();
  go(SCR_RESULTS);
}

// "type\x1fword\x1fl1\x1fl2\x1fl3\x1fhint" cards joined by \x1e.
static void parse_cards(const char *s) {
  s_ncards = 0;
  clear_extras();
  while (*s && s_ncards < MAX_CARDS) {
    Card *c = &s_cards[s_ncards];
    memset(c, 0, sizeof(Card));
    char *fields[4] = { c->l1, c->l2, c->l3, c->hint };
    int f = 0;
    char num[4] = { 0 };
    int nl = 0;
    while (*s && *s != '\x1e') {
      if (*s == '\x1f') {
        if (f == 0) c->type = (uint8_t)atoi(num);
        if (f == 1) c->word = (uint8_t)atoi(num);
        f++;
        nl = 0;
        memset(num, 0, sizeof(num));
      } else if (f < 2) {
        if (nl < 3) num[nl++] = *s;
        num[nl] = '\0';
      } else if (f - 2 < 4) {
        char *dst = fields[f - 2];
        size_t len = strlen(dst);
        if (len < sizeof(c->l1) - 1) {
          dst[len] = *s;
          dst[len + 1] = '\0';
        }
      }
      s++;
    }
    if (f >= 2) s_ncards++;
    if (*s == '\x1e') s++;
  }
}

static void wait_timer_cb(void *ctx) {
  s_wait_timer = NULL;
  if (s_screen != SCR_WAIT) return;
  s_quiet_reply = false;
  // No answer: the watch answers what it can itself. A late answer from
  // the phone still replaces it.
  if (s_wait_list) {
    if (find_offline_list()) {
      s_wait_list = false;
      return;
    }
  } else if (answer_offline()) {
    s_no_answer_shown = true;
    return;
  }
  show_local_card("No answer", "from the phone", "Is the Pebble app open?");
  s_no_answer_shown = true;
}

// Copies one \x1f-separated field; returns where the next one starts.
static const char *take_field(const char *s, char *dst, size_t cap) {
  size_t n = 0;
  while (*s && *s != '\x1f') {
    if (n < cap - 1) dst[n++] = *s;
    s++;
  }
  dst[n] = '\0';
  return *s ? s + 1 : s;
}

// The phone's answer to a tune aim: n aims in so far (TUNE_CANT: can't
// tune now). Not done yet: back to the tune screen with the phone's note.
static void tune_reply(uint8_t n) {
  Card *c = &s_cards[0];
  if (n == TUNE_CANT || n >= TUNE_NEEDED) {
    s_tune = false;
    s_card = 0;
    if (n == TUNE_CANT) vibes_double_pulse();
    else vibes_short_pulse();
    reveal_light();
    go(SCR_RESULTS);
    return;
  }
  bool took = c->word != 0;   // the phone marks an aim it kept
  s_tune_n = n;
  strncpy(s_tune_note, c->l1, sizeof(s_tune_note) - 1);
  s_tune_note[sizeof(s_tune_note) - 1] = '\0';
  // The phone names the target it is measuring against (it can change
  // while the app is open, as things rise and set).
  if (c->l2[0]) strncpy(s_tune_tgt, c->l2, sizeof(s_tune_tgt) - 1);
  if (c->l3[0]) strncpy(s_tune_where, c->l3, sizeof(s_tune_where) - 1);
  if (took) vibes_short_pulse();
  else vibes_double_pulse();
  reveal_light();
  go(SCR_TUNE);
}

// Shows the cards just parsed: as a tune step (tune_n is the
// phone's count) or as answers (tune_n < 0).
static void deliver_reply(int16_t tune_n) {
  if (tune_n >= 0) {
    tune_reply((uint8_t)tune_n);
    return;
  }
  s_card = 0;
  // One buzz for a confident answer, two for maybe, nothing found, or a
  // warning. A found target already had its lock buzz.
  uint8_t w = s_cards[0].word;
  if (s_quiet_reply) s_quiet_reply = false;
  else if (s_cards[0].type != T_SUN && (w == 1 || w == 2)) vibes_short_pulse();
  else vibes_double_pulse();
  if (s_screen == SCR_FIND) {   // still finding: the card waits for a tap (a pattern's chart shows now)
    layer_mark_dirty(s_canvas);
    return;
  }
  reveal_light();
  reveal_start();
  go(SCR_RESULTS);
}

static void inbox_received(DictionaryIterator *it, void *ctx) {
  Tuple *t;
  if ((t = dict_find(it, MESSAGE_KEY_TUNE_TGT)) && t->type == TUPLE_CSTRING) {
    const char *s = take_field(t->value->cstring, s_moon_tgt, sizeof(s_moon_tgt));
    take_field(s, s_moon_where, sizeof(s_moon_where));
  }
  if ((t = dict_find(it, MESSAGE_KEY_SKY_FRAME)) && t->type == TUPLE_BYTE_ARRAY &&
      parse_frame(t->value->data, t->length) && memcmp(s_frame_raw, t->value->data, 19) != 0) {
    memcpy(s_frame_raw, t->value->data, 19);
    persist_write_data(PERSIST_FRAME, t->value->data, 19);
  }
  if ((t = dict_find(it, MESSAGE_KEY_SKY_EPH)) && t->type == TUPLE_BYTE_ARRAY && eph_set(t->value->data, t->length)) {
    save_eph();
  }
  if ((t = dict_find(it, MESSAGE_KEY_FIND_LIST)) && t->type == TUPLE_BYTE_ARRAY) {
    find_list_received(t->value->data, t->length);
  }
  if ((t = dict_find(it, MESSAGE_KEY_LAYERS))) {
    uint8_t layers = (uint8_t)t->value->uint32 | (1 << L_ANY);
    if (layers != s_layers) {
      s_layers = layers;
      persist_write_int(PERSIST_LAYERS, s_layers);
      if (!layer_on(s_layer)) {
        s_layer = L_ANY;
        persist_write_int(PERSIST_LAYER, s_layer);
      }
      s_slide_dir = 0;   // the rungs changed under it
    }
  }
  if ((t = dict_find(it, MESSAGE_KEY_DAYLIGHT))) {
    bool day = t->value->int32 != 0;
    if (day != s_daylight) {
      s_daylight = day;
      persist_write_bool(PERSIST_DAY, s_daylight);
      apply_theme();
    }
  }
  if ((t = dict_find(it, MESSAGE_KEY_PREFS))) prefs_received(t->value->uint32);
  if ((t = dict_find(it, MESSAGE_KEY_NEW_PLACE))) {
    // Not while an answer is still on its way to the phone.
    s_place_ask = t->value->int32 != 0 && !s_place_asked && !s_prefs_pending;
    if (s_place_ask && s_screen == SCR_HOME && !s_intro) ask_place();
  }
  if ((t = dict_find(it, MESSAGE_KEY_STATUS)) && t->type == TUPLE_CSTRING) {
    const char *s = t->value->cstring;
    for (int l = 0; l < L_COUNT; l++) {
      int n = 0;
      while (*s && *s != '\x1f') {
        if (n < (int)sizeof(s_status[l]) - 1) s_status[l][n++] = *s;
        s++;
      }
      s_status[l][n] = '\0';
      if (*s == '\x1f') s++;
    }
    s_have_status = true;
  }
  Tuple *seq = dict_find(it, MESSAGE_KEY_R_SEQ);
  Tuple *data = dict_find(it, MESSAGE_KEY_R_DATA);
  bool awaiting = s_screen == SCR_WAIT || ((s_screen == SCR_RESULTS || s_screen == SCR_FIND) && s_no_answer_shown);
  if (seq && data && data->type == TUPLE_CSTRING && (uint16_t)seq->value->uint32 == s_seq && awaiting) {
    s_no_answer_shown = false;
    s_offline_shown = false;
    if (s_wait_timer) {
      app_timer_cancel(s_wait_timer);
      s_wait_timer = NULL;
    }
    parse_cards(data->value->cstring);
    Tuple *ch = dict_find(it, MESSAGE_KEY_R_CHART);
    if (ch && ch->type == TUPLE_BYTE_ARRAY && ch->length <= CHART_MAX) {
      memcpy(s_chart, ch->value->data, ch->length);
      s_chart_len = ch->length;
    }
    Tuple *mo = dict_find(it, MESSAGE_KEY_R_MOON);
    if (mo && mo->type == TUPLE_BYTE_ARRAY && mo->length == 2) {
      memcpy(s_moon_look, mo->value->data, 2);
      s_have_moon_look = true;
    }
    Tuple *fa = dict_find(it, MESSAGE_KEY_R_FACT);
    if (fa && fa->type == TUPLE_CSTRING) {
      strncpy(s_fact, fa->value->cstring, FACT_MAX - 1);
      s_fact[FACT_MAX - 1] = '\0';
    }
    // A chart or fact card whose data didn't come is dropped.
    int kept = 0;
    for (int i = 0; i < s_ncards; i++) {
      if ((s_cards[i].type == T_CHART && !s_chart_len) || (s_cards[i].type == T_FACT && !s_fact[0])) continue;
      if (kept != i) s_cards[kept] = s_cards[i];
      kept++;
    }
    s_ncards = kept;
    place_fact();
    if (s_ncards == 0) {
      show_local_card("Something went", "wrong", "Point again");
      return;
    }
    Tuple *tn = dict_find(it, MESSAGE_KEY_TUNE_N);
    int16_t tune_n = tn && s_tune ? (int16_t)tn->value->uint32 : -1;
    if (dict_find(it, MESSAGE_KEY_WRIST_Q) && !s_wrist_ok) {
      s_pending_tune = tune_n;
      vibes_double_pulse();
      reveal_light();
      go(SCR_WRISTQ);
      return;
    }
    deliver_reply(tune_n);
    return;
  }
  layer_mark_dirty(s_canvas);
}

static void outbox_failed(DictionaryIterator *it, AppMessageResult reason, void *ctx) {
  // The sky and gear going up: sent again on the phone's next status or on
  // reconnecting. It says nothing about an aim waiting for its answer.
  if (dict_find(it, MESSAGE_KEY_PREFS)) return;
  if (s_screen == SCR_WAIT) {
    if (s_wait_timer) {
      app_timer_cancel(s_wait_timer);
      s_wait_timer = NULL;
    }
    if (s_wait_list) {
      s_wait_list = false;
      if (!find_offline_list()) show_msg("Phone not", "connected");
    } else if (!answer_offline()) {
      show_local_card("Phone not", "connected", "Open the Pebble app");
    }
  }
}

static void connection_handler(bool connected) {
  if (connected && s_prefs_pending) prefs_send();
  layer_mark_dirty(s_canvas);
}

static void cancel_aim(const char *why);

// A notification over the app shakes the wrist (and its buzz isn't filtered
// out of the compass), so an aim in progress is dropped; coming back,
// restore the backlight tint the system reset.
static void touch_forget(void);

static void will_focus(bool in_focus) {
  if (!in_focus) s_light_away = true;
  if (!in_focus) touch_forget();
  if (!in_focus && s_screen == SCR_AIM) cancel_aim("Interrupted");
}

static void did_focus(bool in_focus) {
  if (in_focus) s_light_away = false;
  if (in_focus) apply_theme();
}

// ---------------------------------------------------------------- Find it

// SKY_FRAME: 19 bytes (find.js).
static bool parse_frame(const uint8_t *b, size_t len) {
  if (len < 19) return false;
  s_frame.lat = (int32_t)rd_u32(b) / 1e5;
  s_frame.lon = (int32_t)rd_u32(b + 4) / 1e5;
  s_frame.decl = rd_i16(b + 8) / 100.0;
  for (int w = 0; w < 2; w++) {
    s_frame.yaw[w] = rd_i16(b + 10 + 4 * w) / 100.0;
    s_frame.pitch[w] = rd_i16(b + 12 + 4 * w) / 100.0;
  }
  // The sky and what Find it shows (its last byte) come from s_prefs,
  // which the phone sends with every status (PREFS).
  s_have_frame = true;
  return true;
}

// A length-prefixed string at b[*k].
static bool take_string(const uint8_t *b, int len, int *k, char *dst, size_t cap) {
  if (*k >= len) return false;
  int n = b[(*k)++];
  if (*k + n > len) return false;
  int c = n < (int)cap - 1 ? n : (int)cap - 1;
  memcpy(dst, b + *k, (size_t)c);
  dst[c] = '\0';
  *k += n;
  return true;
}

// FIND_LIST (find.js). Returns the number of targets, or -1 if it's
// malformed.
static int parse_find_list(const uint8_t *b, int len) {
  if (len < 6 || b[0] != 4) return -1;
  time_t t0 = (time_t)rd_u32(b + 1);
  if (t0 == 0) return -2;   // the phone doesn't know where you are
  int k = 5, n = b[k++], ntrack = 0;
  FindTarget spare;
  s_nfind = 0;
  for (int i = 0; i < n; i++) {
    FindTarget *t = s_nfind < FIND_MAX ? &s_find[s_nfind] : &spare;
    memset(t, 0, sizeof(*t));
    if (k + 5 > len) return -1;
    t->id = b[k];
    t->type = b[k + 1];
    t->kind = b[k + 2];
    t->see = b[k + 3];
    t->best = b[k + 4] & FIND_BEST;
    t->give = b[k + 4] & ~FIND_BEST;
    k += 5;
    if (!take_string(b, len, &k, t->name, sizeof(t->name)) || !take_string(b, len, &k, t->where, sizeof(t->where)) ||
        !take_string(b, len, &k, t->note, sizeof(t->note))) {
      return -1;
    }
    if (t->kind == 0) {
      if (k + 4 > len) return -1;
      t->ra = rd_u16(b + k) * 360.0 / 65536;
      t->dec = rd_i16(b + k + 2) / 100.0;
      k += 4;
    } else {
      if (k + 4 > len) return -1;
      t->start = rd_u16(b + k);
      t->step = b[k + 2];
      int m = b[k + 3];
      k += 4;
      if (k + 4 * m > len) return -1;
      t->track0 = (uint8_t)ntrack;
      for (int j = 0; j < m; j++, k += 4) {
        if (ntrack >= FIND_TRACK_MAX || t == &spare) continue;
        s_track[ntrack].az = rd_u16(b + k);
        s_track[ntrack].alt = rd_i16(b + k + 2);
        ntrack++;
        t->npts++;
      }
      if (t->npts < 2 || t->step == 0) continue;   // no path to follow
    }
    if (t != &spare) s_nfind++;
  }
  if (k + 4 <= len) {
    s_sun_ra = rd_u16(b + k) * 360.0 / 65536;
    s_sun_dec = rd_i16(b + k + 2) / 100.0;
  } else {
    s_sun_dec = -90;   // no Sun given: never warn
  }
  s_find_t0 = t0;
  s_skew = (int32_t)(t0 - time(NULL));
  s_find_local = false;
  mark_best();
  return s_nfind;
}

// Where a target is now, apparent. False once a moving one has run off the
// end of its path.
static bool find_target_pos(const FindTarget *t, double *az, double *alt) {
  time_t now;
  uint16_t ms;
  time_ms(&now, &ms);
  int64_t tn = (int64_t)now + s_skew;
  if (t->kind == 0) {
    double lst = sky_lst((time_t)tn, ms, s_frame.lon);
    double h;
    sky_eq_to_hor(t->ra, t->dec, lst, s_frame.lat, az, &h);
    *alt = h + sky_refraction(h);
    return true;
  }
  // Before a pass, where it will rise.
  double x = ((double)(tn - s_find_t0 - t->start) + ms / 1000.0) / t->step;
  if (x < 0) x = 0;
  int i = (int)x;
  if (i >= t->npts - 1) return false;
  double f = x - i;
  double a0 = s_track[t->track0 + i].az * 360.0 / 65536, a1 = s_track[t->track0 + i + 1].az * 360.0 / 65536;
  *az = sky_rev(a0 + sky_wrap180(a1 - a0) * f);
  *alt = (s_track[t->track0 + i].alt + (s_track[t->track0 + i + 1].alt - s_track[t->track0 + i].alt) * f) / 100.0;
  return true;
}

// Seconds until a pass to come rises (0 once it has, or for anything else).
static int32_t find_wait_s(const FindTarget *t) {
  if (t->kind == 0 || !t->start) return 0;
  int32_t w = (int32_t)(s_find_t0 + t->start - ((int64_t)time(NULL) + s_skew));
  return w > 0 ? w : 0;
}

// Where the Sun is now, apparent (from the list's RA/Dec: it moves a
// degree a day among the stars).
static void sun_now(double *saz, double *salt) {
  time_t now_s;
  uint16_t ms;
  time_ms(&now_s, &ms);
  sky_eq_to_hor(s_sun_ra, s_sun_dec, sky_lst((time_t)((int64_t)now_s + s_skew), ms, s_frame.lon), s_frame.lat, saz,
                salt);
  *salt += sky_refraction(*salt);
}

// The Sun flags again, for now (the list may be minutes old, the Sun up
// since): false if the target has become too near the Sun to find.
static bool find_sun_ok(FindTarget *t) {
  double az, alt, saz, salt;
  // Gone (the finding screen says so), or a pass to come (it's dark then).
  if (find_wait_s(t) || !find_target_pos(t, &az, &alt)) return true;
  sun_now(&saz, &salt);
  t->see = (uint8_t)((t->see & SEE_HOW) | sun_flags(t->see & SEE_HOW, az, alt, saz, salt));
  layer_mark_dirty(s_canvas);
  return !(t->see & SEE_NEAR_SUN);
}

static void stop_find(void) {
  if (s_tick_timer) {
    app_timer_cancel(s_tick_timer);
    s_tick_timer = NULL;
  }
  if (s_frame_timer) {
    app_timer_cancel(s_frame_timer);
    s_frame_timer = NULL;
  }
}

static void tick_cb(void *ctx);
static void found_send(void *ctx);

// From "Found it" to its card (a tap): the phone's, with its chart and a
// fact, once it has come. BACK from it goes back to the list.
static void found_show(void) {
  stop_find();
  s_fs.found = false;
  s_find_back = true;
  s_card = 0;
  reveal_light();
  reveal_start();
  go(SCR_RESULTS);
}

// Locked on: "Found it" (draw_found) while you stay on it; the tapes again
// once you're held off it OFF_MS. The first time (once it has risen),
// the lock buzz, its card, and the phone asked for its own.
static void find_locked(void) {
  s_fs.found = true;
  s_off_at = 0;
  layer_mark_dirty(s_canvas);
  FindTarget *t = &s_find[s_find_cur];
  if (s_find_sent || find_wait_s(t)) return;
  s_find_sent = true;
  vibes_cancel();
  static const uint32_t lock[] = { 60, 80, 60, 80, 300 };
  vibes_enqueue_custom_pattern((VibePattern){ .durations = lock, .num_segments = 5 });
  s_quiet_until = now_ms() + 600 + QUIET_MS;
  memset(&s_cards[0], 0, sizeof(Card));
  s_cards[0].type = t->type;
  strncpy(s_cards[0].l1, t->name, sizeof(s_cards[0].l1) - 1);
  strncpy(s_cards[0].l2, "Found it!", sizeof(s_cards[0].l2) - 1);
  s_ncards = 1;
  s_card = 0;
  clear_extras();
  if (t->type == T_MOON && s_have_frame) {
    OffPlace at = { s_frame.lat, s_frame.lon, s_frame.sky };
    s_have_moon_look = off_moon_look(time(NULL), &at, s_moon_look);
  }
  s_no_answer_shown = false;
  s_offline_shown = s_find_local || !connection_service_peek_pebble_app_connection();
  reveal_light();
  if (s_send_timer) {
    app_timer_cancel(s_send_timer);
    s_send_timer = NULL;
  }
  if (!s_find_local && connection_service_peek_pebble_app_connection()) {
    s_seq++;
    persist_write_int(PERSIST_SEQ, s_seq);
    s_send_tries = 0;
    found_send(NULL);
  }
}

// Tells the phone which target was found, retrying while the outbox is
// busy; its answer (card, chart, fact) replaces the watch's card.
static void found_send(void *ctx) {
  s_send_timer = NULL;
  if (s_screen != SCR_RESULTS && s_screen != SCR_FIND) return;
  DictionaryIterator *it;
  AppMessageResult r = app_message_outbox_begin(&it);
  if (r == APP_MSG_BUSY && ++s_send_tries < SEND_TRIES) {
    s_send_timer = app_timer_register(SEND_RETRY_MS, found_send, NULL);
    return;
  }
  if (r == APP_MSG_OK && dict_write_uint8(it, MESSAGE_KEY_FIND_FOUND, s_find[s_find_cur].id) == DICT_OK &&
      dict_write_uint16(it, MESSAGE_KEY_A_SEQ, s_seq) == DICT_OK && app_message_outbox_send() == APP_MSG_OK) {
    s_no_answer_shown = true;
    s_quiet_reply = true;
  }
}

static void frame_cb(void *ctx);

// What the finding screen shows besides the tapes, as bits: a change
// redraws it (a reading alone only moves the tapes, which glide).
static uint8_t find_flags(void) {
  return (uint8_t)(s_fs.have | s_fs.held << 1 | s_fs.too_high << 2 | s_fs.found << 3 | s_fs.gone << 4 |
                   s_fs.facing << 5 | s_fs.level << 6);
}

// One sensor reading while finding (a compass heading 5 times a second,
// an accelerometer sample 25 times): where the top of the watch points
// now, which way to the target, and whether it has stayed close long
// enough. The tapes glide there (frame_cb).
static void find_update(void) {
  if (!s_have_fa || !s_have_fhead || s_fs.intro) return;
  SkyAim a = sky_aim_dir(s_fhead * 360.0 / TRIG_MAX_ANGLE, s_fa[0], s_fa[1], s_fa[2], s_frame.decl,
                         (SkyVec){ 0, 1, 0 });
  FindTarget *t = &s_find[s_find_cur];
  uint8_t flags = find_flags();
  uint64_t now = now_ms();
  bool moved = false;   // the target: redraw
  if (!s_pos.at || now - s_pos.at >= FIND_POS_MS) {
    moved = true;
    s_pos.at = now;
    s_pos.ok = find_target_pos(t, &s_pos.taz, &s_pos.talt);
  }
  double taz = s_pos.taz, talt = s_pos.talt;
  s_fs.gone = !s_pos.ok || talt < -1;
  s_fs.have = true;
  s_fs.held = a.face > FACE_MIN;
  if (s_fs.held) s_unheld_at = 0;
  else if (!s_unheld_at) s_unheld_at = now;
  s_fs.too_high = a.twelve_pitch > TOO_HIGH_PITCH;   // up or down: its heading means little
  s_fs.az = a.az;
  s_fs.alt = a.alt;
  if (!s_show_set) {
    s_show_az = a.az;
    s_show_alt = a.alt;
    s_show_set = true;
  }
  bool was_facing = s_fs.facing;
  if (!s_fs.gone) {
    s_fs.taz = taz;
    s_fs.talt = talt;
    s_fs.daz = sky_wrap180(taz - a.az);
    s_fs.dalt = talt - a.alt;
    // Facing it: the heading within ON_DEG (or the target's give: a big
    // pattern's) of sky at the target's height (more heading, higher up);
    // level: the tilt within that. Each holds until OFF_DEG - ON_DEG more;
    // the heading's give stops at FACING_MAX (in the same proportion to
    // come on). Overhead, there's no tilting to do.
    double on = t->give ? t->give : ON_DEG, off = on + (OFF_DEG - ON_DEG);
    double k = sky_cosd(talt), deg = s_fs.facing ? off : on;
    double cap = s_fs.facing ? FACING_MAX : FACING_MAX * on / off;
    double give = k * cap > deg ? deg / k : cap;
    s_fs.facing = (s_fs.daz < 0 ? -s_fs.daz : s_fs.daz) <= give;
    s_fs.level = talt <= HIGH_ALT && (s_fs.dalt < 0 ? -s_fs.dalt : s_fs.dalt) <= (s_fs.level ? off : on);
  }
  bool can = s_fs.held && !s_fs.too_high && !s_fs.gone && !s_fs.timeout;
  if (!can) s_fs.facing = s_fs.level = false;
  // One tap on turning to face it (not again for a while: at the edge it
  // can come and go; nor while it's found).
  if (s_fs.facing && !was_facing && !s_fs.found && now - s_tap_ms >= TAP_GAP_MS) {
    static const uint32_t tap[] = { TAP_MS };
    vibes_enqueue_custom_pattern((VibePattern){ .durations = tap, .num_segments = 1 });
    s_tap_ms = now;
    s_quiet_until = now + TAP_MS + QUIET_MS;
  }
  // Both tapes on (overhead, facing it is enough), held LOCK_MS: found.
  // Found, it stays found while it's on (and the timeout waits), or while
  // the watch isn't held up (you're looking at the sky; the timeout runs,
  // so a watch let fall stops in the end); held off it OFF_MS, back to
  // the tapes. Gone is gone.
  bool on = can && s_fs.facing && (s_fs.level || talt > HIGH_ALT);
  if (s_fs.found) {
    if (s_fs.gone) {
      s_fs.found = false;
    } else if (on || !s_fs.held) {
      s_off_at = 0;
      if (on) s_find_start = now;
      if (on && !s_find_sent && !find_wait_s(t)) find_locked();   // a pass has just risen here
    } else if (!s_off_at) {
      s_off_at = now;
    } else if (now - s_off_at >= OFF_MS) {
      s_fs.found = false;
      s_lock_start = 0;
      layer_mark_dirty(s_canvas);
    }
  } else if (on) {
    if (!s_lock_start) {
      s_lock_start = now;
    } else if (now - s_lock_start >= LOCK_MS) {
      find_locked();
    }
  } else {
    s_lock_start = 0;
  }
  // The tapes glide (not while found: they aren't shown).
  double gaz = sky_wrap180(a.az - s_show_az), galt = a.alt - s_show_alt;
  if (!s_fs.found && !s_frame_timer && ((gaz < 0 ? -gaz : gaz) >= 0.05 || (galt < 0 ? -galt : galt) >= 0.05)) {
    s_frame_timer = app_timer_register(FRAME_MS, frame_cb, NULL);
  }
  if ((moved && !s_fs.found) || flags != find_flags()) layer_mark_dirty(s_canvas);
}


// The tapes glide toward the latest reading, about 30 frames a second,
// and stop once they're there (the next reading starts them again).
static void frame_cb(void *ctx) {
  s_frame_timer = NULL;
  if (s_screen != SCR_FIND || s_fs.intro || s_fs.found) return;
  double daz = sky_wrap180(s_fs.az - s_show_az), dalt = s_fs.alt - s_show_alt;
  if ((daz < 0 ? -daz : daz) < 0.05 && (dalt < 0 ? -dalt : dalt) < 0.05) {
    s_show_az = s_fs.az;
    s_show_alt = s_fs.alt;
  } else {
    s_show_az = sky_rev(s_show_az + daz * GLIDE);
    s_show_alt += dalt * GLIDE;
    s_frame_timer = app_timer_register(FRAME_MS, frame_cb, NULL);
  }
  layer_mark_dirty(s_canvas);
}

// Times out after FIND_TIMEOUT_MS off it, with no button; a pass to come
// counts down.
static void tick_cb(void *ctx) {
  s_tick_timer = NULL;
  if (s_screen != SCR_FIND) return;
  uint64_t now = now_ms();
  if (s_fs.intro) return;   // started again from find_begin
  if (find_wait_s(&s_find[s_find_cur])) layer_mark_dirty(s_canvas);
  if (!s_fs.timeout && now - s_find_start > FIND_TIMEOUT_MS) {
    s_fs.timeout = true;
    s_fs.found = false;
    s_lock_start = 0;
    layer_mark_dirty(s_canvas);
  }
  light_update();   // "Still looking?", the watch down a while, the battery: let the light go
  if (!s_fs.have || !s_fs.held) layer_mark_dirty(s_canvas);   // "Hold your watch" may be due
  s_tick_timer = app_timer_register(FIND_TIMER_MS, tick_cb, NULL);
}

// Finding starts (or starts again, after "Still looking?"): the clock,
// the sensors at full rate, the timeout check.
// The readings from "how to find it" carry on, so the tapes show at once.
static void open_coach(void);

// Aims and finding need a calibrated compass: if it isn't, the coach (and
// false).
static bool compass_ready(void) {
  if (s_cal == CompassStatusCalibrated) return true;
  open_coach();
  return false;
}

static void find_begin(void) {
  if (!compass_ready()) return;
  stop_find();
  memset(&s_fs, 0, sizeof(s_fs));
  memset(&s_pos, 0, sizeof(s_pos));
  s_lock_start = 0;
  s_unheld_at = 0;
  s_off_at = 0;
  s_show_set = false;
  s_find_start = now_ms();
  accel_follow_screen();
  find_update();
  light_update();   // after "Still looking?": hold it again
  layer_mark_dirty(s_canvas);
  s_tick_timer = app_timer_register(FIND_TIMER_MS, tick_cb, NULL);
}

// A target picked: how to find it first (it stays until a tap or
// SELECT; Find it may be used seldom enough to forget), then find_begin.
static void start_find(int row) {
  if (!compass_ready()) return;
  if (row < 0 || row >= s_nfind) return;
  s_find_cur = row;
  s_find_sent = false;
  s_find_back = false;
  stop_find();
  memset(&s_fs, 0, sizeof(s_fs));
  s_have_fhead = false;   // fresh readings come in while it shows
  s_have_fa = false;
  s_fs.intro = true;
  s_lock_start = 0;
  go(SCR_FIND);
}

static void wait_timer_cb(void *ctx);

// Asks the phone what's up to find.
// Sends FIND_REQ, retrying while the outbox is busy (as send_aim does);
// with no phone, the watch makes the list itself.
static void find_send(void *ctx) {
  s_send_timer = NULL;
  if (s_screen != SCR_WAIT || !s_wait_list) return;
  DictionaryIterator *it;
  AppMessageResult r = connection_service_peek_pebble_app_connection() ? app_message_outbox_begin(&it)
                                                                       : APP_MSG_NOT_CONNECTED;
  if (r == APP_MSG_BUSY && ++s_send_tries < SEND_TRIES) {
    s_send_timer = app_timer_register(SEND_RETRY_MS, find_send, NULL);
    return;
  }
  if (r != APP_MSG_OK || dict_write_uint8(it, MESSAGE_KEY_FIND_REQ, 1) != DICT_OK ||
      (eph_wanted() && dict_write_uint8(it, MESSAGE_KEY_EPH_REQ, 1) != DICT_OK) ||
      app_message_outbox_send() != APP_MSG_OK) {
    s_wait_list = false;
    if (s_wait_timer) {
      app_timer_cancel(s_wait_timer);
      s_wait_timer = NULL;
    }
    if (!find_offline_list()) show_msg("Phone not", "connected");
  }
}

static void find_request(void) {
  if (!compass_ready()) return;
  if (s_send_timer) {
    app_timer_cancel(s_send_timer);
    s_send_timer = NULL;
  }
  s_wait_list = true;
  s_find_back = false;
  s_no_answer_shown = false;
  s_quiet_reply = false;
  s_send_tries = 0;
  go(SCR_WAIT);
  if (s_wait_timer) app_timer_cancel(s_wait_timer);
  s_wait_timer = app_timer_register(WAIT_TIMEOUT_MS, wait_timer_cb, NULL);
  find_send(NULL);
}

// The list came: on to picking.
static void find_list_received(const uint8_t *b, int len) {
  bool awaiting = s_wait_list && (s_screen == SCR_WAIT || (s_screen == SCR_RESULTS && s_no_answer_shown));
  if (!awaiting) return;
  s_wait_list = false;
  if (s_wait_timer) {
    app_timer_cancel(s_wait_timer);
    s_wait_timer = NULL;
  }
  int n = parse_find_list(b, len);
  if (n == -2) {
    if (!find_offline_list()) show_msg("I need to know", "where you are");
  } else if (n < 0) {
    show_msg("Something went", "wrong");
  } else if (n == 0) {
    show_msg("Nothing to find", "up right now");
  } else {
    pick_show(VIEW_BEST, 0, 0, ROW_NONE);
    reveal_light();
    go(SCR_PICK);
  }
}

// ---------------------------------------------------------------- no phone

// Whether to ask the phone for a new Moon-and-planets table: there is
// none, or it runs out within two days. The ask rides on the next aim or
// Find it request, so it takes no message of its own.
static bool eph_wanted(void) {
  double ra, dec, mag;
  return !eph_body(B_MOON, time(NULL) + 2 * 86400, &ra, &dec, &mag, NULL, NULL);
}

// The Moon-and-planets table, kept in pieces (a stored value holds 256
// bytes at most).
static void save_eph(void) {
  size_t len;
  const uint8_t *b = eph_bytes(&len);
  persist_write_int(PERSIST_EPH_LEN, (int32_t)len);
  for (size_t at = 0, k = 0; at < len; at += PERSIST_DATA_MAX_LENGTH, k++) {
    size_t n = len - at < PERSIST_DATA_MAX_LENGTH ? len - at : PERSIST_DATA_MAX_LENGTH;
    persist_write_data(PERSIST_EPH + (uint32_t)k, b + at, n);
  }
}

static void load_eph(void) {
  if (!persist_exists(PERSIST_EPH_LEN)) return;
  int32_t len = persist_read_int(PERSIST_EPH_LEN);
  if (len <= 0 || len > EPH_MAX) return;
  uint8_t *buf = malloc((size_t)len);
  if (!buf) return;
  bool ok = true;
  for (int32_t at = 0, k = 0; at < len && ok; at += PERSIST_DATA_MAX_LENGTH, k++) {
    int n = len - at < PERSIST_DATA_MAX_LENGTH ? (int)(len - at) : PERSIST_DATA_MAX_LENGTH;
    ok = persist_read_data(PERSIST_EPH + (uint32_t)k, buf + at, (size_t)n) == n;
  }
  if (ok) eph_set(buf, (size_t)len);
  free(buf);
}

// Answers the finished aim (s_out) on the watch: the stars, the Moon and
// planets, when the phone can't. False when the watch can't either: no
// place known yet, or a layer only the phone knows (planes, satellites).
static bool answer_offline(void) {
  if (!s_have_frame || s_tune || (sky_layer() != L_ANY && sky_layer() != L_PLANETS && sky_layer() != L_STARS)) return false;
  SkyAim a = sky_aim(s_out.head_cd / 100.0, s_out.ax, s_out.ay, s_out.az, s_wrist, s_frame.decl,
                     s_frame.yaw[s_wrist], s_frame.pitch[s_wrist]);
  clear_extras();
  if (a.roll_too_far) {
    memset(&s_cards[0], 0, sizeof(Card));
    strcpy(s_cards[0].l1, "Turn your hand");
    strcpy(s_cards[0].l2, "so the watch");
    strcpy(s_cards[0].l3, "faces up more");
    s_ncards = 1;
  } else {
    // As the phone does it (index.js): wider when the compass isn't sure.
    double base = s_out.cal == CompassStatusCalibrated ? 4 : 9;
    double jit = s_out.jit_cd / 100.0 * sky_cosd(a.alt);
    OffPlace at = { s_frame.lat, s_frame.lon, s_frame.sky };
    s_ncards = off_match(a.az, a.alt, sky_sqrt(base * base + jit * jit), sky_layer(), s_out.mid_s, s_out.mid_ms, &at,
                         s_cards, 5);
    if (s_ncards && s_cards[0].type == T_MOON) {
      s_have_moon_look = off_moon_look(s_out.mid_s, &at, s_moon_look);
    }
  }
  if (s_ncards == 0) return false;
  s_card = 0;
  s_offline_shown = true;
  s_no_answer_shown = false;
  uint8_t w = s_cards[0].word;
  if (s_cards[0].type != T_SUN && (w == W_THATS || w == W_PROBABLY)) vibes_short_pulse();
  else vibes_double_pulse();
  reveal_light();
  reveal_start();
  go(SCR_RESULTS);
  return true;
}

// A fixed target for the Find it list, as find.js makes them: up, seen
// as well as the setting asks (how, cards.h SEE_*), marked near the Sun.
// False if it isn't offered.
static bool find_entry(FindTarget *t, uint8_t type, const char *name, double ra, double dec, double mag,
                       double lst, double sun_az, double sun_alt, bool thin_moon) {
  double az, alt;
  sky_eq_to_hor(ra, dec, lst, s_frame.lat, &az, &alt);
  alt += sky_refraction(alt);
  if (alt < 8) return false;
  int how = off_seeing(mag, alt, off_limiting_mag(sun_alt, s_frame.sky));
  if (thin_moon && sun_alt > -1 && how < SEE_CLOSE) how = SEE_CLOSE;   // a pale crescent by day
  if (how > s_frame.see_max) return false;
  memset(t, 0, sizeof(*t));
  t->type = type;
  t->see = (uint8_t)how | sun_flags(how, az, alt, sun_az, sun_alt);
  t->ra = ra;
  t->dec = dec;
  strncpy(t->name, name, sizeof(t->name) - 1);
  off_where(az, alt, t->where, sizeof(t->where));
  return true;
}

// Sorts targets easiest first, the ones too near the Sun last, otherwise
// keeping their order (find.js does the same).
static void find_sort(FindTarget *list, int n) {
  for (int i = 1; i < n; i++) {
    FindTarget t = list[i];
    int j = i;
    for (; j > 0 && see_rank(list[j - 1].see) > see_rank(t.see); j--) list[j] = list[j - 1];
    list[j] = t;
  }
}

// The Find it list made on the watch (no Space Station: that needs the
// phone). False if there's no place known yet.
static bool find_offline_list(void) {
  if (!s_have_frame) return false;
  time_t now = time(NULL);
  double lst = sky_lst(now, 0, s_frame.lon), saz, salt;
  off_sun(now, &s_sun_ra, &s_sun_dec);
  sky_eq_to_hor(s_sun_ra, s_sun_dec, lst, s_frame.lat, &saz, &salt);
  salt += sky_refraction(salt);
  s_find_t0 = now;
  s_skew = 0;
  s_nfind = 0;
  s_find_local = true;
  // The Moon, then the planets brightest first, then the bright stars.
  double ra[B_COUNT], dec[B_COUNT], mag[B_COUNT], lit = 0;
  bool have[B_COUNT];
  for (int b = 0; b < B_COUNT; b++) {
    have[b] = eph_body(b, now, &ra[b], &dec[b], &mag[b], b == B_MOON ? &lit : NULL, NULL);
  }
  // A Moon too new to see isn't offered (as find.js).
  if (have[B_MOON] && lit >= 0.03 &&
      find_entry(&s_find[s_nfind], T_MOON, "The Moon", ra[B_MOON], dec[B_MOON], mag[B_MOON], lst, saz, salt,
                 lit < 0.2)) {
    s_nfind++;
  }
  bool used[B_COUNT] = { true };
  for (;;) {
    int best = -1;
    for (int b = 1; b < B_COUNT; b++) {
      if (have[b] && !used[b] && (best < 0 || mag[b] < mag[best])) best = b;
    }
    if (best < 0) break;
    used[best] = true;
    if (s_nfind < FIND_MAX &&
        find_entry(&s_find[s_nfind], T_PLANET, eph_name(best), ra[best], dec[best], mag[best], lst, saz, salt,
                   false)) {
      s_nfind++;
    }
  }
  // The stars fill the rest, easiest first (as find.js), from the
  // brightest FIND_STARS.
  OffStar *st = malloc(FIND_STARS * sizeof(OffStar));
  FindTarget *ft = malloc(FIND_STARS * sizeof(FindTarget));
  if (st && ft) {
    OffPlace at = { s_frame.lat, s_frame.lon, s_frame.sky };
    int n = off_bright_stars(now, &at, 2.1, 8, st, FIND_STARS), m = 0;
    for (int i = 0; i < n; i++) {
      if (find_entry(&ft[m], T_STAR, st[i].name, st[i].ra, st[i].dec, st[i].mag, lst, saz, salt, false)) m++;
    }
    find_sort(ft, m);
    for (int i = 0; i < m && s_nfind < FIND_MAX; i++) s_find[s_nfind++] = ft[i];
  }
  free(st);
  free(ft);
  find_sort(s_find, s_nfind);
  for (int i = 0; i < s_nfind; i++) s_find[i].id = (uint8_t)i;
  mark_best();
  if (s_nfind == 0) {
    show_msg("Nothing to find", "up right now");
  } else {
    pick_show(VIEW_BEST, 0, 0, ROW_NONE);
    reveal_light();
    go(SCR_PICK);
  }
  return true;
}

// ---------------------------------------------------------------- aiming

static void aim_timer_cb(void *ctx);
static void send_aim(void *ctx);

static void end_aim(void) {
  if (s_aim_timer) {
    app_timer_cancel(s_aim_timer);
    s_aim_timer = NULL;
  }
}

static void cancel_aim(const char *why) {
  end_aim();
  show_msg(why, "Tap SELECT to aim");
}

static void finish_aim(void) {
  end_aim();
  // Circular mean of the headings recorded in the window, and their spread.
  int32_t ss = 0, sc = 0, nc = 0;
  int8_t worst = CompassStatusCalibrated;
  int count = s_ncompass < MAX_READINGS ? s_ncompass : MAX_READINGS;
  for (int i = 0; i < count; i++) {
    ss += sin_lookup(s_compass[i].v);
    sc += cos_lookup(s_compass[i].v);
    if (s_compass[i].cal < worst) worst = s_compass[i].cal;
    nc++;
  }
  if (nc < MIN_COMPASS || s_nsum < 2) {
    vibes_double_pulse();
    show_msg("Try again", "Hold still a moment longer");
    return;
  }
  int32_t mean = atan2_lookup((int16_t)((ss / nc) >> 2), (int16_t)((sc / nc) >> 2));
  // The spread in tenths of a degree, so the sum fits 32 bits (at most
  // 1800 squared, times MAX_READINGS): 64-bit division would cost the app
  // image most of a kilobyte of library code.
  uint32_t var = 0;
  for (int i = 0; i < count; i++) {
    int32_t d = (s_compass[i].v - mean) % TRIG_MAX_ANGLE;
    if (d > TRIG_MAX_ANGLE / 2) d -= TRIG_MAX_ANGLE;
    if (d < -TRIG_MAX_ANGLE / 2) d += TRIG_MAX_ANGLE;
    int32_t ddd = d * 1125 / 20480;   // degrees x 10 (36000 / TRIG_MAX_ANGLE / 10)
    var += (uint32_t)(ddd * ddd);
  }
  int32_t head_cd = (mean + TRIG_MAX_ANGLE) % TRIG_MAX_ANGLE * 1125 / 2048;
  int32_t jit_cd = nc > 1 ? (int32_t)isqrt64(var / (uint32_t)(nc - 1)) * 10 : 0;

  // The middle of the recording, on the watch's clock: now less how long
  // ago that was (a second or two).
  time_t ws;
  uint16_t wms;
  time_ms(&ws, &wms);
  int32_t m = (int32_t)wms - (int32_t)(now_ms() - (s_record_ms + RECORD_MS / 2));
  int32_t q = m / 1000, r = m % 1000;
  if (r < 0) {
    r += 1000;
    q--;
  }
  s_out.mid_s = ws + q;
  s_out.mid_ms = (uint16_t)r;
  s_out.head_cd = head_cd;
  s_out.jit_cd = jit_cd;
  s_out.ax = (int16_t)(s_sum[0] / s_nsum);
  s_out.ay = (int16_t)(s_sum[1] / s_nsum);
  s_out.az = (int16_t)(s_sum[2] / s_nsum);
  s_out.cal = (uint8_t)worst;
  s_out.nc = (uint16_t)nc;
  if (!connection_service_peek_pebble_app_connection()) {
    if (!answer_offline()) show_local_card("Phone not", "connected", "Open the Pebble app");
    return;
  }
  s_seq++;
  persist_write_int(PERSIST_SEQ, s_seq);
  s_send_tries = 0;
  // Got it: lower your arm. A tick, not a buzz: the answer's buzz (sure
  // or not) comes when the phone has worked it out.
  static const uint32_t tick[] = { TAP_MS };
  vibes_enqueue_custom_pattern((VibePattern){ .durations = tick, .num_segments = 1 });
  go(SCR_WAIT);
  send_aim(NULL);
}

// Hands the finished aim to the outbox, retrying for a couple of seconds
// if it is still busy (the AIM_START message from the tap, on a slow link).
static void send_aim(void *ctx) {
  s_send_timer = NULL;
  if (s_screen != SCR_WAIT) return;
  DictionaryIterator *it;
  AppMessageResult r = app_message_outbox_begin(&it);
  if (r == APP_MSG_BUSY && ++s_send_tries < SEND_TRIES) {
    s_send_timer = app_timer_register(SEND_RETRY_MS, send_aim, NULL);
    return;
  }
  if (r != APP_MSG_OK) {
    if (!answer_offline()) show_local_card("Phone busy", "", "Point again");
    return;
  }
  bool ok = dict_write_uint16(it, MESSAGE_KEY_A_SEQ, s_seq) == DICT_OK &&
            dict_write_int32(it, MESSAGE_KEY_A_T, (int32_t)s_out.mid_s) == DICT_OK &&
            dict_write_uint16(it, MESSAGE_KEY_A_MS, s_out.mid_ms) == DICT_OK &&
            dict_write_int32(it, MESSAGE_KEY_A_HEAD, s_out.head_cd) == DICT_OK &&
            dict_write_int32(it, MESSAGE_KEY_A_JIT, s_out.jit_cd) == DICT_OK &&
            dict_write_int16(it, MESSAGE_KEY_A_AX, s_out.ax) == DICT_OK &&
            dict_write_int16(it, MESSAGE_KEY_A_AY, s_out.ay) == DICT_OK &&
            dict_write_int16(it, MESSAGE_KEY_A_AZ, s_out.az) == DICT_OK &&
            dict_write_uint8(it, MESSAGE_KEY_A_CAL, s_out.cal) == DICT_OK &&
            dict_write_uint16(it, MESSAGE_KEY_A_NC, s_out.nc) == DICT_OK &&
            dict_write_uint8(it, MESSAGE_KEY_A_LAYER, sky_layer()) == DICT_OK &&
            dict_write_uint8(it, MESSAGE_KEY_A_WRIST, s_wrist) == DICT_OK &&
            (!s_tune || dict_write_uint8(it, MESSAGE_KEY_A_TUNE, (uint8_t)(s_tune_n + 1)) == DICT_OK);
  if (!ok || app_message_outbox_send() != APP_MSG_OK) {
    if (!answer_offline()) show_local_card("Phone not", "connected", "Open the Pebble app");
    return;
  }
  if (s_wait_timer) app_timer_cancel(s_wait_timer);
  s_wait_timer = app_timer_register(WAIT_TIMEOUT_MS, wait_timer_cb, NULL);
}

static void aim_timer_cb(void *ctx) {
  s_aim_timer = NULL;
  if (s_screen != SCR_AIM) return;
  vibes_double_pulse();
  cancel_aim("Let's try again");
}

static void start_settle(void) {
  s_phase = AIM_SETTLE;
  s_settle_ms = now_ms();
}

static void start_record(const int16_t m[3]) {
  s_phase = AIM_RECORD;
  s_record_ms = now_ms();
  memcpy(s_rec0, m, sizeof(s_rec0));
  s_sum[0] = s_sum[1] = s_sum[2] = 0;
  s_nsum = 0;
  s_ncompass = 0;
}

// One accelerometer batch (200 ms) during an aim.
static void aim_accel(const int16_t m[3], int32_t spread) {
  uint64_t now = now_ms();
  bool still = spread <= STEADY_SPREAD_MG &&
               (!s_have_prev || dist2(m, s_prev) <= STEADY_STEP_MG * STEADY_STEP_MG);
  memcpy(s_prev, m, sizeof(s_prev));
  s_have_prev = true;

  switch (s_phase) {
    case AIM_MOVE:
      if (!s_have_tap) {
        memcpy(s_tap, m, sizeof(s_tap));
        s_have_tap = true;
#if defined(SKY_SHOT) && (SKY_SHOT == 9 || SKY_SHOT == 18)
        start_settle();   // harness: the emulator's arm never moves
#endif
      } else if (dist2(m, s_tap) > MOVE_MG * MOVE_MG ||
                 (forearm_el_cd(s_tap) > RAISED_EL_CD && now - s_tap_ms >= RAISED_WAIT_MS)) {
        start_settle();
      }
      break;
    case AIM_SETTLE:
      if (!still) {
        s_settle_ms = now;
      } else if (now - s_settle_ms >= SETTLE_MS) {
        start_record(m);
      }
      break;
    case AIM_RECORD:
      if (!still || dist2(m, s_rec0) > RECORD_DRIFT_MG * RECORD_DRIFT_MG) {
        start_settle();   // moved: start the steady wait over
        break;
      }
      s_sum[0] += m[0];
      s_sum[1] += m[1];
      s_sum[2] += m[2];
      s_nsum++;
      if (s_nsum >= RECORD_BATCHES && (s_ncompass >= MIN_COMPASS || s_nsum >= RECORD_MAX_BATCHES)) {
        finish_aim();
      }
      break;
  }
  layer_mark_dirty(s_canvas);
}

static void start_aim(void) {
  if (!compass_ready()) return;
  s_quiet_reply = false;
  s_find_back = false;
  if (s_send_timer) {
    app_timer_cancel(s_send_timer);
    s_send_timer = NULL;
  }
  s_no_answer_shown = false;
  s_tap_ms = now_ms();
  s_phase = AIM_MOVE;
  s_have_tap = s_have_prev = false;
  s_ncompass = 0;
  s_nsum = 0;
  end_aim();
  s_aim_timer = app_timer_register(AIM_TIMEOUT_MS, aim_timer_cb, NULL);
  // Let the phone know, so it can freshen its location while you point.
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) == APP_MSG_OK) {
    dict_write_uint8(it, MESSAGE_KEY_AIM_START, s_tune ? AIM_START_TUNE : sky_layer());
    if (eph_wanted()) dict_write_uint8(it, MESSAGE_KEY_EPH_REQ, 1);
    app_message_outbox_send();
  }
  go(SCR_AIM);
}

// ---------------------------------------------------------------- sensors

static void coach_finish_cb(void *ctx);
static void coach_check_cb(void *ctx);

static void compass_handler(CompassHeadingData data) {
  CompassStatus was = s_cal;
  s_cal = data.compass_status;
  if (s_cal == CompassStatusCalibrated) {
    s_uncal_since = 0;
  } else if (!s_uncal_since) {   // lost it: the coach takes over if it stays lost
    s_uncal_since = now_ms();
    app_timer_register(COACH_DELAY_MS, coach_check_cb, NULL);
  }
  bool usable = s_cal == CompassStatusCalibrating || s_cal == CompassStatusCalibrated;
  // Readings just after a tick are skipped.
  if (usable && s_screen == SCR_FIND && now_ms() >= s_quiet_until) {
    s_fhead = data.magnetic_heading;
    s_have_fhead = true;
    find_update();
  }
  if (usable) {
    s_have_heading = true;
    if (s_screen == SCR_AIM && s_phase == AIM_RECORD && s_ncompass < MAX_READINGS) {
      s_compass[s_ncompass++] = (Reading){ .t = (uint32_t)(now_ms() - s_record_ms),
                                           .v = data.magnetic_heading, .cal = (int8_t)s_cal };
    }
  }
  if (s_screen == SCR_COACH && !s_coach_done && s_cal == CompassStatusCalibrated) {
    s_coach_done = now_ms();
    vibes_short_pulse();
    app_timer_register(COACH_DONE_MS, coach_finish_cb, NULL);
  }
  if (was != s_cal && (s_screen == SCR_HOME || s_screen == SCR_COACH)) layer_mark_dirty(s_canvas);
}

static void accel_handler(AccelData *data, uint32_t n) {
#if defined(SKY_SHOT) && SKY_SHOT == 2
  return;   // harness: hold the aiming screen still for its screenshot
#endif
  if (s_screen != SCR_AIM && s_screen != SCR_FIND) return;
  // Only the screen's own batches: an idle batch (a second, from before
  // the tap) can still arrive before the switch. Once it's made, the
  // firmware drops what was buffered, so the first batch after it is all
  // new.
  // While "how to find it" shows, its slow batches keep a reading ready
  // for the tap (the tapes show at once; 25 wake-ups a second while it's
  // read would cost battery).
  bool intro = s_screen == SCR_FIND && s_fs.intro;
  if (!intro && s_accel_batch != (s_screen == SCR_FIND ? ACCEL_FIND_BATCH : ACCEL_BATCH)) return;
  int32_t sx = 0, sy = 0, sz = 0, used = 0;
  int16_t lo[3] = { INT16_MAX, INT16_MAX, INT16_MAX }, hi[3] = { INT16_MIN, INT16_MIN, INT16_MIN };
  for (uint32_t i = 0; i < n; i++) {
    if (data[i].did_vibrate) continue;
    int16_t v[3] = { data[i].x, data[i].y, data[i].z };
    for (int k = 0; k < 3; k++) {
      if (v[k] < lo[k]) lo[k] = v[k];
      if (v[k] > hi[k]) hi[k] = v[k];
    }
    sx += v[0];
    sy += v[1];
    sz += v[2];
    used++;
  }
  if (used == 0) return;
  int16_t m[3] = { (int16_t)(sx / used), (int16_t)(sy / used), (int16_t)(sz / used) };
  if (s_screen == SCR_FIND) {
    // One sample at a time: halfway to each new one, to calm a shaky hand.
    for (int k = 0; k < 3; k++) s_fa[k] = s_have_fa ? (int16_t)((s_fa[k] + m[k]) / 2) : m[k];
    s_have_fa = true;
    find_update();
    return;
  }
  int32_t spread = 0;
  for (int k = 0; k < 3; k++) {
    if (hi[k] - lo[k] > spread) spread = hi[k] - lo[k];
  }
  aim_accel(m, spread);
}

// ---------------------------------------------------------------- coach

static void coach_tick(void *ctx) {
  s_coach_timer = NULL;
  if (s_screen != SCR_COACH) return;
  s_coach_step = (s_coach_step + 1) % 64;
  layer_mark_dirty(s_canvas);
  s_coach_timer = app_timer_register(COACH_TICK_MS, coach_tick, NULL);
}

static void intro_after_coach(void);

static void leave_coach(void) {
  if (s_coach_timer) {
    app_timer_cancel(s_coach_timer);
    s_coach_timer = NULL;
  }
  if (s_intro) intro_after_coach();
  else go(s_tune ? SCR_TUNE : SCR_HOME);
  if (s_cal != CompassStatusCalibrated) app_timer_register(1000, coach_check_cb, NULL);   // lost again already
}

static void coach_finish_cb(void *ctx) {
  if (s_screen == SCR_COACH) leave_coach();
}

static void open_coach(void) {
  s_coach_start = now_ms();
  s_coach_done = 0;
  s_coach_step = 0;
  go(SCR_COACH);
  if (!s_coach_timer) s_coach_timer = app_timer_register(COACH_TICK_MS, coach_tick, NULL);
}

// The compass needs calibrating: the coach takes over (it can't be
// skipped; BACK leaves the app) once the compass has been uncalibrated
// COACH_DELAY_MS, so a blip doesn't interrupt. Not over an aim, an answer
// or a question (it takes over when they're left; aims and finding can't
// start without it, compass_ready), nor in the first run (which has the
// coach as a step). Checked again each second until it's calibrated.
static void coach_check_cb(void *ctx) {
#ifndef SKY_SHOT   // the emulator's compass never calibrates
  if (s_cal == CompassStatusCalibrated) return;
  if (s_screen == SCR_COACH) return;
  // Not over an answer, a question or an aim: once they're left.
  bool can = s_screen == SCR_HOME || s_screen == SCR_MENU || s_screen == SCR_PICK || s_screen == SCR_MSG ||
             s_screen == SCR_TUNE || s_screen == SCR_FIND;
  if (now_ms() - s_uncal_since < COACH_DELAY_MS || s_intro || !can) {
    app_timer_register(1000, coach_check_cb, NULL);
    return;
  }
  if (s_screen == SCR_FIND) stop_find();
  open_coach();
#endif
}

// ---------------------------------------------------------------- first run, tune

static void finish_intro(void) {
  s_intro = false;
  persist_write_bool(PERSIST_INTRO, true);
}

static void intro_after_coach(void) {
  s_intro_step = INTRO_READY;
  go(SCR_INTRO);
}

static void open_choice(uint8_t which, bool place) {
  s_choice = which;
  s_choice_place = place;
  s_choice_row = which == CHOICE_SKY ? sky_code() : gear_row();
  go(SCR_CHOICE);
}

static void intro_pick_wrist(uint8_t wrist) {
  s_wrist = wrist;
  persist_write_int(PERSIST_WRIST, s_wrist);
  open_choice(CHOICE_SKY, false);
}

// The phone has moved far since the sky was set, and it's dark: ask again.
static void ask_place(void) {
  s_place_ask = false;
  s_place_asked = true;
  bump_idle();
  vibes_short_pulse();
  reveal_light();
  open_choice(CHOICE_SKY, true);
}

static void go_home(void);

static void choice_pick(int row) {
  if (s_choice == CHOICE_SKY) set_prefs((uint8_t)((s_prefs & 0xf0) | row));
  else set_prefs((uint8_t)((s_prefs & 0xcf) | GEAR_SHOW[row] << 4));
  if (!s_intro) {
    vibes_short_pulse();
    go_home();
  } else if (s_choice == CHOICE_SKY) {
    open_choice(CHOICE_GEAR, false);
  } else if (s_cal != CompassStatusCalibrated) {
    open_coach();
  } else {
    intro_after_coach();
  }
}

// BACK: in the first run, the question before; for a new place, the sky
// stays as it was, but now for here (so the phone stops asking).
static void choice_back(void) {
  if (!s_intro) {
    set_prefs(s_prefs);
    go_home();
  } else if (s_choice == CHOICE_GEAR) {
    open_choice(CHOICE_SKY, false);
  } else {
    s_intro_step = INTRO_WRIST;
    go(SCR_INTRO);
  }
}

static void start_session(void) {
  if (!s_moon_tgt[0]) {
    show_msg("The Moon isn't up", "or is too low or high");
    return;
  }
  strncpy(s_tune_tgt, s_moon_tgt, sizeof(s_tune_tgt) - 1);
  strncpy(s_tune_where, s_moon_where, sizeof(s_tune_where) - 1);
  s_tune = true;
  s_tune_n = 0;
  s_tune_note[0] = '\0';
  go(SCR_TUNE);
}

static void go_home(void) {
  s_tune = false;
  go(SCR_HOME);
}

// The answer to "is your watch on your LEFT wrist?".
static void wrist_answer(bool yes) {
  if (yes) {
    s_wrist_ok = true;
    deliver_reply(s_tune ? s_pending_tune : -1);   // a session that ended meanwhile gets plain answers
    return;
  }
  s_wrist = s_wrist ? 0 : 1;
  persist_write_int(PERSIST_WRIST, s_wrist);
  s_tune_n = 0;   // a tune starts again for this wrist
  s_tune_note[0] = '\0';
  vibes_short_pulse();
  show_msg("Changed it to your", s_wrist ? "RIGHT wrist" : "LEFT wrist");
}

// ---------------------------------------------------------------- buttons

static void idle_arm(void);

static void idle_cb(void *ctx) {
  s_idle_timer = NULL;
  // Aiming, waiting, or finding (until "Still looking?"): not idle.
  if (s_screen == SCR_AIM || s_screen == SCR_WAIT || (s_screen == SCR_FIND && !s_fs.timeout && !s_fs.intro)) {
    idle_arm();
    return;
  }
  window_stack_pop_all(false);
}

static void idle_arm(void) {
  if (s_idle_timer) app_timer_cancel(s_idle_timer);
  s_idle_timer = app_timer_register(IDLE_EXIT_MS, idle_cb, NULL);
}

// A button or a touch: also, someone's reading.
static void bump_idle(void) {
  idle_arm();
  light_read_more();
}

// The next rung on (dir +1 up the ladder), round from one end to the other.
static int next_layer(int dir) {
  int at = 0;
  for (int i = 0; i < RUNG_COUNT; i++) {
    if (RUNG_ORDER[i] == s_layer) at = i;
  }
  for (int i = 1; i < RUNG_COUNT; i++) {
    int l = RUNG_ORDER[((at + dir * i) % RUNG_COUNT + RUNG_COUNT) % RUNG_COUNT];
    if (layer_on(l)) return l;
  }
  return s_layer;
}

// Settings is never remembered as the rung to open on.
static void home_step(int dir) {
  int l = next_layer(dir);
  if (l == s_layer) return;
  s_layer = (uint8_t)l;
  if (s_layer < L_COUNT) persist_write_int(PERSIST_LAYER, s_layer);
  slide_start(dir);
}

static int wrap(int i, int n) {
  return n > 0 ? ((i % n) + n) % n : 0;
}

// UP (-1) and DOWN (+1) on a list: the answers and their pages in turn,
// the menu's rows, the Find it list; round from the end to the start.
static void list_step(int dir) {
  if (s_screen == SCR_RESULTS) s_card = wrap(s_card + dir, s_ncards);
  else if (s_screen == SCR_MENU) s_menu_row = wrap(s_menu_row + dir, menu_rows());
  else if (s_screen == SCR_PICK) s_pick_row = wrap(s_pick_row + dir, s_nrows);
  else if (s_screen == SCR_CHOICE) s_choice_row = wrap(s_choice_row + dir, 3);
  // A list glides to show the new row; an answer half dragged goes back.
  ListGeom g;
  if (list_geom(&g)) {
    s_scroll_touch = false;
    list_scroll(&g);   // a flick's target can be past the end
    s_scroll_to = (int16_t)scroll_showing(&g, *list_sel(), s_scroll_to);
    motion_start();
  }
  if (s_screen == SCR_RESULTS) motion_reset();
  layer_mark_dirty(s_canvas);
}

static void up_click(ClickRecognizerRef rec, void *ctx) {
  bump_idle();
  switch (s_screen) {
    case SCR_INTRO:
      if (s_intro_step == INTRO_WRIST) intro_pick_wrist(0);
      break;
    case SCR_WRISTQ:
      wrist_answer(true);
      break;
    case SCR_HOME:
      home_step(1);
      break;
    case SCR_RESULTS:
    case SCR_MENU:
    case SCR_PICK:
    case SCR_CHOICE:
      list_step(-1);
      break;
    default:
      break;
  }
}

static void down_click(ClickRecognizerRef rec, void *ctx) {
  bump_idle();
  switch (s_screen) {
    case SCR_INTRO:
      if (s_intro_step == INTRO_WRIST) intro_pick_wrist(1);
      break;
    case SCR_WRISTQ:
      wrist_answer(false);
      break;
    case SCR_HOME:
      home_step(-1);
      break;
    case SCR_RESULTS:
    case SCR_MENU:
    case SCR_PICK:
    case SCR_CHOICE:
      list_step(1);
      break;
    default:
      break;
  }
}

static void select_click(ClickRecognizerRef rec, void *ctx) {
  bump_idle();
  switch (s_screen) {
    case SCR_AIM:
      cancel_aim("Cancelled");
      break;
    case SCR_COACH:   // no skipping it: the app needs the compass
      break;
    case SCR_MENU:
      switch (s_menu_row) {
        case MENU_SKY:
          set_prefs((uint8_t)((s_prefs & 0xf0) | (sky_code() + 1) % SKY_COUNT));
          break;
        case MENU_GEAR:
          set_prefs((uint8_t)((s_prefs & 0xcf) | GEAR_SHOW[(gear_row() + 1) % GEAR_COUNT] << 4));
          break;
        case MENU_LIGHT:
          set_prefs((uint8_t)((s_prefs & 0x3f) | (light_mode() + 1) % LIGHT_COUNT << 6));
          break;
        case MENU_THEME: {
          int at = 0;
          for (int i = 0; i < THEME_COUNT; i++) {
            if (THEME_ORDER[i] == s_theme) at = i;
          }
          s_theme = THEME_ORDER[(at + 1) % THEME_COUNT];
          s_theme_set = true;
          persist_write_int(PERSIST_THEME, s_theme);
          apply_theme();
          prefs_send();   // the phone's settings page takes its colours from it
          break;
        }
        case MENU_WRIST:
          s_wrist = s_wrist ? 0 : 1;
          persist_write_int(PERSIST_WRIST, s_wrist);
          break;
        default:
          start_session();
          return;
      }
      layer_mark_dirty(s_canvas);
      break;
    case SCR_CHOICE:
      choice_pick(s_choice_row);
      break;
    case SCR_WRISTQ:
      break;
    case SCR_PICK: {
      if (s_pick_row >= s_nrows) break;
      int r = s_rows[s_pick_row];
      if (r == ROW_MORE) {
        pick_show(VIEW_KINDS, 0, 0, ROW_NONE);
      } else if (r <= ROW_KIND) {
        pick_show(VIEW_KIND, (uint8_t)(ROW_KIND - r), 0, ROW_NONE);
      } else if (!find_sun_ok(&s_find[r])) {
        // Too near the Sun: it stays on the list so you know why, but isn't found.
        vibes_double_pulse();
      } else {
        start_find(r);
      }
      break;
    }
    case SCR_FIND:
      // Found: its card (once it has one). Else start (from how to find
      // it) or start the clock again (after "Still looking?"), same
      // target, unless the Sun has come near it since: back to the list.
      if (s_fs.found) {
        if (s_find_sent) found_show();
      } else if (find_sun_ok(&s_find[s_find_cur])) {
        find_begin();
      } else {
        stop_find();
        vibes_double_pulse();
        pick_show(s_pick_view, s_pick_kind, 0, s_find_cur);
        go(SCR_PICK);
      }
      break;
    case SCR_INTRO:
      if (s_intro_step != INTRO_READY) break;
      finish_intro();
      // and aim, as a tap on Home would
      if (s_cal != CompassStatusCalibrated) open_coach();
      else start_aim();
      break;
    case SCR_WAIT:
      if (s_wait_timer) {
        app_timer_cancel(s_wait_timer);
        s_wait_timer = NULL;
      }
      if (s_wait_list) find_request();
      else start_aim();
      break;
    default:
      if (s_msg_timer) {
        app_timer_cancel(s_msg_timer);
        s_msg_timer = NULL;
      }
      // On the Settings rung (and a message over it, "The Moon isn't up")
      // SELECT opens the menu rather than aiming.
      if (s_layer == RUNG_SETTINGS && !s_tune && (s_screen == SCR_HOME || s_screen == SCR_MSG)) {
        s_menu_row = 0;
        go(SCR_MENU);
      } else if (s_cal != CompassStatusCalibrated) {
        open_coach();
      } else if (s_layer == L_FIND && !s_tune) {
        find_request();
      } else {
        start_aim();
      }
      break;
  }
}

// A press held past the long-click time swallows the single click, so
// outside Home and Results a long press does what a tap would. Results
// opens the menu too: a "nothing there" card can suggest Tune on the Moon.
static void select_long(ClickRecognizerRef rec, void *ctx) {
  bump_idle();
  if (s_screen == SCR_HOME || (s_screen == SCR_RESULTS && !s_tune)) {
    s_menu_row = 0;
    go(SCR_MENU);
  } else {
    select_click(rec, ctx);
  }
}

static void back_click(ClickRecognizerRef rec, void *ctx) {
  bump_idle();
  switch (s_screen) {
    case SCR_HOME:
      window_stack_pop_all(true);
      break;
    case SCR_INTRO:
      if (s_intro_step == INTRO_WRIST) {
        window_stack_pop_all(true);   // asked again next time
      } else {
        finish_intro();
        go_home();
      }
      break;
    case SCR_TUNE:
      go_home();
      break;
    case SCR_WRISTQ:
      wrist_answer(true);   // leave it as it is
      break;
    case SCR_CHOICE:
      choice_back();
      break;
    case SCR_AIM:
      cancel_aim("Cancelled");
      break;
    case SCR_COACH:
      window_stack_pop_all(true);
      break;
    case SCR_WAIT:
      if (s_wait_timer) {
        app_timer_cancel(s_wait_timer);
        s_wait_timer = NULL;
      }
      s_wait_list = false;
      go(s_tune ? SCR_TUNE : SCR_HOME);
      break;
    case SCR_FIND:
      stop_find();
      go(SCR_PICK);
      break;
    case SCR_PICK:
      // One kind's targets: back to the kinds; the kinds: back to Best now.
      if (s_pick_view == VIEW_KIND) {
        pick_show(VIEW_KINDS, 0, 0, ROW_KIND - s_pick_kind);
        break;
      }
      if (s_pick_view == VIEW_KINDS) {
        pick_show(VIEW_BEST, 0, 0, ROW_MORE);
        break;
      }
      s_wait_list = false;
      go(s_tune ? SCR_TUNE : SCR_HOME);
      break;
    default:
      s_wait_list = false;
      if (s_screen == SCR_RESULTS && s_find_back) {
        // Its card, from Find it: found it, so back to the list it was
        // picked from, on its row. Its reply is done with, even if late.
        s_find_back = false;
        s_no_answer_shown = s_quiet_reply = false;
        if (s_send_timer) {
          app_timer_cancel(s_send_timer);
          s_send_timer = NULL;
        }
        go(SCR_PICK);
        break;
      }
      go(s_tune ? SCR_TUNE : SCR_HOME);
      break;
  }
}

static void click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
  window_long_click_subscribe(BUTTON_ID_SELECT, 600, select_long, NULL);
  window_single_click_subscribe(BUTTON_ID_BACK, back_click);
}

// ---------------------------------------------------------------- touch

// Touch (the Pebble Time 2's screen): drag up or down, drag left or
// right, and tap. The screen follows the finger, so dragging up brings up
// what's below: on Home and in lists that's DOWN. On Results, up and down
// go from one answer to the next and left and right through an answer's
// pages, all round. A tap is SELECT, or picks the row it lands on (on the
// two-answer questions, a tap by an answer). Right is BACK where nothing
// goes sideways (Home, so it leaves the app as BACK does, the lists,
// Tune). The compass coach, aiming, finding
// and waiting ignore the screen: a sleeve or the other hand brushing it
// mustn't spoil an aim.
//
// Read from the raw touch stream, not the SDK's gesture recognizers: on
// the watch's 4.33 firmware an app's recognizers never fired (the raw
// events came, the recognizers stayed silent), and its swipe needs 30 px
// in 300 ms, which a finger on a wrist often doesn't manage. A touch that
// stays within TAP_SLOP_PX and lifts within TAP_MAX_MS is a tap; one that
// ends DRAG_MIN_PX or more along one axis (at least twice the other) is a
// drag that way, at any speed.
#define DRAG_MIN_PX 30

// The coach is ignored too: the arm is drawing an 8, and a brush would
// skip the calibration.
static bool touch_ignored(void) {
  return s_screen == SCR_AIM || (s_screen == SCR_FIND && !s_fs.found && !s_fs.intro) || s_screen == SCR_WAIT ||
         s_screen == SCR_COACH;
}

// The card dir on from this one (+1 the next), round: across, this
// answer's next page; else the next answer, at its first page.
static int card_next(int dir, bool across) {
  int start = group_start(s_card);
  if (across) return start + wrap(s_card - start + dir, group_len(start));
  int k = wrap(group_index(start) + dir, group_count());
  for (int i = 0, g = -1; i < s_ncards; i++) {
    if ((i == 0 || !is_page(i)) && ++g == k) return i;
  }
  return s_card;
}

// The answer dir answers on (+1 the next), at its first page.
static void answer_step(int dir) {
  bump_idle();
  s_card = card_next(dir, false);
  layer_mark_dirty(s_canvas);
}

// This answer's page dir on (+1 the next), round. False with no pages.
static bool page_step(int dir) {
  if (group_len(group_start(s_card)) < 2) return false;
  bump_idle();
  s_card = card_next(dir, true);
  layer_mark_dirty(s_canvas);
  return true;
}

// ---------------------------------------------------------------- motion

// One timer for what moves on its own: the wait screen, a list gliding to
// where a flick or a button sends it, an answer going on to the next (or
// springing back) after the finger lets go. It stops when nothing moves.
#define MOTION_MS      33
#define CARD_GO_PX     50      // drag an answer this far (or flick it) and it goes on
#define CARD_FLICK     8       // ... a flick: pixels a frame
#define FLICK_FRAMES   8       // a flick glides about this many frames' worth on
#define FLICK_MAX      40      // pixels a frame, at most

// The canvas where the dragged answer is, and the next one right beside
// it, edge to edge (off the screen while it's still).
static void card_place(void) {
  int off = s_card_off, size = s_card_across ? 200 : 228, next = off < 0 ? off + size : off - size;
  layer_set_frame(s_canvas, s_card_across ? GRect(off, 0, 200, 228) : GRect(0, off, 200, 228));
  if (s_peek) layer_set_frame(s_peek, s_card_across ? GRect(next, 0, 200, 228) : GRect(0, next, 200, 228));
}

// A list's scroll, moved by the finger (or a flick): within the list, and
// the chosen row kept on screen.
static void scroll_set(int px) {
  ListGeom g;
  if (!list_geom(&g) || !g.n) return;
  int max = list_max(&g);
  s_scroll = (int16_t)(px < 0 ? 0 : px > max ? max : px);
  int first = (s_scroll + g.step - 1) / g.step, last = (s_scroll + (g.shown - 1) * g.step) / g.step;
  int *sel = list_sel();
  if (*sel < first) *sel = first;
  else if (*sel > last) *sel = last;
}

// Most of the way there each frame (ease out), at least a pixel.
static int16_t ease_to(int16_t v, int16_t to, int div) {
  int d = (to - v) / div;
  if (!d) d = to > v ? 1 : to < v ? -1 : 0;
  return (int16_t)(v + d);
}

static void motion_cb(void *ctx) {
  s_motion_timer = NULL;
  if (!s_canvas) return;   // the window has gone
  bool more = s_screen == SCR_WAIT;
  if (s_scroll != s_scroll_to) {
    int16_t v = ease_to(s_scroll, s_scroll_to, 3);
    if (s_scroll_touch) scroll_set(v);
    else s_scroll = v;
    if (s_scroll != v) s_scroll_to = s_scroll;   // hit the end
    more = true;
  }
  if (s_card_off != s_card_to || s_card_go) {
    s_card_off = ease_to(s_card_off, s_card_to, 2);
    if (s_card_off == s_card_to && s_card_go) {
      // Gone, and the next one (drawn beside it) is in place: it's the one.
      if (s_card_across) page_step(s_card_go);
      else answer_step(s_card_go);
      s_card_go = 0;
      s_card_off = s_card_to = 0;
    }
    card_place();
    more = true;
  }
  layer_mark_dirty(s_canvas);
  if (more) s_motion_timer = app_timer_register(MOTION_MS, motion_cb, NULL);
}

static void motion_start(void) {
  if (!s_motion_timer) s_motion_timer = app_timer_register(MOTION_MS, motion_cb, NULL);
}

// A new screen (or a new list on it): the list scrolled to show its
// chosen row, as if it had just opened; an answer back in its place.
static void motion_reset(void) {
  ListGeom g;
  s_scroll = s_scroll_to = list_geom(&g) ? (int16_t)scroll_showing(&g, *list_sel(), 0) : 0;
  s_card_off = s_card_to = 0;
  s_card_go = 0;
  if (s_canvas) card_place();
  if (s_screen == SCR_WAIT) motion_start();
}

// The touch handlers return whether the gesture did anything (and so
// lights the screen). dir +1: the finger went up (or left).
// (The lists and the answers follow the finger instead: touch_drag.)
static bool touch_vertical(int dir) {
  if (s_screen != SCR_HOME) return false;   // the wrist questions answer only to a tap on an answer
  if (dir > 0) down_click(NULL, NULL);
  else up_click(NULL, NULL);
  return true;
}

static bool touch_horizontal(int dir) {
  if (dir < 0 && (s_screen == SCR_MENU || s_screen == SCR_PICK || s_screen == SCR_TUNE || s_screen == SCR_HOME ||
                  s_screen == SCR_CHOICE)) {
    back_click(NULL, NULL);
    return true;
  }
  return false;
}

// The row of a list (rows `step` apart from y0, `h` high, scrolled
// `scroll` pixels, `n` in all) at y, or -1.
static int row_at(int y, int y0, int step, int h, int scroll, int n) {
  if (y < y0) return -1;
  int k = (y - y0 + scroll) / step;
  if (y - y0 + scroll - k * step >= h) return -1;
  return k < n ? k : -1;
}

// The wrist questions' answers sit by UP (top) and DOWN (bottom); a tap on
// the question between them is nothing.
#define ANSWER_TOP_Y    64
#define ANSWER_BOTTOM_Y 164

static bool touch_tap(GPoint at) {
  int row = -1;
  switch (s_screen) {
    case SCR_INTRO:
    case SCR_WRISTQ:
      if (s_screen == SCR_INTRO && s_intro_step != INTRO_WRIST) select_click(NULL, NULL);
      else if (at.y < ANSWER_TOP_Y) up_click(NULL, NULL);
      else if (at.y > ANSWER_BOTTOM_Y) down_click(NULL, NULL);
      else return false;
      return true;
    case SCR_MENU:
    case SCR_PICK: {
      ListGeom g;
      list_geom(&g);
      if ((row = row_at(at.y, g.y0, g.step, g.h, list_scroll(&g), g.n)) < 0) return false;
      *list_sel() = row;
      break;
    }
    case SCR_CHOICE:
      if ((row = row_at(at.y, MENU_Y, MENU_STEP, MENU_H, 0, 3)) < 0) return false;
      s_choice_row = row;
      break;
    default:
      break;
  }
  select_click(NULL, NULL);
  return true;
}

#define TAP_SLOP_PX 12
#define TAP_MAX_MS  600

static struct {
  bool down;                 // a touch is in progress (and counts)
  Screen screen;             // ... begun on this screen
  GPoint start, last, far;   // where it began, its last position, its furthest from start
  uint64_t t0, t_last;       // when it began, and the last position came
  bool drag, across;         // past a tap's slop: a drag, and which way it went first
  int16_t scroll0;           // the list's scroll when it began
  int16_t vel;               // the finger's speed along the drag, pixels a frame (+ right or down)
} s_touch;

// An answer still on its way (a flick, then a new touch): there at once.
static void card_settle(void) {
  if (s_card_go) {
    if (s_card_across) page_step(s_card_go);
    else answer_step(s_card_go);
  }
  s_card_off = s_card_to = 0;
  s_card_go = 0;
  card_place();
}

// Whether the answer dragged has somewhere to go: another answer (down)
// or another page of it (across).
static bool card_can_go(void) {
  return s_card_across ? group_len(group_start(s_card)) > 1 : group_count() > 1;
}

// The answer coming in beside the one dragged: drawn as the canvas draws
// that one (one picture on the heap still: only an answer's first page has
// one, and two first pages are never side by side with it).
static void peek_update(Layer *layer, GContext *ctx) {
  if (s_screen != SCR_RESULTS || !s_card_off || !card_can_go()) return;
  Palette p = palette();
  graphics_context_set_fill_color(ctx, p.bg);
  graphics_fill_rect(ctx, layer_get_bounds(layer), 0, GCornerNone);
  int keep = s_card;
  s_card = card_next(s_card_off < 0 ? 1 : -1, s_card_across);
  draw_results(ctx, p);
  s_card = keep;
}

// The finger moved, d pixels from where it began along the drag: a list
// scrolls with it; an answer follows it (only a little if there's
// nothing to go on to).
static void touch_drag(int d) {
  ListGeom g;
  if (!s_touch.across && list_geom(&g)) {
    s_scroll_touch = true;
    scroll_set(s_touch.scroll0 - d);
    s_scroll_to = s_scroll;
  } else if (s_screen == SCR_RESULTS) {
    s_card_across = s_touch.across;
    s_card_off = s_card_to = (int16_t)(card_can_go() ? d : d / 4);
    card_place();
  } else {
    return;
  }
  bump_idle();
  layer_mark_dirty(s_canvas);
}

// The finger let go of a drag (vel: its speed, pixels a frame): a list
// glides on a way; an answer dragged (or flicked) far enough goes on to
// the next, or springs back. False if the drag wasn't one of those.
static bool touch_release(int vel) {
  ListGeom g;
  if (!s_touch.across && list_geom(&g)) {
    s_scroll_touch = true;
    s_scroll_to = (int16_t)(s_scroll - vel * FLICK_FRAMES);
    list_scroll(&g);   // within the list, so the glide ends
    motion_start();
    return true;
  }
  if (s_screen != SCR_RESULTS) return false;
  int off = s_card_off, dir = 0;
  if (card_can_go()) {
    if (off <= -CARD_GO_PX || (off < -10 && vel <= -CARD_FLICK)) dir = 1;   // up or left: the next
    else if (off >= CARD_GO_PX || (off > 10 && vel >= CARD_FLICK)) dir = -1;
  }
  int size = s_card_across ? 200 : 228;
  s_card_to = (int16_t)(dir > 0 ? -size : dir < 0 ? size : 0);
  s_card_go = (int8_t)dir;
  motion_start();
  return true;
}

static void touch_handler(const TouchEvent *ev, void *ctx) {
  GPoint at = GPoint(ev->x, ev->y);
  if (ev->type == TouchEvent_Touchdown) {
    // A touch on the idle watchface's behalf (non_navigational) never counts,
    // nor one begun where the screen is ignored.
    s_touch.down = !ev->non_navigational && !touch_ignored();
    s_touch.screen = s_screen;
    s_touch.start = s_touch.last = at;
    s_touch.far = GPoint(0, 0);
    s_touch.t0 = s_touch.t_last = now_ms();
    s_touch.drag = false;
    s_touch.vel = 0;
    // A finger on a flicked list stops it where it is (a button's glide
    // goes on to its row); an answer on its way is there at once.
    if (s_touch.down && s_screen == SCR_RESULTS) card_settle();
    ListGeom g;
    if (s_touch.down && list_geom(&g) && s_scroll != s_scroll_to) {
      s_scroll_touch = true;
      scroll_set(s_scroll);   // stopped part way: the chosen row on screen
      s_scroll_to = s_scroll;
    }
    s_touch.scroll0 = s_scroll;
    return;
  }
  if (!s_touch.down) return;
  if (ev->type == TouchEvent_PositionUpdate) {
    // The liftoff's own position isn't reliable (the driver reports (0, 0)),
    // so the gesture ends at the last update.
    uint64_t t = now_ms();
    int dt = (int)(t - s_touch.t_last);
    if (s_touch.drag && dt > 0) {
      int step = s_touch.across ? at.x - s_touch.last.x : at.y - s_touch.last.y;
      int v = step * MOTION_MS / dt;   // one sample a millisecond after the last mustn't fling it far
      if (v > FLICK_MAX) v = FLICK_MAX;
      if (v < -FLICK_MAX) v = -FLICK_MAX;
      s_touch.vel = (int16_t)((s_touch.vel + v) / 2);
    }
    s_touch.t_last = t;
    s_touch.last = at;
    int dx = at.x - s_touch.start.x, dy = at.y - s_touch.start.y;
    int ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
    if (ax > s_touch.far.x) s_touch.far.x = (int16_t)ax;
    if (ay > s_touch.far.y) s_touch.far.y = (int16_t)ay;
    if (s_screen != s_touch.screen) return;
    if (!s_touch.drag && (s_touch.far.x > TAP_SLOP_PX || s_touch.far.y > TAP_SLOP_PX)) {
      s_touch.drag = true;
      s_touch.across = ax > ay;
    }
    if (s_touch.drag) touch_drag(s_touch.across ? dx : dy);
    return;
  }
  s_touch.down = false;   // Liftoff
  // The screen changed under the finger (an answer came, Find it locked on,
  // a message timed out): the gesture was meant for the one before.
  if (s_screen != s_touch.screen || touch_ignored()) return;
  int dx = s_touch.last.x - s_touch.start.x, dy = s_touch.last.y - s_touch.start.y;
  int ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
  bool did = false;
  if (s_touch.far.x <= TAP_SLOP_PX && s_touch.far.y <= TAP_SLOP_PX) {
    if (now_ms() - s_touch.t0 <= TAP_MAX_MS) did = touch_tap(s_touch.start);   // longer: a press held
  } else if (s_touch.drag && touch_release(now_ms() - s_touch.t_last > 100 ? 0 : s_touch.vel)) {
    did = true;   // held still before letting go: no flick
  } else if (ay >= DRAG_MIN_PX && ay >= 2 * ax) {
    did = touch_vertical(dy < 0 ? 1 : -1);
  } else if (ax >= DRAG_MIN_PX && ax >= 2 * ay) {
    did = touch_horizontal(dx < 0 ? 1 : -1);
  }
  if (did) reveal_light();
}

// A notification or other modal can take the Liftoff: forget the touch.
static void touch_forget(void) {
  s_touch.down = false;
  if (s_card_off && !s_card_go) {   // an answer left half dragged goes back
    s_card_to = 0;
    motion_start();
  }
}

// The window reads the screen itself, opted out of the system's touch
// navigation (third-party apps are out unless they opt in; this keeps it
// so). Subscribing also keeps the touch sensor on while the app is
// open (otherwise it runs only while touch navigation is on in the
// watch's settings).
// Screenshot builds leave touch out (none of their seeds use it), which
// makes room for the seeds in the app image; SKY_TOUCH=1 puts it back, to
// drive a seed with touches (README).
#if defined(SKY_SHOT) && !defined(SKY_TOUCH)
#define TOUCH_ON 0
#else
#define TOUCH_ON 1
#endif
static void touch_attach(Window *window) {
  window_set_touch_bridge_disabled(window, true);
  if (TOUCH_ON) touch_service_subscribe(touch_handler, NULL);
}

// ---------------------------------------------------------------- harness

#ifdef SKY_SHOT
// SKY_SHOT=1..7, 10..17, 22..73 seed one screen for screenshots; 9 feeds fake 5 Hz compass
// readings (the emulator's compass never reports a valid heading) and skips
// the "arm moved" step, so a whole aim runs through the phone and back; 18
// does the same for a Tune my aim aim.
static void fake_compass_cb(void *ctx) {
  static int k;
  static const int wobble[5] = { 0, 1, -1, 2, -2 };
  int deg = 100 + wobble[k++ % 5];
  compass_handler((CompassHeadingData){ .magnetic_heading = TRIG_MAX_ANGLE * deg / 360,
                                        .compass_status = CompassStatusCalibrated });
  app_timer_register(200, fake_compass_cb, NULL);
}

static void shot_card(int i, int type, int word, const char *a, const char *b, const char *c, const char *h) {
  s_cards[i] = (Card){ .type = (uint8_t)type, .word = (uint8_t)word };
  strncpy(s_cards[i].l1, a, 31);
  strncpy(s_cards[i].l2, b, 31);
  strncpy(s_cards[i].l3, c, 31);
  strncpy(s_cards[i].hint, h, 31);
}

static void shot_seed(void) {
  s_intro = false;
  s_screen = SCR_HOME;
  strncpy(s_tune_tgt, "the Moon", sizeof(s_tune_tgt) - 1);
  strncpy(s_tune_where, "low in the SE", sizeof(s_tune_where) - 1);
  strncpy(s_moon_tgt, "the Moon", sizeof(s_moon_tgt) - 1);
  strncpy(s_moon_where, "low in the SE", sizeof(s_moon_where) - 1);
  s_cal = CompassStatusCalibrated;
  s_have_heading = true;
  s_have_status = true;
  strncpy(s_status[L_ANY], "Point at anything", 31);
  strncpy(s_status[L_PLANETS], "Moon and 2 planets up", 31);
  strncpy(s_status[L_STARS], "About 260 stars out", 31);
  strncpy(s_status[L_SATS], "Space Station + 2 more", 31);
  strncpy(s_status[L_PLANES], "14 planes nearby", 31);
  s_layers |= (1 << L_SATS) | (1 << L_PLANES);
#if SKY_SHOT == 9 || SKY_SHOT == 18
  app_timer_register(200, fake_compass_cb, NULL);
#if SKY_SHOT == 18
  s_tune = true;
  s_screen = SCR_TUNE;
#endif
  return;
#endif
  shot_card(0, T_STAR, 2, "Vega", "in Lyra", "Easy to see", "A bit to the left");
  shot_card(1, T_PLANET, 3, "Saturn", "Planet", "Bright", "Higher and right");
  shot_card(2, T_CONST, 0, "Cassiopeia", "Constellation", "You're pointing into it", "");
  s_ncards = 3;
#if SKY_SHOT == 1
  s_layer = L_ANY;
#elif SKY_SHOT == 2
  s_screen = SCR_AIM;
  s_phase = AIM_RECORD;
  s_record_ms = now_ms() - 500;
#elif SKY_SHOT == 3
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 4
  s_cal = CompassStatusCalibrating;
  s_coach_start = now_ms() - 12000;
  s_coach_step = 10;
  s_screen = SCR_COACH;
#elif SKY_SHOT == 5
  s_screen = SCR_MENU;
#elif SKY_SHOT == 6
  s_theme = THEME_STAR;
  s_layer = L_PLANETS;
#elif SKY_SHOT == 7
  s_theme = THEME_DAY;
  s_card = 1;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 10
  shot_card(0, T_SAT, 1, "Starlink train", "12 satellites in a row", "171 mi up", "17,200 mph, moving left");
  shot_card(1, T_SAT, 3, "Space Station", "The ISS", "263 mi up", "17,100 mph, moving down-right");
  s_ncards = 2;
  s_theme = THEME_NIGHT;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 12
  shot_card(0, T_PLANE, 1, "Southwest 900", "San Jose to Phoenix", "7,300 ft, 27 mi away", "480 mph, moving left");
  shot_card(1, T_PLANE, 3, "United Parcel Service 869", "Boeing 767-300", "4,300 ft, 14 mi away",
            "340 mph, moving up-left");
  s_ncards = 2;
  s_theme = THEME_DAY;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 11
  s_theme = THEME_NIGHT;
  s_layer = L_SATS;
#elif SKY_SHOT == 13 || SKY_SHOT == 15
  s_intro = true;
  s_intro_step = SKY_SHOT == 13 ? INTRO_WRIST : INTRO_READY;
  s_screen = SCR_INTRO;
#elif SKY_SHOT == 14
  s_screen = SCR_WRISTQ;
#elif SKY_SHOT == 16
  s_tune = true;
  s_tune_n = 1;
  strncpy(s_tune_note, "Got it! 2 more to go", sizeof(s_tune_note) - 1);
  s_screen = SCR_TUNE;
#elif SKY_SHOT == 32 || SKY_SHOT == 33 || SKY_SHOT == 34
  // The first run's two questions, then "Where are you now?" in Stargazer.
  s_intro = SKY_SHOT != 34;
  s_choice = SKY_SHOT == 33 ? CHOICE_GEAR : CHOICE_SKY;
  s_choice_place = SKY_SHOT == 34;
  s_choice_row = SKY_SHOT == 34 ? SKY_DARK : 1;
  s_theme = SKY_SHOT == 32 ? THEME_NIGHT : SKY_SHOT == 33 ? THEME_DAY : THEME_STAR;
  s_screen = SCR_CHOICE;
#elif SKY_SHOT == 35
  // The menu on its Theme row: Auto (Stargazer), at night.
  s_prefs = SKY_DARK;
  s_theme = THEME_AUTO_STAR;
  s_daylight = false;
  s_menu_row = MENU_THEME;
  s_screen = SCR_MENU;
#elif SKY_SHOT == 69 || SKY_SHOT == 70
  // Waiting for the phone: after an aim; opening Find it.
  s_wait_list = SKY_SHOT == 70;
  s_theme = THEME_NIGHT;
  s_screen = SCR_WAIT;
#elif SKY_SHOT == 71
  // The menu part way through a finger's scroll.
  s_menu_row = 1;
  s_scroll = s_scroll_to = 40;
  s_screen = SCR_MENU;
#elif SKY_SHOT == 72
  // An answer dragged part way up, the next one to come.
  s_screen = SCR_RESULTS;
  s_card_off = s_card_to = -80;
  card_place();
#elif SKY_SHOT == 67 || SKY_SHOT == 68
  // The menu's Keep light on row: the default, and the widest choice.
  s_prefs = (uint8_t)(SKY_SUBURBS | (SKY_SHOT == 68 ? LIGHT_READ_LONG << 6 : 0));
  s_menu_row = MENU_LIGHT;
  s_screen = SCR_MENU;
#elif SKY_SHOT == 36
  // An answer arriving: the ring closing in.
  s_ncards = 1;
  s_theme = THEME_NIGHT;
  s_reveal_start = 1;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 17
  shot_card(0, T_MOON, 0, "Aim tuned!", "You were 6 degrees off,", "now about 2", "");
  s_ncards = 1;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 22 || SKY_SHOT == 23
  // Orion rising (test/chart.test.js), Betelgeuse circled; then the fact.
  static const uint8_t orion[] = {
    13, 59, 122, 22, 131, 137, 17, 131, 127, 18, 130, 117, 17, 95, 80, 18, 173, 176, 17, 197, 121, 19,
    162, 144, 1, 184, 98, 1, 150, 113, 1, 63, 82, 0, 185, 120, 0, 137, 136, 0,
    7, 0, 1, 1, 2, 2, 3, 3, 4, 1, 5, 3, 6, 0, 4,
    5, 14, 178, 81, 178, 126, 177, 193, 176, 239, 175 };
  memcpy(s_chart, orion, sizeof(orion));
  s_chart_len = sizeof(orion);
  strncpy(s_fact, "Put Betelgeuse where the Sun is and it would swallow Mercury, Venus, Earth and Mars.",
          FACT_MAX - 1);
  shot_card(0, T_STAR, 1, "Betelgeuse", "in Orion", "Easy to see", "");
  shot_card(1, T_CHART, 0, "Orion", "Betelgeuse is circled", "", "");
  shot_card(2, T_FACT, 0, "Did you know?", "", "", "");
  shot_card(3, T_STAR, 3, "Bellatrix", "in Orion", "Easy to see", "Further right");
  s_ncards = 4;
  s_card = SKY_SHOT == 22 ? 1 : 2;
  s_theme = THEME_NIGHT;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 24 || SKY_SHOT == 25 || SKY_SHOT == 26 || SKY_SHOT == 53 || SKY_SHOT == 54 || SKY_SHOT == 55
  // 24: Best now; 53: More under it; 54: the kinds; 55: constellations.
  static const struct { uint8_t type, see; bool best; const char *name, *where; } list[] = {
    { T_MOON, SEE_EASY, true, "The Moon", "low in the E" },
    { T_PLANET, SEE_EASY, true, "Saturn", "halfway up in the SE" },
    { T_SAT, SEE_EASY, true, "Space Station", "7:42 pm, SW to NE, high" },
    { T_CONST, SEE_EASY, true, "Summer Triangle", "Vega, high in the W" },
    { T_STAR, SEE_EASY, true, "Vega", "high in the W" },
    { T_CONST, SEE_EASY, false, "Cassiopeia", "halfway up in the NE" },
    { T_CONST, SEE_EASY, false, "Great Square", "high in the E" },
    { T_STAR, SEE_EASY, false, "Deneb", "high in the NW" },
    { T_PLANET, SEE_BINOCULARS, false, "Uranus", "low in the E" } };
  for (int i = 0; i < 9; i++) {
    s_find[i] = (FindTarget){ .id = (uint8_t)i, .type = list[i].type, .see = list[i].see, .best = list[i].best };
    strncpy(s_find[i].name, list[i].name, sizeof(s_find[i].name) - 1);
    strncpy(s_find[i].where, list[i].where, sizeof(s_find[i].where) - 1);
    // The Space Station is a pass to come: "Next at" on its kind's row.
    if (list[i].type == T_SAT) s_find[i] = (FindTarget){ .id = (uint8_t)i, .type = T_SAT, .kind = 1, .see = SEE_EASY,
                                                           .best = true, .start = 7200, .step = 10, .npts = 2,
                                                           .name = "Space Station", .where = "7:42 pm, SW to NE, high" };
  }
  s_find_t0 = time(NULL);
  s_nfind = 9;
  s_layer = L_FIND;
  s_theme = THEME_NIGHT;
  s_find_cur = 1;
  if (SKY_SHOT == 54) pick_show(VIEW_KINDS, 0, 3, ROW_NONE);   // on Satellites: a pass to come
  else if (SKY_SHOT == 55) pick_show(VIEW_KIND, KIND_PATTERN, 0, ROW_NONE);
  else pick_show(VIEW_BEST, 0, SKY_SHOT == 53 ? 5 : SKY_SHOT == 24 ? 2 : 1, ROW_NONE);
  s_screen = SKY_SHOT == 25 || SKY_SHOT == 26 ? SCR_FIND : SCR_PICK;
  s_fs.have = s_fs.held = true;
  // 25: turn right to Saturn; 26: facing it, tilt up.
  s_fs.facing = SKY_SHOT == 26;
  s_fs.az = SKY_SHOT == 25 ? 195 : 256;
  s_fs.alt = SKY_SHOT == 25 ? 20 : 25;
  s_fs.taz = 257;
  s_fs.talt = 38;
  s_fs.daz = 257 - s_fs.az;
  s_fs.dalt = s_fs.talt - s_fs.alt;
  s_show_az = s_fs.az;
  s_show_alt = s_fs.alt;
#elif SKY_SHOT == 47 || SKY_SHOT == 48 || SKY_SHOT == 49 || SKY_SHOT == 50 || SKY_SHOT == 51 || SKY_SHOT == 52 || \
      SKY_SHOT == 56
  // 47: Found it; 48: turn to the Space Station, overhead; 49: Found it,
  // overhead; 50: tilt up, in Stargazer; 51: not held up to read; 52: how
  // to find it, first; 56: Found it near the Sun.
  s_find[0] = (FindTarget){ .id = 0, .type = SKY_SHOT == 47 || SKY_SHOT == 50 || SKY_SHOT == 56 ? T_PLANET : T_SAT,
                            .see = SKY_SHOT == 56 ? SEE_EASY | SEE_BLOCK_SUN : SEE_EASY };
  strncpy(s_find[0].name, SKY_SHOT == 56 ? "Venus" : SKY_SHOT == 47 || SKY_SHOT == 50 ? "Saturn" : "Space Station",
          sizeof(s_find[0].name) - 1);
  strncpy(s_find[0].where, "high in the NW, moving", sizeof(s_find[0].where) - 1);
  s_nfind = 1;
  s_layer = L_FIND;
  s_theme = SKY_SHOT == 50 ? THEME_STAR : THEME_NIGHT;
  s_screen = SCR_FIND;
  s_fs.have = true;
  s_fs.held = SKY_SHOT != 51;
  s_fs.found = SKY_SHOT == 47 || SKY_SHOT == 49 || SKY_SHOT == 56;
  s_fs.intro = SKY_SHOT == 52;
  s_unheld_at = SKY_SHOT == 51;   // not held up for a long while
  s_fs.facing = SKY_SHOT == 50;
  s_fs.az = SKY_SHOT == 48 ? 350 : 256;
  s_fs.alt = SKY_SHOT == 48 ? 30 : 25;
  s_fs.talt = SKY_SHOT == 49 ? 84 : SKY_SHOT == 48 ? 74 : 38;
  s_fs.taz = SKY_SHOT == 48 ? 310 : 257;
  s_fs.daz = s_fs.taz - s_fs.az;
  s_fs.dalt = s_fs.talt - s_fs.alt;
  s_show_az = s_fs.az;
  s_show_alt = s_fs.alt;
#elif (SKY_SHOT >= 63 && SKY_SHOT <= 66) || SKY_SHOT == 73
  // 63: a pattern found, its chart with the star it was found by circled
  // (chart.js, the Summer Triangle, 11 Oct 2026 8 pm in Phoenix); a pass
  // to come: 64 on where it will rise, 65 how to find it, 66 turning to
  // where it will rise.
  static const uint8_t summer[] = {
    21, 190, 164, 23, 197, 70, 18, 59, 130, 18, 178, 85, 1, 152, 68, 1, 67, 133, 1, 201, 109, 1, 88, 170, 1, 137, 134,
    1, 162, 155, 1, 41, 160, 1, 167, 161, 1, 100, 115, 1, 75, 81, 0, 48, 127, 0, 80, 78, 0, 204, 89, 0, 98, 126, 0,
    160, 108, 0, 181, 58, 0, 208, 87, 0, 3, 0, 1, 1, 2, 2, 0, 0, 3, 15, 86, 101, 103, 97, 32, 105, 115, 32, 99, 105,
    114, 99, 108, 101, 100 };
  bool pat = SKY_SHOT == 63;
  s_find[0] = (FindTarget){ .id = 0, .type = pat ? T_CONST : T_SAT, .see = SEE_EASY, .kind = pat ? 0 : 1,
                            .start = pat ? 0 : 725, .step = 10, .npts = 2 };
  strncpy(s_find[0].name, pat ? "Summer Triangle" : "Space Station", sizeof(s_find[0].name) - 1);
  strncpy(s_find[0].where, pat ? "Vega, high in the W" : "7:42 pm, SW to NE, high", sizeof(s_find[0].where) - 1);
  if (!pat) strncpy(s_find[0].note, "Then 9:19 pm, W to N", sizeof(s_find[0].note) - 1);
  if (SKY_SHOT == 73) {   // a moonrise to wait for: how to find it
    s_find[0].type = T_MOON;
    strncpy(s_find[0].name, "The Moon", sizeof(s_find[0].name) - 1);
    strncpy(s_find[0].where, "Rises 10:51 am, SE", sizeof(s_find[0].where) - 1);
    strncpy(s_find[0].note, "Waxing crescent, 16% lit", sizeof(s_find[0].note) - 1);
  }
  s_track[0] = (TrackPoint){ (uint16_t)(225 * 65536 / 360), 900 };
  s_track[1] = (TrackPoint){ (uint16_t)(230 * 65536 / 360), 1200 };
  s_find_t0 = time(NULL);
  s_nfind = 1;
  if (pat) {
    memcpy(s_chart, summer, sizeof(summer));
    s_chart_len = sizeof(summer);
    shot_card(0, T_CONST, 1, "Summer Triangle", "Part of Lyra", "", "");
    s_ncards = 1;
    s_find_sent = true;
  }
  s_layer = L_FIND;
  s_theme = THEME_NIGHT;
  s_screen = SCR_FIND;
  s_fs.have = s_fs.held = true;
  s_fs.found = SKY_SHOT == 63 || SKY_SHOT == 64;
  s_fs.intro = SKY_SHOT == 65 || SKY_SHOT == 73;
  s_fs.az = 200;
  s_fs.alt = 10;
  s_fs.taz = pat ? 280 : 225;
  s_fs.talt = pat ? 62 : 9;
  s_fs.daz = s_fs.taz - s_fs.az;
  s_fs.dalt = s_fs.talt - s_fs.alt;
  s_show_az = s_fs.az;
  s_show_alt = s_fs.alt;
#elif SKY_SHOT == 30
  // The Sun's label on the chosen row, under Stargazer; then nothing there.
  s_find[0] = (FindTarget){ .id = 0, .type = T_MOON, .see = SEE_CLOSE | SEE_BLOCK_SUN };
  strncpy(s_find[0].name, "The Moon", sizeof(s_find[0].name) - 1);
  strncpy(s_find[0].where, "low in the E", sizeof(s_find[0].where) - 1);
  s_find[1] = (FindTarget){ .id = 1, .type = T_PLANET, .see = SEE_BINOCULARS | SEE_NEAR_SUN };
  strncpy(s_find[1].name, "Venus", sizeof(s_find[1].name) - 1);
  strncpy(s_find[1].where, "low in the W", sizeof(s_find[1].where) - 1);
  s_nfind = 2;
  s_theme = THEME_STAR;
  mark_best();
  pick_show(VIEW_BEST, 0, 0, ROW_NONE);
  s_screen = SCR_PICK;
#elif SKY_SHOT == 31
  shot_card(0, T_NOTHING, 0, "Nothing I know", "is there", "Try STARS for faint ones", "");
  shot_card(1, T_PLANE, 1, "Southwest 900", "San Jose to Phoenix", "7,300 ft, 27 mi away", "A bit higher");
  s_ncards = 2;
  s_theme = THEME_NIGHT;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 37 || SKY_SHOT == 43 || SKY_SHOT == 40
  // The first answer with its chart on its own page, your aim marked: a
  // star (Orion, as chart.js builds it), nothing there, a satellite's path.
  static const uint8_t orion_here[] = {
    39, 145, 139, 17, 158, 165, 17, 178, 142, 19, 147, 129, 17, 137, 106, 18, 121, 102, 16, 113, 121, 22, 103,
    118, 16, 86, 110, 16, 88, 106, 16, 84, 83, 16, 78, 89, 16, 146, 134, 18, 160, 84, 17, 162, 88, 16, 168, 99,
    16, 166, 104, 16, 154, 79, 16, 139, 69, 16, 129, 69, 16, 125, 71, 16, 63, 118, 2, 158, 147, 1, 176, 129, 1,
    60, 92, 1, 44, 169, 1, 39, 95, 1, 93, 72, 1, 65, 88, 1, 198, 164, 1, 157, 131, 1, 65, 132, 1, 33, 139, 0,
    173, 139, 0, 35, 119, 0, 148, 140, 0, 219, 139, 0, 194, 105, 0, 130, 171, 0, 29, 0, 1, 1, 2, 2, 3, 3, 4, 4,
    5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 8, 8, 7, 7, 6, 6, 0, 0, 12, 12, 3, 3, 4, 4, 13, 13, 14, 14,
    15, 15, 16, 16, 15, 15, 14, 14, 13, 13, 17, 17, 18, 18, 19, 19, 20, 0, 1, 119, 115, 3, 8, 105, 110, 32, 79,
    114, 105, 111, 110 };
  static const uint8_t cas_nothing[] = {
    9, 133, 157, 17, 144, 129, 17, 129, 111, 17, 142, 85, 17, 112, 77, 17, 140, 96, 1, 40, 80, 0, 213, 104, 0,
    153, 72, 0, 4, 0, 1, 1, 2, 2, 3, 3, 4, 0, 1, 157, 103, 3, 24, 80, 111, 105, 110, 116, 105, 110, 103, 32,
    105, 110, 116, 111, 32, 67, 97, 115, 115, 105, 111, 112, 101, 105, 97 };
  static const uint8_t iss_path[] = {
    10, 111, 123, 14, 48, 158, 16, 81, 140, 16, 137, 108, 16, 161, 95, 16, 184, 84, 16, 208, 76, 16, 105, 108,
    2, 113, 107, 1, 148, 131, 1, 6, 1, 2, 2, 0, 0, 3, 3, 4, 4, 5, 5, 6, 0, 1, 104, 131, 3, 21,
    50, 54, 51, 32, 109, 105, 32, 117, 112, 44, 32, 49, 55, 44, 49, 48, 48, 32, 109, 112, 104, 2, 5, 6 };
  const uint8_t *b = SKY_SHOT == 37 ? orion_here : SKY_SHOT == 43 ? cas_nothing : iss_path;
  s_chart_len = SKY_SHOT == 37 ? sizeof(orion_here) : SKY_SHOT == 43 ? sizeof(cas_nothing) : sizeof(iss_path);
  memcpy(s_chart, b, s_chart_len);
  strncpy(s_fact, "Betelgeuse will explode as a supernova one day, maybe in the next 100,000 years.", FACT_MAX - 1);
  if (SKY_SHOT == 37) shot_card(0, T_STAR, 1, "Betelgeuse", "in Orion", "Easy to see", "A bit to the left");
  if (SKY_SHOT == 43) shot_card(0, T_NOTHING, 0, "Nothing there", "", "Pointing into Cassiopeia", "");
  if (SKY_SHOT == 40) shot_card(0, T_SAT, 1, "Space Station", "The ISS", "263 mi up", "17,100 mph, moving up-right");
  shot_card(1, T_FACT, 0, "Did you know?", "", "", "");
  shot_card(2, T_STAR, 3, "Bellatrix", "in Orion", "Easy to see", "Further right");
  s_ncards = SKY_SHOT == 37 ? 3 : 2;
  s_theme = THEME_NIGHT;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 38 || SKY_SHOT == 41 || SKY_SHOT == 42
  // A planet's photo: Saturn by night and by day, Jupiter in Stargazer.
  strncpy(s_fact, "With a small telescope you can see the rings of Saturn.", FACT_MAX - 1);
  shot_card(0, T_PLANET, SKY_SHOT == 42 ? 3 : 1, SKY_SHOT == 42 ? "Jupiter" : "Saturn", "Planet", "Bright",
            "Higher and right");
  shot_card(1, T_FACT, 0, "Did you know?", "", "", "");
  s_ncards = 2;
  s_theme = SKY_SHOT == 41 ? THEME_DAY : SKY_SHOT == 42 ? THEME_STAR : THEME_NIGHT;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 39 || SKY_SHOT == 44
  // The Moon as it's lit: a waxing crescent lit from the lower right; a
  // waning gibbous in Stargazer.
  strncpy(s_fact, "The same side of the Moon always faces the Earth.", FACT_MAX - 1);
  shot_card(0, T_MOON, 1, "The Moon", SKY_SHOT == 39 ? "Waxing crescent" : "Waning gibbous", "", "");
  shot_card(1, T_FACT, 0, "Did you know?", "", "", "");
  s_ncards = 2;
  s_moon_look[0] = SKY_SHOT == 39 ? 23 : 78;
  s_moon_look[1] = SKY_SHOT == 39 ? 55 : 125;
  s_have_moon_look = true;
  s_theme = SKY_SHOT == 39 ? THEME_NIGHT : THEME_STAR;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 45 || SKY_SHOT == 46
  // The watch's own answer: the word beside NO PHONE.
  shot_card(0, T_STAR, SKY_SHOT == 45 ? 1 : 2, "Vega", "in Lyra", "Easy to see", "A bit to the left");
  s_ncards = 1;
  s_offline_shown = true;
  s_theme = THEME_NIGHT;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 57 || SKY_SHOT == 58 || SKY_SHOT == 59
  // A plane's first answer: its route (or what it is), its path with its
  // shape on it, how high and far (or what else it might be), how fast.
  // Bytes from chart.js track() with planes.path().
  static const uint8_t sw_route[] = {
    12, 154, 93, 14, 204, 92, 16, 179, 93, 16, 129, 93, 16, 103, 93, 16, 78, 94, 16, 52, 94, 16, 163, 90, 2, 141,
    110, 2, 205, 109, 1, 150, 92, 1, 164, 92, 1, 6, 1, 2, 2, 0, 0, 3, 3, 4, 4, 5, 5, 6, 5, 15, 117, 78, 118, 139,
    119, 185, 119, 247, 118, 1, 164, 100, 5, 219, 3, 83, 74, 67, 3, 80, 72, 88, 2, 5, 6, 4, 1, 0, 3 };
  static const uint8_t heli_rival[] = {
    11, 150, 103, 14, 161, 109, 16, 156, 106, 16, 142, 100, 16, 132, 95, 16, 117, 88, 16, 95, 77, 16, 132, 98, 1,
    167, 114, 1, 98, 78, 1, 44, 109, 1, 6, 1, 2, 2, 0, 0, 3, 3, 4, 4, 5, 5, 6, 3, 1, 127, 16, 127, 32, 127, 1, 160,
    111, 6, 17, 111, 114, 32, 83, 111, 117, 116, 104, 119, 101, 115, 116, 32, 49, 49, 50, 51, 2, 5, 6, 4, 6, 0, 3 };
  bool heli = SKY_SHOT == 58;
  s_chart_len = heli ? sizeof(heli_rival) : sizeof(sw_route);
  memcpy(s_chart, heli ? heli_rival : sw_route, s_chart_len);
  strncpy(s_fact, "San Jose to Phoenix is about 620 miles as the crow flies.", FACT_MAX - 1);
  if (heli) shot_card(0, T_PLANE, 2, "N412PD", "Airbus H125", "2,400 ft, 3 mi away", "130 mph, moving down-left");
  else shot_card(0, T_PLANE, 1, "Southwest 900", "San Jose to Phoenix", "7,300 ft, 27 mi away", "480 mph, moving left");
  shot_card(1, T_FACT, 0, "Did you know?", "", "", "");
  shot_card(2, T_PLANE, 3, "Southwest 1123", "Boeing 737-800", "9,100 ft, 31 mi away", "460 mph, moving up-right");
  s_ncards = 3;
  s_theme = SKY_SHOT == 57 ? THEME_NIGHT : SKY_SHOT == 58 ? THEME_DAY : THEME_STAR;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 60 || SKY_SHOT == 61 || SKY_SHOT == 62
  // A planet's chart card with its ground: Saturn low in the east, 11 Oct
  // 2026 6:30 pm in Phoenix, near Pegasus (chart.js through addExtras).
  static const uint8_t sat_peg[] = {
    18, 128, 142, 15, 97, 41, 17, 72, 78, 17, 132, 61, 17, 106, 103, 17, 152, 52, 17, 40, 154, 1, 33, 101, 1, 52,
    152, 1, 57, 93, 1, 216, 107, 1, 162, 145, 0, 75, 149, 0, 222, 126, 0, 158, 88, 0, 196, 90, 0, 193, 59, 0, 214,
    131, 0, 8, 1, 2, 2, 1, 1, 3, 3, 4, 4, 2, 2, 4, 4, 3, 3, 5, 5, 0, 166, 66, 169, 128, 170, 181, 169, 246, 166, 7,
    2 };
  memcpy(s_chart, sat_peg, sizeof(sat_peg));
  s_chart_len = sizeof(sat_peg);
  shot_card(0, T_PLANET, 1, "Saturn", "Planet", "Easy to see", "");
  shot_card(1, T_CHART, 0, "Near Pegasus", "Saturn is circled", "", "");
  s_ncards = 2;
  s_card = 1;
  s_theme = SKY_SHOT == 60 ? THEME_NIGHT : SKY_SHOT == 61 ? THEME_DAY : THEME_STAR;
  s_screen = SCR_RESULTS;
#elif SKY_SHOT == 27
  s_layer = RUNG_SETTINGS;
  s_theme = THEME_NIGHT;
#elif SKY_SHOT == 28 || SKY_SHOT == 29
  // A long name on the second answer, with no phone; then the Sun.
  shot_card(0, T_PLANE, 1, "Southwest 900", "San Jose to Phoenix", "7,300 ft, 27 mi away", "A bit higher");
  shot_card(1, T_PLANE, 3, "United Parcel Service 869", "Boeing 767-300", "4,300 ft, 14 mi away",
            "Lower and left");
  shot_card(2, T_SUN, 0, "Don't look", "at the Sun!", "It can hurt your eyes", "");
  s_ncards = 3;
  s_offline_shown = true;
  s_card = SKY_SHOT == 28 ? 1 : 2;
  s_theme = SKY_SHOT == 28 ? THEME_DAY : THEME_STAR;
  s_screen = SCR_RESULTS;
#endif
  // The seeds set the screen without go(): scroll to the chosen row as it
  // would (71 and 72 seed a scroll or a drag of their own).
  if (SKY_SHOT != 71 && SKY_SHOT != 72) motion_reset();
}
#endif

// ---------------------------------------------------------------- lifecycle

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_canvas = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_canvas, canvas_update);
  layer_add_child(root, s_canvas);
  s_peek = layer_create(GRect(0, 228, 200, 228));
  layer_set_update_proc(s_peek, peek_update);
  layer_add_child(root, s_peek);
  touch_attach(window);
}

static void window_unload(Window *window) {
  layer_destroy(s_peek);
  s_peek = NULL;
  layer_destroy(s_canvas);
  s_canvas = NULL;
}

// The bigger buffers live on the heap: the app image (code, data and
// statics) has to fit in the 65,535 bytes its header can describe, and the
// heap doesn't count towards that.
static bool alloc_buffers(void) {
  s_status = calloc(L_COUNT, sizeof(*s_status));
  s_compass = calloc(MAX_READINGS, sizeof(Reading));
  s_cards = calloc(MAX_CARDS, sizeof(Card));
  s_chart = calloc(CHART_MAX, 1);
  s_fact = calloc(FACT_MAX, 1);
  s_find = calloc(FIND_MAX, sizeof(FindTarget));
  s_track = calloc(FIND_TRACK_MAX, sizeof(TrackPoint));
  s_tx = calloc(1, sizeof(Texts));
  return s_status && s_compass && s_cards && s_chart && s_fact && s_find && s_track && s_tx;
}

static void free_buffers(void) {
  free(s_status);
  free(s_compass);
  free(s_cards);
  free(s_chart);
  free(s_fact);
  free(s_find);
  free(s_track);
  free(s_tx);
  art_free();
  off_free();
}

static bool init(void) {
  if (!alloc_buffers()) return false;   // not enough memory to start
  s_uncal_since = now_ms();             // no reading yet: give it COACH_DELAY_MS
  s_wrist = persist_exists(PERSIST_WRIST) ? (uint8_t)persist_read_int(PERSIST_WRIST) : 0;
  s_theme_set = persist_exists(PERSIST_THEME);
  s_theme = s_theme_set ? (uint8_t)persist_read_int(PERSIST_THEME) : THEME_AUTO;
  if (s_theme >= THEME_COUNT) s_theme = THEME_AUTO;
  if (persist_exists(PERSIST_LAYERS)) s_layers = (uint8_t)persist_read_int(PERSIST_LAYERS) | (1 << L_ANY);
  s_have_36 = text_h("Ag", FONT_36, 200) > text_h("Ag", FONT_KEY_GOTHIC_28_BOLD, 200);
  s_layer = persist_exists(PERSIST_LAYER) ? (uint8_t)persist_read_int(PERSIST_LAYER) : L_ANY;
  if (s_layer >= L_COUNT || !layer_on(s_layer)) s_layer = L_ANY;
  s_daylight = persist_exists(PERSIST_DAY) ? persist_read_bool(PERSIST_DAY) : true;
  s_seq = persist_exists(PERSIST_SEQ) ? (uint16_t)persist_read_int(PERSIST_SEQ) : 0;
  s_intro = !persist_exists(PERSIST_INTRO);
  uint8_t frame[19];
  if (persist_exists(PERSIST_FRAME) && persist_read_data(PERSIST_FRAME, frame, sizeof(frame)) == (int)sizeof(frame) &&
      parse_frame(frame, sizeof(frame))) {
    memcpy(s_frame_raw, frame, sizeof(frame));
  }
  // Before v0.16 the sky and gear came only in the frame.
  if (persist_exists(PERSIST_PREFS)) s_prefs = (uint8_t)persist_read_int(PERSIST_PREFS);
  else if (s_have_frame) s_prefs = s_frame_raw[18];
  s_prefs = prefs_byte(s_prefs);
  s_prefs_pending = persist_exists(PERSIST_PREFS_PENDING);
  if (s_prefs_pending) s_prefs_seq = (uint8_t)persist_read_int(PERSIST_PREFS_PENDING);
  apply_prefs();
  load_eph();
  if (s_intro) {
    s_intro_step = INTRO_WRIST;
    s_screen = SCR_INTRO;
  }

  s_window = window_create();
  window_set_click_config_provider(s_window, click_config);
  window_set_window_handlers(s_window, (WindowHandlers){ .load = window_load, .unload = window_unload });
  window_stack_push(s_window, true);
  apply_theme();

  app_message_register_inbox_received(inbox_received);
  app_message_register_outbox_failed(outbox_failed);
  // Answers with a chart and a fact run past 1 KB.
  uint32_t inbox = app_message_inbox_size_maximum();
  app_message_open(inbox < 2048 ? inbox : 2048, 256);
  connection_service_subscribe((ConnectionHandlers){ .pebble_app_connection_handler = connection_handler });
  app_focus_service_subscribe_handlers((AppFocusHandlers){ .will_focus = will_focus, .did_focus = did_focus });
  backlight_service_subscribe(light_handler);

  compass_service_set_heading_filter(0);
  compass_service_subscribe(compass_handler);
  // Never unsubscribed while running: unsubscribing with a batch queued
  // faults the app on current firmware (coredevices/PebbleOS#2252).
  s_accel_batch = accel_batch_wanted();
  accel_data_service_subscribe(s_accel_batch, accel_handler);
  accel_service_set_sampling_rate(ACCEL_SAMPLING_25HZ);

#ifdef SKY_SHOT
  shot_seed();
  apply_theme();
  accel_follow_screen();
#endif
  app_timer_register(COACH_DELAY_MS, coach_check_cb, NULL);
  idle_arm();
  return true;
}

// Leaving the app (BACK on Home, the idle exit, or another app opening)
// ends here, and unsubscribing turns the magnetometer off once no other app
// uses it (PebbleOS services/ecompass). A notification over the app doesn't
// come here: the app keeps running underneath, compass and all, so the
// compass is still warm when the notification is dismissed.
static void deinit(void) {
  touch_service_unsubscribe();
  backlight_service_unsubscribe();
  compass_service_unsubscribe();
  app_focus_service_unsubscribe();
  connection_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  if (init()) {
    app_event_loop();
    deinit();
  }
  free_buffers();
}
