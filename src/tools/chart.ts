import type { McpServer } from "@modelcontextprotocol/server";
import type { LimitFunction } from "p-limit";
import { z } from "zod";
import { queueEngineCall } from "../limits.js";
import { assertHarmonic, harmonicPositions, MAX_HARMONIC } from "../math.js";
import { OBJECT_CODES, type Positions } from "../types.js";
import { registerEngineTool } from "./call.js";
import type { ToolDeps } from "./deps.js";
import { aspectLimitField, aspectSetField, readAspects } from "./aspect-list.js";
import {
  AYANAMSA_CHOICES,
  ayanamsaField,
  birthRule,
  birthShape,
  harmonicNumber,
  HOUSE_SYSTEM_NAMES,
  houseSystemField,
  objectCodesField,
  repeatedCodeRule,
  resolveBirth,
} from "./input.js";
import {
  ASPECT_LIST_LIMIT,
  aspectSummaryOutput,
  angleOutput,
  ayanamsaMeta,
  ayanamsaOutput,
  bodyOutput,
  chartHeadline,
  houseOutput,
  placeMeta,
  placeOutput,
  shapeAngles,
  shapeBodies,
  shapeHouses,
} from "./output.js";

export const CHART_TOOL_NAME = "get_chart_data";

// Re-exported so existing imports keep working: the output shape and the aspect rules live in output.ts.
export { ASPECT_LIST_LIMIT, ASPECT_TABLE, majorAspects, type AspectType } from "./output.js";
export { STUB_MARKER } from "./call.js";

export const chartInputShape = {
  ...birthShape,
  house_system: houseSystemField,
  ayanamsa: ayanamsaField,
  harmonic: harmonicNumber
    .default(1)
    .describe(
      `Harmonic H, a whole number from 1 to ${MAX_HARMONIC}. Leave out for 1, the natal chart. Above 1 each longitude is multiplied by H, so the bodies, aspects, houses and angles are harmonic positions; the houses and angles are the harmonic multiples of the natal ones, not recalculated cusps.`,
    ),
  bodies: objectCodesField('Object codes to return, such as Sun and Moo.'),
  aspects: aspectSetField,
  aspect_limit: aspectLimitField,
};

// The fields are strict: an unknown key is refused, not dropped, so a typo such as house_sytem
// cannot quietly return the default house system. The rules that span fields follow. Each message
// is also the fix line the caller sees.
export const chartInputSchema = z.strictObject(chartInputShape).superRefine((input, ctx) => {
  birthRule(input, ctx);
  repeatedCodeRule(input, ctx);
});

export type ChartArgs = z.infer<typeof chartInputSchema>;

export const chartOutputSchema = z.object({
  headline: z
    .string()
    .describe("The Sun, Moon and Ascendant positions as plain text. Only the bodies requested appear."),
  bodies: z.array(bodyOutput).describe("The requested bodies in object-code order."),
  houses: z.array(houseOutput).describe("The twelve house cusps, house 1 to 12."),
  angles: z.array(angleOutput).describe("The four angles: ASC, MC, DSC and IC."),
  aspects: aspectSummaryOutput("the chart").describe(
    "Aspects between bodies. Only when aspects is all, also aspects between bodies and the angles ASC and MC, each item with a strength, and set says all. The total and whether the list was cut are always given.",
  ),
  missing: z
    .array(z.enum(OBJECT_CODES))
    .describe("Requested object codes the engine did not compute. Empty when all were computed."),
  meta: z
    .object({
      house_system: z.enum(HOUSE_SYSTEM_NAMES).describe("House system that was requested."),
      housesFrom: z.enum(HOUSE_SYSTEM_NAMES).describe("House system the engine used for the houses."),
      harmonic: z
        .number()
        .int()
        .min(1)
        .max(MAX_HARMONIC)
        .describe("Harmonic the positions are in: 1 for the natal chart, otherwise the harmonic that was requested."),
      astrolog_version: z
        .string()
        .describe("Version of the engine that produced the numbers, or the stub's label."),
      utc: z.string().describe("Moment the numbers are for, in UT, such as 1990-06-15T23:30:00Z."),
      place: placeOutput.describe("Birth place used for the houses and angles."),
      ayanamsa: ayanamsaOutput,
    })
    .describe("Settings and provenance behind the numbers."),
});

export type ChartOutput = z.infer<typeof chartOutputSchema>;

// Runs one chart: resolves the place, converts the moment to UT, asks the engine for positions
// through the shared concurrency limit, and shapes the output. Throws AstroError or a timeout.
// The signal is aborted when the call has timed out or returned; an engine call still waiting for
// a slot then does not start.
export async function getChart(
  input: ChartArgs,
  deps: ToolDeps,
  limit: LimitFunction,
  signal?: AbortSignal,
): Promise<ChartOutput> {
  return (await chartAndSource(input, deps, limit, signal)).output;
}

// The chart and the provenance source of the engine that produced its numbers. The tool handler
// needs the source to mark a stub result; the output schema does not carry it.
async function chartAndSource(
  input: ChartArgs,
  deps: ToolDeps,
  limit: LimitFunction,
  signal?: AbortSignal,
) {
  assertHarmonic(input.harmonic);
  const { place, utc } = await resolveBirth(input, deps);
  const natal: Positions = await queueEngineCall(
    limit,
    () =>
      deps.engine.cast({
        utc,
        latitude: place.latitude,
        longitude: place.longitude,
        houseSystem: input.house_system,
        ayanamsa: input.ayanamsa,
        bodies: input.bodies,
      }),
    signal,
    deps.engineQueue,
  );
  // The natal positions are the engine's; a harmonic chart multiplies them, and the houses are not recomputed.
  const positions = input.harmonic === 1 ? natal : harmonicPositions(natal, input.harmonic);

  const bodies = shapeBodies(positions.bodies);
  const aspects = readAspects({ bodies, angles: positions.angles }, input.aspects, input.aspect_limit);

  return {
    output: {
      headline: chartHeadline(bodies, positions.angles.ASC),
      bodies,
      houses: shapeHouses(positions.houses),
      angles: shapeAngles(positions.angles),
      aspects,
      missing: positions.missing,
      meta: {
        house_system: input.house_system,
        housesFrom: positions.housesFrom,
        harmonic: input.harmonic,
        astrolog_version: positions.provenance.astrologVersion,
        utc: positions.provenance.utc,
        place: placeMeta(place),
        ...ayanamsaMeta(positions.provenance.ayanamsa),
      },
    },
    source: positions.provenance.source,
  };
}

const CHART_DESCRIPTION = [
  "Call this when someone asks to calculate a natal chart (birth chart) for a birth date, time and place: where the Sun, Moon, planets, houses and angles fall, and their aspects.",
  "Why: the numbers come from the configured engine with fixed settings, so the same input always gives the same numbers. With ENGINE=stub they are placeholders, and the text starts with a PLACEHOLDER line.",
  `Returns: a headline of the Sun, Moon and Ascendant positions; each requested body with sign, degree, minute, retrograde flag and house; the twelve house cusps; the four angles (ASC, MC, DSC, IC); the aspects, which are by default the ${ASPECT_LIST_LIMIT} tightest of the five major aspects between bodies; the total count and a truncated flag; and the house system, the harmonic, the version of the engine that made the numbers, UT moment and place.`,
  'Aspects: "aspects" chooses the set. "major" (default) reads the five major aspects between bodies, and nothing else; its output is unchanged. "all" reads the 17 vibrational aspects, such as semisquare, quincunx, quintile, septile and novile, between bodies and the angles ASC and MC, with each orb 16 degrees divided by the aspect\'s harmonic, and the five major ones at the wider of that and their major orb (trine 6, square 6, sextile 4), so the "all" set holds every major aspect (with aspect_limit 0, every one is listed). Only "all" reads the angles as targets and adds a strength to each item and set to the list. "aspect_limit" is how many to list, 8 by default; 0 lists every aspect.',
  "Harmonic H, from 1 to 10000 and 1 when left out, multiplies every longitude by H, and the houses and angles shown are the harmonic multiples of the natal ones, not recalculated cusps.",
  `Input ayanamsa sets the zodiac: ${AYANAMSA_CHOICES}; a sidereal result names the ayanamsa in meta.`,
  "Gives positions and facts only, with no interpretation. Pass either place, or latitude, longitude and timezone.",
].join(" ");

export function registerChartTool(server: McpServer, deps: ToolDeps, limit: LimitFunction): void {
  registerEngineTool(server, deps, {
    name: CHART_TOOL_NAME,
    title: "Natal chart data",
    description: CHART_DESCRIPTION,
    failure: { subject: "The chart", timeoutFix: "Retry in a moment; if it repeats, request fewer bodies." },
    inputSchema: chartInputSchema,
    outputSchema: chartOutputSchema,
    run: (input, signal) => chartAndSource(input, deps, limit, signal),
  });
}
