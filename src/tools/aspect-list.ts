import { z } from "zod";
import { pairAspects, VIBRATIONAL_ASPECTS, vibrationalAspectLimits, type AspectLimit, type AspectType } from "../math.js";
import type { ObjectCode } from "../types.js";
import {
  ASPECT_LIST_LIMIT,
  ASPECT_TABLE,
  aspectSummary,
  majorAspects,
  type AspectPoint,
  type AspectSummary,
  type ListedAspect,
} from "./output.js";
import { formatDegreesMinutes } from "./format.js";

// The aspect sets a chart or composite can read. "major" is the five aspects those tools always read;
// "all" is the 17 vibrational aspects, read between the bodies and the angles ASC and MC.
export const ASPECT_SETS = ["major", "all"] as const;

export type AspectSet = (typeof ASPECT_SETS)[number];

const ASPECTS_FIX = 'Give the aspect set as "major" or "all".';
const ASPECT_LIMIT_FIX = "Give the aspect limit as a whole number from 0 up, for example 8; 0 lists every aspect.";

// Other names and abbreviations people use for each aspect of the vibrational set. The result always uses the name itself.
export const ASPECT_SYNONYMS: Record<string, string> = {
  conjunction: "conj",
  opposition: "opp",
  trine: "tri",
  square: "sqr, quartile",
  quintile: "qtl",
  biquintile: "bi-quintile",
  sextile: "sex",
  septile: "sep",
  biseptile: "bi-septile",
  triseptile: "tri-septile",
  semisquare: "semi-square, octile",
  sesquiquadrate: "sesquisquare, sesqui-square, trioctile",
  novile: "nonile",
  binovile: "bi-novile",
  quadnovile: "quadri-novile",
  semisextile: "semi-sextile",
  quincunx: "inconjunct",
};

// An aspect as the guide names it: "square (sqr, quartile, 90°)", with the angle to the arcminute when it is not whole.
function aspectEntry({ key, angle }: AspectType): string {
  const degrees = Number.isInteger(angle) ? `${angle}°` : formatDegreesMinutes(angle);
  const synonyms = ASPECT_SYNONYMS[key];
  return `${key} (${synonyms === undefined ? "" : `${synonyms}, `}${degrees})`;
}

// The aspect names, their synonyms and angles by set, for the descriptions of every tool with an aspect set. Built from
// VIBRATIONAL_ASPECTS and ASPECT_TABLE, so it names exactly the aspects the sets read.
export const ASPECT_NAME_GUIDE = (() => {
  const isMajor = ({ key }: AspectType) => Object.hasOwn(ASPECT_TABLE, key);
  const major = VIBRATIONAL_ASPECTS.filter(isMajor).map(aspectEntry);
  const added = VIBRATIONAL_ASPECTS.filter((aspect) => !isMajor(aspect)).map(aspectEntry);
  return `The aspect names results use, with other names people use and the angle (no input takes an aspect name): "major" has ${major.join(", ")}; "all" adds ${added.join(", ")}.`;
})();

export const aspectSetField = z
  .enum(ASPECT_SETS, { error: ASPECTS_FIX })
  .default("major")
  .describe(
    'Which aspects to list. "major" (default) lists the five major aspects between the bodies. "all" lists the 17 vibrational aspects, such as semisquare, quincunx, quintile, septile and novile, between the bodies and the angles ASC and MC. Each orb is 16 degrees divided by the harmonic, and the five major aspects take the wider of that and their major orb (trine 6, square 6, sextile 4), so the "all" set holds every "major" aspect. For example, quintile has an orb of 3.2 and semisquare 2. ' +
      ASPECT_NAME_GUIDE,
  );

export const aspectLimitField = z
  .number({ error: ASPECT_LIMIT_FIX })
  .int(ASPECT_LIMIT_FIX)
  .min(0, ASPECT_LIMIT_FIX)
  .default(ASPECT_LIST_LIMIT)
  .describe(
    `How many aspects to list, tightest orb first for major, and by strength for all. Leave out for ${ASPECT_LIST_LIMIT}. 0 lists every aspect. The result always gives the total and whether the list was cut.`,
  );

// The bodies in object-code order and the two angles the "all" set reads as targets.
export interface AspectInput {
  bodies: { code: ObjectCode; longitude: number }[];
  angles: { ASC: number; MC: number };
}

// The orb of each aspect in the "all" set: 16 ÷ its harmonic, as vibrationalAspectLimits gives it. For the five
// major aspects it is the wider of that and their ASPECT_TABLE orb, so every aspect "major" lists is also in "all":
// trine 6 (not 5.33), square 6 (not 4), sextile 4 (not 2.67); conjunction 16 and opposition 8 are already wider.
export function allSetLimits(): AspectLimit[] {
  return vibrationalAspectLimits().map((limit) => {
    const key = limit.type.key;
    if (!Object.hasOwn(ASPECT_TABLE, key)) {
      return limit;
    }
    return { type: limit.type, orb: Math.max(limit.orb, ASPECT_TABLE[key as keyof typeof ASPECT_TABLE].orb) };
  });
}

// The aspect summary for the set the caller asked for. "major" is the existing reader, unchanged, so its
// output is the same as before this input existed: no strength, no set. "all" adds the angles as targets,
// lists every aspect of the 17-aspect set ranked by strength, and says which set it is.
export function readAspects(input: AspectInput, set: AspectSet, listLimit: number): AspectSummary {
  if (set === "major") {
    return aspectSummary(majorAspects(input.bodies), listLimit);
  }
  const points: Array<readonly [AspectPoint, number]> = [
    ...input.bodies.map(({ code, longitude }) => [code, longitude] as const),
    ["ASC", input.angles.ASC],
    ["MC", input.angles.MC],
  ];
  const aspects: ListedAspect[] = pairAspects(points, allSetLimits()).map((found) => ({
    a: found.a,
    b: found.b,
    type: found.aspect,
    deviation: found.orb,
    strength: found.strength,
  }));
  return { ...aspectSummary(aspects, listLimit), set: "all" };
}
