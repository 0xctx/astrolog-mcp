import { IANAZone } from "luxon";
import { z } from "zod";
import { MAX_HARMONIC } from "../math.js";
import {
  AstroError,
  AYANAMSAS,
  DEFAULT_AYANAMSA,
  type Ayanamsa,
  DEFAULT_HOUSE_SYSTEM,
  HOUSE_SYSTEMS,
  OBJECT_CODES,
  SIDEREAL_AYANAMSAS,
  type HouseSystem,
  type Latitude,
  type Longitude,
  type ObjectCode,
  type Place,
  type UtcMoment,
} from "../types.js";
import { BODY_NAMES, formatLatitude, formatLongitudeCoordinate } from "./format.js";
import type { ToolDeps } from "./deps.js";

export const HOUSE_SYSTEM_NAMES = Object.keys(HOUSE_SYSTEMS) as [HouseSystem, ...HouseSystem[]];

// Other names people use for an object, added after its own name. Only accepted codes appear here.
const BODY_SYNONYMS: Partial<Record<ObjectCode, string>> = { Nor: "North Node" };

// The object codes with their names, so a caller can tell Moo from Moon in the description.
export const OBJECT_CODE_LIST = OBJECT_CODES.map((code) => {
  const names = [BODY_NAMES[code], BODY_SYNONYMS[code]].filter((name) => name !== undefined && name !== code);
  return names.length > 0 ? `${code} (${names.join(", ")})` : code;
});

// YYYY-MM-DD and 24-hour HH:MM. Whether the date exists is checked by isRealDate, not by the pattern.
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// True for a date that exists, such as 2000-06-15. 2000-02-30 is refused.
export function isRealDate(text: string): boolean {
  const [year = NaN, month = NaN, day = NaN] = text.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// True for an IANA zone name such as America/Chicago. luxon's setZone also takes "local", "system"
// and "UTC+5", which are not stable zone names, so this asks IANAZone alone, as the real toUtc does.
export function isKnownZone(name: string): boolean {
  return IANAZone.isValidZone(name);
}

// The birth fields every tool that names a person or a moment takes: a moment in the place's local
// time, and a place as a name or as explicit coordinates.
export const birthShape = {
  birth_date: z
    .string({ error: "Give the birth date as YYYY-MM-DD, for example 1990-06-15." })
    .regex(DATE_PATTERN, "Write the birth date as YYYY-MM-DD, for example 1990-06-15.")
    .refine(isRealDate, "Give the birth date as a date that exists, such as 1990-06-15.")
    .describe("Birth date in the local calendar of the birth place, as YYYY-MM-DD, for example 1990-06-15."),
  birth_time: z
    .string({ error: "Give the birth time as 24-hour HH:MM, for example 19:30." })
    .regex(TIME_PATTERN, "Write the birth time as 24-hour HH:MM, for example 19:30.")
    .describe("Birth clock time in the local time of the birth place, 24-hour HH:MM, for example 19:30."),
  place: z
    .string()
    .min(1, "Give a place name such as Austin, TX, or leave the place out.")
    .max(200, "Shorten the place name to 200 characters or fewer.")
    .optional()
    .describe(
      "Birth place to look up, as a name like 'Austin, TX', or one of these shorthands, which stand alone with no region or country: 'NYC', 'New York', 'LA', 'L.A.', 'SF', 'San Fran', 'DC', 'Philly', 'Vegas', 'Peking' or 'Saigon'. Give this or latitude, longitude and timezone, not both. Anything else must be a place name in the GeoNames table, or latitude, longitude and time zone given directly.",
    ),
  latitude: z
    .number()
    .min(-90, "Give latitude from -90 to 90 in signed decimal degrees.")
    .max(90, "Give latitude from -90 to 90 in signed decimal degrees.")
    .optional()
    .describe(
      "Birth latitude in signed decimal degrees, north positive, for example 30.2672. Give with longitude and timezone instead of place.",
    ),
  longitude: z
    .number()
    .min(-180, "Give longitude from -180 to 180 in signed decimal degrees.")
    .max(180, "Give longitude from -180 to 180 in signed decimal degrees.")
    .optional()
    .describe(
      "Birth longitude in signed decimal degrees, east positive, for example -97.7431. Give with latitude and timezone instead of place.",
    ),
  timezone: z
    .string()
    .min(1, "Give the time zone as an IANA time zone name such as America/Chicago.")
    .max(64, "Give the time zone as an IANA time zone name such as America/Chicago.")
    .refine(isKnownZone, "Give the time zone as an IANA time zone name such as America/Chicago.")
    .optional()
    .describe(
      "IANA time zone name for the birth time, such as America/Chicago, America/New_York, America/Los_Angeles, or Europe/London. Give with latitude and longitude instead of place.",
    ),
};

export const birthSchema = z.strictObject(birthShape);

export type BirthArgs = z.infer<typeof birthSchema>;

// The rules that span the birth fields: a place or all three coordinates, not both. Each message is
// also the fix line the caller sees.
export function birthRule<T extends BirthArgs>(input: T, ctx: z.core.$RefinementCtx<T>): void {
  const hasCoordinates =
    input.latitude !== undefined || input.longitude !== undefined || input.timezone !== undefined;
  const hasAllCoordinates =
    input.latitude !== undefined && input.longitude !== undefined && input.timezone !== undefined;
  if (input.place !== undefined && hasCoordinates) {
    ctx.addIssue({
      code: "custom",
      path: ["place"],
      message: "Give a place, or latitude, longitude and time zone, not both.",
      input: input.place,
    });
  } else if (input.place === undefined && !hasAllCoordinates) {
    ctx.addIssue({
      code: "custom",
      path: [],
      message: "Give a place, or all three of latitude, longitude and time zone.",
      input,
    });
  }
}

// What people call each value, for the descriptions. These names are not accepted as values themselves.
export const HOUSE_SYSTEM_SYNONYMS: Record<HouseSystem, string> = {
  placidus: "Placidus, Plac",
  koch: "Koch, birthplace houses, GOH",
  equal: "Equal house, equal from the Ascendant",
  campanus: "Campanus, Camp",
  regiomontanus: "Regiomontanus, Regio",
  porphyry: "Porphyry, Porph",
  whole_sign: "Whole Sign, whole-sign houses, sign houses, WSH",
};

export const AYANAMSA_SYNONYMS: Record<Ayanamsa, string> = {
  tropical: "Western, sayana",
  lahiri: "Lahiri, Chitra Paksha, Indian national ayanamsa",
  fagan_bradley: "Fagan-Bradley, Fagan/Bradley, Western sidereal",
  raman: "Raman, B. V. Raman",
  krishnamurti: "Krishnamurti, KP, K.P.",
};

// The sentence that maps each accepted value to the names people use for it, so a caller passes the
// value: "Pass the value even when a person uses another name for it: placidus is also called Placidus or Plac; …".
export function namesPeopleUse(synonyms: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(synonyms).map(([value, names]) => `${value} is also called ${orList(names.split(", "))}`);
  return `Pass the value even when a person uses another name for it: ${pairs.join("; ")}.`;
}

export const houseSystemField = z
  .enum(HOUSE_SYSTEM_NAMES, {
    error: `Give the house system as one of ${HOUSE_SYSTEM_NAMES.join(", ")}.`,
  })
  .default(DEFAULT_HOUSE_SYSTEM)
  .describe(
    `House system that sets the house cusps: one of ${HOUSE_SYSTEM_NAMES.join(", ")}. Leave out for ${DEFAULT_HOUSE_SYSTEM}. ${namesPeopleUse(HOUSE_SYSTEM_SYNONYMS)}`,
  );

// The sidereal names in a sentence: "lahiri, fagan_bradley, raman or krishnamurti".
function orList(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names.join("");
}

// The values as the tool descriptions say them, from the same list the schema uses. The descriptions
// test reads this sentence back and checks it names exactly the sidereal values.
export const AYANAMSA_CHOICES = `tropical by default, or ${orList(SIDEREAL_AYANAMSAS)} for sidereal longitudes`;

// The zodiac the positions are in: tropical by default, or a sidereal ayanamsa. Each tool adds the
// field under the name `ayanamsa`, and the value is always set after parsing, so a default call
// reaches the engine with "tropical".
export const ayanamsaField = z
  .enum(AYANAMSAS, { error: `Give the zodiac as one of ${AYANAMSAS.join(", ")}.` })
  .default(DEFAULT_AYANAMSA)
  .describe(
    `Zodiac for the positions: ${AYANAMSAS.join(", ")}. Leave out for ${DEFAULT_AYANAMSA}. A sidereal value such as lahiri gives sidereal longitudes, with the ayanamsa subtracted from the tropical ones. ${namesPeopleUse(AYANAMSA_SYNONYMS)}`,
  );

const HARMONIC_FIX = `Give the harmonic as a whole number from 1 to ${MAX_HARMONIC}, for example 5.`;

// A harmonic H: a whole number from 1 to MAX_HARMONIC. Each tool adds its own default and description.
export const harmonicNumber = harmonicNumberWith(HARMONIC_FIX, MAX_HARMONIC);

// The same field with its own refusal text and top, for a tool whose range is not 1 to MAX_HARMONIC.
export function harmonicNumberWith(fix: string, max: number) {
  return z.number({ error: fix }).int(fix).min(1, fix).max(max, fix);
}

// A list of object codes, each once. `purpose` says what the list selects, then the codes follow.
export function objectCodesField(purpose: string) {
  return z
    .array(z.enum(OBJECT_CODES, { error: `Give each body as one of the object codes ${OBJECT_CODES.join(", ")}.` }))
    .min(1, "List at least one object code, or leave the bodies out for all of them.")
    .max(OBJECT_CODES.length, `List at most ${OBJECT_CODES.length} object codes.`)
    .optional()
    .describe(`${purpose} Codes: ${OBJECT_CODE_LIST.join(", ")}. Leave out for all of them.`);
}

// Rejects a list that names the same object code twice, with the fix line the caller sees.
export function repeatedCodeRule<T extends { bodies?: readonly string[] | undefined }>(
  input: T,
  ctx: z.core.$RefinementCtx<T>,
): void {
  const { bodies } = input;
  if (bodies !== undefined && new Set(bodies).size !== bodies.length) {
    ctx.addIssue({
      code: "custom",
      path: ["bodies"],
      message: "List each object code once, or leave the bodies out.",
      input: bodies,
    });
  }
}

// The place and the UT moment of one birth. A place name goes to the lookup; explicit coordinates
// are used as they are.
export async function resolveBirth(birth: BirthArgs, deps: ToolDeps): Promise<{ place: Place; utc: UtcMoment }> {
  const place = birth.place !== undefined ? await deps.resolvePlace(birth.place) : explicitPlace(birth);
  const utc = deps.toUtc({ date: birth.birth_date, time: birth.birth_time, timezone: place.timezone });
  return { place, utc };
}

function explicitPlace(birth: BirthArgs): Place {
  const { latitude, longitude, timezone } = birth;
  if (latitude === undefined || longitude === undefined || timezone === undefined) {
    throw new AstroError(
      "latitude, longitude and time zone must all be given without a place",
      "Give a place, or all three of latitude, longitude and time zone.",
    );
  }
  const latitudeValue: Latitude = { degrees: Math.abs(latitude), hemisphere: latitude < 0 ? "S" : "N" };
  const longitudeValue: Longitude = {
    degrees: Math.abs(longitude),
    hemisphere: longitude < 0 ? "W" : "E",
  };
  return {
    name: `${formatLatitude(latitudeValue)} ${formatLongitudeCoordinate(longitudeValue)}`,
    latitude: latitudeValue,
    longitude: longitudeValue,
    timezone,
  };
}
