# Changelog

## 1.1 (2026-10-14)

From the first reports from outside the US: a planet "not there" when it
was, a landing plane missing, and extra answers nobody knew were there.

- **CLOSEST, when you miss.** If nothing is close to where you pointed,
  the answer is now the bright thing nearest your aim (the Moon, a planet
  or one of the brightest stars, up to 25 degrees away), with how far off
  you were and which way, and a chart of your aim and it. Before, a miss
  of more than about 12 degrees said "Nothing there". In a dark sky, faint
  stars round the aim no longer crowd out the bright planet beside them.
- **Tune on what you missed.** Hold SELECT on a CLOSEST answer and Tune
  my aim starts on that object straight away: three aims and your aim is
  corrected. Tune on the Moon is now **Tune my aim**, and uses a bright
  planet when there's no Moon.

<img src="https://github.com/hornofabraxas/pointer-planetarium/raw/v1.1/docs/screenshots/closest.png" width="200" alt="CLOSEST: Saturn, 14 degrees off"> <img src="https://github.com/hornofabraxas/pointer-planetarium/raw/v1.1/docs/screenshots/closest-chart.png" width="200" alt="Where you pointed, Saturn circled"> <img src="https://github.com/hornofabraxas/pointer-planetarium/raw/v1.1/docs/screenshots/tune-saturn.png" width="200" alt="Tune my aim: point at Saturn">

- **More answers are easier to find.** A rail down the right edge has a
  mark for each answer, the one you're on lit up. The first time a result
  has more than one, the answer hops up once after a few seconds to show
  the next one under it (just once, and never again after you've moved
  between answers). UP and DOWN now go answer to answer, like dragging;
  an answer's own pages are a sideways drag. "or Vega" now shows on the
  first page whenever there's room, not only the last.

<img src="https://github.com/hornofabraxas/pointer-planetarium/raw/v1.1/docs/screenshots/more-answers.png" width="200" alt="The rail on a planet answer"> <img src="https://github.com/hornofabraxas/pointer-planetarium/raw/v1.1/docs/screenshots/nudge.png" width="200" alt="The one-time nudge, part way"> <img src="https://github.com/hornofabraxas/pointer-planetarium/raw/v1.1/docs/screenshots/plane.png" width="200" alt="A plane answer with the rail">

- **Plane data says what's wrong.** Answers wait longer for slow plane
  data (up to 9 seconds in PLANES, and up to 6 in ANYTHING where it's been
  slow), for mobile data and connections from far away. When there are no
  planes, the PLANES line and the answer say why: "Plane data too slow",
  "Can't reach plane data", "Few planes tracked here" (the volunteer
  receivers behind the data don't cover everywhere; checked with one wider
  look at most once an hour) or "None tracked nearby".
- **Copy diagnostics** on the settings page's About tab: your last few
  aims, your location (rounded to about 60 miles), the compass and the
  plane data as the app saw them, to paste into a message when something
  isn't working.

## 1.0 (2026-10-13)

The first public release.

- **Point and identify:** the Moon, the planets, about 2,900 named and
  unnamed stars, all 88 constellations, satellites you can see (the Space
  Station, Tiangong, Hubble, bright satellites, Starlink trains) and the
  planes around you, with how sure the app is.
- **Pictures and charts:** NASA pictures of the Moon and planets, the
  Moon lit as it is tonight, constellation charts drawn the way the sky
  looks now, satellite paths, and plane routes and shapes.
- **Fun facts** for the Moon, planets, stations, about 90 stars, every
  constellation and about 75 kinds of plane, plus ones worked out from
  what you pointed at.
- **Find it:** pick the Moon, a planet, a constellation or star shape, a
  bright star, or the next pass of the Space Station, Tiangong or Hubble,
  and two tapes steer the top of your watch to it. A Moon that hasn't
  risen yet, or a pass to come, gets a countdown.
- **Learns how you point,** per wrist, from its sure answers; Tune on the
  Moon speeds that up.
- **Compass calibration takes over** whenever the compass needs it, so
  aims are never made with a compass that isn't ready.
- **Works by touch:** lists scroll under your finger, answers follow your
  finger from one to the next.
- **Themes:** Day, Night, and a red Stargazer theme for dark-adapted eyes,
  switching automatically at sunset.
- **Logbook** on the phone: everything you've seen, as a collection.
- **Without the phone,** the watch still names the stars, the Moon and
  the planets.
