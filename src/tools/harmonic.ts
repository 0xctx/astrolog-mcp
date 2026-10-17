import type { McpServer } from "@modelcontextprotocol/server";
import type { LimitFunction } from "p-limit";
import { z } from "zod";
import { queueEngineCall } from "../limits.js";
import {
  assertHarmonic,
  harmonicPositions,
  MAX_HARMONIC,
  midpointContacts,
  type MidpointConfig,
  type MidpointContact,
  VIBRATIONAL_ASPECTS,
  VIBRATIONAL_MIDPOINT_ORB,
} from "../math.js";
import { OBJECT_CODES } from "../types.js";
import { registerEngineTool, type EngineResult } from "./call.js";
import type { ToolDeps } from "./deps.js";
import { ANGLE_NAMES, BODY_NAMES, formatDegreesMinutes, formatLongitude } from "./format.js";
import {
  AYANAMSA_CHOICES,
  ayanamsaField,
  birthRule,
  birthShape,
  harmonicNumber,
  HOUSE_SYSTEM_NAMES,
  houseSystemField,
  resolveBirth,
} from "./input.js";
import { ayanamsaMeta, ayanamsaOutput, placeMeta, placeOutput, signedPosition } from "./output.js";

export const HARMONIC_TOOL_NAME = "get_harmonic_midpoints";

// The structures a call returns when it does not say how many. The caller may ask for 1 to the maximum.
export const STRUCTURE_DEFAULT_LIMIT = 12;
export const STRUCTURE_MAX_LIMIT = 50;
const LIMIT_FIX = `Give the number of structures to list as a whole number from 1 to ${STRUCTURE_MAX_LIMIT}.`;

// The points a midpoint can involve: every body the engine returns, then the Ascendant and Midheaven.
const POINT_CODES = [...OBJECT_CODES, "ASC", "MC"] as const;
type PointCode = (typeof POINT_CODES)[number];
const ANGLE_POINTS = ["ASC", "MC"] as const;

// The classic midpoint method with the vibrational pack's aspects and orb. No other method is offered.
const MIDPOINT_CONFIG: MidpointConfig = { aspects: VIBRATIONAL_ASPECTS, orb: VIBRATIONAL_MIDPOINT_ORB };

export const harmonicInputShape = {
  ...birthShape,
  house_system: houseSystemField,
  ayanamsa: ayanamsaField,
  harmonic: harmonicNumber.describe(
    `Harmonic H, a whole number from 1 to ${MAX_HARMONIC}, for example 5. Every longitude is multiplied by H before the midpoints are read; 1 is the natal chart.`,
  ),
  limit: z
    .number({ error: LIMIT_FIX })
    .int(LIMIT_FIX)
    .min(1, LIMIT_FIX)
    .max(STRUCTURE_MAX_LIMIT, LIMIT_FIX)
    .default(STRUCTURE_DEFAULT_LIMIT)
    .describe(
      `How many midpoint structures to return, tightest orb first, from 1 to ${STRUCTURE_MAX_LIMIT}. Leave out for ${STRUCTURE_DEFAULT_LIMIT}.`,
    ),
};

// The fields are strict, as for get_chart_data: an unknown key is refused, and the birth fields must
// give a place or all three coordinates.
export const harmonicInputSchema = z
  .strictObject(harmonicInputShape)
  .superRefine((input, ctx) => birthRule(input, ctx));

export type HarmonicArgs = z.infer<typeof harmonicInputSchema>;

const bodyPosition = z.object({
  code: z.enum(OBJECT_CODES).describe("Object code, such as Sun or Moo."),
  name: z.string().describe("Common name of the body, such as Moon."),
  ...signedPosition,
});

const anglePosition = z.object({
  code: z.enum(ANGLE_POINTS).describe("Angle code: ASC or MC."),
  name: z.string().describe("Name of the angle, such as Midheaven."),
  ...signedPosition,
});

const structureOutput = z.object({
  a: z.enum(POINT_CODES).describe("The first of the two points whose midpoint this is."),
  b: z.enum(POINT_CODES).describe("The second of the two points whose midpoint this is."),
  midpoint_sign_degree_text: z
    .string()
    .describe("The midpoint's sign and degree as text, such as 24°14′ Gemini."),
  focus: z.enum(POINT_CODES).describe("The point that sits on, or in aspect to, the midpoint."),
  aspect: z.string().describe("Aspect name from the vibrational set, such as conjunction or quintile."),
  orb: z.number().min(0).describe("Distance from exact in decimal degrees, to four places."),
  strength: z.number().min(0).max(1).describe("1 at exact and 0 at the edge of the orb, to four places."),
  text: z
    .string()
    .describe("The structure as text, such as Mercury conjunction the midpoint of Sun and Moon, orb 0°00′."),
});

export const harmonicOutputSchema = z.object({
  headline: z
    .string()
    .describe("The harmonic, the number of midpoint structures and the tightest one, as plain text."),
  harmonic_positions: z
    .object({
      bodies: z.array(bodyPosition).describe("The bodies in object-code order, each longitude multiplied by the harmonic."),
      angles: z.array(anglePosition).describe("The Ascendant and Midheaven, ASC then MC, each multiplied by the harmonic."),
    })
    .describe("Positions in the harmonic chart: each longitude is the natal longitude times the harmonic."),
  structures: z
    .object({
      items: z.array(structureOutput).describe("The tightest midpoint structures, tightest orb first, up to limit."),
      total: z.number().int().min(0).describe("How many midpoint structures the chart has in this harmonic in all."),
      truncated: z.boolean().describe("True when items is shorter than total."),
    })
    .describe("Classic midpoint structures in this harmonic, ranked by orb."),
  missing: z
    .array(z.enum(OBJECT_CODES))
    .describe("Object codes the engine did not compute, so no structure uses them. Empty when all were computed."),
  meta: z
    .object({
      harmonic: z.number().int().min(1).max(MAX_HARMONIC).describe("The harmonic the structures are in."),
      house_system: z.enum(HOUSE_SYSTEM_NAMES).describe("House system that was requested."),
      housesFrom: z.enum(HOUSE_SYSTEM_NAMES).describe("House system the engine used for the houses and angles."),
      utc: z.string().describe("Moment the numbers are for, in UT, such as 1990-06-15T23:30:00Z."),
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

export type HarmonicOutput = z.infer<typeof harmonicOutputSchema>;

type StructureOutput = z.infer<typeof structureOutput>;

// A body's name, or an angle's name for ASC and MC.
function pointName(code: PointCode): string {
  return code === "ASC" || code === "MC" ? ANGLE_NAMES[code] : BODY_NAMES[code];
}

// Four decimal places: enough to tell two orbs apart. Ranking reads the unrounded orb.
function toFourPlaces(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// One midpoint contact as the output shows it. midpointContacts names only bodies and ASC or MC,
// so each code is a PointCode.
function structureOf(contact: MidpointContact): StructureOutput {
  const focus = contact.focus as PointCode;
  const a = contact.a as PointCode;
  const b = contact.b as PointCode;
  return {
    a,
    b,
    midpoint_sign_degree_text: formatLongitude(contact.midpoint).text,
    focus,
    aspect: contact.aspect,
    orb: toFourPlaces(contact.orb),
    strength: toFourPlaces(contact.strength),
    text: `${pointName(focus)} ${contact.aspect} the midpoint of ${pointName(a)} and ${pointName(b)}, orb ${formatDegreesMinutes(contact.orb)}`,
  };
}

// Runs one harmonic: resolves the place, casts the natal chart once through the shared concurrency
// limit, reads the midpoint structures of the harmonic, and shapes the output. Throws AstroError or a
// timeout. The harmonic is checked before any place is resolved or engine call starts.
export async function getHarmonicMidpoints(
  input: HarmonicArgs,
  deps: ToolDeps,
  limit: LimitFunction,
  signal?: AbortSignal,
): Promise<HarmonicOutput> {
  return (await harmonicAndSource(input, deps, limit, signal)).output;
}

async function harmonicAndSource(
  input: HarmonicArgs,
  deps: ToolDeps,
  limit: LimitFunction,
  signal?: AbortSignal,
): Promise<EngineResult<HarmonicOutput>> {
  assertHarmonic(input.harmonic);
  const { place, utc } = await resolveBirth(input, deps);
  const natal = await queueEngineCall(
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
  );

  const harmonic = harmonicPositions(natal, input.harmonic);
  // Tightest orb first; equal orbs keep the stronger structure first.
  const ranked = midpointContacts(natal, input.harmonic, MIDPOINT_CONFIG).sort(
    (x, y) => x.orb - y.orb || y.strength - x.strength,
  );
  const items = ranked.slice(0, input.limit).map(structureOf);
  const tightest = items[0];

  const bodies = OBJECT_CODES.flatMap((code) => {
    const body = harmonic.bodies[code];
    if (body === undefined) {
      return [];
    }
    return [{ code, name: BODY_NAMES[code], ...formatLongitude(body.longitude), longitude: body.longitude }];
  });
  const angles = ANGLE_POINTS.map((code) => ({
    code,
    name: ANGLE_NAMES[code],
    ...formatLongitude(harmonic.angles[code]),
    longitude: harmonic.angles[code],
  }));

  const count = `${ranked.length} midpoint ${ranked.length === 1 ? "structure" : "structures"}`;
  const headline = `Harmonic ${input.harmonic}: ${count}.${tightest ? ` Tightest: ${tightest.text}.` : ""}`;

  return {
    output: {
      headline,
      harmonic_positions: { bodies, angles },
      structures: { items, total: ranked.length, truncated: ranked.length > items.length },
      missing: natal.missing,
      meta: {
        harmonic: input.harmonic,
        house_system: input.house_system,
        housesFrom: natal.housesFrom,
        utc: natal.provenance.utc,
        place: placeMeta(place),
        provenance: { astrolog_version: natal.provenance.astrologVersion, source: natal.provenance.source },
        ...ayanamsaMeta(natal.provenance.ayanamsa),
      },
    },
    source: natal.provenance.source,
  };
}

const HARMONIC_DESCRIPTION = [
  "Call this when someone asks which midpoint structures a birth chart has in one harmonic, such as harmonic 5 or 7, for a birth date, time and place.",
  "Why: the chart is cast once by the configured engine, each longitude is multiplied by the harmonic, and the classic midpoint method tests every pair of points, so the same input always gives the same structures. With ENGINE=stub they are placeholders, and the text starts with a PLACEHOLDER line.",
  `Returns: a headline with the structure count and the tightest structure; the harmonic positions of the bodies, Ascendant and Midheaven; up to limit structures (default ${STRUCTURE_DEFAULT_LIMIT}, at most ${STRUCTURE_MAX_LIMIT}) ranked by orb, each with its focus point, the two points whose midpoint it is, the aspect, orb, strength and the midpoint's sign and degree; the total count; and the harmonic, house system, UT moment, place and provenance.`,
  `Input ayanamsa sets the zodiac the longitudes are multiplied in: ${AYANAMSA_CHOICES}; a sidereal result names the ayanamsa in meta. Gives positions and facts only, with no interpretation. Pass either place, or latitude, longitude and timezone. One harmonic per call.`,
].join(" ");

export function registerHarmonicTool(server: McpServer, deps: ToolDeps, limit: LimitFunction): void {
  registerEngineTool(server, deps, {
    name: HARMONIC_TOOL_NAME,
    title: "Harmonic midpoint structures",
    description: HARMONIC_DESCRIPTION,
    failure: {
      subject: "The harmonic chart",
      timeoutFix: "Retry in a moment; if it repeats, report it with the time it happened.",
    },
    inputSchema: harmonicInputSchema,
    outputSchema: harmonicOutputSchema,
    run: (input, signal) => harmonicAndSource(input, deps, limit, signal),
  });
}
