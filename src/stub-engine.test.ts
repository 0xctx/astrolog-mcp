import { describe, expect, it } from "vitest";
import { StubEngine } from "./stub-engine.js";
import {
  AstroError,
  HOUSE_NUMBERS,
  HOUSE_SYSTEMS,
  OBJECT_CODES,
  type Birth,
  type ChartInput,
  type CompositeInput,
  type CompositeKind,
  type HouseSystem,
  type ObjectCode,
} from "./types.js";

const input: ChartInput = {
  utc: "1990-06-15T19:30:00Z",
  latitude: { degrees: 40.7, hemisphere: "N" },
  longitude: { degrees: 73.9, hemisphere: "W" },
};

const ALL_SYSTEMS = Object.keys(HOUSE_SYSTEMS) as HouseSystem[];
const NON_WHOLE_SIGN_SYSTEMS = ALL_SYSTEMS.filter((system) => system !== "whole_sign");

// The systems where MC, IC and DSC sit on cusps 10, 4 and 7. Equal and whole_sign are left out.
const ANGLES_ON_CUSPS_SYSTEMS: HouseSystem[] = [
  "placidus",
  "koch",
  "campanus",
  "regiomontanus",
  "porphyry",
];

describe("StubEngine ayanamsa", () => {
  const SIDEREAL = ["lahiri", "fagan_bradley", "raman", "krishnamurti"] as const;
  const composite: CompositeInput = {
    a: { utc: input.utc, latitude: input.latitude, longitude: input.longitude },
    b: { utc: "1992-03-02T06:50:00Z", latitude: input.latitude, longitude: input.longitude },
    kind: "composite",
  };

  it("refuses every sidereal value in cast, sky and composite, with a fix line", async () => {
    const engine = new StubEngine();
    for (const ayanamsa of SIDEREAL) {
      await expect(engine.cast({ ...input, ayanamsa })).rejects.toMatchObject({
        name: "AstroError",
        message: `The ${ayanamsa} zodiac needs the real Astrolog engine: this server runs placeholder numbers, which are tropical only.`,
        fix: "Use the tropical zodiac, or ask the server's operator to run the real Astrolog engine for sidereal positions.",
      });
      await expect(engine.sky({ utc: input.utc, ayanamsa })).rejects.toBeInstanceOf(AstroError);
      await expect(engine.composite({ ...composite, ayanamsa })).rejects.toBeInstanceOf(AstroError);
    }
  });

  it("answers tropical exactly as it answers with no ayanamsa", async () => {
    const engine = new StubEngine();
    expect(await engine.cast({ ...input, ayanamsa: "tropical" })).toEqual(await engine.cast(input));
    expect(await engine.sky({ utc: input.utc, ayanamsa: "tropical" })).toEqual(await engine.sky({ utc: input.utc }));
    expect(await engine.composite({ ...composite, ayanamsa: "tropical" })).toEqual(await engine.composite(composite));
  });

  it("refuses an unknown value as invalid input, before any placeholder is made", async () => {
    await expect(new StubEngine().cast({ ...input, ayanamsa: "vedic" as never })).rejects.toMatchObject({
      message: 'input.ayanamsa must be one of tropical, lahiri, fagan_bradley, raman, krishnamurti, got "vedic"',
    });
  });
});

describe("StubEngine.cast", () => {
  it("returns the fixed positions for every body, house and angle", async () => {
    const positions = await new StubEngine().cast(input);

    expect(Object.keys(positions.bodies).sort()).toEqual([...OBJECT_CODES].sort());
    expect(positions.bodies.Sun).toEqual({ longitude: 0, speed: 0.99, retrograde: false, house: 12 });
    expect(positions.bodies.Mer).toEqual({ longitude: 36, speed: -1.2, retrograde: true, house: 1 });
    expect(positions.bodies.Sed).toEqual({ longitude: 342, speed: 0.1, retrograde: false, house: 11 });
    expect(positions.houses[1]).toBe(15);
    expect(positions.houses[12]).toBe(345);
    expect(positions.angles).toEqual({ ASC: 15, MC: 285, DSC: 195, IC: 105 });
    expect(positions.missing).toEqual([]);
    expect(positions.housesFrom).toBe("placidus");
    expect(positions.provenance).toEqual({
      astrologVersion: "stub (no astrolog run)",
      ayanamsa: "tropical",
      source: "stub",
      utc: "1990-06-15T19:30:00Z",
    });
  });

  it("places each body in the house whose cusps hold its longitude", async () => {
    const { bodies } = await new StubEngine().cast(input);

    expect(bodies.Moo?.house).toBe(1);
    expect(bodies.Ven?.house).toBe(2);
    expect(bodies.Sat?.house).toBe(4);
    expect(bodies.Chi?.house).toBe(6);
    expect(bodies.Ves?.house).toBe(9);
    expect(bodies.Hau?.house).toBe(10);
    expect(bodies.Mak?.house).toBe(11);
  });

  it("keeps every longitude and cusp in [0, 360)", async () => {
    const positions = await new StubEngine().cast(input);
    const longitudes = [
      ...Object.values(positions.bodies).map((body) => body.longitude),
      ...HOUSE_NUMBERS.map((house) => positions.houses[house]),
      ...Object.values(positions.angles),
    ];

    expect(longitudes).toHaveLength(OBJECT_CODES.length + 12 + 4);
    for (const longitude of longitudes) {
      expect(longitude).toBeGreaterThanOrEqual(0);
      expect(longitude).toBeLessThan(360);
    }
  });

  it.each(NON_WHOLE_SIGN_SYSTEMS)("puts ASC on cusp 1 for %s", async (houseSystem) => {
    const { houses, angles } = await new StubEngine().cast({ ...input, houseSystem });

    expect(angles.ASC).toBe(houses[1]);
  });

  it.each(ANGLES_ON_CUSPS_SYSTEMS)("puts IC, DSC and MC on cusps 4, 7 and 10 for %s", async (houseSystem) => {
    const { houses, angles } = await new StubEngine().cast({ ...input, houseSystem });

    expect(angles.IC).toBe(houses[4]);
    expect(angles.DSC).toBe(houses[7]);
    expect(angles.MC).toBe(houses[10]);
  });

  it("names every non-whole_sign system in the ASC list or in equal", () => {
    expect([...ANGLES_ON_CUSPS_SYSTEMS, "equal"].sort()).toEqual([...NON_WHOLE_SIGN_SYSTEMS].sort());
  });

  // Under whole_sign, cusp 1 is 0 degrees of the sign that holds ASC, not ASC itself.
  it("starts each whole_sign cusp at 0 degrees of a sign, with ASC inside house 1", async () => {
    const positions = await new StubEngine().cast({ ...input, houseSystem: "whole_sign" });
    const { houses, angles, housesFrom, bodies } = positions;

    expect(housesFrom).toBe("whole_sign");
    for (const house of HOUSE_NUMBERS) {
      expect(houses[house]).toBe((house - 1) * 30);
    }
    expect(angles.ASC).not.toBe(houses[1]);
    expect(angles.ASC).toBeGreaterThanOrEqual(houses[1]);
    expect(angles.ASC).toBeLessThan(houses[2]);
    expect(angles.MC).toBeGreaterThanOrEqual(houses[10]);
    expect(angles.MC).toBeLessThan(houses[11]);
    expect(bodies.Sun?.house).toBe(1);
    expect(bodies.Mer?.house).toBe(2);
    expect(bodies.Sed?.house).toBe(12);
  });

  it("returns only the requested bodies when bodies is given", async () => {
    const positions = await new StubEngine().cast({ ...input, bodies: ["Moo", "Mer"] });

    expect(positions.bodies).toEqual({
      Moo: { longitude: 18, speed: 13.2, retrograde: false, house: 1 },
      Mer: { longitude: 36, speed: -1.2, retrograde: true, house: 1 },
    });
    expect(positions.missing).toEqual([]);
    expect(Object.keys(positions.houses)).toHaveLength(12);
  });

  it("keeps retrograde equal to speed < 0 for every body", async () => {
    const engine = new StubEngine();
    const { bodies } = await engine.cast(input);
    const { bodies: skyBodies } = await engine.sky({ utc: input.utc });

    for (const body of [...Object.values(bodies), ...Object.values(skyBodies)]) {
      expect(body.retrograde).toBe(body.speed < 0);
    }
    expect(bodies.Mer?.retrograde).toBe(true);
    expect(bodies.Plu?.retrograde).toBe(true);
    expect(bodies.Nor?.retrograde).toBe(true);
    expect(bodies.Sun?.retrograde).toBe(false);
  });

  it("gives the same answer on every call and does not share state between results", async () => {
    const engine = new StubEngine();
    const first = await engine.cast(input);
    first.bodies.Sun = { longitude: 999, speed: 0, retrograde: true, house: 1 };
    first.houses[1] = 999;
    first.angles.ASC = 999;
    first.missing.push("Cer");

    expect(await engine.cast(input)).toEqual(await new StubEngine().cast(input));
  });

  it.each([
    ["an unknown object code", { bodies: ["Xyz" as ObjectCode] }],
    ["an empty bodies list", { bodies: [] }],
    ["a repeated object code", { bodies: ["Sun", "Sun"] as ObjectCode[] }],
    ["a latitude above 90", { latitude: { degrees: 91, hemisphere: "N" as const } }],
    ["a utc with no Z", { utc: "1990-06-15T19:30:00" as ChartInput["utc"] }],
    ["an unknown house system", { houseSystem: "geocentric" as HouseSystem }],
  ])("rejects %s with an AstroError that has a fix line", async (_label, change) => {
    const engine = new StubEngine();

    await expect(engine.cast({ ...input, ...change })).rejects.toThrow(AstroError);
    await expect(engine.cast({ ...input, ...change })).rejects.toMatchObject({
      fix: expect.stringMatching(/\S/),
    });
  });
});

describe("StubEngine.sky", () => {
  it("returns every body with speed and retrograde and no house", async () => {
    const result = await new StubEngine().sky({ utc: input.utc });

    expect(Object.keys(result.bodies).sort()).toEqual([...OBJECT_CODES].sort());
    expect(result.bodies.Mer).toEqual({ longitude: 36, speed: -1.2, retrograde: true });
    expect(result.bodies.Sun).toEqual({ longitude: 0, speed: 0.99, retrograde: false });
    expect(result.missing).toEqual([]);
    expect(result.provenance).toEqual({
      astrologVersion: "stub (no astrolog run)",
      ayanamsa: "tropical",
      source: "stub",
      utc: input.utc,
    });
  });

  it("returns only the requested bodies when bodies is given", async () => {
    const result = await new StubEngine().sky({ utc: input.utc, bodies: ["Moo", "Mer"] });

    expect(result.bodies).toEqual({
      Moo: { longitude: 18, speed: 13.2, retrograde: false },
      Mer: { longitude: 36, speed: -1.2, retrograde: true },
    });
  });

  it("rejects a utc with no Z with an AstroError", async () => {
    await expect(new StubEngine().sky({ utc: "1990-06-15T19:30:00" as typeof input.utc })).rejects.toThrow(
      AstroError,
    );
  });
});

describe("StubEngine.composite", () => {
  const a: Birth = { utc: input.utc, latitude: input.latitude, longitude: input.longitude };
  const b: Birth = {
    utc: "1992-03-01T08:00:00Z",
    latitude: { degrees: 51.5, hemisphere: "N" },
    longitude: { degrees: 0.1, hemisphere: "W" },
  };

  it("returns every body and cusps, with the two birth moments in inputUtc and no utc for a composite", async () => {
    const positions = await new StubEngine().composite({ a, b, kind: "composite" });

    expect(Object.keys(positions.bodies).sort()).toEqual([...OBJECT_CODES].sort());
    expect(positions.housesFrom).toBe("placidus");
    expect(positions.houses[1]).toBe(15);
    expect(positions.missing).toEqual([]);
    expect(positions.provenance).toEqual({
      astrologVersion: "stub (no astrolog run)",
      ayanamsa: "tropical",
      source: "stub",
      kind: "composite",
      inputUtc: [a.utc, b.utc],
    });
    expect(positions.provenance).not.toHaveProperty("utc");
  });

  it("uses the composite's own houseSystem", async () => {
    const positions = await new StubEngine().composite({ a, b, kind: "davison", houseSystem: "whole_sign" });

    expect(positions.housesFrom).toBe("whole_sign");
    expect(positions.houses[1]).toBe(0);
  });

  it("reads the composite's own bodies, not a person's", async () => {
    const positions = await new StubEngine().composite({ a, b, kind: "composite", bodies: ["Moo"] });

    expect(Object.keys(positions.bodies)).toEqual(["Moo"]);
  });

  // The two moments are 731 days apart (the span holds 29 February 1992), so the midpoint is 365.5
  // days after the first: 12 hours past 1991-06-15T19:30:00Z.
  it("gives the davison midpoint in UT, rounded to the second", async () => {
    const positions = await new StubEngine().composite({
      a: { ...a, utc: "1990-06-15T19:30:00Z" },
      b: { ...b, utc: "1992-06-15T19:30:00Z" },
      kind: "davison",
    });

    expect(positions.provenance).toEqual({
      astrologVersion: "stub (no astrolog run)",
      ayanamsa: "tropical",
      source: "stub",
      kind: "davison",
      inputUtc: ["1990-06-15T19:30:00Z", "1992-06-15T19:30:00Z"],
      utc: "1991-06-16T07:30:00Z",
    });
  });

  it("rounds a half-second midpoint up to the next whole second", async () => {
    const positions = await new StubEngine().composite({
      a: { ...a, utc: "1990-06-15T19:30:00Z" },
      b: { ...b, utc: "1990-06-15T19:30:03Z" },
      kind: "davison",
    });

    expect(positions.provenance).toMatchObject({ kind: "davison", utc: "1990-06-15T19:30:02Z" });
  });

  it("rejects a houseSystem or bodies on a or b, with an AstroError that names the composite", async () => {
    const withHouseSystem = { a: { ...a, houseSystem: "koch" } as Birth, b, kind: "composite" as const };
    const withBodies = { a, b: { ...b, bodies: ["Sun"] } as Birth, kind: "composite" as const };

    await expect(new StubEngine().composite(withHouseSystem)).rejects.toThrow(AstroError);
    await expect(new StubEngine().composite(withHouseSystem)).rejects.toMatchObject({
      fix: expect.stringMatching(/composite input/),
    });
    await expect(new StubEngine().composite(withBodies)).rejects.toThrow(/b sets houseSystem or bodies/);
  });

  it("rejects an unknown kind with an AstroError", async () => {
    await expect(new StubEngine().composite({ a, b, kind: "cusp" as CompositeKind })).rejects.toThrow(
      /kind must be "composite" or "davison"/,
    );
  });

  it("rejects a missing a with an AstroError, not a TypeError", async () => {
    const missing = { b, kind: "composite" } as unknown as CompositeInput;

    await expect(new StubEngine().composite(missing)).rejects.toThrow(AstroError);
    await expect(new StubEngine().composite(missing)).rejects.toThrow(/a must be an object/);
  });

  it("rejects when b is invalid, with an AstroError", async () => {
    const bad = { ...b, latitude: { degrees: Number.NaN, hemisphere: "N" as const } };

    await expect(new StubEngine().composite({ a, b: bad, kind: "composite" })).rejects.toThrow(
      AstroError,
    );
  });
});
