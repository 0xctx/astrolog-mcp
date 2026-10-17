// The shared chart contract. Every module codes against this file; do not edit it in isolation.
// Every position in Positions and SkyPositions comes from an astrolog run. Nothing here computes
// an ephemeris.

// Object codes: astrolog's short names for the bodies. Mak is Makemake. Nor is the mean lunar
// node under the default pins; a different pin would change what Nor means.
export const OBJECT_CODES = [
  "Sun",
  "Moo",
  "Mer",
  "Ven",
  "Mar",
  "Jup",
  "Sat",
  "Ura",
  "Nep",
  "Plu",
  "Chi",
  "Nor",
  "Cer",
  "Pal",
  "Jun",
  "Ves",
  "Eri",
  "Hau",
  "Mak",
  "Sed",
] as const;

export type ObjectCode = (typeof OBJECT_CODES)[number];

// House systems and their astrolog `-c` numbers. Nothing else may hard-code these numbers.
export const HOUSE_SYSTEMS = {
  placidus: 0,
  koch: 1,
  equal: 2,
  campanus: 3,
  regiomontanus: 5,
  porphyry: 6,
  whole_sign: 14,
} as const;

export type HouseSystem = keyof typeof HOUSE_SYSTEMS;

export const DEFAULT_HOUSE_SYSTEM: HouseSystem = "placidus";

// The sidereal ayanamsas. Each is offered only once measured on the pinned binary. Its astrolog name
// is in src/astrolog/zodiac.ts, a record that the typecheck requires
// to name every value here.
export const SIDEREAL_AYANAMSAS = ["lahiri", "fagan_bradley", "raman", "krishnamurti"] as const;

export type SiderealAyanamsa = (typeof SIDEREAL_AYANAMSAS)[number];

// The zodiac: tropical, or one of the sidereal ayanamsas.
export const AYANAMSAS = ["tropical", ...SIDEREAL_AYANAMSAS] as const;

export type Ayanamsa = (typeof AYANAMSAS)[number];

export const DEFAULT_AYANAMSA: Ayanamsa = "tropical";

export const HOUSE_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export type HouseNumber = (typeof HOUSE_NUMBERS)[number];

export const ANGLE_CODES = ["ASC", "MC", "DSC", "IC"] as const;

export type AngleCode = (typeof ANGLE_CODES)[number];

// The two composite kinds: "composite" is astrolog's -rc, "davison" is its -rm.
export const COMPOSITE_KINDS = ["composite", "davison"] as const;

export type CompositeKind = (typeof COMPOSITE_KINDS)[number];

// A moment in UT with a required trailing Z: "1990-06-15T19:30:00Z". The type checks the shape
// only. validateChartInput, validateSkyInput and validateCompositeInput call validateUtc, which
// checks that the date and time exist.
export type UtcMoment = `${number}-${number}-${number}T${number}:${number}:${number}Z`;

// Latitude in unsigned degrees, 0 to 90, with the hemisphere letter. The adapter applies the sign.
export interface Latitude {
  degrees: number;
  hemisphere: "N" | "S";
}

// Longitude in unsigned degrees, 0 to 180, with the hemisphere letter. The adapter applies the
// sign.
export interface Longitude {
  degrees: number;
  hemisphere: "E" | "W";
}

// Where the numbers came from. `source` is "stub" for StubEngine, so nobody reads its values as
// data; the stub's astrologVersion says the same in words.
export interface Provenance {
  // The astrolog version reported by `-H`.
  astrologVersion: string;
  source: "astrolog" | "stub";
  // The moment the positions are for, in UT.
  utc: UtcMoment;
  // The zodiac the run used: the value the engine was given, "tropical" for a default call and for
  // the stub. Every result names its zodiac here, so a reader can refuse two results that differ.
  ayanamsa: Ayanamsa;
}

// Provenance for a composite. A composite has no moment of its own, so `inputUtc` lists the two
// birth moments in the order a, b. Only a davison has a `utc`: the UT midpoint of the two moments,
// rounded to the second with half a second rounding up. `ayanamsa` is the zodiac the composite is in.
export type CompositeProvenance = {
  astrologVersion: string;
  source: "astrolog" | "stub";
  inputUtc: [UtcMoment, UtcMoment];
  ayanamsa: Ayanamsa;
} & (
  | { kind: "composite"; utc?: undefined }
  | { kind: "davison"; utc: UtcMoment }
);

export interface ChartInput {
  // Birth moment in UT.
  utc: UtcMoment;
  latitude: Latitude;
  longitude: Longitude;
  // Omitted means DEFAULT_HOUSE_SYSTEM. Positions.housesFrom says which system astrolog used.
  houseSystem?: HouseSystem;
  // Omitted means DEFAULT_AYANAMSA, the tropical zodiac. A sidereal value shifts every longitude
  // by the ayanamsa, as astrolog computes it for the moment.
  ayanamsa?: Ayanamsa;
  // Omitted means every ObjectCode. When given, it is non-empty with no repeats, and
  // Positions.bodies holds only these codes.
  bodies?: ObjectCode[];
}

// One person's birth data in a composite: the moment and the place, and nothing else. The
// houseSystem, ayanamsa and bodies of a composite belong on CompositeInput, and
// validateCompositeInput rejects them on a or b.
export type Birth = Omit<ChartInput, "houseSystem" | "ayanamsa" | "bodies">;

// A moment with no place: the sky at one UT moment, for transits.
export interface SkyInput {
  utc: UtcMoment;
  // Omitted means DEFAULT_AYANAMSA. Same rules as ChartInput.ayanamsa.
  ayanamsa?: Ayanamsa;
  // Omitted means every ObjectCode. Same rules as ChartInput.bodies.
  bodies?: ObjectCode[];
}

// Two charts merged by astrolog. The composite's own houseSystem and bodies are the only ones
// read; a and b carry birth data only.
export interface CompositeInput {
  a: Birth;
  b: Birth;
  kind: CompositeKind;
  // Omitted means DEFAULT_HOUSE_SYSTEM. Same rules as ChartInput.houseSystem.
  houseSystem?: HouseSystem;
  // Omitted means DEFAULT_AYANAMSA. Same rules as ChartInput.ayanamsa.
  ayanamsa?: Ayanamsa;
  // Omitted means every ObjectCode. Same rules as ChartInput.bodies.
  bodies?: ObjectCode[];
}

// A place produced by resolvePlace, after lookup or explicit coordinates.
export interface Place {
  // The name the user gave, such as "Austin, TX". Shown back; never used for a lookup here.
  name: string;
  latitude: Latitude;
  longitude: Longitude;
  // IANA zone name, such as "America/Chicago".
  timezone: string;
}

// A birth moment as the user gave it, in the place's local time, before conversion to UT.
export interface LocalMoment {
  // Calendar date in the place's zone, "YYYY-MM-DD".
  date: string;
  // Clock time in the place's zone, "HH:MM" or "HH:MM:SS".
  time: string;
  // IANA zone name that date and time are in.
  timezone: string;
}

// A body's position at a moment, without a place.
export interface SkyBody {
  // Ecliptic longitude in degrees, 0 up to but not including 360.
  longitude: number;
  // Degrees per day, from astrolog's ObjDir.
  speed: number;
  // True exactly when speed < 0.
  retrograde: boolean;
}

// A body in a chart: a sky position plus the house it falls in.
export type Body = SkyBody & {
  // House from astrolog's ObjHouse, under Positions.housesFrom.
  house: HouseNumber;
};

// The fields every chart result shares. Each result adds its own provenance.
interface ChartFields {
  // Only the requested bodies appear. A body that is absent was either not requested or is in
  // `missing`.
  bodies: Partial<Record<ObjectCode, Body>>;
  // House cusps in ecliptic longitude degrees, 0 up to but not including 360.
  houses: Record<HouseNumber, number>;
  // Angles in ecliptic longitude degrees, 0 up to but not including 360. ASC is cusp 1 in every
  // system except whole_sign, where cusp 1 is 0 degrees of the sign that holds ASC. MC, IC and DSC
  // sit on cusps 10, 4 and 7 for placidus, koch, campanus, regiomontanus and porphyry only; for
  // equal and whole_sign they are not guaranteed to sit there.
  angles: Record<AngleCode, number>;
  // Requested codes astrolog did not compute, for example an asteroid whose file is absent.
  // Empty when every requested code was computed.
  missing: ObjectCode[];
  // The house system astrolog actually used for the houses and bodies. Astrolog falls back to
  // Porphyry for Placidus and Koch beyond about 66 degrees latitude, so this can differ from the
  // request.
  housesFrom: HouseSystem;
}

export interface Positions extends ChartFields {
  provenance: Provenance;
}

// The result of Engine.composite. It is its own type, so a single chart's Positions does not
// carry a union of provenance shapes.
export interface CompositePositions extends ChartFields {
  provenance: CompositeProvenance;
}

export interface SkyPositions {
  // Only the requested bodies appear. A body that is absent was either not requested or is in
  // `missing`.
  bodies: Partial<Record<ObjectCode, SkyBody>>;
  // Requested codes astrolog did not compute. Empty when every requested code was computed.
  missing: ObjectCode[];
  provenance: Provenance;
}

// Every Engine method returns astrolog's numbers and rejects only with AstroError. A real
// implementation calls the matching validator first, so a missing or malformed field is an
// AstroError and not a TypeError.
export interface Engine {
  cast(input: ChartInput): Promise<Positions>;
  sky(input: SkyInput): Promise<SkyPositions>;
  composite(input: CompositeInput): Promise<CompositePositions>;
}

// The one error an Engine rejects with. `fix` is one line that tells the caller what to change.
export class AstroError extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
    this.name = "AstroError";
  }
}

// Throws AstroError for input that the contract cannot express as a valid chart.
export function validateChartInput(input: ChartInput): void {
  requireObject(input, "input");
  validateBirth(input, "input");
  validateHouseSystem(input.houseSystem, "input.houseSystem");
  validateAyanamsa(input.ayanamsa, "input.ayanamsa");
  validateBodies(input.bodies, "input.bodies");
}

// Throws AstroError for a sky request the contract cannot express.
export function validateSkyInput(input: SkyInput): void {
  requireObject(input, "input");
  validateUtc(input.utc, "input.utc");
  validateAyanamsa(input.ayanamsa, "input.ayanamsa");
  validateBodies(input.bodies, "input.bodies");
}

// Throws AstroError for a composite the contract cannot express. a and b must be birth data only.
export function validateCompositeInput(input: CompositeInput): void {
  requireObject(input, "input");
  validateBirthOnly(input.a, "a");
  validateBirthOnly(input.b, "b");
  if (!(COMPOSITE_KINDS as readonly unknown[]).includes(input.kind)) {
    throw new AstroError(
      `kind must be "composite" or "davison", got ${show(input.kind)}`,
      'Set kind to "composite" for astrolog -rc, or "davison" for -rm.',
    );
  }
  validateHouseSystem(input.houseSystem, "input.houseSystem");
  validateAyanamsa(input.ayanamsa, "input.ayanamsa");
  validateBodies(input.bodies, "input.bodies");
}

// A composite's a and b carry birth data only. houseSystem, ayanamsa and bodies belong on the composite.
function validateBirthOnly(birth: Birth, name: string): void {
  requireObject(birth, name);
  const { houseSystem, bodies, ayanamsa } = birth as Partial<Pick<ChartInput, "houseSystem" | "bodies" | "ayanamsa">>;
  if (houseSystem !== undefined || bodies !== undefined) {
    throw new AstroError(
      `${name} sets houseSystem or bodies, which only the composite takes`,
      `Move houseSystem and bodies up to the composite input and remove them from ${name}.`,
    );
  }
  if (ayanamsa !== undefined) {
    throw new AstroError(
      `${name} sets ayanamsa, which only the composite takes`,
      `Move ayanamsa up to the composite input and remove it from ${name}.`,
    );
  }
  validateBirth(birth, name);
}

// The moment and the place, shared by a chart and by a composite's a and b.
function validateBirth(birth: Birth, name: string): void {
  requireObject(birth, name);
  validateUtc(birth.utc, `${name}.utc`);
  validateLatitude(birth.latitude, `${name}.latitude`);
  validateLongitude(birth.longitude, `${name}.longitude`);
}

function validateLatitude(latitude: Latitude, path: string): void {
  requireObject(latitude, path);
  validateDegrees(latitude.degrees, `${path}.degrees`, 90);
  if (latitude.hemisphere !== "N" && latitude.hemisphere !== "S") {
    throw new AstroError(
      `${path}.hemisphere must be N or S, got ${show(latitude.hemisphere)}`,
      `Set ${path}.hemisphere to "N" or "S".`,
    );
  }
}

function validateLongitude(longitude: Longitude, path: string): void {
  requireObject(longitude, path);
  validateDegrees(longitude.degrees, `${path}.degrees`, 180);
  if (longitude.hemisphere !== "E" && longitude.hemisphere !== "W") {
    throw new AstroError(
      `${path}.hemisphere must be E or W, got ${show(longitude.hemisphere)}`,
      `Set ${path}.hemisphere to "E" or "W".`,
    );
  }
}

// Throws AstroError unless value is an object. A missing field must stop here, not reach a read.
function requireObject(value: unknown, path: string): void {
  if (typeof value !== "object" || value === null) {
    throw new AstroError(
      `${path} must be an object, got ${show(value)}`,
      `Pass ${path} as an object with its fields set.`,
    );
  }
}

// Shows a bad value in a message. Strings are quoted; other values show their value or their type.
function show(value: unknown): string {
  if (typeof value === "string") {
    return `"${value}"`;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === undefined || value === null) {
    return String(value);
  }
  return typeof value;
}

const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const UTC_FIX =
  'Write the moment in UT as "YYYY-MM-DDTHH:MM:SSZ", for example "1990-06-15T19:30:00Z".';

// The pattern checks the digits. The round trip through Date rejects dates that do not exist,
// such as February 30, and times such as 24:00:00.
function validateUtc(utc: unknown, path: string): void {
  if (!isRealUtc(utc)) {
    throw new AstroError(`${path} must be a real UT moment ending in Z, got ${show(utc)}`, UTC_FIX);
  }
}

function isRealUtc(utc: unknown): utc is UtcMoment {
  if (typeof utc !== "string" || !UTC_PATTERN.test(utc)) {
    return false;
  }
  const date = new Date(utc);
  return !Number.isNaN(date.getTime()) && date.toISOString() === utc.replace(/Z$/, ".000Z");
}

function validateDegrees(degrees: unknown, path: string, max: number): void {
  if (typeof degrees !== "number" || !Number.isFinite(degrees) || degrees < 0 || degrees > max) {
    throw new AstroError(
      `${path} must be a number from 0 to ${max}, got ${show(degrees)}`,
      `Give ${path} as unsigned degrees from 0 to ${max}, and set the hemisphere letter.`,
    );
  }
}

function validateHouseSystem(houseSystem: unknown, path: string): void {
  if (houseSystem === undefined) {
    return;
  }
  if (typeof houseSystem !== "string" || !Object.hasOwn(HOUSE_SYSTEMS, houseSystem)) {
    const names = Object.keys(HOUSE_SYSTEMS).join(", ");
    throw new AstroError(
      `${path} must be one of ${names}, got ${show(houseSystem)}`,
      `Use one of ${names}, or omit ${path} for ${DEFAULT_HOUSE_SYSTEM}.`,
    );
  }
}

function validateAyanamsa(ayanamsa: unknown, path: string): void {
  if (ayanamsa === undefined) {
    return;
  }
  if (typeof ayanamsa !== "string" || !(AYANAMSAS as readonly string[]).includes(ayanamsa)) {
    const names = AYANAMSAS.join(", ");
    throw new AstroError(
      `${path} must be one of ${names}, got ${show(ayanamsa)}`,
      `Use one of ${names}, or omit ${path} for ${DEFAULT_AYANAMSA}.`,
    );
  }
}

function validateBodies(bodies: unknown, path: string): void {
  if (bodies === undefined) {
    return;
  }
  if (!Array.isArray(bodies)) {
    throw new AstroError(
      `${path} must be a list of object codes, got ${show(bodies)}`,
      `Pass a list such as ["Sun", "Moo"], or omit ${path} for every object code.`,
    );
  }
  if (bodies.length === 0) {
    throw new AstroError(
      `${path} must name at least one object code`,
      `Omit ${path} to get every object code, or list codes such as Sun and Moo.`,
    );
  }
  for (const code of bodies) {
    if (typeof code !== "string" || !(OBJECT_CODES as readonly string[]).includes(code)) {
      throw new AstroError(
        `unknown object code ${show(code)} in ${path}`,
        `Use one of the object codes, for example Sun or Moo: ${OBJECT_CODES.join(", ")}.`,
      );
    }
  }
  if (new Set(bodies).size !== bodies.length) {
    throw new AstroError(
      `${path} lists the same object code more than once`,
      "List each object code once, or omit it.",
    );
  }
}
