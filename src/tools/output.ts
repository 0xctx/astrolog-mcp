import { z } from "zod";
import { VIBRATIONAL_ASPECTS } from "../math.js";
import {
  ANGLE_CODES,
  HOUSE_NUMBERS,
  OBJECT_CODES,
  SIDEREAL_AYANAMSAS,
  type AngleCode,
  type Ayanamsa,
  type Body,
  type HouseNumber,
  type ObjectCode,
  type Place,
  type SiderealAyanamsa,
} from "../types.js";
import {
  ANGLE_NAMES,
  BODY_NAMES,
  formatDegreesMinutes,
  formatLatitude,
  formatLongitude,
  formatLongitudeCoordinate,
} from "./format.js";

// The major aspects and their orbs in degrees. Two bodies form an aspect when their separation is
// within `orb` of `angle`. A pair matches at most one type, because no two windows overlap. The "all"
// set reads these five too, with the wider of this orb and 16 ÷ harmonic (see aspect-list.ts).
export const ASPECT_TABLE = {
  conjunction: { angle: 0, orb: 8 },
  opposition: { angle: 180, orb: 8 },
  trine: { angle: 120, orb: 6 },
  square: { angle: 90, orb: 6 },
  sextile: { angle: 60, orb: 4 },
} as const;

export type AspectType = keyof typeof ASPECT_TABLE;

// The aspects a chart or composite lists before it says it was cut.
export const ASPECT_LIST_LIMIT = 8;

// The points an aspect can join: every body, then the angles ASC and MC. Only the "all" set reads the angles.
export const ASPECT_POINT_CODES = [...OBJECT_CODES, "ASC", "MC"] as const;

export type AspectPoint = (typeof ASPECT_POINT_CODES)[number];

// The names of the 17 vibrational aspects, which the "all" set reads. The "major" set is a subset. Every tool that names an
// aspect in its output takes this list, so the names are defined once.
export const ALL_ASPECT_NAMES = VIBRATIONAL_ASPECTS.map((type) => type.key) as [string, ...string[]];

// A longitude in sign, degree and whole minute, with its text and the raw longitude.
export const signedPosition = {
  sign: z.string().describe("Zodiac sign name, such as Gemini."),
  degree: z.number().int().min(0).max(29).describe("Whole degree within the sign, 0 to 29."),
  minute: z.number().int().min(0).max(59).describe("Whole arcminute within the degree, 0 to 59."),
  text: z.string().describe("Position as text, such as 24°14′ Gemini."),
  longitude: z.number().min(0).max(360).describe("Ecliptic longitude in decimal degrees, 0 up to 360."),
};

export const bodyOutput = z.object({
  code: z.enum(OBJECT_CODES).describe("Object code, such as Sun or Moo."),
  name: z.string().describe("Common name of the body, such as Moon."),
  ...signedPosition,
  retrograde: z.boolean().describe("True when the body moves backward in the zodiac at this moment, from its speed."),
  house: z.number().int().min(1).max(12).describe("House the body falls in, 1 to 12, under housesFrom."),
});

export const houseOutput = z.object({
  house: z.number().int().min(1).max(12).describe("House number, 1 to 12."),
  ...signedPosition,
});

export const angleOutput = z.object({
  code: z.enum(ANGLE_CODES).describe("Angle code: ASC, MC, DSC or IC."),
  name: z.string().describe("Name of the angle, such as Ascendant."),
  ...signedPosition,
});

export const aspectOutput = z.object({
  a: z.enum(ASPECT_POINT_CODES).describe("First point's code: an object code, or ASC or MC for an angle."),
  b: z.enum(ASPECT_POINT_CODES).describe("Second point's code: an object code, or ASC or MC for an angle."),
  type: z.enum(ALL_ASPECT_NAMES).describe("Aspect name, from the set the call asked for."),
  orb: z.number().min(0).describe("Distance from exact, in decimal degrees to two places."),
  strength: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Only when aspects is all: 1 at exact, 0 at the edge of the aspect's orb, to two places. Left out for major."),
  text: z.string().describe("Aspect as text, such as Sun square Moon, orb 1°05′."),
});

// The aspect list a chart or composite shares: the listed items, the total and the cut flag.
// `owner` names what has the aspects, such as "the chart", in the total's description.
export function aspectSummaryOutput(owner: string) {
  return z.object({
    items: z
      .array(aspectOutput)
      .describe("The listed aspects, ranked as the set says: tightest orb first for major, and by strength for all."),
    total: z.number().int().min(0).describe(`How many aspects ${owner} has in all, in the set the call asked for.`),
    truncated: z.boolean().describe("True when items is shorter than total."),
    set: z
      .literal("all")
      .optional()
      .describe("Only when aspects is all: the set that produced the list. Left out for major."),
  });
}

export type AspectSummary = z.infer<ReturnType<typeof aspectSummaryOutput>>;

// The sidereal ayanamsa a result is in. It is left out of meta for the tropical zodiac, so a default
// result has the same fields it always had. The type holds only sidereal names, so "tropical" can
// never appear here.
export const ayanamsaOutput = z
  .enum(SIDEREAL_AYANAMSAS)
  .optional()
  .describe("Sidereal ayanamsa the positions are in, such as lahiri. Left out for the tropical zodiac.");

// The meta key for the zodiac: nothing for tropical, the name for a sidereal value. Callers pass the
// zodiac a result carries in its provenance, not the value the request asked for.
export function ayanamsaMeta(ayanamsa: Ayanamsa): { ayanamsa?: SiderealAyanamsa } {
  return ayanamsa === "tropical" ? {} : { ayanamsa };
}

export const placeOutput = z.object({
  name: z.string().describe("Place name, or the coordinates when no name was given."),
  latitude: z.string().describe("Latitude with its letter, such as 30°16′N."),
  longitude: z.string().describe("Longitude with its letter, such as 97°44′W."),
  timezone: z.string().describe("IANA time zone name used for the birth time."),
});

export interface Positioned {
  code: ObjectCode;
  longitude: number;
}

export interface Aspect {
  a: ObjectCode;
  b: ObjectCode;
  type: AspectType;
  // Distance from exact in degrees, unrounded. Ranking uses this so rounding cannot reorder it.
  deviation: number;
}

// Every major aspect between the given bodies, tightest first. Ties keep the input order: the
// earlier pair, then the table order of aspect types.
export function majorAspects(bodies: Positioned[]): Aspect[] {
  const found: Aspect[] = [];
  bodies.forEach((first, i) => {
    bodies.slice(i + 1).forEach((second) => {
      const apart = Math.abs(first.longitude - second.longitude) % 360;
      const separation = Math.min(apart, 360 - apart);
      for (const type of Object.keys(ASPECT_TABLE) as AspectType[]) {
        const { angle, orb } = ASPECT_TABLE[type];
        const deviation = Math.abs(separation - angle);
        if (deviation <= orb) {
          found.push({ a: first.code, b: second.code, type, deviation });
        }
      }
    });
  });
  return found.sort((x, y) => x.deviation - y.deviation);
}

export type AspectItem = z.infer<typeof aspectOutput>;

// An aspect as the summary reads it: its two points, its name and its distance from exact. Both sets produce this.
// Only the "all" set has a strength; a listed aspect without one gets no strength key.
export interface ListedAspect {
  a: AspectPoint;
  b: AspectPoint;
  type: string;
  deviation: number;
  strength?: number;
}

// A body's name, or an angle's, for the text of an aspect.
function pointName(code: AspectPoint): string {
  return code === "ASC" || code === "MC" ? ANGLE_NAMES[code] : BODY_NAMES[code];
}

function aspectOutputOf(aspect: ListedAspect): AspectItem {
  // Rounded to the arcminute, so the number and the text name the same orb.
  const arcminutes = Math.round(aspect.deviation * 60);
  const orbText = formatDegreesMinutes(arcminutes / 60);
  return {
    a: aspect.a,
    b: aspect.b,
    type: aspect.type,
    orb: Math.round((arcminutes / 60) * 100) / 100,
    ...(aspect.strength === undefined ? {} : { strength: Math.round(aspect.strength * 100) / 100 }),
    text: `${pointName(aspect.a)} ${aspect.type} ${pointName(aspect.b)}, orb ${orbText}`,
  };
}

// The first `listLimit` aspects, the total and whether the list was cut. A limit of 0 lists every aspect.
// The aspects arrive already ranked, so this only cuts the list. It does not add `set`; the caller does.
export function aspectSummary(aspects: readonly ListedAspect[], listLimit: number): AspectSummary {
  return cutList(aspects, listLimit, aspectOutputOf);
}

// The first `limit` items, each shaped for the result, with the count in full. A limit of 0 lists every item. Items past the
// limit are never shaped, so a long list costs only what it shows. Every cut list in the results goes through here.
export function cutList<T, U>(
  items: readonly T[],
  limit: number,
  shape: (item: T) => U,
): { items: U[]; total: number; truncated: boolean } {
  const shown = limit === 0 ? items : items.slice(0, limit);
  return { items: shown.map((item) => shape(item)), total: items.length, truncated: shown.length < items.length };
}

export type ShapedBody = z.infer<typeof bodyOutput>;

// The bodies that are present, in object-code order, with their sign and degree.
export function shapeBodies(bodies: Partial<Record<ObjectCode, Body>>): ShapedBody[] {
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
        house: body.house,
        longitude: body.longitude,
      },
    ];
  });
}

export function shapeHouses(houses: Record<HouseNumber, number>): z.infer<typeof houseOutput>[] {
  return HOUSE_NUMBERS.map((house) => ({
    house,
    ...formatLongitude(houses[house]),
    longitude: houses[house],
  }));
}

export function shapeAngles(angles: Record<AngleCode, number>): z.infer<typeof angleOutput>[] {
  return ANGLE_CODES.map((code) => ({
    code,
    name: ANGLE_NAMES[code],
    ...formatLongitude(angles[code]),
    longitude: angles[code],
  }));
}

// The Sun and Moon, then the Ascendant, as plain text. Only the bodies given appear.
export function chartHeadline(bodies: ShapedBody[], ascendant: number): string {
  const parts = bodies
    .filter((body) => body.code === "Sun" || body.code === "Moo")
    .map((body) => `${body.name} ${body.text}`);
  parts.push(`Ascendant ${formatLongitude(ascendant).text}`);
  return parts.join(", ");
}

// The place with its coordinate letters, as the result shows it.
export function placeMeta(place: Place): z.infer<typeof placeOutput> {
  return {
    name: place.name,
    latitude: formatLatitude(place.latitude),
    longitude: formatLongitudeCoordinate(place.longitude),
    timezone: place.timezone,
  };
}
