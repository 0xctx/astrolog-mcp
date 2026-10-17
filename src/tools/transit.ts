import type { McpServer } from "@modelcontextprotocol/server";
import type { LimitFunction } from "p-limit";
import { z } from "zod";
import { queueEngineCall } from "../limits.js";
import {
  MAX_HARMONIC,
  PAIRING_LABELS,
  VIBRATIONAL_ASPECTS,
  VIBRATIONAL_ORB_RULE,
  harmonicPositions,
  harmonicSky,
  readPairings,
  transitAspects,
  vibrationalTransitLimit,
  type AspectLimit,
  type ApproachPhase,
  type AspectType as VibrationalAspect,
  type PairingLabel,
  type PointSetHit,
} from "../math.js";
import {
  OBJECT_CODES,
  type AngleCode,
  type ObjectCode,
  type Positions,
  type SkyBody,
  type SkyPositions,
  type UtcMoment,
} from "../types.js";
import { registerEngineTool, type EngineResult } from "./call.js";
import type { ToolDeps } from "./deps.js";
import {
  DATE_PATTERN,
  HOUSE_SYSTEM_NAMES,
  TIME_PATTERN,
  AYANAMSA_CHOICES,
  ayanamsaField,
  birthRule,
  birthShape,
  houseSystemField,
  isKnownZone,
  isRealDate,
  objectCodesField,
  repeatedCodeRule,
  resolveBirth,
} from "./input.js";
import { ASPECT_NAME_GUIDE, ASPECT_SETS, type AspectSet } from "./aspect-list.js";
import { ALL_ASPECT_NAMES, ayanamsaMeta, ayanamsaOutput, cutList, signedPosition } from "./output.js";
import { ANGLE_NAMES, BODY_NAMES, formatDegreesMinutes, formatLongitude } from "./format.js";

export const TRANSIT_TOOL_NAME = "get_transit_data";

// The transit list shows this many aspects before it says it was cut.
export const TRANSIT_LIST_LIMIT = 15;

// The include values: each names one pairing. T is a transiting body, Tm the midpoint of two of them; N a natal point, Nm the
// midpoint of two natal points. The order of this list is not the order of the rows: rows are ranked together.
export const TRANSIT_INCLUDE = ["points", "to_natal_midpoints", "transit_midpoints", "midpoint_to_midpoint"] as const;

export type TransitInclude = (typeof TRANSIT_INCLUDE)[number];

// Each include value names its pairing. The record has a key for every include value, so a value with no pairing does not compile;
// transit.test.ts checks that every pairing has a value.
const PAIRING_OF_INCLUDE: Record<TransitInclude, PairingLabel> = {
  points: "T to N",
  to_natal_midpoints: "T to Nm",
  transit_midpoints: "Tm to N",
  midpoint_to_midpoint: "Tm to Nm",
};

// The five major aspects, each by its own harmonic: conjunction 1, opposition 2, trine 3, square 4, sextile 6. Each takes its own
// orb, from its own harmonic, never from the chart's harmonic. ASPECT_TABLE in output.ts must match them (aspect-list.test.ts).
export const MAJOR_HARMONICS = [1, 2, 3, 4, 6];

const TRANSIT_LIMITS: AspectLimit[] = VIBRATIONAL_ASPECTS.filter((type) => MAJOR_HARMONICS.includes(type.harmonic)).map(
  (type) => ({ type, orb: vibrationalTransitLimit(type) }),
);

// The aspects a point reading takes: the five major ones, or all 17 vibrational aspects.
const TRANSIT_MAJOR_ASPECTS = VIBRATIONAL_ASPECTS.filter((type) => MAJOR_HARMONICS.includes(type.harmonic));

// The aspects a reading takes for its set. The daily reading takes the same set, so both read the same aspects.
export function readingAspects(set: AspectSet): readonly VibrationalAspect[] {
  return set === "all" ? VIBRATIONAL_ASPECTS : TRANSIT_MAJOR_ASPECTS;
}

// Every natal point a row can name: the object codes, then the two angles.
const NATAL_CODES = [...OBJECT_CODES, "ASC", "MC"] as const;

type NatalCode = (typeof NATAL_CODES)[number];

const INCLUDE_FIX = `Give the pairings to include as a list of ${TRANSIT_INCLUDE.join(", ")}, for example points and transit_midpoints.`;
const DUPLICATE_INCLUDE_FIX = "List each pairing once, for example points and transit_midpoints.";
const MIN_STRENGTH_FIX = "Give the minimum strength as a number from 0 to 1, for example 0.5; 0 keeps every aspect inside its orb.";
const ASPECT_LIMIT_FIX = "Give the aspect limit as a whole number from 0 up, for example 15; 0 lists every aspect.";

const transitAspectsField = z
  .enum(ASPECT_SETS, { error: 'Give the aspect set as "major" or "all".' })
  .default("major")
  .describe(
    'Which aspects to read. "major" (default) reads the five major aspects. "all" reads the 17 vibrational aspects, such as semisquare, quincunx, quintile, septile and novile. The orb depends on the pairing: a point pairing (T to N) takes the transit orb of the aspect\'s own harmonic, 2 degrees for harmonics 1 to 4 and 1 degree above; any pairing with a midpoint takes the classic midpoint orb, 1.5 degrees for conjunction and opposition and 1.5 × 2 ÷ harmonic for the others. Every row names its pairing, the rows of the default reading too. A row whose phase is unknown reads "phase unknown" and is never applying. ' +
      ASPECT_NAME_GUIDE,
  );

const transitIncludeField = z
  .array(z.enum(TRANSIT_INCLUDE, { error: INCLUDE_FIX }), { error: INCLUDE_FIX })
  .min(1, INCLUDE_FIX)
  .default(["points"])
  .describe(
    'Which pairings to read, as a list, in any order: rows are ranked together whatever the order. "points" (default) reads transiting bodies to natal points (T to N). "to_natal_midpoints" reads transiting bodies to natal midpoints (T to Nm). "transit_midpoints" reads midpoints of pairs of transiting bodies to natal points (Tm to N). "midpoint_to_midpoint" reads transit midpoints to natal midpoints (Tm to Nm). Each value gives its own rows, named by pairing. Repeating a value is refused.',
  );

const transitMinStrengthField = z
  .number({ error: MIN_STRENGTH_FIX })
  .min(0, MIN_STRENGTH_FIX)
  .max(1, MIN_STRENGTH_FIX)
  .default(0)
  .describe(
    "Keep only the aspects whose strength is at least this, from 0 to 1: 1 at exact and 0 at the edge of the orb. Leave out or 0 keeps every aspect inside its orb.",
  );

const transitAspectLimitField = z
  .number({ error: ASPECT_LIMIT_FIX })
  .int(ASPECT_LIMIT_FIX)
  .min(0, ASPECT_LIMIT_FIX)
  .default(TRANSIT_LIST_LIMIT)
  .describe(
    `How many aspects to list. The default reading ranks by orb, tightest first; the others rank by strength, to two places, with equal strengths in pairing order. Leave out for ${TRANSIT_LIST_LIMIT}. 0 lists every aspect. The result always gives the total and whether the list was cut.`,
  );

// The reading: which aspects, which pairings, the strength floor and the list length. The transit tool and the daily reading take
// these four fields, so they are defined once here.
export const transitReadingShape = {
  aspects: transitAspectsField,
  include: transitIncludeField,
  min_strength: transitMinStrengthField,
  aspect_limit: transitAspectLimitField,
};

export const transitReadingSchema = z.object(transitReadingShape);

export type TransitReading = z.infer<typeof transitReadingSchema>;

// The rule every reading shares: each include value at most once. A reading that takes include calls it from its own refinement.
export function readingRule(reading: { include: readonly TransitInclude[] }, ctx: z.RefinementCtx): void {
  if (new Set(reading.include).size !== reading.include.length) {
    ctx.addIssue({
      code: "custom",
      path: ["include"],
      message: DUPLICATE_INCLUDE_FIX,
      input: reading.include,
    });
  }
}

export const transitInputShape = {
  ...birthShape,
  transit_date: z
    .string({ error: "Give the transit date as YYYY-MM-DD, for example 2000-06-15." })
    .regex(DATE_PATTERN, "Write the transit date as YYYY-MM-DD, for example 2000-06-15.")
    .refine(isRealDate, "Give the transit date as a date that exists, such as 2000-06-15.")
    .optional()
    .describe(
      "Date of the sky to read, as YYYY-MM-DD in transit_timezone, for example 2000-06-15. Give with transit_time, or leave both out for the sky now.",
    ),
  transit_time: z
    .string({ error: "Give the transit time as 24-hour HH:MM, for example 12:00." })
    .regex(TIME_PATTERN, "Write the transit time as 24-hour HH:MM, for example 12:00.")
    .optional()
    .describe(
      "Clock time of the sky to read, 24-hour HH:MM in transit_timezone, for example 12:00. Give with transit_date, or leave both out for the sky now.",
    ),
  transit_timezone: z
    .string()
    .min(1, "Give the transit time zone as an IANA time zone name such as America/New_York, or leave it out for UT.")
    .max(64, "Give the transit time zone as an IANA time zone name such as America/New_York.")
    .refine(isKnownZone, "Give the transit time zone as an IANA time zone name such as America/New_York.")
    .optional()
    .describe(
      "IANA time zone name for transit_date and transit_time, such as America/New_York. Leave out for UT. Give only with transit_date and transit_time.",
    ),
  house_system: houseSystemField,
  ayanamsa: ayanamsaField,
  harmonic: z
    .number({ error: "Give the harmonic as a whole number from 1 to 10000, for example 5." })
    .int("Give the harmonic as a whole number from 1 to 10000, for example 5.")
    .min(1, "Give the harmonic as a whole number from 1 to 10000, for example 5.")
    .max(MAX_HARMONIC, "Give the harmonic as a whole number from 1 to 10000, for example 5.")
    .default(1)
    .describe(
      "Harmonic to read the chart and the sky in: 1 is the ordinary transit. Above 1, the natal chart and the sky are both multiplied by it (longitude times harmonic, mod 360) before the aspects are read.",
    ),
  bodies: objectCodesField(
    'Transiting bodies to return, such as Sun and Moo. The midpoints of transiting bodies (Tm) are made from these only; the natal chart is always whole.',
  ),
  ...transitReadingShape,
};

// The fields are strict, as for the chart. The sky needs both transit_date and transit_time, or
// neither: a date alone has no time to read, and a zone alone has no moment to convert.
export const transitInputSchema = z.strictObject(transitInputShape).superRefine((input, ctx) => {
  birthRule(input, ctx);
  const dated = input.transit_date !== undefined;
  const timed = input.transit_time !== undefined;
  if (dated !== timed) {
    ctx.addIssue({
      code: "custom",
      path: [dated ? "transit_time" : "transit_date"],
      message: "Give the transit date and time together, or leave both out for the sky now.",
      input: dated ? input.transit_date : input.transit_time,
    });
  }
  if (!dated && !timed && input.transit_timezone !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["transit_timezone"],
      message: "Give the transit time zone only with the transit date and time, or leave it out for the sky now.",
      input: input.transit_timezone,
    });
  }
  repeatedCodeRule(input, ctx);
  readingRule(input, ctx);
});

export type TransitArgs = z.infer<typeof transitInputSchema>;

const skyBodyOutput = z.object({
  code: z.enum(OBJECT_CODES).describe("Object code of the transiting body, such as Sun or Moo."),
  name: z.string().describe("Common name of the body, such as Moon."),
  ...signedPosition,
  retrograde: z.boolean().describe("True when the body moves backward in the zodiac at this moment, from its speed."),
});

// One row of the aspect list. Every reading gives the same keys, so a caller reads the pairing and nothing else to tell the rows
// apart. The default reading's rows are T to N rows, with the keys it always had.
export const transitRowOutput = z.object({
  pairing: z
    .enum(PAIRING_LABELS)
    .describe(
      "The pairing the row is in. T is a transiting body, Tm the midpoint of two transiting bodies, N a natal point (a body, ASC or MC) and Nm the midpoint of two natal points. The pairings are T to N, T to Nm, Tm to N and Tm to Nm.",
    ),
  transit_point: z
    .string()
    .describe("The transiting point: a body code such as Mar, or a transiting midpoint as two codes, such as Mar/Jup."),
  natal_point: z
    .string()
    .describe("The natal point: a body code, ASC or MC, or a natal midpoint as two of them, such as Sun/Moo."),
  transit_codes: z
    .array(z.enum(OBJECT_CODES))
    .describe("The object codes the transiting point is made of: one for a body, two for a midpoint."),
  natal_codes: z
    .array(z.enum(NATAL_CODES))
    .describe("The codes the natal point is made of: one for a body or an angle, two for a midpoint."),
  transit_body: z
    .enum(OBJECT_CODES)
    .nullable()
    .describe("The transiting body's code when the transiting point is a body; null for a transiting midpoint."),
  natal_target: z
    .enum(NATAL_CODES)
    .nullable()
    .describe("The natal point's code when it is a body or an angle (ASC or MC); null for a natal midpoint."),
  aspect: z.enum(ALL_ASPECT_NAMES).describe("Aspect name, such as conjunction, trine or semisquare."),
  orb: z.number().min(0).describe("Distance from exact, in decimal degrees to two places."),
  phase: z
    .enum(["applying", "separating", "unknown"])
    .describe(
      "applying when the orb shrinks over a short look-ahead, separating when it grows, and unknown when a body's speed is not known or a fold or the aspect's exact point is crossed inside the look-ahead.",
    ),
  applying: z.boolean().describe("True only when phase is applying, so an unknown phase is never applying."),
  strength: z
    .number()
    .min(0)
    .max(1)
    .describe("1 at exact and 0 at the edge of the orb's limit, to two places."),
  text: z
    .string()
    .describe("Aspect as text, such as Transiting Sun trine natal Moon, orb 1°05′, applying, or Transiting midpoint of Mars and Jupiter trine natal Sun, orb 0°40′, separating."),
});

// The aspects of a reading: the rows, the total before the cut, and whether the list was cut.
export const transitAspectsOutput = z
  .object({
    items: z
      .array(transitRowOutput)
      .describe(
        "The aspects. The default reading lists the tightest major aspects between transiting bodies and natal points, tightest orb first. Any other reading lists rows of the pairings asked for, ranked by strength, largest first.",
      ),
    total: z
      .number()
      .int()
      .min(0)
      .describe("How many aspects there are in all, after min_strength, before aspect_limit is applied."),
    truncated: z.boolean().describe("True when items is shorter than total."),
  })
  .describe("Aspects between transiting points and natal points, or their midpoints, as the request chose them.");

export const transitOutputSchema = z.object({
  headline: z
    .string()
    .describe("The transiting Sun and Moon positions as plain text. Only the bodies in the sky appear."),
  sky: z
    .array(skyBodyOutput)
    .describe("The transiting bodies in object-code order. With harmonic above 1 these are the harmonic chart's longitudes."),
  aspects: transitAspectsOutput,
  missing: z
    .array(z.enum(OBJECT_CODES))
    .describe("Object codes the engine did not compute, for the sky or the natal chart. Empty when all were computed."),
  meta: z
    .object({
      harmonic: z
        .number()
        .int()
        .min(1)
        .max(MAX_HARMONIC)
        .describe("Harmonic the chart and the sky were read in: 1 is the ordinary transit."),
      house_system: z.enum(HOUSE_SYSTEM_NAMES).describe("House system that was requested for the natal chart."),
      housesFrom: z.enum(HOUSE_SYSTEM_NAMES).describe("House system the engine used for the natal houses and angles."),
      utc: z
        .string()
        .describe("Moment the sky is for, in UT: the transit moment, or the instant of the call when none was given."),
      natal_utc: z.string().describe("Birth moment of the natal chart, in UT."),
      provenance: z
        .object({
          astrolog_version: z
            .string()
            .describe("Version of the engine that produced the numbers, or the stub's label."),
          source: z.enum(["astrolog", "stub"]).describe("The real engine for real numbers, or stub for placeholders."),
        })
        .describe("Where the numbers came from."),
      ayanamsa: ayanamsaOutput,
    })
    .describe("Settings and provenance behind the numbers."),
});

export type TransitOutput = z.infer<typeof transitOutputSchema>;
export type TransitRow = z.infer<typeof transitRowOutput>;
export type TransitAspects = z.infer<typeof transitAspectsOutput>;

type SkyOutput = z.infer<typeof skyBodyOutput>;

// The UT moment the sky is read at. Both date and time are given (the schema allows neither or both),
// and the zone defaults to UT. Neither given means now, from the injected clock, to the second.
function skyMoment(input: TransitArgs, deps: ToolDeps, now: () => Date): UtcMoment {
  if (input.transit_date === undefined || input.transit_time === undefined) {
    return now().toISOString().replace(/\.\d{3}Z$/, "Z") as UtcMoment;
  }
  return deps.toUtc({
    date: input.transit_date,
    time: input.transit_time,
    timezone: input.transit_timezone ?? "UTC",
  });
}

// Runs one transit: the natal chart and the sky through the shared concurrency limit, the harmonic
// on both sides when it is above 1, then the aspect search. Throws AstroError or a timeout.
export async function getTransit(
  input: TransitArgs,
  deps: ToolDeps,
  limit: LimitFunction,
  now: () => Date,
  signal?: AbortSignal,
): Promise<EngineResult<TransitOutput>> {
  const birth = await resolveBirth(input, deps);
  const utc = skyMoment(input, deps, now);
  const [natal, sky] = await Promise.all([
    queueEngineCall(
      limit,
      () =>
        deps.engine.cast({
          utc: birth.utc,
          latitude: birth.place.latitude,
          longitude: birth.place.longitude,
          houseSystem: input.house_system,
          ayanamsa: input.ayanamsa,
        }),
      signal,
      deps.engineQueue,
    ),
    queueEngineCall(
      limit,
      () => deps.engine.sky({ utc, ayanamsa: input.ayanamsa, bodies: input.bodies }),
      signal,
      deps.engineQueue,
    ),
  ]);

  const harmonic = input.harmonic;
  const natalChart = harmonic > 1 ? harmonicPositions(natal, harmonic) : natal;
  const transitSky = harmonic > 1 ? harmonicSky(sky, harmonic) : sky;
  const aspects = readTransitAspects(natalChart, transitSky, input);
  const skyBodies = shapeSky(transitSky.bodies);
  // A result is a stub result when either engine call was: placeholders must never read as data.
  const source = natal.provenance.source === "stub" || sky.provenance.source === "stub" ? "stub" : "astrolog";

  return {
    output: {
      headline: transitHeadline(skyBodies, harmonic),
      sky: skyBodies,
      aspects,
      // Only the requested bodies count: the natal chart is always cast whole, so its missing list is
      // cut to the same codes as the sky's.
      missing: OBJECT_CODES.filter(
        (code) =>
          (input.bodies === undefined || input.bodies.includes(code)) &&
          (natal.missing.includes(code) || sky.missing.includes(code)),
      ),
      meta: {
        harmonic,
        house_system: input.house_system,
        housesFrom: natal.housesFrom,
        utc,
        natal_utc: birth.utc,
        provenance: { astrolog_version: natal.provenance.astrologVersion, source },
        ...ayanamsaMeta(natal.provenance.ayanamsa),
      },
    },
    source,
  };
}

// The aspects of one sky moment against one natal chart, as the reading asks. Pure: positions in, rows out, with no engine and
// no I/O, so the daily reading can call it once per moment. Both positions must already be in the reading's harmonic (see
// harmonicPositions and harmonicSky), and in one zodiac, which the readers check.
export function readTransitAspects(natal: Positions, sky: SkyPositions, reading: TransitReading): TransitAspects {
  return isDefaultReading(reading) ? defaultAspects(natal, sky, reading) : pairedAspects(natal, sky, reading);
}

// The request that keeps today's output: the five major aspects, and the points pairing alone.
function isDefaultReading(reading: TransitReading): boolean {
  return reading.aspects === "major" && reading.include.length === 1 && reading.include[0] === "points";
}

// The default reading: the major aspects between transiting bodies and natal points, tightest orb first, as T to N rows.
// min_strength and aspect_limit apply to it; at their defaults they change nothing.
function defaultAspects(natal: Positions, sky: SkyPositions, reading: TransitReading): TransitAspects {
  const hits = transitAspects(natal, sky, TRANSIT_LIMITS)
    .filter((hit) => hit.strength >= reading.min_strength)
    .sort((x, y) => x.orb - y.orb);
  return cutList(hits, reading.aspect_limit, (hit) =>
    rowOf({
      pairing: "T to N",
      moving: hit.transit,
      movingCodes: [hit.transit],
      still: hit.natal,
      stillCodes: [hit.natal],
      aspect: hit.aspect,
      orb: hit.orb,
      strength: hit.strength,
      phase: hit.phase,
    }),
  );
}

// Every reading other than the default: the included pairings from readPairings, merged in pairing order and ranked by strength.
function pairedAspects(natal: Positions, sky: SkyPositions, reading: TransitReading): TransitAspects {
  const readings = readPairings(sky, natal, {
    aspects: readingAspects(reading.aspects),
    orb: VIBRATIONAL_ORB_RULE,
    minStrength: reading.min_strength,
  });
  const wanted = new Set(reading.include.map((value) => PAIRING_OF_INCLUDE[value]));
  const rows = PAIRING_LABELS.filter((label) => wanted.has(label)).flatMap((label) =>
    readings[label].map((hit) => ({ ...hit, pairing: label })),
  );
  return cutList(rankByStrength(rows), reading.aspect_limit, rowOf);
}

// A row before it is shaped: a hit and the pairing it came from. The codes are the object codes each point is made of.
export type ReadRow = Pick<
  PointSetHit,
  "moving" | "movingCodes" | "still" | "stillCodes" | "aspect" | "orb" | "strength" | "phase"
> & { pairing: PairingLabel };

// The strength as the result shows it: two places. Ranking uses this value, so rows that show the same strength keep their order.
function shownStrength(strength: number): number {
  return Math.round(strength * 100) / 100;
}

// Ranks rows by the strength they show, largest first. The sort is stable, so rows with equal shown strengths keep the order they
// came in: the pairing order, then the order each reading gives.
export function rankByStrength<T extends { strength: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((x, y) => shownStrength(y.strength) - shownStrength(x.strength));
}

// The bodies in the sky, in object-code order, with sign and degree. No house: the sky has none.
function shapeSky(bodies: Partial<Record<ObjectCode, SkyBody>>): SkyOutput[] {
  return OBJECT_CODES.flatMap((code) => {
    const body = bodies[code];
    if (body === undefined) {
      return [];
    }
    return [
      {
        code,
        name: BODY_NAMES[code],
        ...formatLongitude(body.longitude),
        retrograde: body.speed < 0,
        longitude: body.longitude,
      },
    ];
  });
}

// The Sun and Moon when they are in the sky, else every body that is. Harmonic charts say so first.
function transitHeadline(sky: SkyOutput[], harmonic: number): string {
  const sunAndMoon = sky.filter((body) => body.code === "Sun" || body.code === "Moo");
  const shown = sunAndMoon.length > 0 ? sunAndMoon : sky;
  const text = shown.map((body) => `${body.name} ${body.text}`).join(", ");
  if (text === "") {
    return "No transiting bodies were computed for this moment.";
  }
  return harmonic > 1 ? `Harmonic ${harmonic}: ${text}` : text;
}

// One row as the result shows it, the same for every reading. The orb is rounded to the arcminute first, so the number and the
// text name the same orb, as the chart's aspects do. The phase is in words, and unknown reads as unknown.
function rowOf(hit: ReadRow): TransitRow {
  const [transitCode] = hit.movingCodes;
  const [natalCode] = hit.stillCodes;
  return {
    pairing: hit.pairing,
    transit_point: hit.moving,
    natal_point: hit.still,
    transit_codes: [...hit.movingCodes] as ObjectCode[],
    natal_codes: [...hit.stillCodes] as NatalCode[],
    transit_body: hit.movingCodes.length === 1 ? (transitCode as ObjectCode) : null,
    natal_target: hit.stillCodes.length === 1 ? (natalCode as NatalCode) : null,
    aspect: hit.aspect,
    orb: Math.round(arcminuteOrb(hit.orb) * 100) / 100,
    phase: hit.phase,
    applying: hit.phase === "applying",
    strength: shownStrength(hit.strength),
    text: aspectSentence(hit),
  };
}

// An orb to the arcminute, in decimal degrees. The numbers and the texts of the results all take it, so they name one orb.
export function arcminuteOrb(orb: number): number {
  return Math.round(orb * 60) / 60;
}

// The facts of one aspect that its sentence states: the codes of each point, the aspect, the orb and the phase.
export interface AspectFacts {
  movingCodes: readonly string[];
  stillCodes: readonly string[];
  aspect: string;
  orb: number;
  phase: ApproachPhase;
}

// An aspect as one sentence, such as "Transiting Moon trine natal Sun, orb 0°12′, applying". The orb is shown to the arcminute and
// the phase in words. The transit rows and the daily hits both state their aspect with this, so the wording is one.
export function aspectSentence(facts: AspectFacts): string {
  return `Transiting ${pointText(facts.movingCodes)} ${facts.aspect} natal ${pointText(facts.stillCodes)}, orb ${formatDegreesMinutes(arcminuteOrb(facts.orb))}, ${PHASE_TEXT[facts.phase]}`;
}

// The name of a natal point: an angle's name for ASC and MC, a body's name for an object code.
function targetName(code: string): string {
  return code === "ASC" || code === "MC" ? ANGLE_NAMES[code as AngleCode] : BODY_NAMES[code as ObjectCode];
}

// A point as text from its codes: a body or an angle by its name, or a midpoint as "midpoint of X and Y".
function pointText(codes: readonly string[]): string {
  const [first, second] = codes;
  if (second === undefined) {
    return targetName(first ?? "");
  }
  return `midpoint of ${targetName(first ?? "")} and ${targetName(second)}`;
}

const PHASE_TEXT: Record<ApproachPhase, string> = {
  applying: "applying",
  separating: "separating",
  unknown: "phase unknown",
};

export const TRANSIT_DESCRIPTION = [
  "Call this when someone asks what the sky holds at one moment, now or at a given date and time, against a natal chart: which planets are transiting and which natal points they aspect at that moment.",
  "Why: the natal chart and the sky come from the configured engine with fixed settings, so the same input always gives the same numbers. With ENGINE=stub they are placeholders, and the text starts with a PLACEHOLDER line.",
  "Inputs: birth_date and birth_time give the birth moment in the local time of the birth place, with place, or with latitude, longitude and timezone. house_system names the natal house system. ayanamsa sets the zodiac of both the natal chart and the sky. harmonic sets the harmonic of both. bodies limits the transiting bodies, and so the midpoints made of them; the natal chart is always whole. transit_date and transit_time give the moment of the sky, with transit_timezone for its zone; leave out both for the sky now.",
  `Returns: the transiting bodies with sign, degree, minute and retrograde flag; the aspects, ranked by orb for the default reading and by strength for the others, the ${TRANSIT_LIST_LIMIT} tightest unless aspect_limit says otherwise, with the total and a truncated flag; and the sky moment, the birth moment, the house system and the harmonic.`,
  'Reading: aspects is "major" (default) or "all" (17 vibrational aspects). A point pairing (T to N) takes each aspect\'s own transit orb; any pairing with a midpoint takes the classic midpoint orb. include lists the pairings, in any order: "points" (default: transiting bodies to natal points, T to N), "to_natal_midpoints" (to natal midpoints, T to Nm), "transit_midpoints" (midpoints of transiting bodies to natal points, Tm to N) and "midpoint_to_midpoint" (transit midpoints to natal midpoints, Tm to Nm). Every row names its pairing, the points or midpoint pairs involved, orb, strength and phase (applying, separating or unknown). The default reading keeps its keys, order, orb and strength, and only a row whose phase is unknown changes its applying (false) and text ("phase unknown"); any other reading ranks by strength. Every row has the same keys. min_strength keeps the aspects at or above a strength from 0 to 1, and aspect_limit sets how many to list, with 0 for all.',
  "Leave out transit_date and transit_time for the sky now. With harmonic above 1, the natal chart and the sky are both multiplied by the harmonic (longitude times harmonic, mod 360), and every longitude returned is that harmonic chart's.",
  `Input ayanamsa sets the zodiac for both the natal chart and the sky: ${AYANAMSA_CHOICES}; a sidereal result names the ayanamsa in meta. Gives positions and facts only, with no interpretation.`,
].join(" ");

// `now` is the clock for a sky read with no moment. Tests pass their own; the server uses the real one.
export function registerTransitTool(
  server: McpServer,
  deps: ToolDeps,
  limit: LimitFunction,
  now: () => Date = () => new Date(),
): void {
  registerEngineTool(server, deps, {
    name: TRANSIT_TOOL_NAME,
    title: "Transits to a natal chart",
    description: TRANSIT_DESCRIPTION,
    failure: { subject: "The transit", timeoutFix: "Retry in a moment; if it repeats, request fewer bodies." },
    inputSchema: transitInputSchema,
    outputSchema: transitOutputSchema,
    run: (input, signal) => getTransit(input, deps, limit, now, signal),
  });
}
