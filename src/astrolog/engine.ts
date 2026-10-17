import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ALL_OBJECTS } from "../objects.js";
import {
  AstroError,
  DEFAULT_AYANAMSA,
  DEFAULT_HOUSE_SYSTEM,
  HOUSE_NUMBERS,
  validateChartInput,
  validateCompositeInput,
  validateSkyInput,
  type Ayanamsa,
  type Birth,
  type Body,
  type ChartInput,
  type CompositeInput,
  type CompositePositions,
  type Engine,
  type HouseNumber,
  type HouseSystem,
  type ObjectCode,
  type Positions,
  type SkyBody,
  type SkyInput,
  type SkyPositions,
  type UtcMoment,
} from "../types.js";
import { locateBinary, readVersion } from "./binary.js";
import { runExpressions } from "./expressions.js";
import { runSmoke } from "./smoke.js";

// Beyond about 66.56 degrees astrolog falls back to Porphyry for Placidus and Koch. The exact
// limit follows the obliquity, so the engine asks the binary above this latitude instead.
const POLAR_CHECK_LATITUDE = 60;

interface ChartReading {
  bodies: Partial<Record<ObjectCode, Body>>;
  houses: Record<HouseNumber, number>;
  angles: Positions["angles"];
  missing: ObjectCode[];
}

export class AstrologEngine implements Engine {
  private constructor(
    private readonly binary: string,
    private readonly version: string,
  ) {}

  // Locates the binary, reads its version and runs the smoke chart. Rejects with AstroError when
  // any of that fails: the server does not start on a binary it cannot trust.
  static async start(env: NodeJS.ProcessEnv = process.env): Promise<AstrologEngine> {
    const binary = locateBinary(env);
    const dir = await makeDir("astrolog-start-");
    let version: string;
    try {
      version = await readVersion(binary, dir);
    } finally {
      await removeDir(dir);
    }
    await runSmoke(binary, version);
    return new AstrologEngine(binary, version);
  }

  async cast(input: ChartInput): Promise<Positions> {
    validateChartInput(input);
    const houseSystem = input.houseSystem ?? DEFAULT_HOUSE_SYSTEM;
    const ayanamsa = input.ayanamsa ?? DEFAULT_AYANAMSA;
    const codes = input.bodies ?? ALL_OBJECTS;
    const chartArgs = castArgs(input);
    const reading = await this.read(chartArgs, houseSystem, codes, ayanamsa);
    const housesFrom = await this.housesUsed(chartArgs, houseSystem, reading, [input.latitude], ayanamsa);
    return { ...reading, housesFrom, provenance: { astrologVersion: this.version, source: "astrolog", utc: input.utc, ayanamsa } };
  }

  async sky(input: SkyInput): Promise<SkyPositions> {
    validateSkyInput(input);
    const codes = input.bodies ?? ALL_OBJECTS;
    const ayanamsa = input.ayanamsa ?? DEFAULT_AYANAMSA;
    const expressions = codes.flatMap((code) => [`ObjLon O_${code}`, `ObjDir O_${code}`]);
    const values = await runExpressions({
      binary: this.binary,
      chartArgs: qaArgs(input.utc, "0:00:00E", "0:00:00N"),
      houseSystem: DEFAULT_HOUSE_SYSTEM,
      ayanamsa,
      codes,
      expressions,
    });
    const bodies: Partial<Record<ObjectCode, SkyBody>> = {};
    const missing: ObjectCode[] = [];
    codes.forEach((code, i) => {
      const body = skyBody(values[2 * i], values[2 * i + 1]);
      if (body) {
        bodies[code] = body;
      } else {
        missing.push(code);
      }
    });
    return { bodies, missing, provenance: { astrologVersion: this.version, source: "astrolog", utc: input.utc, ayanamsa } };
  }

  async composite(input: CompositeInput): Promise<CompositePositions> {
    validateCompositeInput(input);
    const houseSystem = input.houseSystem ?? DEFAULT_HOUSE_SYSTEM;
    const ayanamsa = input.ayanamsa ?? DEFAULT_AYANAMSA;
    const codes = input.bodies ?? ALL_OBJECTS;
    const dir = await makeDir("astrolog-composite-");
    try {
      for (const [file, birth] of [["a.as", input.a], ["b.as", input.b]] as const) {
        await runExpressions({
          binary: this.binary,
          chartArgs: castArgs(birth),
          afterPins: ["-o", file],
          houseSystem,
          ayanamsa,
          codes: [],
          expressions: [],
          cwd: dir,
        });
      }
      const chartArgs = [input.kind === "composite" ? "-rc" : "-rm", "a.as", "b.as"];
      const reading = await this.read(chartArgs, houseSystem, codes, ayanamsa, dir);
      const housesFrom = await this.housesUsed(
        chartArgs,
        houseSystem,
        reading,
        [input.a.latitude, input.b.latitude],
        ayanamsa,
        dir,
      );
      const base = { astrologVersion: this.version, source: "astrolog" as const, ayanamsa };
      const inputUtc: [UtcMoment, UtcMoment] = [input.a.utc, input.b.utc];
      const provenance =
        input.kind === "composite"
          ? { ...base, kind: "composite" as const, inputUtc }
          : { ...base, kind: "davison" as const, inputUtc, utc: midpoint(input.a.utc, input.b.utc) };
      return { ...reading, housesFrom, provenance };
    } finally {
      await removeDir(dir);
    }
  }

  // Body positions, cusps and angles in one call.
  private async read(
    chartArgs: readonly string[],
    houseSystem: HouseSystem,
    codes: readonly ObjectCode[],
    ayanamsa: Ayanamsa,
    cwd?: string,
  ): Promise<ChartReading> {
    const expressions = [
      ...codes.flatMap((code) => [`ObjLon O_${code}`, `ObjDir O_${code}`, `ObjHouse O_${code}`]),
      ...HOUSE_NUMBERS.map((n) => `Cusp ${n}`),
      "ObjLon O_Asc",
      "ObjLon O_Mid",
    ];
    const values = await runExpressions({ binary: this.binary, chartArgs, houseSystem, ayanamsa, codes, expressions, cwd });
    const bodies: Partial<Record<ObjectCode, Body>> = {};
    const missing: ObjectCode[] = [];
    codes.forEach((code, i) => {
      const [lon, dir, house] = [values[3 * i], values[3 * i + 1], values[3 * i + 2]];
      const sky = skyBody(lon, dir);
      if (sky && house !== undefined && house >= 1 && house <= 12) {
        bodies[code] = { ...sky, house: house as HouseNumber };
      } else {
        missing.push(code);
      }
    });
    const rest = values.slice(3 * codes.length);
    const houses = {} as Record<HouseNumber, number>;
    HOUSE_NUMBERS.forEach((n, i) => {
      houses[n] = degrees(rest[i] as number);
    });
    const asc = degrees(rest[12] as number);
    const mc = degrees(rest[13] as number);
    return { bodies, houses, angles: { ASC: asc, MC: mc, DSC: degrees(asc + 180), IC: degrees(mc + 180) }, missing };
  }

  // The system astrolog used. Placidus and Koch become Porphyry near the poles; the binary is
  // the judge: if the cusps equal a Porphyry run's cusps, that is what was used.
  private async housesUsed(
    chartArgs: readonly string[],
    requested: HouseSystem,
    reading: ChartReading,
    places: readonly { degrees: number }[],
    ayanamsa: Ayanamsa,
    cwd?: string,
  ): Promise<HouseSystem> {
    if ((requested !== "placidus" && requested !== "koch") || places.every((p) => p.degrees <= POLAR_CHECK_LATITUDE)) {
      return requested;
    }
    // The same zodiac as the reading, so the comparison is between cusps in one zodiac.
    const porphyry = await runExpressions({
      binary: this.binary,
      chartArgs,
      houseSystem: "porphyry",
      ayanamsa,
      codes: [],
      expressions: HOUSE_NUMBERS.map((n) => `Cusp ${n}`),
      cwd,
    });
    const same = HOUSE_NUMBERS.every((n, i) => Math.abs(degrees(porphyry[i] as number) - reading.houses[n]) < 1e-6);
    return same ? "porphyry" : requested;
  }
}

async function makeDir(prefix: string): Promise<string> {
  try {
    return await mkdtemp(path.join(tmpdir(), prefix));
  } catch (e) {
    throw new AstroError(
      `could not create a working directory (${(e as NodeJS.ErrnoException).code ?? "error"})`,
      "Make sure the system temp directory exists and is writable.",
    );
  }
}

// A cleanup failure must never replace the error that is already on its way out.
async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

function skyBody(longitude: number | undefined, speed: number | undefined): SkyBody | undefined {
  // A body whose ephemeris does not cover the date comes back as exactly 0 longitude and 0 speed.
  if (longitude === undefined || speed === undefined || (longitude === 0 && speed === 0)) {
    return undefined;
  }
  return { longitude: degrees(longitude), speed, retrograde: speed < 0 };
}

// Degrees folded into 0 up to but not including 360.
function degrees(value: number): number {
  const folded = ((value % 360) + 360) % 360;
  return folded >= 360 ? 0 : folded;
}

// `-qa` arguments for a UT moment: month day year time zone-0 longitude latitude. Astrolog reads
// an unsigned coordinate as west, so every coordinate carries its letter. Before 15 Oct 1582
// astrolog reads the Julian calendar, so the date is converted.
function qaArgs(utc: UtcMoment, longitude: string, latitude: string): string[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(utc);
  if (!match) {
    throw new AstroError(`not a UT moment: ${utc}`, 'Write the moment as "YYYY-MM-DDTHH:MM:SSZ".');
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const [y, m, d] = isBeforeGregorian(year, month, day) ? julianDate(year, month, day) : [year, month, day];
  const clock = `${hour}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  return ["-qa", String(m), String(d), String(y), clock, "0", longitude, latitude];
}

function castArgs(place: Birth): string[] {
  return qaArgs(place.utc, coordinate(place.longitude.degrees, place.longitude.hemisphere), coordinate(place.latitude.degrees, place.latitude.hemisphere));
}

// 73.9 W becomes "73:54:00W".
function coordinate(value: number, hemisphere: "N" | "S" | "E" | "W"): string {
  const total = Math.round(value * 3600);
  const mm = String(Math.floor(total / 60) % 60).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${Math.floor(total / 3600)}:${mm}:${ss}${hemisphere}`;
}

function isBeforeGregorian(year: number, month: number, day: number): boolean {
  return year < 1582 || (year === 1582 && (month < 10 || (month === 10 && day < 15)));
}

// A proleptic Gregorian date as the Julian-calendar (year, month, day).
function julianDate(year: number, month: number, day: number): [number, number, number] {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  const jdn =
    day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  const c = jdn + 32082;
  const dd = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * dd) / 4);
  const mm = Math.floor((5 * e + 2) / 153);
  return [dd - 4800 + Math.floor(mm / 10), mm + 3 - 12 * Math.floor(mm / 10), e - Math.floor((153 * mm + 2) / 5) + 1];
}

// The UT midpoint of two moments, rounded to the second with half a second rounding up.
export function midpoint(a: UtcMoment, b: UtcMoment): UtcMoment {
  const mid = (Date.parse(a) + Date.parse(b)) / 2;
  const seconds = Math.floor(mid / 1000 + 0.5);
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z") as UtcMoment;
}
