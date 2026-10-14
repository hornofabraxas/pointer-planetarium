# Pointer Planetarium design

Status: draft for review, 2026-10-07. Builds on the moon test (v0.2),
research into sky data sources, and a first throwaway test app run on a
real phone.

## 1. What it is

Point at something in the sky with your finger. The watch buzzes and tells
you what it is: a plane, a satellite, a planet, a star.

Design goals, in priority order:

1. **A child can use it.** One button to aim, plain words, big text, no
   setup beyond "which wrist" and "draw an 8".
2. **Honest.** When it isn't sure, it says so. It never shows a confident
   wrong answer when a hedged one is true.
3. **Fast.** Results within about a second of the "got it" buzz.
4. **Light on the watch.** The watch is a sensor and a screen. The phone
   does the thinking and the network. Nothing streams over Bluetooth.

What we know from testing:

- Raw pointing misses were 3 to 6 degrees; after removing a constant offset,
  the 90% cone was about 6 degrees (3 aims, so rough). The compass, not the
  data, limits accuracy.
- People point with their index finger. The design never asks for a
  straight-arm, flat-palm pose.
- The phone side has no CORS limits (requests go through the Pebble app's
  native HTTP client), runs modern JavaScript, has at least 4 MB of
  storage, and propagates a satellite in about 57 microseconds.

## 2. Using it

### 2.1 Buttons

| Screen | UP | DOWN | SELECT | BACK |
|---|---|---|---|---|
| Home | Layer up (farther) | Layer down (nearer) | Aim | Exit |
| Aiming | (ignored) | (ignored) | Cancel | Cancel |
| Results | Previous result | Next result | Aim again (same layer) | Home |
| Compass coach | (ignored) | (ignored) | Skip | Home |

Long-press SELECT on Home opens the small watch menu (sky, gear, theme,
keep light on, wrist, "Tune my aim"). Everything else lives on the phone settings page.

### 2.2 Layers: the sky ladder

UP and DOWN move along a ladder that runs from the ground up. The home
screen draws it on the right edge, beside the buttons: the current rung as
a big icon on a lit disc beside SELECT (which aims with it), the rungs UP
and DOWN go to as smaller icons beside those buttons, and two dots above
and below when there are more rungs than that. (All six rungs at once made
icons too small to read.) A press slides the ladder one rung through the
disc in 180 ms (about six frames, nothing after).

```
  FIND IT                 (not an aim: pick something, follow the tapes)
  STARS        farthest   (stars, constellations, Milky Way objects)
  PLANETS                 (Moon and planets)
  SATELLITES              (space stations, bright satellites, Starlink trains)
  PLANES       nearest
  ? ANYTHING              "I don't know what that is"
```

- **ANYTHING** is the first-run default and sits at the bottom: "what's
  that?" starts at the ground and UP climbs into the sky. It searches every
  enabled layer and ranks across them (section 4).
- Choosing a specific layer is how a user says "I know it's a plane, which
  one?". It narrows the search, so it is both faster and more accurate.
- The ladder goes round: UP from FIND IT is ANYTHING, and DOWN from
  ANYTHING is FIND IT. The last layer is remembered.
- Layers turned off in settings disappear from the ladder.
- Each rung shows a live count when it's free to compute: "3 satellites
  up", "5 planets up". Planes show a count only from the most recent aim,
  since nothing polls for them (section 6.2).

### 2.3 Aiming

The v0.2 timed countdown worked but was slow (5.5 s). The full app captures
**as soon as the arm is steady**:

1. Tap SELECT. The screen says "Point with your finger".
2. Raise your arm and point. The watch watches the accelerometer.
3. When the arm has been still for about 0.6 s, it records for about 1.2 s.
   If you move, it waits for you to settle again.
4. **One buzz: got it.** Lower your arm. The backlight comes on with the
   result (dim red at night).

Typical total: about 2.5 s. If the arm never settles within 8 s, it shows
"Hold still" and keeps waiting; SELECT cancels. There is no start buzz, so
the motor never shakes the compass during a recording.

The 0.6 s settle is not optional: the firmware low-pass filters the
compass's tilt input (about 0.3 s lag), so the heading needs that long to
catch up with the arm.

**Roll check.** The firmware's tilt correction breaks down when the watch's
12 o'clock edge points steeply up (a thumb-up fist). If the recorded
attitude shows that, the result says "Turn your hand so the watch faces up
more" instead of guessing. The test session's natural finger-pointing pose
had only about 17 degrees of roll, well inside the limit.

### 2.4 Results

One result per screen, the best first. UP/DOWN pages through the rest (at
most 5, plus the chart and fact cards from v0.9). A row of dots shows how
many there are.

```
 [plane icon] PROBABLY . . .   <- confidence word in the band (v0.17)
 American 1234
 Phoenix to Chicago
 11,000 ft, 8 mi away
 <- a little to your left
```

From v0.17 the first answer shows a picture in place of its lines when it
has one: a star, a constellation, or nothing there at night get the
constellation chart under the name (crosshairs where the user pointed,
the caption under it); a planet its photo (`tools/make_art.py`, on the
watch), its chart a page later; the Moon its photo with the unlit part
cut away (R_MOON: lit percent, lit side's angle from up / 2); a satellite
its path over a minute (`chart.track`). That goes for a MAYBE first
answer too; the other answers keep their lines and hints.

Card contents by type:

| Type | Line 1 | Line 2 | Line 3 |
|---|---|---|---|
| Plane | Flight ("American 1234"), or registration | Route if it checks out, else aircraft type | Height and distance |
| Satellite | Name ("Space Station") | Kind ("space station", "Starlink train") | Height, direction it's moving |
| Planet / Moon | Name | "Planet" (or the Moon's phase) | Brightness in words ("very bright") |
| Star | Name, or "a star in Orion" | Constellation | How bright / how far |
| Constellation | "Orion" | "Constellation" | (none) |
| Nothing | "Nothing I know is there" | Tip: "Try again and hold still" | (none) |
| Chart (v0.9) | Constellation name | the stick figure as it stands in the sky, answer circled | "Vega is circled" |
| Fact (v0.9) | "Did you know?" | one fact, up to 120 characters | (none) |

The first answer about a planet is followed by its chart card (stars,
constellations and satellites have theirs on the answer's own page);
any first answer with something to say is followed by a fact card. The chart is a stereographic projection about the answer in
the observer's own horizon frame (zenith up), fitted to 192 x 140 pixels,
at most 60 degrees across (bigger figures are cut around the answer), with
bright stars, planets and the horizon. Facts are written for the app (the
Moon, planets, stations, about 90 stars including every named star brighter
than 2.5, all 88 constellations with a second for the 25 most seen, the 16
star patterns, about 75 plane families) or worked out (v0.21): a star's
colour and surface heat and its size or stage of life from the catalog's
spectral type (one character a star: class and luminosity class), the
light it gives off and how our Sun would look from there (from its
magnitude and Hipparcos distance; visible light, dust ignored), when its
light left it; a planet's distance now and Venus's phase; the Moon's
distance, near closest or farthest, earthshine on a crescent and the full
Moon's almanac name (Harvest: nearest the September equinox; Hunter's: the
next); a plane's speed, height and trip length (great circle between its
route's airports). Each subject turns to its own next fact (written first,
the light fact last, so it's at most one in four or five), never the fact
shown just before; the phone remembers the last 200 subjects.

The last line points toward the object relative to where you aimed
("a little to your left", "just above") when the offset is over about
2 degrees. Over time that teaches the user how they point, and it confirms
the answer.

**Confidence words, not percentages:**

| Probability | Word |
|---|---|
| 75% and up | THAT'S |
| 40 to 75% | PROBABLY |
| 15 to 40% | MAYBE |
| under 15% | not shown |

Haptics carry the outcome for a user who isn't looking yet: one buzz = a
confident answer, two short = "maybe" or "nothing found".

**Sun safety.** If the aim is within 20 degrees of the Sun while it's up,
the first card is "Don't look at the Sun!" The Sun is never offered as a
fun result.

### 2.5 Home screen

- The sky ladder on the right (section 2.2); the layer name and status
  to its left, level with the current rung.
- One status line: "5 planets up" or "Compass ready".
- A hint at the bottom: "Tap SELECT, then point".
- If something needs attention, a single chip replaces the status line:
  "Draw an 8", "Phone not connected".

### 2.6 Themes

The phone computes the Sun's altitude and sends a theme on open:

- **Day** (Sun above -6 degrees, about 1 degree of hysteresis): black on
  white, readable in sunlight.
- **Night:** white on black, dim backlight.
- **Stargazer** (optional setting): red on black and a dim red backlight
  for dark-adapted eyes.

Watch menu: Auto (Night) / Auto (Stargazer) / Day / Night / Stargazer. The
Autos switch at the Sun's -6 degrees, to Night or to Stargazer. Until one
is picked, the theme follows the sky setting: Auto (Stargazer) for a dark
sky, Auto (Night) otherwise (v0.16). The watch tells the phone its theme
(PREFS) so the settings page can go red too.

### 2.7 First run

A few short screens on the watch:

1. "Which wrist is your watch on?" UP = left wrist, DOWN = right wrist.
   Then (v0.16) "Where are you?" (City / Suburbs / Dark sky, each with
   about how many stars you can see: 80, 260, 900) and "What do you look
   with?" (My eyes / Binoculars / Telescope, which is Find it's reach).
   Both are also watch menu rows (Sky, Gear) and on the phone page. The
   phone keeps them; a change on the watch goes up as PREFS and stays
   pending until a status echoes it back. After dark, more than 50 km from
   where the sky was last set, the phone sends NEW_PLACE and the watch
   asks "Where are you now?" once.
2. Compass coach (section 5), only if the compass isn't calibrated. The
   firmware keeps its calibration between launches, so the coach is not
   shown every time; the app shows it on open whenever the compass reports
   it isn't calibrated.
3. "Point at anything in the sky and tap SELECT." Then home.

No aim tuning on the first run (section 5.2): the app learns it.

A wrong wrist setting mirrors every aim into the ground. After two such
aims in a row (that the other wrist would put in the sky) the watch asks
"Is your watch on your LEFT wrist?"; "No" switches it and says so. This
happened in the 2026-10-08 field session (DOWN = right, pressed by
mistake).

Location permission is requested by the phone app as usual. If it is
denied, the home chip says "Turn on location in the Pebble app".

### 2.8 Find it (v0.9; pointing with the top of the watch since v0.18)

The other direction: the user picks a target and the watch guides the
top of the watch (12 o'clock) to it. The FIND IT rung (top of the ladder) asks the phone for what
can be found now: the Moon (unless too new to see), the planets, star
patterns (v0.20), the brightest named stars (to magnitude 2.1), and up to
two satellites during a visible pass (the Space Station, then by rank and
brightness: Tiangong, Hubble, a train of 3 or more new satellites, by eye
only), at most 28 (everything but the stars, up to 8 patterns; stars fill
the rest, as many as fit 1,700 bytes of the watch's 2,048-byte inbox).
Planes are left out: they move too fast and too unpredictably.

**Best now and More (v0.20).** A list of 28 at two rows a screen was too
long to scroll. The phone marks about five as Best now, and the watch
opens on those with a More row under them; More lists the kinds there are
(Moon and planets, Star patterns, Bright stars, Satellites), and a kind
lists all of its targets. The pick (find.js markBest): first the best of
each kind that can be seen by eye (score: kind, then how hard to see,
height, brightness; at most 1 Moon, 2 planets, 2 patterns, 1 star, 2
satellites), then the best of the rest that can be found, then the rest
in list order, so a short list is all there. A pattern that shares stars
with one already in (Orion and its Belt) waits. With only one left over
it goes in too (no More for one). The no-phone list takes its first five.

**Star patterns (v0.20).** Sixteen (patterns.js): asterisms drawn there
through catalog stars (by IAU name, or by J2000 place where a star has
none), and three constellations by their own figure (Orion, Cassiopeia's
W, Scorpius). Offered when the middle is at least 12 degrees up and three
quarters of its stars are above 8, and when the eye can make it out:
three quarters of its stars visible (or a set magnitude for Orion and the
Pleiades, whose shape shows long before their faintest figure stars).
Finding one steers to its middle, on within half its size (5 to 10
degrees, the extra byte's give); the found card is the pattern's figure
(the chart zoomed to at least 8 degrees, for the Pleiades) with a caption
and a written fact.

Find it is for things you know are there but can't easily see, so it
doesn't hide what's faint; it says how to see each one (v0.13), from how
far past the eye's limit (section 4) it is: by eye; **look closely** (up
to 1.5 magnitudes past: by eye, knowing just where, as Find it shows you;
Jupiter by day); **binoculars** (up to 4 past); **telescope**. By day a
crescent under 20% lit is "look closely" at best. These steps are first
guesses for the field sessions to tune. A setting picks how far down the
list goes: by eye, binoculars (the default), everything. The status lines
and the answer cards use the same rule ("Hard to see now", "Try
binoculars", "Needs a telescope").

The Sun, while it's up (above -2 degrees): nothing within 15 degrees of
it is found, nor anything needing binoculars or a telescope within 30 (a
sweep with binoculars across the Sun can blind). Those stay on the list,
marked "Too near the Sun", so the user knows why; SELECT on one buzzes
twice. Something seen by eye between 15 and 30 degrees is marked "Block
the Sun first!", on the list, on how to find it, at the top of the
finding screen and on Found it (in place of the name: that's when you
look up). Up to v0.19 the guide also went quiet with a full-screen
warning and a buzz when the top of the watch came within 12 degrees of the
Sun; v0.20 drops that (user decision): while finding you look at the
watch, not the sky, and it was distracting. The watch checks the Sun
again when a target is picked or started again, since the list can be
minutes old.

**Why the top of the watch (v0.18).** Up to v0.17 Find it followed the
finger, like an aim, and guided by ticks that sped up as you closed in.
Two problems: with the arm out you can't see the screen, so everything on
it was wasted; and a tick rate only says how far, never which way (people
are poor at telling 600 ms ticks from 800 ms, and the compass lags about
0.3 s), so finding meant wandering and comparing. Holding the watch as if
reading it and pointing its top keeps the screen in view the whole time
(at the horizon the face points straight up at you; tilting up turns it
toward you). The pointing axis is the watch itself, so there's no finger
offset to learn. Aims (identifying what you see) still follow the finger:
there you point at something you can already see.

The watch works out where its top points by itself, on every compass
reading (5 a second; sky.c sky_aim_dir with (0, 1, 0)), so nothing
streams: the phone sends each target's RA/Dec (the Station: its path for
3 minutes, a point every 3 s) and a sky frame (place, declination, finger
offset per wrist, sky), which the watch keeps. The top's azimuth is the
firmware's own heading (tilt compensated, for the 12 o'clock axis) plus
the declination; its height is its pitch; roll doesn't move it.

- **First, how (v0.19):** picking a target shows its name, where to look
  and "Hold your watch as if reading it and point its top at the sky.
  Turn, then tilt, as the screen says." until a tap or SELECT (BACK: the
  list). Find it may be weeks between uses, so it's every time, not only
  the first. The 3 minutes start after it.
- **Screen: two tapes, one step at a time.** Across the top a compass tape
  (2 px a degree, about 46 degrees each way), the pointer under it where
  the top points; up the right a height tape (0 to 90). The target is a
  diamond on each, a chevron at the end when it's off the tape. The words
  carry the step: "Turn right 62°" until facing it, then "Tilt up 13°",
  then "Hold it". Turning first, because your heading barely changes as
  you tilt, so it stays done. A pilot's tapes beat a viewfinder (a dot to
  put in a ring, or an arrow at the rim): those need reading and
  interpreting, the tapes split it into two one-direction steps.
- **On:** facing it = the heading within 5 degrees of sky at the target's
  height (5 / cos(alt) of heading); level = height within 5. Each stays on
  until past 7. Near the zenith the heading's give stops at 45 to stay on
  (32 to come on). A tape that's on fills in (in Stargazer
  colour can't tell things apart, so fill does).
- **Smooth (v0.19):** the firmware gives a compass heading only 5 times a
  second (magnetometer at 5 Hz, fw/services/ecompass/service.c; 20 Hz
  while calibrating but only every 4th reaches apps), and v0.18 redrew
  only then, so the tapes jumped. Now: drawing runs at about 30 frames a
  second while the tapes catch up (each frame closes 0.3 of the gap, about
  0.1 s), then stops until the next reading (a reading redraws only
  when the words or a tape's state change, or the target moved); the height comes from the
  accelerometer one sample at a time (25 Hz, each halfway to the last, to
  calm a shaky hand), since it needs no compass; the latest heading is used
  as is (v0.18 averaged two, 0.1 s more lag); the target's and the Sun's
  places are worked out 4 times a second, not on every sample. Still
  firmware's: the heading's 5 Hz, and the heading trails a tilt by about
  0.3 s (its tilt correction filters gravity at 0.5 Hz). Turning first,
  tilting second keeps that out of the way.
- **Buzzes:** one 40 ms tap on coming to face it (at most every 1.5 s);
  the lock pattern; the Sun's double pulse. No hotter / colder ticks.
  Compass readings within 120 ms of a buzz are skipped (the motor sits
  beside the compass); accelerometer samples taken while vibrating are
  dropped by the firmware's flag.
- **Overhead:** the firmware's heading is for the 12 o'clock axis, which
  means nothing pointed straight up (and the SDK has no raw
  magnetometer), so past about 70 degrees of tilt it can't be followed. A
  target higher than 65 isn't tilted to: turn to face it ("then look
  up"), and facing it held 0.7 s locks on. Found, it says "Look almost
  straight up" (65 to 80) or "Look straight up" (80 and up). Near the
  zenith a little sky is a lot of heading, hence the wider give.
- **Not held up:** the screen faces up less than 0.25 (within 15 degrees
  of on edge, like an arm hanging down): "Hold your watch as if reading
  it". Tilted up (or down) past 70: "Tilt down (up) a little". Both stop
  the tapes and any lock, and show where to look ("high in the SW").
- **Lock**: both tapes on for 0.7 s (overhead: facing it), the same rule
  the screen shows, so "Hold it" always ends in a lock.
  The pattern (60-80-60-80-300 ms), then **Found it** and a big arrow up
  (past the top of the watch) for 3 s, or until any button; then the
  answer card, the phone's if it has come (its chart and fact; no "where
  to look" hint, the arrow said it).
- Locks don't teach the aim: the top of the watch isn't the finger.

To check in the field: whether the tapes' 5 degrees turn
on too eagerly or too reluctantly, whether the tap disturbs the compass,
and how the firmware heading behaves tilted up 50 to 70 degrees.

## 3. Who does what

**Rule:** the watch senses, draws and buzzes. The phone computes and
fetches. Bluetooth carries only small messages: one aim up, one results
packet down.

### 3.1 Watch

- Button UI, sky ladder, result cards, coach animation, themes.
- Steadiness detection and capture: compass (5 Hz) and accelerometer
  (25 Hz, batched) averaged over the recording window, as in v0.2.
- Type icons as small PNG resources (a few KB total).
- Persisted: wrist, last layer, theme override, onboarding done.

### 3.2 Phone

- Turning the raw capture into a sky direction: full attitude from gravity
  plus the 12 o'clock heading, the wrist axis, WMM2025 declination, and the
  user's personal offset, learned (section 5.2).
- Everything to do with the sky: ephemerides, satellite propagation,
  aircraft feeds, the star catalog, the matcher and confidence model.
- All network access and caching.
- The settings page.

### 3.3 The star catalog on the watch (v0.9)

The phone's answer is about 0.5 KB per aim, so a catalog on the watch
saves little Bluetooth time; the phone stays the one that answers whenever
it can. The watch has its own copy for answering with no phone, and for
Find it's offline list:

- `resources/data/sky.bin` (32 KB of the 256 KB an app may carry): all
  2,887 stars as unit vectors at epoch 2027.0 (precession to the date is
  under 0.15 degrees until 2036), their names, each star's constellation,
  Roman's table and the rotation to B1875. Built from the phone's catalog
  by `tools/make_watch_sky.js`.
- The Moon and planets are not computed on the watch: the phone sends a
  table (the Moon every 3 hours for a week, topocentric; the planets daily
  for two weeks; about 700 bytes) when the watch asks (riding on its next
  aim) or after a move of half a degree. The watch interpolates. The Sun
  it works out itself (a few lines).
- `src/c/offline.c` scores stars, planets and the Moon as `matcher.js`
  does, with the same sky limits (all 2,887 stars only under a dark sky).
  test/c/offline_test.c checks the two agree.
- It answers when the phone is out of reach or silent for 6 s, for
  ANYTHING, PLANETS and STARS. Its cards say NO PHONE; a late answer from
  the phone replaces them. No learning or logging happens offline.

Trig uses the SDK's integer lookups (0.006 degrees), arithmetic is soft
double, and resource reads go through one 512-byte buffer (an app has a
4 KB stack on emery).

A live sky view (a chart that moves with the watch) would build on this.

### 3.4 Messages

| Direction | When | Contents | Size |
|---|---|---|---|
| Phone to watch | App open, then on change | Theme, layer counts, enabled layers, status chip | about 100 B |
| Watch to phone | SELECT tapped | "Aim started" and the layer (starts the plane fetch, section 6.2) | about 10 B |
| Watch to phone | Each aim | Time, raw heading, mean gravity vector, heading jitter, compass status, layer | about 60 B |
| Phone to watch | Each aim | Up to 5 cards: type, 3 short lines, confidence, offset hint | about 400 to 600 B |
| Phone to watch | With the first answer (v0.9) | R_CHART: the chart's points, lines, horizon and extras (aim, arrow, caption); R_FACT: the fact; R_MOON (v0.17): how the Moon is lit | 60 to 260 B, up to 120 B, 2 B |
| Watch to phone | FIND IT, SELECT | FIND_REQ | a few B |
| Phone to watch | Reply | FIND_LIST (targets, the Sun) and SKY_FRAME | 300 to 900 B |
| Watch to phone | Lock-on | FIND_FOUND and a sequence number; answered like an aim | a few B |
| Watch to phone | With an aim or FIND_REQ, when needed | EPH_REQ: the Moon-and-planets table is missing or runs out within 2 days | 7 B |
| Phone to watch | Asked, or after a move | SKY_EPH: the Moon and planets for the days ahead | about 700 B |

The watch opens AppMessage at 2 KB in (v0.9: answers with a chart and a
fact run past 1 KB; the phone trims the last cards if one wouldn't fit),
256 B out.

## 4. Matching and confidence

### 4.1 Candidates

For the aim direction A and each object i with predicted position P_i:

- d_i = angle between A and P_i.
- sigma_i = sqrt(sigma_aim^2 + sigma_obj,i^2)
  - **sigma_aim** (the pointing error) comes from the compass state:
    about 3 degrees calibrated with a tuned aim, 4 to 5 calibrated without,
    8 or more while calibrating. Heading jitter during the capture widens
    it.
  - **sigma_obj** (the object's own position error): 0 for stars and
    planets. For planes: speed times data age, divided by range. For
    satellites: about 2 km per day of element age (growing faster after
    3 days), divided by range, combined with how far it moves across the
    sky in half a second (clock, reaction and tracking lag).
- An object is a candidate if d_i < 3 sigma_i, capped at 12 degrees.

### 4.2 Scoring

Each candidate gets a score from a 2-D Gaussian likelihood times a prior:

    L_i = exp(-d_i^2 / (2 sigma_i^2)) / sigma_i^2
    p_i = L_i * prior_i / (sum_j L_j * prior_j + L_none * prior_none)

Dividing by sigma^2 matters: a fuzzy plane position should not beat a
sharp star at the same distance from the aim.

The **"nothing there" term** (L_none times prior_none, a constant) keeps
the app honest. If nothing is close, every p_i stays low and the card says
"Nothing I know is there" rather than promoting a far-off object.

**Priors** encode what a person is likely to be pointing at:

- **Visible right now:** ANYTHING mode requires it. Satellites must be
  sunlit with the observer's Sun below -6 degrees. Stars must be brighter
  than the sky allows (a limit from Sun altitude and the user's sky
  setting). In an explicit layer, invisible objects are still allowed but
  are labelled "not visible right now".
- **Brightness:** brighter objects are likelier targets; the prior falls
  off with magnitude. The Moon and Venus dominate when near.
- **Planes:** nearer and lower aircraft are more noticeable. Aircraft on
  the ground are dropped.

### 4.3 Groups and overload

Any one type can swamp the list (a hundred aircraft near an airport, a
Starlink train, hundreds of faint stars). The controls:

- **Group before ranking.** Satellites from the same launch within a
  degree or two become one "Starlink train (12 satellites)" card. Stars in
  a cluster become the cluster (the Pleiades).
- **Per-type cap in ANYTHING mode:** at most 3 cards per type, 5 total.
- **Minimum probability:** under 15% is not shown.
- **Stars fall back to constellations.** In STARS, if no star scores well,
  the answer is the constellation the aim falls in ("You're pointing into
  Orion"). Constellation lookup precesses the aim to B1875 first, as the
  Roman 1987 boundary table requires.

### 4.4 Tuning

The cone and priors start from the test numbers and get tuned with field
logs. During development a hidden developer mode logged every aim with its
raw sensor data, the candidates and the chosen answer; it was removed
before the public release.

## 5. Compass coaching

The firmware reports one of three statuses: invalid, calibrating,
calibrated. It does not report progress.

### 5.1 Draw an 8

Shown on app open whenever the status isn't "calibrated", and from the
home chip.

- An animated figure 8 traced by a dot, and the text "Draw a big 8 in the
  air with your watch".
- Encouragement that changes with time instead of a fake progress bar:
  "Keep going", then "Bigger loops", then after 30 s "Step away from cars,
  metal and electronics".
- On "calibrated": a buzz, "Compass ready!", and straight back to where the
  user was.
- If it drops back to "calibrating" later, the home chip says "Draw an 8"
  again. The app never forces it mid-aim.

### 5.2 Learning your aim

The firmware calibration fixes the magnetometer. It can't know how the
watch sits on your wrist or how you point. The app learns that itself
(v0.8; v0.6 and v0.7 asked the user to point at a named target):

1. **From confident answers.** When an answer about the Moon, a planet or
   a star is at least 60% likely, with no close rival, the finger offset
   that would have put the aim dead on becomes a sample for that wrist,
   unless it is more than 10 degrees from the offset in use (a wrong
   answer must not pull the offset off). Planes and satellites never
   teach: their positions carry their own errors.
2. **The offset** is the median of the last 20 samples, once there are 5
   (the default until then). Recent samples win, so a recalibrated compass
   is followed.
3. **Tune my aim** (watch menu): three aims at the Moon when it's 15 to 65
   degrees up and clear of the Sun, else at the brightest planet that is.
   Most people can't find a named star on request; everyone can find the
   Moon or Jupiter. A CLOSEST answer (the bright thing nearest a miss,
   matcher.js) offers a tune on that object, star or not: holding SELECT
   on it says that's what was meant. If its offset beats
   the current one on those aims (each scored leaving itself out), the
   samples restart from the Moon's three, which count from the start; if
   not, they join the rest.

Why not one target three times: the 2026-10-08 session showed a compass
error that changes with direction (about 4 degrees, left of target to the
SW and W, right to the N and E). A tune at one target removes the bias in
that direction only; answers from all round the sky average it out.

### 5.3 Disturbed compass

If heading jitter during a capture is high, or one aim disagrees sharply
with the user's tuned offset, the result adds "Your compass seems
disturbed here" and widens the cone. Cars, railings and rebar cause local
errors of 3 to 4 degrees or more; that warning is the honest answer to
them.

## 6. Data

### 6.1 Sources

| Layer | Source | Refresh | Cache | Size |
|---|---|---|---|---|
| Planes (positions) | adsb.lol `/v2/point`, fallback adsb.fi, optional home receiver | Only when an aim starts in PLANES or ANYTHING; reused for 10 s | Memory only | 60 KB per fetch (25 nm, Phoenix) |
| Planes (details) | Feed `r`/`t`; adsbdb by hex, then hexdb | On first sight of an aircraft | 30 days per hex | about 1 KB each |
| Planes (routes) | VRS route file per airline via jsDelivr, with a position check | On first sight of an airline | 7 days | 5 to 160 KB per airline |
| Airlines, airports, aircraft types | VRS + OurAirports tables, trimmed | Bundled | n/a | under 100 KB |
| Satellites | CelesTrak `stations`, `visual`, `last-30-days` (JSON) | Every 24 h; never twice within 2 h; back off on any error | Persistent | about 75 KB plus recent launches |
| Moon, planets, Sun | Own code (Schlyter) | Computed | n/a | under 10 KB |
| Stars and constellations | Bright Star Catalogue to mag 5.5 (and fainter stick-figure stars), IAU names, van der Sluys stick figures, Hipparcos distances, Roman boundaries | Bundled | n/a | about 45 KB phone, 32 KB watch |
| Moon and planets for the watch | Own code, as a table | When the watch asks, or after a move | Watch persistent storage | about 700 B |
| Declination | WMM2025 (public domain) | Per location fix | Persistent | about 4 KB |

Kid-facing facts ("Biggest planet", "The Hunter") came in v0.9
(`facts.js`), written for the app; numbers from NASA fact sheets and the
makers' figures.

### 6.2 Network rules

- Every data source sits behind a small adapter with its URL template, so a
  provider that changes can be swapped without touching the rest.
- Location is rounded to 0.01 degree (about 1 km) before any request.
- **No polling for planes.** The fetch starts when SELECT is tapped in a
  layer that includes planes, so it runs during the roughly 2.5 s the user
  spends pointing and is usually done by the "got it" buzz. A second aim
  within 10 s reuses the same data. That is one request per aim, and none
  while the app just sits open.
- No request is ever retried tightly. 403 or 429 means back off (2 hours
  for CelesTrak).
- Planes come from whichever feed answers faster, measured over time; the
  other is the fallback. A slow first answer (adsb.lol took 4.1 s once)
  falls back after 2.5 s.
- Responses are checked before use: a malformed feed never crashes the
  matcher.
- Phone storage keys are all prefixed `sf_`. The phone's storage held 82
  keys the test app hadn't written, so apps may share one storage area.

### 6.3 Freshness

- Every aircraft is moved forward to the capture time along its track
  (speed times position age plus the request time). Positions older than
  60 s are dropped.
- About a third of aircraft report no GPS altitude; those use pressure
  altitude.
- Satellite elements older than 3 days widen that satellite's
  uncertainty; older than 10 days, it drops out.

### 6.4 Credits

A "Data sources" section on the settings page, plus a NOTICE file:
adsb.lol (ODbL), adsb.fi (with link), adsbdb, VRS standing data,
OurAirports, CelesTrak / Space-Track, Bright Star Catalogue (Hoffleit and
Warren, via VizieR), IAU WGSN, van der Sluys ConstellationLines (CC BY 4.0,
DOI 10.5281/zenodo.10397192, modified), Roman 1987, NOAA WMM2025,
satellite.js (MIT). The NOTICE also says some data sources forbid
commercial use, so the app stays free.

## 7. Settings (phone page)

Kept short, with sensible defaults; a child never needs to open it.

**What to look for**

- Planes on/off. Hide planes below [500 ft]. Max distance [30 mi].
- Satellites on/off: space stations, bright satellites, new Starlink
  trains. "Show satellites I can't see right now" (off).
- Planets and Moon on/off.
- Stars on/off. Sky: city / suburbs / dark (sets how faint a star can be).
  Constellations on/off.

**Watch and display**

- Wrist: left / right.
- Theme: Auto (Night) / Auto (Stargazer) / Day / Night / Stargazer.
- Units: feet and miles / meters and km (default from phone locale).

**Data**

- Plane data: Automatic / adsb.lol / adsb.fi / My receiver [URL].
- Optional per-user adsb.lol key (for when they start requiring one).
- Data sources and credits.

**Help**

- What the aim has learned, and forgetting it. Reset.

## 8. Battery and speed

**Watch**

- The app is a glance: open, aim a few times, close. It exits after 5
  minutes with no button press. Nothing is recomputed while it sits idle,
  but an open app keeps the magnetometer and accelerometer running and
  stops the watch from returning to its watchface, so an app left open by
  accident would otherwise drain the battery all day. The timeout is a
  safety net, not part of normal use.
- The compass runs while the app is open, because calibration and the
  tilt filter both need it warm. At 5 Hz it is cheap. Leaving the app
  unsubscribes it, which turns the magnetometer off; a notification over
  the app doesn't (the app keeps running underneath).
- The accelerometer stays subscribed for the app's life (unsubscribing
  with a batch queued crashes the app on current firmware). It runs at
  25 Hz, in batches of 5 (every 200 ms) while aiming or finding and of 25
  (once a second) on every other screen, where its readings aren't used.
- No animation runs on Home. The coach animation stops when calibrated.
- The backlight turns on only for the result, and only when it's dark.
- Vibrations are short and few: one per aim result, one on calibration.

**Bluetooth**

- One small message each way per aim; nothing streams.

**Phone**

- PebbleKit JS runs only while the watch app is open, so all phone work
  stops when the app closes.
- Planes are fetched once per aim, never polled.
- Satellites and route tables are fetched at most daily and weekly.

**Speed targets**

- App open to ready: under 2 s (cached data first, refresh after).
- Buzz to result on screen: under 1 s. The plane fetch started at the tap;
  satellites and stars are computed in a few milliseconds. If the plane
  feed is slow (adsb.lol once took 4.1 s), the other layers' results show
  first and planes are added when they arrive.

## 9. Build order

1. **Core (no network):** Moon, planets and stars; the sky ladder; the
   steady-capture aim; the matcher and confidence words; compass coach;
   themes. Works anywhere with no API at all, and is the base for field
   tuning.
2. **Satellites:** CelesTrak cache, satellite.js, visibility, Starlink
   train grouping. Done in v0.4 (with the satellite settings and units).
3. **Planes:** feed adapters with fallback, prefetch, dead reckoning,
   details and routes. Done in v0.5. Airline, airport and type tables are
   fetched lazily from jsDelivr and cached rather than bundled (VRS shards
   them), which keeps the app small and the data current.
4. **Polish:** first run, Tune my aim, settings page, credits, Sun warning,
   developer mode. Done in v0.6. Differences from the plan above: wrist and
   theme stay in the watch menu rather than on the phone page (the watch
   owns them); the optional adsb.lol key waits until adsb.lol asks for one;
   a tune keeps the old offset unless the new one predicts the tune aims
   better (each scored leaving itself out); and sigma_aim stays at 5
   calibrated after tuning until step 5 has field data to set it.
5. **Field tuning:** sigma and priors from logged aims; one session by day
   and one by night. Done with a developer-only field test (v0.7; removed
   before the public release). v0.8 after the 2026-10-08 night: sigma 5 to 4, the aim
   learned from confident answers, and the wrist question. The "nothing
   there" weight and the brightness prior wait for dark-patch aims.
6. **v0.9:** the constellation chart card, fun facts, Find it (the Moon,
   planets, bright stars, the Space Station on a visible pass), and
   answering from the watch with no phone (stars, Moon, planets).
7. **Later:** Round 2 (gabbro) layout; a live sky view; setting the sky
   (city / suburbs / dark) from the location. For the last, no public API
   was found (lightpollutionmap.info is a map site); the World Atlas 2015
   (Falchi et al. 2016) is a 2.9 GB GeoTIFF of artificial zenith
   brightness, on request, CC BY-NC 4.0, which would need cutting down to
   a coarse grid on the phone and calibrating to a limiting magnitude.

The moon test (v0.1, v0.2) was retired in v0.8, and the developer field
test before the public release.

## 10. Decisions for you

1. **Platforms.** Recommendation: PT2 (emery) first, with layouts kept
   centre-weighted so a Round 2 port is cheap later.
2. **Steady-capture instead of the countdown.** Recommendation: yes, with
   the countdown kept as a fallback setting if steadiness detection proves
   flaky outdoors.
3. **ANYTHING at the bottom of the ladder** (ground up), as the first-run
   default. The alternative is a separate button, but there are only
   three.
4. **Distribution.** Public Pebble app store and public GitHub? Store
   listing is the point where a courtesy note to adsb.lol makes sense (its
   docs ask apps in production use to get in touch), and where the privacy
   note in the listing matters. Repo visibility doesn't change either.

Decided 2026-10-07: no kid-facing facts in v1; no plane polling in v1
(fetch per aim); idle exit after 5 minutes.

Decided 2026-10-08 (v0.9): Find it is the top rung of the ladder; it offers
the Space Station only during visible passes, and no planes. Facts are on
by default (they're for grown-ups too). The watch carries all 2,887 stars,
used only as the sky setting allows (5.5 needs Dark countryside). One
release for all four features.

Decided 2026-10-08: planes stay in ANYTHING by default (the rounded
location goes to the plane service on those aims; planes can be turned
off); when the phone gives no altitude, the observer is at sea level; the
moon test app is retired; aim tuning is learned from confident answers,
with a Moon-only tune in the menu and none on the first run; the compass
coach shows only when the compass isn't calibrated.

Decided 2026-10-09 (v0.20): Find it opens on Best now with More under it
(not the kinds first); star patterns as designed (phone only: the no-phone
list stays as it was, for the watch's image room); while finding, no Sun
takeover or buzz, with "Block the Sun first!" kept and added to Found it;
the list's Sun limits kept. The full Starlink catalog (a server caching
CelesTrak's starlink group, since per-phone downloads of it are rate
limited per address) is skipped for now; new trains already come from
last-30-days.

## 11. Shelved ideas

Kept for later, from the first outside user's report (2026-10-14: Saturn
answered "nothing there" two times in three; a landing plane not in the
plane data; extra answers not found).

- **Wider aim error where the compass is weaker.** The watch's compass
  reads the horizontal part of the Earth's field, and that is weaker over
  most of Europe and northern Asia (Moscow 0.70 of Phoenix's, Helsinki
  0.62, Berlin 0.79; `wmm.field().h` already gives it). The same small
  compass faults then throw the heading further off. Widening sigma (and
  MAX_SEARCH) by about sqrt(H at Phoenix / H here) would follow from that,
  but it's a guess until diagnostics from abroad show the misses. CLOSEST
  (matcher.js) covers the worst of it meanwhile.
- **Saying when the location is stale.** With no fresh fix the phone uses
  the last one saved, however old, without saying so (`answerAim` checks
  only that there is one). Older than a day: "Using where you were 3 days
  ago", and why (location off, or it timed out). The diagnostics now note
  the fix's age and the last location error.
- **A "Could be" list** as the first card when the top answer is only
  MAYBE: two or three candidates and how far each is from the aim. Costs
  the most watch space; wait to see whether CLOSEST and the "more answers"
  cue are enough.
