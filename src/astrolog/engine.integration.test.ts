import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { aspectType, transitAspects, type AspectLimit } from "../math.js";
import {
  AstroError,
  OBJECT_CODES,
  type Ayanamsa,
  type Birth,
  type ChartInput,
  type Latitude,
  type Longitude,
  type UtcMoment,
} from "../types.js";
import { locateBinary } from "./binary.js";
import { AstrologEngine } from "./engine.js";
import { runExpressions } from "./expressions.js";

// Runs the real binary. Skipped unless ASTROLOG_BIN is set.
const bin = process.env.ASTROLOG_BIN;
const suite = bin ? describe : describe.skip;

// A short base for scratch dirs, so no test depends on how long os.tmpdir() is.
function scratchBase(): string {
  return tmpdir().length <= 20 ? tmpdir() : "/tmp";
}

const west = (degrees: number): Longitude => ({ degrees, hemisphere: "W" });
const north = (degrees: number): Latitude => ({ degrees, hemisphere: "N" });

// READ BEFORE "FIXING" THIS FILE. "15 Jun 1990 14:30 local, UT-5" is 19:30 UT and gives Sun 84.428,
// not the reference 84.23. The reference values (Sun 84.23, Moon 346.75, Ceres 117.92) are
// reproduced by 14:30 UT, so the test uses 14:30 UT (73:54W 40:42N). The composite second chart and
// the transit moment below are not real people's data: they were chosen to reproduce reference
// numbers (32.83, 341.63) and prove the -rc and -rt paths.
const NATAL: ChartInput = {
  utc: "1990-06-15T14:30:00Z",
  latitude: north(40.7),
  longitude: west(73.9),
};

// The reference values are rounded to two decimals, so a rounded value can be off by 0.005; the
// tight 0.001 tolerance applies to the measured values (84.2290, 346.7518) asserted via toBeCloseTo.
const CLOSE = 0.005;

suite("AstrologEngine against the astrolog binary", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("casts the natal reference chart", async () => {
    const engine = await AstrologEngine.start();
    const chart = await engine.cast(NATAL);
    expect(chart.bodies.Sun?.longitude).toBeCloseTo(84.229, 3);
    expect(Math.abs((chart.bodies.Sun?.longitude ?? 0) - 84.23)).toBeLessThan(CLOSE);
    expect(Math.abs((chart.bodies.Moo?.longitude ?? 0) - 346.75)).toBeLessThan(CLOSE);
    expect(chart.bodies.Moo?.longitude).toBeCloseTo(346.7518, 3);
    expect(Math.abs((chart.bodies.Cer?.longitude ?? 0) - 117.92)).toBeLessThan(CLOSE);
    expect(chart.housesFrom).toBe("placidus");
    expect(chart.provenance.source).toBe("astrolog");
    expect(chart.provenance.astrologVersion).toMatch(/^\d+\.\d+$/);
  });

  it("reads all 20 object codes and every house system", async () => {
    const engine = await AstrologEngine.start();
    for (const houseSystem of ["placidus", "koch", "equal", "campanus", "regiomontanus", "porphyry", "whole_sign"] as const) {
      const chart = await engine.cast({ ...NATAL, houseSystem });
      expect(Object.keys(chart.bodies).sort()).toEqual([...OBJECT_CODES].sort());
      expect(chart.missing).toEqual([]);
      expect(chart.housesFrom).toBe(houseSystem);
      for (const body of Object.values(chart.bodies)) {
        expect(body.longitude).toBeGreaterThanOrEqual(0);
        expect(body.longitude).toBeLessThan(360);
        expect(body.retrograde).toBe(body.speed < 0);
      }
    }
    const whole = await engine.cast({ ...NATAL, houseSystem: "whole_sign" });
    expect(whole.houses[1] % 30).toBe(0);
  });

  it("puts a body whose ephemeris does not cover the date in missing", async () => {
    const engine = await AstrologEngine.start();
    const chart = await engine.cast({ ...NATAL, utc: "0100-06-15T14:30:00Z" });
    expect(chart.missing).toContain("Chi");
    expect(chart.bodies.Chi).toBeUndefined();
    expect(chart.bodies.Sun).toBeDefined();
    const sky = await engine.sky({ utc: "0100-06-15T14:30:00Z", bodies: ["Sun", "Chi"] });
    expect(sky.missing).toEqual(["Chi"]);
  });

  it("reports Porphyry when astrolog falls back near the poles", async () => {
    const engine = await AstrologEngine.start();
    const at = async (degrees: number, houseSystem: "placidus" | "koch" | "equal") =>
      (await engine.cast({ ...NATAL, latitude: north(degrees), houseSystem })).housesFrom;
    expect(await at(40, "placidus")).toBe("placidus");
    expect(await at(65.5, "placidus")).toBe("placidus");
    expect(await at(65.5, "koch")).toBe("koch");
    expect(await at(67, "placidus")).toBe("porphyry");
    expect(await at(70, "koch")).toBe("porphyry");
    expect(await at(70, "equal")).toBe("equal");
    const south = await engine.cast({
      ...NATAL,
      latitude: { degrees: 70, hemisphere: "S" },
    });
    expect(south.housesFrom).toBe("porphyry");
  });

  it("casts the sky without a place", async () => {
    const engine = await AstrologEngine.start();
    const sky = await engine.sky({ utc: NATAL.utc, bodies: ["Sun", "Moo"] });
    expect(sky.bodies.Sun?.longitude).toBeCloseTo(84.229, 3);
    expect(sky.bodies.Moo?.longitude).toBeCloseTo(346.7518, 3);
    expect(Object.keys(sky.bodies)).toEqual(["Sun", "Moo"]);
  });

  // Second chart 1990-03-02T06:50Z London: chosen so that the circular midpoint of 84.23 and its
  // Sun (341.43) gives the reference composite Sun 32.83. Not real birth data.
  it("reproduces the composite Sun with -rc and the Davison chart with -rm", async () => {
    const engine = await AstrologEngine.start();
    const a: Birth = { utc: NATAL.utc, latitude: NATAL.latitude, longitude: NATAL.longitude };
    const b: Birth = {
      utc: "1990-03-02T06:50:00Z",
      latitude: north(51.5),
      longitude: { degrees: 0, hemisphere: "W" },
    };
    const composite = await engine.composite({ a, b, kind: "composite", bodies: ["Sun"] });
    expect(Math.abs((composite.bodies.Sun?.longitude ?? 0) - 32.83)).toBeLessThan(CLOSE);
    expect(composite.provenance).toMatchObject({ kind: "composite", inputUtc: [a.utc, b.utc] });

    const davison = await engine.composite({ a, b, kind: "davison", bodies: ["Sun", "Moo"] });
    expect(davison.provenance.kind).toBe("davison");
    const midUtc = davison.provenance.utc as UtcMoment;
    const sky = await engine.sky({ utc: midUtc, bodies: ["Sun"] });
    expect(davison.bodies.Sun?.longitude).toBeCloseTo(sky.bodies.Sun?.longitude ?? -1, 1);
  });

  // -rt treats the second chart as transiting, and expressions then read that second chart. The
  // moment 11:38 UT on 2 March 1990 was chosen to reproduce the reference transit Sun 341.63.
  it("reads the transit Sun through -rt", async () => {
    const binary = locateBinary();
    const dir = mkdtempSync(path.join(scratchBase(), "astrolog-rt-"));
    scratch.push(dir);
    for (const [file, utc] of [["natal.as", NATAL.utc], ["transit.as", "1990-03-02T11:38:00Z"]] as const) {
      const [y, m, d] = utc.slice(0, 10).split("-").map(Number) as [number, number, number];
      await runExpressions({
        binary,
        chartArgs: ["-qa", String(m), String(d), String(y), utc.slice(11, 19).replace(/^0/, ""), "0", "73:54:00W", "40:42:00N"],
        afterPins: ["-o", file],
        houseSystem: "placidus",
        ayanamsa: "tropical",
        codes: [],
        expressions: [],
        cwd: dir,
      });
    }
    const [sun] = await runExpressions({
      binary,
      chartArgs: ["-rt", "natal.as", "transit.as"],
      houseSystem: "placidus",
      ayanamsa: "tropical",
      codes: ["Sun"],
      expressions: ["ObjLon O_Sun"],
      cwd: dir,
    });
    expect(Math.abs((sun ?? 0) - 341.63)).toBeLessThan(CLOSE);
  });

  it("is not changed by an astrolog.as next to the binary", async () => {
    const dir = mkdtempSync(path.join(scratchBase(), "astrolog-hostile-"));
    scratch.push(dir);
    const real = locateBinary();
    const copy = path.join(dir, "astrolog");
    copyFileSync(real, copy);
    chmodSync(copy, 0o755);
    symlinkSync(path.join(path.dirname(real), "ephem"), path.join(dir, "ephem"));
    mkdirSync(path.join(dir, "w"));
    // Sidereal zodiac, Campanus houses, ephemeris files off: nothing a caller asked for.
    writeFileSync(path.join(dir, "astrolog.as"), "@AD780\n-s 0\n-c 3\n-b\n");
    const engine = await AstrologEngine.start({ ASTROLOG_BIN: copy });
    const chart = await engine.cast({ ...NATAL, bodies: ["Sun"] });
    expect(chart.bodies.Sun?.longitude).toBeCloseTo(84.229, 3);
    expect(chart.housesFrom).toBe("placidus");
  });

  it("pins the ephemeris directory against a hostile astrolog.as", async () => {
    const dir = mkdtempSync(path.join(scratchBase(), "astrolog-hostile2-"));
    scratch.push(dir);
    const real = locateBinary();
    const copy = path.join(dir, "astrolog");
    copyFileSync(real, copy);
    chmodSync(copy, 0o755);
    symlinkSync(path.join(path.dirname(real), "ephem"), path.join(dir, "ephem"));
    writeFileSync(path.join(dir, "astrolog.as"), "@AD780\n-Yi1 /nonexistent/ephem\n-R0\n-R Sun\n=b\n");
    const engine = await AstrologEngine.start({ ASTROLOG_BIN: copy });
    const chart = await engine.cast(NATAL);
    expect(chart.missing).toEqual([]);
    expect(Math.abs((chart.bodies.Cer?.longitude ?? 0) - 117.9217)).toBeLessThan(0.001);
    expect(Math.abs((chart.bodies.Eri?.longitude ?? 0) - 17.5288)).toBeLessThan(0.001);
  });

  it("is not changed by -Ys 1 in astrolog.as", async () => {
    const dir = mkdtempSync(path.join(scratchBase(), "astrolog-ys-"));
    scratch.push(dir);
    const real = locateBinary();
    const copy = path.join(dir, "astrolog");
    copyFileSync(real, copy);
    chmodSync(copy, 0o755);
    symlinkSync(path.join(path.dirname(real), "ephem"), path.join(dir, "ephem"));
    writeFileSync(path.join(dir, "astrolog.as"), "@AD780\n-Ys 1\n");
    const engine = await AstrologEngine.start({ ASTROLOG_BIN: copy });
    const chart = await engine.cast({ ...NATAL, bodies: ["Sun"] });
    expect(chart.bodies.Sun?.longitude).toBeCloseTo(84.229045, 5);
  });

  it("works without astrolog.as next to the binary because every setting is pinned (the probe pins -YQ 0)", async () => {
    const dir = mkdtempSync(path.join(scratchBase(), "astrolog-noas-"));
    scratch.push(dir);
    const copy = path.join(dir, "astrolog");
    copyFileSync(locateBinary(), copy);
    chmodSync(copy, 0o755);
    symlinkSync(path.join(path.dirname(locateBinary()), "ephem"), path.join(dir, "ephem"));
    const engine = await AstrologEngine.start({ ASTROLOG_BIN: copy });
    const chart = await engine.cast({ ...NATAL, bodies: ["Sun"] });
    // The copy is the same binary: it reports the version the real one does (7.80 or 8.00).
    const real = await (await AstrologEngine.start()).cast({ ...NATAL, bodies: ["Sun"] });
    expect(chart.provenance.astrologVersion).toBe(real.provenance.astrologVersion);
  });

  it("names the missing ephemeris file and refuses to start", async () => {
    const dir = mkdtempSync(path.join(scratchBase(), "astrolog-noephem-"));
    scratch.push(dir);
    const copy = path.join(dir, "astrolog");
    copyFileSync(locateBinary(), copy);
    chmodSync(copy, 0o755);
    await expect(AstrologEngine.start({ ASTROLOG_BIN: copy })).rejects.toThrow(/ephemeris|expected|returned/);
  });
});

// Each offered ayanamsa, measured on the binary for NATAL: the Sun in that zodiac and the shift
// from the tropical Sun 84.229045. Measured with the pins as shipped, and identical on Astrolog 7.80
// and 8.00 to six decimals. A value that fails here is not offered.
const SIDEREAL_SUN: Record<Exclude<Ayanamsa, "tropical">, { sun: number; shift: number }> = {
  lahiri: { sun: 60.501745, shift: -23.7273 },
  fagan_bradley: { sun: 59.618537, shift: -24.610508 },
  raman: { sun: 61.948046, shift: -22.280999 },
  krishnamurti: { sun: 60.598597, shift: -23.630448 },
};

// The signed difference of two longitudes, from -180 up to 180.
const shiftOf = (from: number, to: number): number => ((to - from + 540) % 360) - 180;

suite("each ayanamsa on the real binary", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A copy of the binary in its own folder, with a chosen astrolog.as so the user's file is tested.
  // Undefined means no astrolog.as at all.
  async function withSettingsFile(text: string | undefined): Promise<string> {
    const dir = mkdtempSync(path.join(scratchBase(), "astrolog-zodiac-"));
    scratch.push(dir);
    const real = locateBinary();
    const copy = path.join(dir, "astrolog");
    copyFileSync(real, copy);
    chmodSync(copy, 0o755);
    symlinkSync(path.join(path.dirname(real), "ephem"), path.join(dir, "ephem"));
    if (text !== undefined) {
      writeFileSync(path.join(dir, "astrolog.as"), text);
    }
    return copy;
  }

  it("shifts the Sun by its measured amount from the tropical Sun", async () => {
    const engine = await AstrologEngine.start();
    const tropical = await engine.cast({ ...NATAL, bodies: ["Sun"] });
    expect(tropical.bodies.Sun?.longitude).toBeCloseTo(84.229045, 4);
    for (const [name, want] of Object.entries(SIDEREAL_SUN)) {
      const chart = await engine.cast({ ...NATAL, ayanamsa: name as Ayanamsa, bodies: ["Sun"] });
      const sun = chart.bodies.Sun?.longitude ?? NaN;
      expect(sun, name).toBeCloseTo(want.sun, 4);
      expect(shiftOf(tropical.bodies.Sun?.longitude ?? NaN, sun), name).toBeCloseTo(want.shift, 4);
      expect(chart.provenance.source).toBe("astrolog");
    }
  });

  it("shifts the whole chart by the same amount: Moon, Ascendant, cusp 1 and the sky", async () => {
    const engine = await AstrologEngine.start();
    const tropical = await engine.cast({ ...NATAL, bodies: ["Moo"] });
    const lahiri = await engine.cast({ ...NATAL, ayanamsa: "lahiri", bodies: ["Moo"] });
    const shift = SIDEREAL_SUN.lahiri.shift;
    expect(shiftOf(tropical.bodies.Moo?.longitude ?? NaN, lahiri.bodies.Moo?.longitude ?? NaN)).toBeCloseTo(shift, 4);
    expect(shiftOf(tropical.angles.ASC, lahiri.angles.ASC)).toBeCloseTo(shift, 4);
    expect(shiftOf(tropical.houses[1], lahiri.houses[1])).toBeCloseTo(shift, 4);
    const sky = await engine.sky({ utc: NATAL.utc, ayanamsa: "lahiri", bodies: ["Sun"] });
    expect(sky.bodies.Sun?.longitude).toBeCloseTo(SIDEREAL_SUN.lahiri.sun, 4);
  });

  // Measured: astrolog casts each birth chart with the ayanamsa for its own date, then takes the
  // midpoint of the two sidereal positions. The two birth dates are three months apart, so the
  // composite's shift is the mean of the two birth shifts (-23.7273 and -23.7232), not one figure.
  it("gives a composite the midpoint of its two sidereal charts", async () => {
    const engine = await AstrologEngine.start();
    const a: Birth = { utc: NATAL.utc, latitude: NATAL.latitude, longitude: NATAL.longitude };
    const b: Birth = { utc: "1990-03-02T06:50:00Z", latitude: north(51.5), longitude: { degrees: 0, hemisphere: "W" } };
    const shiftOfBirth = async (birth: Birth) => {
      const sunIn = async (ayanamsa: Ayanamsa) =>
        (await engine.cast({ ...birth, ayanamsa, bodies: ["Sun"] })).bodies.Sun?.longitude ?? NaN;
      return shiftOf(await sunIn("tropical"), await sunIn("lahiri"));
    };
    const birthShifts = (await shiftOfBirth(a)) + (await shiftOfBirth(b));
    const tropical = await engine.composite({ a, b, kind: "composite", bodies: ["Sun"] });
    const lahiri = await engine.composite({ a, b, kind: "composite", ayanamsa: "lahiri", bodies: ["Sun"] });
    expect(shiftOf(tropical.bodies.Sun?.longitude ?? NaN, lahiri.bodies.Sun?.longitude ?? NaN)).toBeCloseTo(birthShifts / 2, 3);
  });

  // Settings files a user might keep. Each one switches sidereal on or off, or sets an offset; the
  // pins override every one of them, so no result changes whichever is there.
  const HOSTILE_SETTINGS: Array<[string, string | undefined]> = [
    ["no astrolog.as", undefined],
    ["=s", "=s\n"],
    ["@AD780 =s :s Faga", "@AD780 =s :s Faga\n"],
    ["-s 0", "-s 0\n"],
    ["_s", "_s\n"],
    ["=s / -s Lahiri", "=s / -s Lahiri\n"],
  ];

  it.each(HOSTILE_SETTINGS)("is not changed by an astrolog.as with %s", async (_name, text) => {
    const copy = await withSettingsFile(text);
    const engine = await AstrologEngine.start({ ASTROLOG_BIN: copy });
    const tropical = await engine.cast({ ...NATAL, bodies: ["Sun"] });
    expect(tropical.bodies.Sun?.longitude).toBeCloseTo(84.229045, 4);
    expect(tropical.provenance.ayanamsa).toBe("tropical");
    for (const [name, want] of Object.entries(SIDEREAL_SUN)) {
      const chart = await engine.cast({ ...NATAL, ayanamsa: name as Ayanamsa, bodies: ["Sun"] });
      expect(chart.bodies.Sun?.longitude, name).toBeCloseTo(want.sun, 4);
    }
  });

  // The Davison chart is cast for the UT midpoint of the two births. Its zodiac is that moment's own
  // ayanamsa, so its shift is the shift of the sky at the same moment, to the same precision.
  it("shifts a Davison chart by the ayanamsa of its midpoint moment", async () => {
    const engine = await AstrologEngine.start();
    const a: Birth = { utc: NATAL.utc, latitude: NATAL.latitude, longitude: NATAL.longitude };
    const b: Birth = { utc: "1990-03-02T06:50:00Z", latitude: north(51.5), longitude: { degrees: 0, hemisphere: "W" } };
    const tropical = await engine.composite({ a, b, kind: "davison", bodies: ["Sun"] });
    const lahiri = await engine.composite({ a, b, kind: "davison", ayanamsa: "lahiri", bodies: ["Sun"] });
    const midUtc = tropical.provenance.utc as UtcMoment;
    const skyTropical = await engine.sky({ utc: midUtc, bodies: ["Sun"] });
    const skyLahiri = await engine.sky({ utc: midUtc, ayanamsa: "lahiri", bodies: ["Sun"] });
    const skyShift = shiftOf(skyTropical.bodies.Sun?.longitude ?? NaN, skyLahiri.bodies.Sun?.longitude ?? NaN);
    expect(lahiri.provenance).toMatchObject({ kind: "davison", ayanamsa: "lahiri", utc: midUtc });
    expect(shiftOf(tropical.bodies.Sun?.longitude ?? NaN, lahiri.bodies.Sun?.longitude ?? NaN)).toBeCloseTo(skyShift, 4);
    // Measured on Astrolog 7.80 at 1990-04-23T22:40:00Z: the Lahiri shift is -23.724839.
    expect(skyShift).toBeCloseTo(-23.724839, 4);
  });

  // Each result names the zodiac its run used, so a reader can refuse a pair that differs.
  it("names the zodiac each result was cast in, and refuses a natal chart read against a tropical sky", async () => {
    const engine = await AstrologEngine.start();
    expect((await engine.cast({ ...NATAL, bodies: ["Sun"] })).provenance.ayanamsa).toBe("tropical");
    expect((await engine.sky({ utc: NATAL.utc, ayanamsa: "raman", bodies: ["Sun"] })).provenance.ayanamsa).toBe("raman");
    const natal = await engine.cast({ ...NATAL, ayanamsa: "lahiri", bodies: ["Sun"] });
    expect(natal.provenance.ayanamsa).toBe("lahiri");
    const limits: AspectLimit[] = [{ type: aspectType("conjunction", 0, 1), orb: 2 }];
    const tropicalSky = await engine.sky({ utc: NATAL.utc, bodies: ["Sun"] });
    expect(() => transitAspects(natal, tropicalSky, limits)).toThrow(AstroError);
    const lahiriSky = await engine.sky({ utc: NATAL.utc, ayanamsa: "lahiri", bodies: ["Sun"] });
    expect(() => transitAspects(natal, lahiriSky, limits)).not.toThrow();
  });
});
