import type { McpServer } from "@modelcontextprotocol/server";
import type { LimitFunction } from "p-limit";
import { DateTime } from "luxon";
import { z } from "zod";
import { queueEngineCall } from "../limits.js";
import {
  harmonicPositions,
  harmonicSky,
  MAX_DAY_HARMONIC,
  maxDayHarmonic,
  MOON_CODE,
  PAIRING_LABELS,
  readDay,
  shownScore,
  type DayHit,
  type DayIngress,
  type DayStation,
  type DaySignChange,
} from "../math.js";
import { AstroError, OBJECT_CODES, type SkyPositions, type UtcMoment } from "../types.js";
import { ASPECT_NAME_GUIDE, ASPECT_SETS } from "./aspect-list.js";
import { registerEngineTool, type EngineResult } from "./call.js";
import type { ToolDeps } from "./deps.js";
import { BODY_NAMES, SIGNS } from "./format.js";
import {
  AYANAMSA_CHOICES,
  ayanamsaField,
  birthRule,
  birthShape,
  DATE_PATTERN,
  harmonicNumberWith,
  HOUSE_SYSTEM_NAMES,
  houseSystemField,
  isKnownZone,
  isRealDate,
  resolveBirth,
} from "./input.js";
import { ALL_ASPECT_NAMES, ayanamsaMeta, ayanamsaOutput, cutList, placeMeta, placeOutput } from "./output.js";
import { aspectSentence, arcminuteOrb, readingAspects } from "./transit.js";

export const DAILY_TOOL_NAME = "get_daily_transits";

// The lists a call returns when it does not say how many. The caller may ask for 1 to the maximum.
export const DAILY_DEFAULT_LIMIT = 10;
export const DAILY_MAX_LIMIT = 50;
const LIMIT_FIX = `Give the number of items to list as a whole number from 1 to ${DAILY_MAX_LIMIT}.`;
const SCORE_FIX = "Give the minimum strength as a number from 0 to 1, for example 0.5; 0 keeps every hit within its orb.";
const ASPECTS_FIX = 'Give the aspect set as "major" or "all".';
const HARMONIC_FIX =
  "Give the harmonic as a whole number from 1 to the day's maximum, which is 18 on a 24-hour day and 17 on a 25-hour day.";

export const dailyInputShape = {
  ...birthShape,
  date: z
    .string({ error: "Give the date as YYYY-MM-DD, for example 2026-10-14." })
    .regex(DATE_PATTERN, "Write the date as YYYY-MM-DD, for example 2026-10-14.")
    .refine(isRealDate, "Give the date as a date that exists, such as 2026-10-14.")
    .describe(
      "Local calendar day to read, as YYYY-MM-DD, for example 2026-10-14. The day runs from its local midnight to the next one.",
    ),
  day_timezone: z
    .string()
    .min(1, "Give the day's time zone as an IANA time zone name such as America/New_York, or leave it out for the birth place's zone.")
    .max(64, "Give the day's time zone as an IANA time zone name such as America/New_York.")
    .refine(isKnownZone, "Give the day's time zone as an IANA time zone name such as America/New_York.")
    .optional()
    .describe(
      "IANA time zone of the day, such as America/New_York. Leave out for the natal timezone: the birth place's zone, from place or from timezone.",
    ),
  house_system: houseSystemField,
  ayanamsa: ayanamsaField,
  aspects: z
    .enum(ASPECT_SETS, { error: ASPECTS_FIX })
    .default("major")
    .describe(
      'Which aspects to rank. "major" (default) ranks the five major aspects: conjunction, sextile, square, trine and opposition, with the midpoint pairings built on them. "all" ranks the 17 vibrational aspects, such as semisquare, quintile, septile and novile, as well. A pair of points takes the lesser of 16 degrees divided by the aspect\'s harmonic and 2 degrees (1 degree above harmonic 4). A pair with a midpoint takes the midpoint orb: 1.5 degrees at harmonics 1 and 2, and 3 divided by the harmonic above. ' +
        ASPECT_NAME_GUIDE,
    ),
  harmonic: harmonicNumberWith(HARMONIC_FIX, MAX_DAY_HARMONIC)
    .default(1)
    .describe(
      "Harmonic to read the chart and the sky in, a whole number from 1 up to the day's maximum: 432 divided by the day's hours, rounded down, so 18 on a 24-hour day and 17 on a 25-hour day. 1 is the ordinary daily reading; above 1, the natal chart and every sky sample are multiplied by it (longitude times harmonic, mod 360).",
    ),
  limit: z
    .number({ error: LIMIT_FIX })
    .int(LIMIT_FIX)
    .min(1, LIMIT_FIX)
    .max(DAILY_MAX_LIMIT, LIMIT_FIX)
    .default(DAILY_DEFAULT_LIMIT)
    .describe(
      `How many items to list in each of hits, ingresses, stations, Moon sign changes and Moon aspects, from 1 to ${DAILY_MAX_LIMIT}. Leave out for ${DAILY_DEFAULT_LIMIT}. Each list states its total and whether it was cut.`,
    ),
  min_strength: z
    .number({ error: SCORE_FIX })
    .min(0, SCORE_FIX)
    .max(1, SCORE_FIX)
    .default(0)
    .describe(
      "Keep an aspect hit only when its score, not its tightness, is at least this, from 0 to 1, compared at the two places the score shows. The score is as the tool description says; the transit tool's min_strength compares its tightness instead. Leave out for 0, which keeps every hit.",
    ),
};

// The fields are strict, as for get_chart_data: an unknown key is refused, and the birth fields must give a place or all
// three coordinates.
export const dailyInputSchema = z.strictObject(dailyInputShape).superRefine((input, ctx) => birthRule(input, ctx));

export type DailyArgs = z.infer<typeof dailyInputSchema>;

const hitOutput = z.object({
  pairing: z.enum(PAIRING_LABELS).describe(
    "Pairing: T is a transiting body and Tm the midpoint of two; N is a natal point and Nm the midpoint of two natal points.",
  ),
  moving: z
    .string()
    .describe("The transiting body's code, such as Moo, or two codes joined by a slash for a transiting midpoint, such as Sun/Moo."),
  still: z
    .string()
    .describe("The natal point's code, such as Sun, or ASC or MC, or two codes joined by a slash for a natal midpoint."),
  aspect: z.enum(ALL_ASPECT_NAMES).describe("Aspect name from the vibrational set, such as trine, quincunx or semisquare."),
  orb: z
    .number()
    .min(0)
    .describe("Least distance from exact over the day, in decimal degrees, to the arcminute (four places). The text gives the same orb."),
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("The score, as the tool description says, to two places. 1 is the top score."),
  phase: z
    .enum(["applying", "separating"])
    .describe(
      "Phase of the day's least orb, not a look-ahead: applying when the least orb comes after the start of the day, so the orb shrinks into it; separating when it is at the start of the day or at a midpoint's cut, so the orb grows from there. An exact hit reads applying.",
    ),
  exact_utc: z
    .string()
    .nullable()
    .describe(
      "UT moment the aspect is exact, to the minute, interpolated between the samples, such as 2026-10-14T18:32:00Z: the first exact moment of the day only, when it perfects more than once; null when it does not perfect within the day.",
    ),
  exact_local: z
    .string()
    .nullable()
    .describe("The same moment as a clock time in the day's time zone, 24-hour HH:MM; null when it does not perfect within the day."),
  text: z
    .string()
    .describe(
      "The hit as text, with its zone, such as Transiting Moon trine natal Sun, orb 0°12′, applying, exact at 14:05 EDT. A harmonic above 1 starts with Harmonic N:.",
    ),
});

// A sign change, the same for every body. The sign names are the signs of the reading's longitudes, which a harmonic chart
// multiplies first.
const ingressBase = {
  body: z.enum(OBJECT_CODES).describe("Object code of the transiting body, such as Moo."),
  name: z.string().describe("Common name of the body, such as Moon."),
  at_utc: z.string().describe("UT moment of the change, to the minute, such as 2026-10-14T18:32:00Z."),
  at_local: z.string().describe("The change as a clock time in the day's time zone, 24-hour HH:MM."),
};

const signIngressOutput = z.object({
  ...ingressBase,
  change: z.literal("sign").describe("sign: the body changes zodiac sign."),
  from: z.enum(SIGNS).describe("The sign before the change."),
  to: z.enum(SIGNS).describe("The sign after the change."),
  text: z.string().describe("The change as text with its zone, such as Moon enters Scorpio at 14:05 EDT, from Libra."),
});

const houseIngressOutput = z.object({
  ...ingressBase,
  change: z.literal("house").describe("house: the body moves into another natal house."),
  from: z.number().int().min(1).max(12).describe("The natal house before the change, from 1 to 12."),
  to: z.number().int().min(1).max(12).describe("The natal house after the change, from 1 to 12."),
  text: z.string().describe("The change as text with its zone, such as Moon enters house 2 at 14:05 EDT, from house 1."),
});

const ingressOutput = z.discriminatedUnion("change", [signIngressOutput, houseIngressOutput]);

const stationOutput = z.object({
  body: z.enum(OBJECT_CODES).describe("Object code of the body."),
  name: z.string().describe("Common name of the body, such as Mercury."),
  to: z.enum(["retrograde", "direct"]).describe("The retrograde flag after the change."),
  at_utc: z.string().describe("UT moment the flag changes, to the minute, such as 2026-10-14T18:32:00Z."),
  at_local: z.string().describe("The change as a clock time in the day's time zone, 24-hour HH:MM."),
  text: z.string().describe("The change as text with its zone, such as Mercury turns retrograde at 10:14 EDT."),
});

// A list of facts, cut to the caller's limit, with the count in full.
function listOutput<T extends z.ZodType>(item: T, what: string) {
  return z.object({
    items: z.array(item).describe(`The first ${what}, up to limit, in the order the list is ranked or timed.`),
    total: z.number().int().min(0).describe(`How many ${what} the day has in all.`),
    truncated: z.boolean().describe("True when items is shorter than total."),
  });
}

export const dailyOutputSchema = z.object({
  headline: z
    .string()
    .describe("The date, the zone, the counts and the Moon's sign changes, as plain text. A harmonic above 1 starts with Harmonic N:."),
  day: z.object({
    date: z.string().describe("The local day, as YYYY-MM-DD."),
    timezone: z.string().describe("IANA time zone of the day."),
    start_utc: z.string().describe("UT moment of the day's local midnight."),
    middle_utc: z.string().describe("UT moment of the middle sample, halfway between the two midnights."),
    end_utc: z.string().describe("UT moment of the next local midnight, which ends the day."),
    hours: z
      .number()
      .describe(
        "Length of the day in hours: 24, or 23 or 25 on a daylight-saving change; a few zones change by 2 hours, so 22 or 26, and some by half an hour, so 23.5 or 24.5.",
      ),
  }),
  hits: listOutput(hitOutput, "aspect hits"),
  ingresses: listOutput(ingressOutput, "ingresses"),
  stations: listOutput(stationOutput, "stations"),
  moon: z.object({
    sign_changes: listOutput(signIngressOutput, "Moon sign changes").describe(
      "The Moon's sign changes that day. At harmonic 1 there is at most one, since the Moon moves under 30 degrees a day; a higher harmonic can give several.",
    ),
    aspects: listOutput(hitOutput, "aspects of the Moon").describe(
      "The aspects of the day whose transiting point is the Moon, or a transiting midpoint that holds the Moon.",
    ),
  }),
  missing: z
    .array(z.enum(OBJECT_CODES))
    .describe("Object codes an engine call did not compute, so the day leaves them out. Empty when all were computed."),
  meta: z
    .object({
      harmonic: z
        .number()
        .int()
        .min(1)
        .describe("The harmonic the chart and the sky were read in, at most the day's maximum: 1 is the ordinary daily reading."),
      aspects: z.enum(ASPECT_SETS).describe("The aspect set the hits were ranked from: major or all."),
      house_system: z.enum(HOUSE_SYSTEM_NAMES).describe("House system that was requested for the natal chart."),
      housesFrom: z.enum(HOUSE_SYSTEM_NAMES).describe("House system the engine used for the natal houses."),
      natal_utc: z.string().describe("Birth moment of the natal chart, in UT."),
      min_strength: z.number().min(0).max(1).describe("The score the hits were kept at or above."),
      limit: z.number().int().min(1).max(DAILY_MAX_LIMIT).describe("How many items each list was asked for."),
      place: placeOutput,
      provenance: z
        .object({
          astrolog_version: z.string().describe("Version of the engine that produced the numbers, or the stub's label."),
          source: z.enum(["astrolog", "stub"]).describe("Where the numbers came from: the engine, or the stub's placeholders."),
        })
        .describe("Where the numbers came from."),
      ayanamsa: ayanamsaOutput,
    })
    .describe("Settings and provenance behind the numbers."),
});

export type DailyOutput = z.infer<typeof dailyOutputSchema>;

// The day's bounds in ms: local midnight, the middle sample, and the next local midnight. Written in whole seconds, so each
// one is an exact UT moment. A day that has no midnight (a zone that moves its clocks at midnight) starts at the first instant
// after the change, which luxon reads from the zone. A day the zone skips entirely has no start on its own date, so it is refused.
export interface DayBounds {
  start: number;
  middle: number;
  end: number;
}

export function dayBounds(date: string, zone: string): DayBounds {
  const start = DateTime.fromISO(date, { zone }).startOf("day");
  const end = start.plus({ days: 1 }).startOf("day");
  if (!start.isValid || !end.isValid) {
    throw new AstroError(
      `cannot read the day ${date} in time zone ${zone}: ${start.invalidReason ?? end.invalidReason ?? "invalid"}`,
      "Check the date (YYYY-MM-DD) and the IANA time zone name.",
    );
  }
  if (start.toISODate() !== date) {
    throw new AstroError(`the zone has no ${date}: its clocks skip that day`, "Pick another date, or a time zone for the day that has it.");
  }
  const startMs = start.toMillis();
  const endMs = end.toMillis();
  return { start: startMs, middle: Math.round((startMs + endMs) / 2000) * 1000, end: endMs };
}

// A UT moment in whole seconds, such as 2026-10-14T18:32:10Z.
function utcOf(ms: number): UtcMoment {
  return new Date(ms).toISOString().replace(".000Z", "Z") as UtcMoment;
}

// A count with its noun in the form that agrees with it: "1 ingress", "2 ingresses".
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

// A moment as the result shows it: UT, the clock time in the day's zone, and that clock time with the zone's name. The moment
// is rounded to the minute: an exact time is interpolated between samples half a day apart, and the integration test measures
// how close that comes. A moment that rounds past the day's end reads as its last minute, so it stays inside the day.
interface Moment {
  utc: UtcMoment;
  local: string;
  zoned: string;
}

function momentAt(ms: number, zone: string, day: DayBounds): Moment {
  const rounded = Math.min(Math.max(Math.round(ms / 60_000) * 60_000, day.start), day.end - 60_000);
  const local = DateTime.fromMillis(rounded, { zone, locale: "en-US" });
  const clock = local.toFormat("HH:mm");
  return { utc: utcOf(rounded), local: clock, zoned: `${clock} ${local.toFormat("ZZZZ")}` };
}

// How items are shaped: the moment of a fraction of the day, and the prefix that marks a harmonic reading.
interface Shape {
  moment: (at: number) => Moment;
  prefix: string;
}

// The bounds a call must keep, checked here as well as in the schema, so a direct call is refused the same way. A refusal names
// the limit and gives the fix.
function assertDailyBounds(input: DailyArgs): void {
  if (!Number.isInteger(input.harmonic) || input.harmonic < 1 || input.harmonic > MAX_DAY_HARMONIC) {
    throw new AstroError(`harmonic ${input.harmonic} is outside 1 to ${MAX_DAY_HARMONIC}`, HARMONIC_FIX);
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > DAILY_MAX_LIMIT) {
    throw new AstroError(`the number of items to list, ${input.limit}, is outside 1 to ${DAILY_MAX_LIMIT}`, LIMIT_FIX);
  }
  if (!(input.min_strength >= 0 && input.min_strength <= 1)) {
    throw new AstroError(`the minimum strength ${input.min_strength} is outside 0 to 1`, SCORE_FIX);
  }
  if (input.aspects !== "major" && input.aspects !== "all") {
    throw new AstroError(`the aspect set "${input.aspects}" is not one the reading knows`, ASPECTS_FIX);
  }
}

// Runs one day: resolves the birth and the day's zone, casts the natal chart and reads the sky at the day's three moments
// through the shared concurrency limit (four engine calls, the most the limit admits at once), then shapes the facts. Throws
// AstroError or a timeout. The natal chart, the samples and their harmonic are the same across the day.
export async function getDailyTransits(
  input: DailyArgs,
  deps: ToolDeps,
  limit: LimitFunction,
  signal?: AbortSignal,
): Promise<DailyOutput> {
  return (await dailyAndSource(input, deps, limit, signal)).output;
}

async function dailyAndSource(
  input: DailyArgs,
  deps: ToolDeps,
  limit: LimitFunction,
  signal?: AbortSignal,
): Promise<EngineResult<DailyOutput>> {
  assertDailyBounds(input);
  const { place, utc } = await resolveBirth(input, deps);
  const zone = input.day_timezone ?? place.timezone;
  const day = dayBounds(input.date, zone);
  // A day's own cap comes from its length, so it is known only once the zone is: a day of 22 hours allows more than one of 25.
  const hours = (day.end - day.start) / 3_600_000;
  const cap = maxDayHarmonic(hours);
  if (input.harmonic > cap) {
    throw new AstroError(
      `harmonic ${input.harmonic} is over the most that ${input.date} reads in ${zone}, a ${hours}-hour day: ${cap}`,
      `Give the harmonic as a whole number from 1 to ${cap} for ${input.date} in ${zone}, or read a day in a zone with a different length.`,
    );
  }
  const sample = (ms: number) =>
    queueEngineCall(limit, () => deps.engine.sky({ utc: utcOf(ms), ayanamsa: input.ayanamsa }), signal, deps.engineQueue);
  const [natal, start, middle, end] = await Promise.all([
    queueEngineCall(
      limit,
      () =>
        deps.engine.cast({
          utc,
          latitude: place.latitude,
          longitude: place.longitude,
          houseSystem: input.house_system,
          ayanamsa: input.ayanamsa,
        }),
      signal,
      deps.engineQueue,
    ),
    sample(day.start),
    sample(day.middle),
    sample(day.end),
  ]);

  const harmonic = input.harmonic;
  const samples: [SkyPositions, SkyPositions, SkyPositions] = [
    harmonicSky(start, harmonic),
    harmonicSky(middle, harmonic),
    harmonicSky(end, harmonic),
  ];
  const reading = readDay({
    natal: harmonicPositions(natal, harmonic),
    sky: samples,
    middle: (day.middle - day.start) / (day.end - day.start),
    aspects: readingAspects(input.aspects),
    minScore: input.min_strength,
  });

  const shape: Shape = {
    moment: (at) => momentAt(day.start + at * (day.end - day.start), zone, day),
    prefix: harmonic === 1 ? "" : `Harmonic ${harmonic}: `,
  };
  // Only the items the result shows are shaped: a day has thousands of aspect hits, and each one carries a clock time.
  const moonSigns = reading.ingresses.filter(
    (change): change is DaySignChange => change.change === "sign" && change.body === MOON_CODE,
  );
  const moonText =
    moonSigns.length === 0
      ? "no sign change"
      : moonSigns.length === 1
        ? `enters ${SIGNS[moonSigns[0]!.to]!} at ${shape.moment(moonSigns[0]!.at).zoned}`
        : `${moonSigns.length} sign changes, the first enters ${SIGNS[moonSigns[0]!.to]!} at ${shape.moment(moonSigns[0]!.at).zoned}`;
  const source = [natal, start, middle, end].some((result) => result.provenance.source === "stub") ? "stub" : "astrolog";

  const output: DailyOutput = {
    headline: `${shape.prefix}Daily transits for ${input.date} in ${zone}: ${plural(reading.hits.length, "aspect hit")}, ${plural(reading.ingresses.length, "ingress", "ingresses")}, ${plural(reading.stations.length, "station")}. Moon: ${moonText}.`,
    day: {
      date: input.date,
      timezone: zone,
      start_utc: utcOf(day.start),
      middle_utc: utcOf(day.middle),
      end_utc: utcOf(day.end),
      hours,
    },
    hits: cutList(reading.hits, input.limit, (hit) => hitOf(hit, shape)),
    ingresses: cutList(reading.ingresses, input.limit, (change) => ingressOf(change, shape)),
    stations: cutList(reading.stations, input.limit, (change) => stationOf(change, shape)),
    moon: {
      sign_changes: cutList(moonSigns, input.limit, (change) => signChangeOf(change, shape)),
      aspects: cutList(
        reading.hits.filter((hit) => hit.movingCodes.includes(MOON_CODE)),
        input.limit,
        (hit) => hitOf(hit, shape),
      ),
    },
    missing: reading.missing,
    meta: {
      harmonic,
      aspects: input.aspects,
      house_system: input.house_system,
      housesFrom: natal.housesFrom,
      natal_utc: natal.provenance.utc,
      min_strength: input.min_strength,
      limit: input.limit,
      place: placeMeta(place),
      provenance: { astrolog_version: natal.provenance.astrologVersion, source },
      ...ayanamsaMeta(natal.provenance.ayanamsa),
    },
  };
  return { output, source };
}

type HitItem = z.infer<typeof hitOutput>;
type IngressItem = z.infer<typeof ingressOutput>;
type SignChangeItem = z.infer<typeof signIngressOutput>;
type StationItem = z.infer<typeof stationOutput>;

// One aspect hit as the result shows it. The orb is rounded to the arcminute, and the number and the text name the same orb.
function hitOf(hit: DayHit, shape: Shape): HitItem {
  const exact = hit.exact === undefined ? undefined : shape.moment(hit.exact);
  const exactText = exact === undefined ? "not exact today" : `exact at ${exact.zoned}`;
  const sentence = aspectSentence({
    movingCodes: hit.movingCodes,
    stillCodes: hit.stillCodes,
    aspect: hit.aspect,
    orb: hit.orb,
    phase: hit.phase,
  });
  return {
    pairing: hit.pairing,
    moving: hit.moving,
    still: hit.still,
    aspect: hit.aspect,
    orb: Math.round(arcminuteOrb(hit.orb) * 10_000) / 10_000,
    score: shownScore(hit.score),
    phase: hit.phase,
    exact_utc: exact?.utc ?? null,
    exact_local: exact?.local ?? null,
    text: `${shape.prefix}${sentence}, ${exactText}`,
  };
}

// A sign change of the Moon, or of any body, as the result shows it: the names of both signs, and the time.
function signChangeOf(change: DaySignChange, shape: Shape): SignChangeItem {
  const at = shape.moment(change.at);
  const name = BODY_NAMES[change.body];
  const from = SIGNS[change.from]!;
  const to = SIGNS[change.to]!;
  return {
    body: change.body,
    name,
    change: "sign",
    from,
    to,
    at_utc: at.utc,
    at_local: at.local,
    text: `${shape.prefix}${name} enters ${to} at ${at.zoned}, from ${from}`,
  };
}

// A sign or house change as the result shows it.
function ingressOf(change: DayIngress, shape: Shape): IngressItem {
  if (change.change === "sign") {
    return signChangeOf(change, shape);
  }
  const at = shape.moment(change.at);
  const name = BODY_NAMES[change.body];
  return {
    body: change.body,
    name,
    change: "house",
    from: change.from,
    to: change.to,
    at_utc: at.utc,
    at_local: at.local,
    text: `${shape.prefix}${name} enters house ${change.to} at ${at.zoned}, from house ${change.from}`,
  };
}

// A retrograde change as the result shows it.
function stationOf(change: DayStation, shape: Shape): StationItem {
  const at = shape.moment(change.at);
  const name = BODY_NAMES[change.body];
  return {
    body: change.body,
    name,
    to: change.to,
    at_utc: at.utc,
    at_local: at.local,
    text: `${shape.prefix}${name} turns ${change.to} at ${at.zoned}`,
  };
}

const DAILY_DESCRIPTION = [
  "Call this when someone asks what one whole local day holds for a birth chart, such as today's transits for a person: the transits and midpoint contacts ranked highest by score on one local day, when each goes exact, which transiting objects change sign or natal house, which change retrograde direction, and what the Moon does that day.",
  "Why: the natal chart comes from the configured engine, and the sky is read at local midnight, at the middle of the day and at the next midnight, as three engine reads in parallel with the same zodiac. Aspects, midpoints, exact times and the ranking are arithmetic on those positions, so the same input always gives the same numbers. With ENGINE=stub they are placeholders.",
  `Returns: a headline, the day's bounds and length, and the aspect hits across the pairings T to N, T to Nm, Tm to N and Tm to Nm, ranked by score, each with its orb, score, applying or separating, and its exact time, to the minute, or null; the sign and natal house changes with their times; the retrograde changes with their times; and the Moon's sign changes and its aspects that day, including a transiting midpoint that holds the Moon. Each list is up to limit (default ${DAILY_DEFAULT_LIMIT}, at most ${DAILY_MAX_LIMIT}) with its total and a truncated flag. It also gives the codes the engine did not compute, the house system, the natal moment, the place and the provenance.`,
  `Inputs: birth_date, birth_time and place, or latitude, longitude and timezone; date, the local day; day_timezone, the day's IANA zone, which defaults to the natal timezone; house_system; ayanamsa (${AYANAMSA_CHOICES}), applied to the natal chart and every sky sample; aspects, "major" (default) or "all"; harmonic, from 1 up to 432 divided by the day's hours, rounded down; limit; and min_strength, which keeps only hits whose score, to two places, is at least that. The score is orb tightness times weight, divided by 1.5 (weight 1 plus 0.25 for an outer transiting body plus 0.25 for a key natal point). Tightness is 1 at exact and 0 at the edge of the orb. Gives positions and facts only, with no interpretation.`,
].join(" ");

export function registerDailyTool(server: McpServer, deps: ToolDeps, limit: LimitFunction): void {
  registerEngineTool(server, deps, {
    name: DAILY_TOOL_NAME,
    title: "Daily transits for a birth chart",
    description: DAILY_DESCRIPTION,
    failure: {
      subject: "The daily reading",
      timeoutFix: "Retry in a moment; if it repeats, report it with the time it happened.",
    },
    inputSchema: dailyInputSchema,
    outputSchema: dailyOutputSchema,
    run: (input, signal) => dailyAndSource(input, deps, limit, signal),
  });
}
