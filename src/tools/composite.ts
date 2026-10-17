import type { McpServer } from "@modelcontextprotocol/server";
import type { LimitFunction } from "p-limit";
import { z } from "zod";
import { queueEngineCall } from "../limits.js";
import { COMPOSITE_KINDS, OBJECT_CODES, type Birth, type Place, type UtcMoment } from "../types.js";
import { registerEngineTool, type EngineResult } from "./call.js";
import type { ToolDeps } from "./deps.js";
import { aspectLimitField, aspectSetField, readAspects } from "./aspect-list.js";
import {
  AYANAMSA_CHOICES,
  HOUSE_SYSTEM_NAMES,
  ayanamsaField,
  birthRule,
  birthShape,
  houseSystemField,
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
  shapeAngles,
  shapeBodies,
  shapeHouses,
} from "./output.js";

export const COMPOSITE_TOOL_NAME = "get_composite_data";

// One person: the birth fields a natal chart takes, strict, with the same place rule.
const personSchema = z.strictObject(birthShape).superRefine((input, ctx) => birthRule(input, ctx));

export const compositeInputShape = {
  person_a: personSchema.describe("The first person: birth date, time and place, as a natal chart takes them."),
  person_b: personSchema.describe("The second person: birth date, time and place, as a natal chart takes them."),
  kind: z
    .enum(COMPOSITE_KINDS, { error: 'Give the chart kind as "composite" or "davison".' })
    .describe(
      '"composite" merges the two charts into one chart. "davison" casts one chart for the midpoint of the two moments, in UT.',
    ),
  house_system: houseSystemField,
  aspects: aspectSetField,
  aspect_limit: aspectLimitField,
  ayanamsa: ayanamsaField,
};

// The fields are strict: an unknown key is refused, as for the chart, and so is an unknown key
// inside either person.
export const compositeInputSchema = z.strictObject(compositeInputShape);

export type CompositeArgs = z.infer<typeof compositeInputSchema>;

export const compositeOutputSchema = z.object({
  headline: z
    .string()
    .describe("The Sun, Moon and Ascendant positions of the composite as plain text."),
  bodies: z.array(bodyOutput).describe("The composite's bodies in object-code order."),
  houses: z.array(houseOutput).describe("The twelve house cusps of the composite, house 1 to 12."),
  angles: z.array(angleOutput).describe("The four angles of the composite: ASC, MC, DSC and IC."),
  aspects: aspectSummaryOutput("the composite").describe(
    "Aspects between the composite's bodies. Only when aspects is all, also aspects between them and the angles ASC and MC, each item with a strength, and set says all. The total and whether the list was cut are always given.",
  ),
  missing: z
    .array(z.enum(OBJECT_CODES))
    .describe("Object codes the engine did not compute. Empty when all were computed."),
  meta: z
    .object({
      kind: z.enum(COMPOSITE_KINDS).describe('"composite" for the merged chart, "davison" for the midpoint chart.'),
      input_utc: z
        .array(z.string())
        .length(2)
        .describe("The two birth moments in UT, person A first, then person B."),
      davison_midpoint_utc: z
        .string()
        .optional()
        .describe("Only when kind is davison: the UT midpoint of the two moments, which the chart was cast for."),
      house_system: z.enum(HOUSE_SYSTEM_NAMES).describe("House system that was requested."),
      housesFrom: z.enum(HOUSE_SYSTEM_NAMES).describe("House system the engine used for the houses."),
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
    .describe("The kind, the input moments, the house systems and the provenance behind the numbers."),
});

export type CompositeOutput = z.infer<typeof compositeOutputSchema>;

// The engine's birth for one person: the UT moment and the coordinates, with no house system.
function birthOf({ place, utc }: { place: Place; utc: UtcMoment }): Birth {
  return { utc, latitude: place.latitude, longitude: place.longitude };
}

// Runs one composite: resolves each person's place and moment, asks the engine for the composite
// through the shared concurrency limit, and shapes the output. Throws AstroError or a timeout.
export async function getComposite(
  input: CompositeArgs,
  deps: ToolDeps,
  limit: LimitFunction,
  signal?: AbortSignal,
): Promise<EngineResult<CompositeOutput>> {
  const a = await resolveBirth(input.person_a, deps);
  const b = await resolveBirth(input.person_b, deps);
  const positions = await queueEngineCall(
    limit,
    () =>
      deps.engine.composite({
        a: birthOf(a),
        b: birthOf(b),
        kind: input.kind,
        houseSystem: input.house_system,
        ayanamsa: input.ayanamsa,
      }),
    signal,
    deps.engineQueue,
  );
  const { provenance } = positions;
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
        kind: provenance.kind,
        input_utc: [...provenance.inputUtc],
        ...(provenance.kind === "davison" ? { davison_midpoint_utc: provenance.utc } : {}),
        house_system: input.house_system,
        housesFrom: positions.housesFrom,
        provenance: { astrolog_version: provenance.astrologVersion, source: provenance.source },
        ...ayanamsaMeta(provenance.ayanamsa),
      },
    },
    source: provenance.source,
  };
}

const COMPOSITE_DESCRIPTION = [
  "Call this when someone asks how two people's charts combine, as one merged composite chart or as a Davison midpoint chart.",
  "Why: both charts come from the configured engine with fixed settings, so the same two people always give the same numbers. With ENGINE=stub they are placeholders, and the text starts with a PLACEHOLDER line.",
  `Returns: the composite's bodies with sign, degree, minute, retrograde flag and house; the twelve house cusps; the four angles (ASC, MC, DSC, IC); the aspects, which are by default the ${ASPECT_LIST_LIMIT} tightest of the five major aspects between its bodies, with the total count and a truncated flag; and the kind, the two birth moments in UT, the Davison midpoint moment when the kind is davison, the house system and the engine's version.`,
  'Aspects: "aspects" chooses the set. "major" (default) reads the five major aspects between the bodies, and nothing else; its output is unchanged. "all" reads the 17 vibrational aspects, such as semisquare, quincunx, quintile, septile and novile, between the bodies and the angles ASC and MC, with each orb 16 degrees divided by the aspect\'s harmonic, and the five major ones at the wider of that and their major orb (trine 6, square 6, sextile 4), so the "all" set holds every major aspect (with aspect_limit 0, every one is listed). Only "all" reads the angles as targets and adds a strength to each item and set to the list. "aspect_limit" is how many to list, 8 by default; 0 lists every aspect.',
  `A composite has no moment of its own: it uses the two birth moments and places. Input ayanamsa sets the zodiac of the composite: ${AYANAMSA_CHOICES}; a sidereal result names the ayanamsa in meta. Gives positions and facts only, with no interpretation. Give each person as place, or as latitude, longitude and timezone.`,
].join(" ");

export function registerCompositeTool(server: McpServer, deps: ToolDeps, limit: LimitFunction): void {
  registerEngineTool(server, deps, {
    name: COMPOSITE_TOOL_NAME,
    title: "Composite of two charts",
    description: COMPOSITE_DESCRIPTION,
    failure: { subject: "The composite", timeoutFix: "Retry in a moment; if it repeats, report it with the time it happened." },
    inputSchema: compositeInputSchema,
    outputSchema: compositeOutputSchema,
    run: (input, signal) => getComposite(input, deps, limit, signal),
  });
}
