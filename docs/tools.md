# Tool reference

The server offers five tools. Each tool's description in `tools/list` is the authoritative contract; this page is the readable version.

All results are numbers and plain facts. A value the engine could not produce is listed in `missing`, never guessed.

## Common input

Birth data, used by every tool (twice in `get_composite_data`):

| Field | Meaning |
| --- | --- |
| `birth_date` | `YYYY-MM-DD`, in the calendar of the birth place. Required. |
| `birth_time` | 24-hour `HH:MM`, in the local time of the birth place. Required. |
| `latitude`, `longitude`, `timezone` | Signed decimal degrees (north and east positive) and an IANA zone such as `America/Chicago`. Give all three, or give `place`. |
| `place` | A place name such as `Austin, TX`, or a shorthand such as `NYC`, `LA`, `SF` or `DC` (full list below). Looked up offline in GeoNames. An ambiguous name returns an error that lists candidates. Not together with the coordinate fields. |

Other fields several tools share:

| Field | Meaning |
| --- | --- |
| `house_system` | `placidus` (default), `koch`, `equal`, `campanus`, `regiomontanus`, `porphyry` or `whole_sign`. |
| `ayanamsa` | `tropical` (default), or the sidereal `lahiri`, `fagan_bradley`, `raman` or `krishnamurti`. A sidereal result names the value in `meta`. The stub refuses a sidereal value. |
| `harmonic` | A whole number from 1 to 10000. `1` is the natal chart (default). A harmonic chart multiplies every longitude by the number, modulo 360. `get_daily_transits` caps it lower, at the day's maximum (see its section). |
| `bodies` | Object codes to return, such as `["Sun","Moo","Mer"]`. Leave out for all of them. |

Place lookup uses GeoNames `cities500` (towns over 500 people). A place that is not in it needs explicit coordinates.

### Place shorthands and alternate spellings

A small, fixed alias table maps everyday shorthand and the old names of renamed cities to one GeoNames place each, by its `geonameId`, so an alias can never be ambiguous. The alias is looked up only when the name search finds no place at all. Every name that already resolves keeps its place, and an ambiguous name stays ambiguous. Shorthand is matched after the same normalisation as a place name (case folded, accents stripped, initialism periods closed). Coordinates, regions and time zones still come only from the GeoNames rows; an alias only names a place, it never supplies numbers.

| Shorthand | Resolves to | Alias target |
| --- | --- | --- |
| `NYC`, `New York` | New York City | New York City, US/NY (`America/New_York`) |
| `LA`, `L.A.` | Los Angeles | Los Angeles, US/CA (`America/Los_Angeles`) |
| `SF`, `San Fran` | San Francisco | San Francisco, US/CA (`America/Los_Angeles`) |
| `DC` | Washington | Washington, US/DC (`America/New_York`) |
| `Philly` | Philadelphia | Philadelphia, US/PA (`America/New_York`) |
| `Vegas` | Las Vegas | Las Vegas, US/NV (`America/Los_Angeles`) |
| `Peking` | Beijing | Beijing, CN (`Asia/Shanghai`) |
| `Saigon` | Ho Chi Minh City | Ho Chi Minh City, VN (`Asia/Ho_Chi_Minh`) |

A shorthand stands alone: it takes no region or country, so `LA, CA`, `Philly, PA` and `NYC, US` are refused. Write `Los Angeles, CA` instead. `NY` is a state code, not a city, so it is not supported; write `New York` or `NYC`. `Washington, DC` already resolves on its own, so it is not aliased. Chi-town is not supported.

Old city names that already match a GeoNames place are not aliased, because an alias would override a place that resolves today: `Bombay` is a town in New Zealand, `Madras` is a town in Oregon, and `Calcutta` names four places and resolves to the one in South Africa by population. For those cities give `Mumbai`, `Kolkata` or `Chennai`, which resolve by name. `Peking` and `Saigon` match no place name in cities500, so their aliases add a resolution where none existed. Anything that is not a known place name or one of these shorthands must be given as `latitude`, `longitude` and `timezone`. Each alias records the primary name and ISO country code of its row, and the row its id returns must match both, so an id that a later GeoNames release gives to another city is refused rather than resolved. Each alias is covered by `src/place-aliases.ts`, checked against the fixture in `src/place.test.ts`, and checked against the real GeoNames files by a test that skips when they are absent.

## `get_chart_data`

A natal chart: each body's sign, degree, minute, house, retrograde flag and ecliptic longitude; the twelve house cusps; the angles (ASC, MC, DSC, IC); and the aspects among them.

Inputs: the birth fields, `house_system`, `ayanamsa`, `harmonic`, `bodies`, `aspects`, `aspect_limit`.

## Aspect inputs

`get_chart_data` and `get_composite_data` take the same two fields:

| Field | Meaning |
| --- | --- |
| `aspects` | `major` (default) lists the five major aspects (conjunction, opposition, trine, square, sextile) between the bodies, with no `strength` and no `set` key, and no angles. `all` lists the 17 vibrational aspects between the bodies and the angles ASC and MC, so minor aspects such as semisquare, sesquiquadrate, quincunx, quintile, septile and novile appear. Angles are aspect targets only in `all`. |
| `aspect_limit` | How many aspects to list: a whole number, `8` by default. `0` lists every aspect. |

Orbs in `all`: each aspect's orb is 16 degrees divided by its own harmonic: conjunction 16, opposition 8, quintile 3.2, semisquare 2. The five major aspects take the wider of that and their major orb, so in `all` they are conjunction 16, opposition 8, trine 6, square 6 and sextile 4 (the harmonic rule alone would give trine 5.33, square 4 and sextile 2.67). Because of this, the `all` set holds every major aspect at the same angle; `all` only adds to it. The list is cut by `aspect_limit`, so a major aspect shows in an `all` list only when it falls inside the cut. With `aspect_limit` `0`, every major aspect is listed.

Every result states `total`, the number of aspects in the set, and `truncated`, true when the list is shorter than the total, so nothing is hidden silently.

`major` lists the tightest orb first. `all` lists by strength: 1 at the exact angle and 0 at the edge of the aspect's orb, so an exact novile can rank above a conjunction that is 10 degrees off. Each `all` item carries its `strength`, rounded to two places, and the list carries `"set": "all"`, so the ranking can be read. `major` items and lists carry neither key.

In a harmonic chart the aspects are read on the harmonic longitudes, and each orb follows the aspect's own harmonic, not the chart's. A harmonic 5 chart with `aspects: "all"` therefore reads the same 17 aspects with the same orbs, on the multiplied positions.

## `get_transit_data`

The transiting bodies at a moment and the aspects between them and a natal chart: by default the five major aspects between transiting bodies and natal points, and with `include` also the midpoints.

Inputs: the birth fields, `house_system`, `ayanamsa`, `harmonic`, `bodies`, plus:

| Field | Meaning |
| --- | --- |
| `transit_date`, `transit_time` | The moment to look at. Leave both out for the sky right now. |
| `transit_timezone` | Zone of that moment. Without one the time is UT. |
| `aspects` | `major` (default) reads the five major aspects. `all` reads the 17 vibrational aspects, such as semisquare, quincunx, quintile, septile and novile. The orb depends on the pairing: a point pairing (T to N) takes the transit orb of the aspect's own harmonic, 2 degrees for harmonics 1 to 4 and 1 degree above; any pairing with a midpoint takes the classic midpoint orb, 1.5 degrees for conjunction and opposition and 1.5 × 2 ÷ harmonic for the others, which is narrower. |
| `include` | A list of pairings, default `["points"]`, in any order: rows are ranked together whatever the order. Each value once; a repeat is refused. `points` reads transiting bodies to natal points (T to N). `to_natal_midpoints` reads transiting bodies to natal midpoints (T to Nm). `transit_midpoints` reads midpoints of pairs of transiting bodies to natal points (Tm to N). `midpoint_to_midpoint` reads transit midpoints to natal midpoints (Tm to Nm). A natal midpoint is the midpoint of two natal points, ASC and MC included. Each value gives its own rows. |
| `min_strength` | Keep only aspects at or above this strength, from 0 to 1. `0` (default) keeps every aspect inside its orb. |
| `aspect_limit` | How many aspects to list: `15` by default. `0` lists every aspect. |

`bodies` limits the transiting bodies, and so the transit midpoints made of them (Tm). The natal side is not filtered: the natal chart is always whole.

Every request returns the same row shape, told apart by `pairing`. The default request (`aspects` `major`, `include` `["points"]`) returns the rows it always had (`transit_body`, `natal_target`, `aspect`, `orb`, `applying`, `strength`, `text`), with the same keys, order, orb and strength, ranked by orb, and now also the keys below. Its `applying` and `text` change only for a row whose phase is unknown (a pair crossing an aspect's exact point, 0 or 180 degrees, or a midpoint flip inside the look-ahead): that row reads `phase` `unknown`, `applying` `false`, and text ending in "phase unknown". Every other request ranks by strength to two places, with equal strengths in pairing order (T to N, T to Nm, Tm to N, Tm to Nm). In the labels, T is a transiting body, Tm the midpoint of two transiting bodies, N a natal point (a body, ASC or MC) and Nm the midpoint of two natal points.

| Key | Meaning |
| --- | --- |
| `pairing` | The pairing the row is in: `T to N`, `T to Nm`, `Tm to N` or `Tm to Nm`. |
| `transit_point`, `natal_point` | The points involved: an object code, `ASC` or `MC`, or a midpoint as two codes such as `Moo/Jup` or `Sun/Moo`. |
| `transit_codes`, `natal_codes` | The same points as arrays of codes: one for a body or an angle, two for a midpoint. Read these, not the slash text. |
| `transit_body`, `natal_target` | The code when the point is a body (or, for natal, an angle); `null` for a midpoint. |
| `aspect`, `orb`, `strength` | The aspect name, its distance from exact in degrees, and 1 at exact down to 0 at the edge of the orb. |
| `phase` | `applying` when the orb shrinks over a short look-ahead, `separating` when it grows, and `unknown` when a speed is not known or the look-ahead crosses a fold: 0° or 180° between the points, the aspect's own exact point, or a midpoint's own 180° flip. An unknown phase is never reported as applying. |
| `applying` | `true` only when `phase` is `applying`. |

`total` counts the aspects after `min_strength` and before `aspect_limit`. A reading with every `include` value, `aspects` `all` and `aspect_limit` `0` is large: every aspect gets a row, and the same JSON is returned in both `content` and `structuredContent`, so it is sent twice. Keep a limit unless every row is needed.

## `get_composite_data`

The composite chart (midpoints of two charts) or the Davison chart (the chart of the midpoint in time and space).

Inputs: `person_a` and `person_b` (each holding the birth fields), `kind` (`composite` or `davison`), `house_system`, `ayanamsa`, `aspects` and `aspect_limit` (see [Aspect inputs](#aspect-inputs)). The house system and zodiac belong to the composite, not to each person.

## `get_harmonic_midpoints`

The classic midpoint structures of a harmonic chart, tightest orb first.

Inputs: the birth fields, `harmonic` (required), `house_system`, `ayanamsa`, and `limit`: how many structures to return, from 1 to 50, default 12.

## `get_daily_transits`

What matters on one local day for a birth chart, as numbers and plain facts: the aspect hits between the transiting bodies and their midpoints and the natal points and their midpoints, the sign and natal house changes, the retrograde changes, and the Moon's sign change and aspects that day.

Inputs: the birth fields (`birth_date`, `birth_time`, and `place` or `latitude`, `longitude` and `timezone`), plus:

| Field | Meaning |
| --- | --- |
| `date` | The local day, `YYYY-MM-DD`. Required. |
| `day_timezone` | IANA zone of the day, such as `America/New_York`. Leave out for the natal timezone, the birth place's zone. It has its own name because `timezone` is the birth zone. |
| `aspects` | `"major"` (default) ranks the five major aspects: conjunction, sextile, square, trine and opposition, with the midpoint pairings built on them. `"all"` ranks the 17 vibrational aspects too. The orbs are the same in both. |
| `house_system`, `ayanamsa` | As in the other tools. `house_system` sets only the natal cusps, so it changes only the house changes. `ayanamsa` applies to the natal chart and to every sky sample. |
| `harmonic` | From 1 to the day's maximum, default 1. The maximum is 432 ÷ the day's hours, rounded down: 18 on a 24-hour day and 17 on a 25-hour day. Above 1 the natal chart and every sample are multiplied by it. The limit is derived in **Harmonic limit** below. |
| `limit` | How many items each list shows, from 1 to 50, default 10. It caps the hits, the ingresses, the stations, the Moon's sign changes and the Moon's aspects alike. |
| `min_strength` | Keeps an aspect hit only when its `score` is at least this, from 0 to 1, default 0. It compares the score, not the tightness that the transit tool's `min_strength` compares. The score is compared at the two places the result shows it, so a hit is never kept below its cut because of digits the result does not show. The totals count only the hits kept. |

**The day.** It runs from local midnight to the next local midnight: 24 hours, or 23 or 25 on a daylight-saving change, and 23.5 or 24.5 where the change is half an hour (Australia/Lord_Howe). A zone whose clocks skip midnight starts the day at the first instant after the skip. A zone that skips the whole calendar day has no such day: Pacific/Apia has no 2011-12-30 and Pacific/Kwajalein has no 1993-08-21. The tool refuses that date before any engine call, with the fix to pick another date or a `day_timezone` that has it. The sky is read at the start, at the middle (halfway between the two midnights, in UT) and at the end: three sky calls in parallel with the natal chart.

**Exact times.** Between the three samples each longitude is the quadratic through its three values, so a moment is a root of that quadratic, and an orb is the closest approach over the day. The moment is rounded to the minute. An aspect that is exact inside the day has its moment in `exact_utc` (UT, such as `2026-10-14T09:19:00Z`) and `exact_local` (the clock time in the day's zone). A hit gives the first exact moment of the day only: a path that perfects twice, for example one that turns back across the point, is listed once, with the earlier moment. An aspect that comes within its orb without being exact in the day has both set to `null`. Every text time carries its zone's abbreviation, such as `09:19 EDT`, or `GMT+2` where the zone has none.

*Accuracy, measured against the engine.* The reading was checked against the real engine (Astrolog 7.80), with a fine sampling every ten minutes of the same UT day. The exact times checked agree with the fine-sampled crossings to under half a minute, most of that the rounding to the minute. The checks are in `src/tools/daily.integration.test.ts`, which holds each to 2 minutes.

*Days that are not 24 hours.* The day's bounds are the local midnights, so a 23-hour day (New York, 2026-03-08) and a 25-hour day (New York, 2026-11-01) are read by the same samples. A zone that changes its clocks by 2 hours gives a 22-hour or a 26-hour day: Antarctica/Troll has 2026-03-29 at 22 hours and 2026-10-25 at 26. Every exact time falls inside the day's `start_utc` and `end_utc`; the integration test checks the New York days.

**Aspects and orbs.** A pair of points takes the transit orb of the aspect: the lesser of 16 ÷ harmonic and 2° for harmonics 1 to 4, or 1° above. A pair with a midpoint takes the classic midpoint orb: 1.5° for harmonics 1 and 2, and 3 ÷ harmonic above. Each aspect of a pair that comes within its orb during the day is one hit with its own exact time, so a pair can have several hits, such as a sextile and a semisquare on the same day. An aspect with two sides, one at +angle and one at −angle, is one hit: its stronger side, and on a tie the side that is exact first. The four pairings are `T to N`, `T to Nm`, `Tm to N` and `Tm to Nm`, as in the midpoint sets. `T` is a transiting body, `Tm` the midpoint of two transiting bodies, `N` a natal point (a body, ASC or MC) and `Nm` the midpoint of two natal points. A transit midpoint is the classic midpoint of two bodies, taken by the shorter arc. Its path is cut where the two bodies are exactly opposite, because the midpoint jumps by 180° there, and each side is read on its own.

**Phase.** This is about the day's least orb, not a short look-ahead as the transit tool's `phase` is. `applying` when the least orb comes after the day's start, so the orb shrinks into it. `separating` when the least orb is at the day's start, or at the cut of a transit midpoint, so the orb grows from there: a midpoint that jumps into orb at its cut reads `separating`. A turn inside the day reads `applying`; a steady orb reads `separating`; an exact hit reads `applying`.

**Harmonic limit.** Between two samples the harmonic longitude of a body moves by its daily motion × the gap ÷ 24 × the harmonic. The gap is half the day: 12 hours on a 24-hour day, 12.5 on a 25-hour day, 13 on a 26-hour day. The reading needs that step under 180°, or it cannot tell a forward move from a backward one. The Moon moves about 15° a day at most; the fastest other body, Mercury, about 2°. The reading allows 20° a day for a body or for the difference of two, which leaves room for the Moon's faster days. So the step is at most 20 × (hours ÷ 2) ÷ 24 × H degrees, and the largest harmonic a day takes is 432 ÷ hours, rounded down: 19 on a 22-hour day, 18 on a 24-hour day, 17 on a 25-hour day and 16 on a 26-hour day. The tool refuses a harmonic over the day's own maximum, and its fix line names that maximum for that day. At 18 on a 24-hour day the step at the limit is exactly 180°, which the reading takes as a forward move.

**Score.** The number that ranks the hits:

```text
tightness = 1 - orb / limit              orb: the least distance from exact over the day
weight    = 1 + 0.25 (outer) + 0.25 (key)
score     = tightness × weight ÷ 1.5     rounded to two places in the output
```

- `outer`: the transiting body is Jupiter, Saturn, Uranus, Neptune or Pluto. A transiting midpoint is never outer.
- `key`: the natal point is the Sun, the Moon, the Ascendant or the Midheaven. A natal midpoint is never key.
- The weight is at most 1.5 and the division keeps the score between 0 and 1. An exact hit by an outer body on a key point scores 1; an exact hit that is neither outer nor key scores 0.67; a hit at the edge of its orb scores 0.

Hits are ranked by score to two places, as the result shows it, highest first, then by the tighter orb, then in the order they were read (moving bodies in object-code order, then midpoints). `limit` keeps the first of that order. `min_strength` is compared with the same two-place score, so the cut and the order agree with what is shown. `total` counts the hits after `min_strength`, and it counts hits per pair and aspect: one pair of points can give one hit for each aspect, and a transit midpoint whose path crosses its 180° cut can list two aspects of the same pair, each with its own exact time or `null`.

**Ingresses.** A transiting body that changes sign, or moves into another natal house, at a time within the day. Sign changes come from the sky samples. House changes are read against the natal cusps. Each is timed by its quadratic root and listed in time order. A body that does not move is never reported as changing. The sign is the sign of the longitude as the reading has it, so at harmonic 3 the sign is that of 3 × the longitude, not of the ordinary longitude.

**Stations.** A body whose retrograde flag changes within the day, timed where its speed crosses zero, and listed in time order.

**The Moon.** `moon.sign_changes` lists the Moon's sign changes that day. At harmonic 1 there is at most one, since the Moon moves under 30° in a day; a higher harmonic can give several. `moon.aspects` lists the hits whose transiting point is the Moon, or a transiting midpoint that holds the Moon, ranked like the hits.

Output: a headline; `day` with the date, zone, the UT moments of the start, middle and end, and the length in hours; `hits`, `ingresses`, `stations` and `moon.sign_changes` and `moon.aspects`, each `{items, total, truncated}`; `missing`, the codes an engine call did not compute; and `meta` with the harmonic, the aspect set, the house system, the natal moment, the place, the provenance and the ayanamsa when sidereal. Every timed item states its time in UT and as a clock time in the day's zone; a hit not exact in the day has null for both. A reading at harmonic above 1 starts its headline and every text with `Harmonic N:`. No item carries interpretation.

With `ENGINE=stub` the numbers are placeholders, and the text starts with a `PLACEHOLDER` line.

## Errors

A failed call returns `isError` with the reason and a `Fix:` line saying what to change, for example:

```text
"Springfield" matches 24 places: Springfield, Missouri, United States (population 170188); … (showing 5 of 24)
Fix: Add a region or country to the place, for example "Springfield, Missouri", or pass latitude, longitude and time zone.
```

A `timezone` of `"local"` or `"UTC+5"` is refused: give an IANA zone name such as `America/Chicago`.

An unknown `ayanamsa`, such as `"vedic"`, is refused with a `Fix:` line that lists the values. A sidereal `ayanamsa` on `ENGINE=stub` is refused the same way, with a fix that says to use `tropical` or run the real engine.

## What the numbers are

- Positions, houses and angles come from an Astrolog run with fixed, neutral settings (the zodiac you pick, tropical unless you pick an ayanamsa, the mean node, and the house system you pick). The pinned switches keep a user's own `astrolog.as` from changing them.
- A sidereal result is the tropical one shifted by the ayanamsa: the Sun is about 24 degrees earlier in `lahiri` than in `tropical`, for example. The ayanamsa grows slowly with the years, so each moment takes the ayanamsa of its own date:
  - A natal chart takes the birth moment's. A transit sky takes the transit moment's, so a transit read against a natal chart applies two shifts that differ by the years between them.
  - A composite casts each birth with the ayanamsa of its own date and takes the midpoint of the two sidereal positions. Its shift is the mean of the two birth shifts, not one figure.
  - A Davison chart takes the ayanamsa of its midpoint moment, the same shift as the sky at that moment.
  - A transit result's natal chart and sky are cast in one zodiac. The server refuses a pair in different zodiacs, so a sidereal chart is never read against a tropical sky.
- Aspects, midpoints and harmonic longitudes are arithmetic on those positions, done by this server.
- The `meta` object of every result names the house system, the UT moment and the Astrolog version that produced it. A sidereal result also names its `ayanamsa`; a tropical one leaves the key out.
- With `ENGINE=stub`, results start with a `PLACEHOLDER` line and are not astrology. The stub has tropical positions only, so it refuses a sidereal `ayanamsa`.
