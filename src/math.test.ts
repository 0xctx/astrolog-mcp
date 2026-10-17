import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_HARMONIC,
  VIBRATIONAL_ASPECTS,
  VIBRATIONAL_MIDPOINT_ORB,
  aspectType,
  harmonicLongitude,
  harmonicPositions,
  harmonicSky,
  matchAspect,
  midpoint,
  pairAspects,
  vibrationalAspectLimits,
  midpointContacts,
  midpointLimit,
  separation,
  strength,
  transitAspects,
  transitLimit,
  vibrationalNatalLimit,
  type MidpointConfig,
  type MidpointContact,
} from "./math.js";
import {
  AstroError,
  HOUSE_NUMBERS,
  type AngleCode,
  type ObjectCode,
  type Positions,
  type SkyPositions,
} from "./types.js";

const config: MidpointConfig = { aspects: VIBRATIONAL_ASPECTS, orb: VIBRATIONAL_MIDPOINT_ORB };

// A chart built by hand. Only the longitudes matter to the math; the rest is filled with inert values,
// and `stub` says so: nothing here is astrolog output.
function handPositions(lons: Partial<Record<ObjectCode, number>>, asc: number, mc: number): Positions {
  const bodies: Positions["bodies"] = {};
  for (const [code, longitude] of Object.entries(lons) as Array<[ObjectCode, number]>) {
    bodies[code] = { longitude, speed: 0, retrograde: false, house: 1 };
  }
  const angles: Record<AngleCode, number> = {
    ASC: asc,
    MC: mc,
    DSC: (asc + 180) % 360,
    IC: (mc + 180) % 360,
  };
  return {
    bodies,
    houses: Object.fromEntries(HOUSE_NUMBERS.map((n) => [n, (n - 1) * 30])) as Positions["houses"],
    angles,
    missing: [],
    housesFrom: "placidus",
    provenance: { astrologVersion: "hand-computed test fixture", source: "stub", utc: "1990-06-15T19:30:00Z", ayanamsa: "tropical" },
  };
}

// The error message's fix line, or a failure when the call did not throw an AstroError.
function fixOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    if (error instanceof AstroError) {
      return error.fix;
    }
    throw error;
  }
  throw new Error("the call did not throw");
}

describe("harmonic longitude", () => {
  it("multiplies by H and wraps at 360", () => {
    expect(harmonicLongitude(100, 5)).toBe(140);
    expect(harmonicLongitude(200, 2)).toBe(40);
    expect(harmonicLongitude(72, 5)).toBe(0);
    expect(harmonicLongitude(359.5, 10000)).toBe(40);
  });

  it("accepts any whole harmonic from 1 to 10000 and rejects the rest", () => {
    expect(harmonicLongitude(1, 1)).toBe(1);
    expect(harmonicLongitude(1, 10000)).toBe(10000 % 360);
    for (const bad of [0, -3, 10001, 1.5, Number.NaN]) {
      expect(() => harmonicLongitude(10, bad)).toThrow(AstroError);
    }
    expect(fixOf(() => harmonicLongitude(10, 0))).toMatch(/whole-number harmonic from 1 to 10000/);
  });
});

describe("separation and midpoint", () => {
  it("measures the shorter arc, 0 to 180", () => {
    expect(separation(350, 10)).toBe(20);
    expect(separation(10, 350)).toBe(20);
    expect(separation(0, 180)).toBe(180);
    expect(separation(-10, 10)).toBe(20);
  });

  it("takes the midpoint on the shorter arc, across 0", () => {
    expect(midpoint(350, 10)).toBe(0);
    expect(midpoint(10, 350)).toBe(0);
    expect(midpoint(100, 200)).toBe(150);
  });
});

describe("strength and limits", () => {
  it("is 1 at exact, 0 at the edge and 1 - orb/limit between", () => {
    expect(strength(0, 2)).toBe(1);
    expect(strength(1.5, 1.5)).toBe(0);
    expect(strength(0.5, 1.5)).toBeCloseTo(2 / 3, 12);
  });

  it("gives the classic limit: the axis orb for harmonics 1 and 2, else in proportion", () => {
    expect(midpointLimit(aspectType("conjunction", 0, 1), 1.5)).toBe(1.5);
    expect(midpointLimit(aspectType("opposition", 1, 2), 1.5)).toBe(1.5);
    expect(midpointLimit(aspectType("biquintile", 2, 5), 1.5)).toBe(0.6);
    expect(midpointLimit(aspectType("septile", 1, 7), 1.5)).toBeCloseTo(3 / 7, 12);
  });

  it("has the vibrational aspect angles", () => {
    const angle = (key: string) => VIBRATIONAL_ASPECTS.find((t) => t.key === key)?.angle;
    expect(angle("biquintile")).toBe(144);
    expect(angle("quadnovile")).toBe(160);
    expect(angle("quincunx")).toBe(150);
    expect(angle("septile")).toBe(51.428571);
    expect(VIBRATIONAL_ASPECTS).toHaveLength(17);
  });
});

describe("aspect matching", () => {
  const limits = [
    { type: aspectType("conjunction", 0, 1), orb: 2 },
    { type: aspectType("square", 1, 4), orb: 2 },
  ];

  it("returns the aspect within its limit with the largest strength", () => {
    expect(matchAspect(91, limits)).toEqual({ aspect: "square", angle: 90, orb: 1, limit: 2, strength: 0.5 });
    expect(matchAspect(0.5, limits)?.aspect).toBe("conjunction");
  });

  it("returns undefined when nothing is within its limit", () => {
    expect(matchAspect(45, limits)).toBeUndefined();
  });

  it("rejects a limit that is not a finite number above 0, so strength is never NaN", () => {
    const conjunction = aspectType("conjunction", 0, 1);
    for (const orb of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => matchAspect(0, [{ type: conjunction, orb }])).toThrow(AstroError);
      expect(() => transitAspects(handPositions({ Sun: 0 }, 200, 300), emptySky, [{ type: conjunction, orb }])).toThrow(
        AstroError,
      );
    }
    expect(fixOf(() => matchAspect(0, [{ type: conjunction, orb: 0 }]))).toMatch(/orb such as 2 degrees/);
  });
});

describe("vibrational natal and transit orbs", () => {
  it("gives the natal orb 16 ÷ H", () => {
    expect(vibrationalNatalLimit(1)).toBe(16);
    expect(vibrationalNatalLimit(8)).toBe(2);
    expect(vibrationalNatalLimit(32)).toBe(0.5);
    expect(() => vibrationalNatalLimit(0)).toThrow(AstroError);
  });

  it("caps the transit orb at 2 degrees for harmonics 1 to 4 and at 1 degree above, as the oracle does", () => {
    expect(transitLimit(16, 1)).toBe(2);
    expect(transitLimit(16 / 4, 4)).toBe(2);
    expect(transitLimit(16 / 5, 5)).toBe(1);
    expect(transitLimit(16 / 32, 32)).toBe(0.5);
    expect(transitLimit(0.5, 1)).toBe(0.5);
    expect(() => transitLimit(0, 1)).toThrow(AstroError);
  });
});

// A transit sky with no bodies, for limit checks that must reach the validation first.
const emptySky: SkyPositions = {
  bodies: {},
  missing: [],
  provenance: { astrologVersion: "hand-computed test fixture", source: "stub", utc: "1990-06-15T19:30:00Z", ayanamsa: "tropical" },
};

describe("classic midpoint contacts", () => {
  it("finds an exact conjunction on the midpoint of two bodies at harmonic 1", () => {
    // Mercury at 20 sits on the midpoint of Sun 10 and Moon 30. Jupiter at 200 opposes that midpoint.
    const p = handPositions({ Sun: 10, Moo: 30, Mer: 20, Jup: 200 }, 200, 300);
    const contacts = midpointContacts(p, 1, config);
    expect(contacts).toContainEqual({
      focus: "Mer",
      a: "Sun",
      b: "Moo",
      aspect: "conjunction",
      midpoint: 20,
      orb: 0,
      limit: 1.5,
      strength: 1,
    });
    expect(contacts).toContainEqual(
      expect.objectContaining({ focus: "Jup", a: "Sun", b: "Moo", aspect: "opposition", orb: 0, strength: 1 }),
    );
  });

  it("reads a quintile in harmonic 5, where the classic limit is 0.6 degrees", () => {
    // In harmonic 5: Sun 0, Moon 50, midpoint 25. Mercury at 19.4 natal is 97 in harmonic 5, 72 from the midpoint.
    const p = handPositions({ Sun: 0, Moo: 10, Mer: 19.4 }, 200, 300);
    expect(midpointContacts(p, 5, config)).toContainEqual({
      focus: "Mer",
      a: "Sun",
      b: "Moo",
      aspect: "quintile",
      midpoint: 25,
      orb: 0,
      limit: 0.6,
      strength: 1,
    });
  });

  it("rounds a harmonic chart's angle to 6 decimals above H 1, and keeps H 1 exact", () => {
    // ASC 10.0000004 in H3 is 30.0000012, which the oracle's harmonic_chart rounds to 30.000001. The
    // midpoint of Sun 0 and that angle is then 15.0000005, not 15.0000006.
    // Mercury at 5 sits on that midpoint in H1 and, times 3, on it in H3.
    const p = handPositions({ Sun: 0, Mer: 5 }, 10.0000004, 300);
    const midpointOf = (harmonic: number) =>
      midpointContacts(p, harmonic, config).find((c) => c.focus === "Mer" && c.a === "Sun" && c.b === "ASC")?.midpoint;
    expect(midpointOf(3)).toBeCloseTo(15.0000005, 9);
    expect(midpointOf(1)).toBeCloseTo(5.0000002, 9);
  });

  it("accepts harmonic 10000 and keeps every midpoint in the circle", () => {
    const p = handPositions({ Sun: 10, Moo: 30, Mer: 20, Jup: 200 }, 200, 300);
    const contacts = midpointContacts(p, MAX_HARMONIC, config);
    expect(Array.isArray(contacts)).toBe(true);
    for (const c of contacts) {
      expect(c.midpoint).toBeGreaterThanOrEqual(0);
      expect(c.midpoint).toBeLessThan(360);
    }
  });

  it("rejects an empty aspect set or a non-positive orb with a fix line", () => {
    const p = handPositions({ Sun: 10 }, 200, 300);
    expect(fixOf(() => midpointContacts(p, 1, { aspects: [], orb: 1.5 }))).toMatch(/VIBRATIONAL_ASPECTS/);
    expect(() => midpointContacts(p, 1, { aspects: VIBRATIONAL_ASPECTS, orb: 0 })).toThrow(AstroError);
  });

  it("has no field or value that says strong, significant or stands out", () => {
    const p = handPositions({ Sun: 10, Moo: 30, Mer: 20, Jup: 200, Ven: 50, Mar: 133 }, 200, 300);
    expect(JSON.stringify(midpointContacts(p, 5, config))).not.toMatch(/strong|significant|stands out/i);
  });
});

describe("transit aspects", () => {
  const natal = handPositions({ Sun: 0 }, 200, 300);
  const limits = [
    { type: aspectType("conjunction", 0, 1), orb: 2 },
    { type: aspectType("square", 1, 4), orb: 2 },
  ];
  const sky: SkyPositions = {
    bodies: {
      Mar: { longitude: 91, speed: -0.5, retrograde: true },
      Ven: { longitude: 0, speed: 1.2, retrograde: false },
    },
    missing: [],
    provenance: { astrologVersion: "hand-computed test fixture", source: "stub", utc: "1990-06-15T19:30:00Z", ayanamsa: "tropical" },
  };

  it("lists each transit to the natal targets, strongest first", () => {
    const hits = transitAspects(natal, sky, limits);
    expect(hits).toEqual([
      {
        transit: "Ven",
        natal: "Sun",
        aspect: "conjunction",
        angle: 0,
        orb: 0,
        limit: 2,
        strength: 1,
        phase: "separating",
        applying: false,
      },
      {
        transit: "Mar",
        natal: "Sun",
        aspect: "square",
        angle: 90,
        orb: 1,
        limit: 2,
        strength: 0.5,
        phase: "applying",
        applying: true,
      },
    ]);
  });

  it("marks a transit applying only when its orb shrinks over the look-ahead", () => {
    const separating = { bodies: { Mar: { ...sky.bodies.Mar!, speed: 0.5 } }, missing: [], provenance: sky.provenance };
    expect(transitAspects(natal, separating, limits)[0]?.applying).toBe(false);
  });

  it("has no field or value that says strong, significant or stands out", () => {
    expect(JSON.stringify(transitAspects(natal, sky, limits))).not.toMatch(/strong|significant|stands out/i);
  });

  it("refuses a natal chart and a sky in different zodiacs, with a fix line", () => {
    const lahiriSky: SkyPositions = { ...sky, provenance: { ...sky.provenance, ayanamsa: "lahiri" } };
    expect(() => transitAspects(natal, lahiriSky, limits)).toThrow(AstroError);
    expect(fixOf(() => transitAspects(natal, lahiriSky, limits))).toBe(
      "Cast both with the same ayanamsa, or read both in tropical.",
    );
    expect(() => transitAspects({ ...natal, provenance: { ...natal.provenance, ayanamsa: "lahiri" } }, sky, limits)).toThrow(
      "the two results are in different zodiacs: lahiri and tropical",
    );
  });
});

describe("every aspect between points (pairAspects)", () => {
  const limits = vibrationalAspectLimits();
  const named = (points: [string, number][]) =>
    pairAspects(points, limits).map((found) => [found.a, found.b, found.aspect]);

  it("has the 17 vibrational aspects, each with its natal orb of 16 divided by its harmonic", () => {
    expect(limits).toHaveLength(17);
    const orbOf = (key: string) => limits.find((limit) => limit.type.key === key)?.orb;
    expect(orbOf("conjunction")).toBe(16);
    expect(orbOf("opposition")).toBe(8);
    expect(orbOf("semisquare")).toBe(2);
    expect(orbOf("quincunx")).toBeCloseTo(16 / 12, 10);
    expect(orbOf("quintile")).toBeCloseTo(3.2, 10);
  });

  it.each([
    ["semisquare", 45, 8],
    ["quincunx", 150, 12],
    ["quintile", 72, 5],
    ["septile", 360 / 7, 7],
    ["novile", 40, 9],
  ])("finds a minor %s at its exact angle, with strength 1", (aspect, sep) => {
    const hits = pairAspects([["Sun", 0], ["Moo", sep]], limits);
    const found = hits.find((hit) => hit.aspect === aspect);
    expect(found).toMatchObject({ a: "Sun", b: "Moo", aspect });
    expect(found?.orb).toBeCloseTo(0, 6);
    expect(found?.strength).toBeCloseTo(1, 6);
  });

  it("finds nothing for a separation outside every orb", () => {
    // 20 degrees is clear of the conjunction's 16-degree orb and of every other window.
    expect(named([["Sun", 0], ["Moo", 20]])).toEqual([]);
  });

  it("measures the short way round the zodiac", () => {
    const hits = pairAspects([["Sun", 359], ["Moo", 40]], limits);
    // 359 to 40 is 41 degrees the short way: novile at 40, one degree out.
    expect(hits.find((hit) => hit.aspect === "novile")?.orb).toBeCloseTo(1, 6);
  });

  it("lists every aspect a pair matches and every pair", () => {
    // Sun and Moon at 0 and 45, Mercury at 0: Sun-Moon semisquare, Sun-Mercury conjunction, Moon-Mercury semisquare.
    expect(named([["Sun", 0], ["Moo", 45], ["Mer", 0]])).toEqual([
      ["Sun", "Moo", "semisquare"],
      ["Sun", "Mer", "conjunction"],
      ["Moo", "Mer", "semisquare"],
    ]);
  });

  it("ranks the strongest first and keeps the input order for equal strengths", () => {
    // A-C (conjunction, exact), A-D and C-D (semisquare, exact) have strength 1 and keep their loop order.
    // A-B and B-C are 10 degrees apart: 10 ÷ 16 short of the conjunction's edge, so strength 0.375, and they come last.
    const hits = pairAspects([["A", 0], ["B", 10], ["C", 0], ["D", 45]], limits);
    const strengths = hits.map((hit) => hit.strength);
    expect(strengths).toEqual([...strengths].sort((x, y) => y - x));
    expect(hits.map((hit) => [hit.a, hit.b])).toEqual([
      ["A", "C"],
      ["A", "D"],
      ["C", "D"],
      ["A", "B"],
      ["B", "C"],
    ]);
    expect(hits[3]?.strength).toBeCloseTo(0.375, 10);
  });

  it("returns the same points for the same input, every time", () => {
    const points: [string, number][] = [["Sun", 12.5], ["Moo", 200.25], ["ASC", 44], ["MC", 290]];
    expect(pairAspects(points, limits)).toEqual(pairAspects(points, limits));
  });

  it("refuses an aspect limit that is not a positive number", () => {
    expect(() => pairAspects([["Sun", 0]], [{ type: aspectType("bad", 1, 4), orb: 0 }])).toThrow(AstroError);
  });
});

describe("harmonic charts", () => {
  // Sun and ASC at 10.0000004: in H 3 that is 30.0000012, which rounds to 30.000001. Moon 100 is exact in H 3.
  const base = handPositions({ Sun: 10.0000004, Moo: 100 }, 10.0000004, 300);
  const natal: Positions = {
    ...base,
    bodies: {
      Sun: { longitude: 10.0000004, speed: 1.5, retrograde: false, house: 1 },
      Moo: { longitude: 100, speed: -0.5, retrograde: true, house: 4 },
    },
    missing: ["Chi"],
  };
  const sky: SkyPositions = {
    bodies: {
      Mar: { longitude: 130, speed: -0.5, retrograde: true },
      Ven: { longitude: 0, speed: 1.25, retrograde: false },
    },
    missing: ["Cer"],
    provenance: { astrologVersion: "hand-computed test fixture", source: "stub", utc: "1990-06-15T19:30:00Z", ayanamsa: "tropical" },
  };

  it("multiplies body longitudes, cusps and angles by H, rounded to 6 decimals above H 1", () => {
    const h3 = harmonicPositions(natal, 3);
    expect(h3.bodies.Sun?.longitude).toBe(30.000001);
    expect(h3.bodies.Moo?.longitude).toBe(300);
    expect(h3.angles.ASC).toBe(30.000001);
    expect(h3.angles.MC).toBe(180);
    expect(h3.angles.DSC).toBe(210.000001);
    expect(h3.houses[2]).toBe(90);
  });

  it("wraps a rounded value that reaches 360 to 0, so every longitude stays below 360", () => {
    const wrapping = handPositions({}, 119.9999999, 300);
    expect(harmonicPositions(wrapping, 3).angles.ASC).toBe(0);
  });

  it("multiplies speed by H, keeps retrograde, house numbers, missing codes and provenance", () => {
    const h3 = harmonicPositions(natal, 3);
    expect(h3.bodies.Sun).toEqual({ longitude: 30.000001, speed: 4.5, retrograde: false, house: 1 });
    expect(h3.bodies.Moo).toEqual({ longitude: 300, speed: -1.5, retrograde: true, house: 4 });
    expect(h3.missing).toEqual(["Chi"]);
    expect(h3.provenance).toEqual(natal.provenance);
    expect(h3.housesFrom).toBe("placidus");
  });

  it("returns the same chart at H 1", () => {
    expect(harmonicPositions(natal, 1)).toEqual(natal);
    const skyH1 = harmonicSky(sky, 1);
    expect(skyH1).toEqual(sky);
  });

  it("does not modify its input", () => {
    const before = structuredClone(natal);
    const skyBefore = structuredClone(sky);
    const h5 = harmonicPositions(natal, 5);
    const s5 = harmonicSky(sky, 5);
    expect(natal).toEqual(before);
    expect(sky).toEqual(skyBefore);
    expect(h5.bodies).not.toBe(natal.bodies);
    expect(h5.angles).not.toBe(natal.angles);
    expect(h5.missing).not.toBe(natal.missing);
    expect(s5.bodies).not.toBe(sky.bodies);
  });

  it("scales a transit sky the same way: longitude by H, speed by H, retrograde unchanged", () => {
    const s3 = harmonicSky(sky, 3);
    expect(s3.bodies.Mar).toEqual({ longitude: 30, speed: -1.5, retrograde: true });
    expect(s3.bodies.Ven).toEqual({ longitude: 0, speed: 3.75, retrograde: false });
    expect(s3.missing).toEqual(["Cer"]);
    expect(s3.provenance).toEqual(sky.provenance);
  });

  it("rejects an invalid harmonic with an AstroError and a fix line", () => {
    for (const bad of [0, -3, 10001, 1.5, Number.NaN]) {
      expect(() => harmonicPositions(natal, bad)).toThrow(AstroError);
      expect(() => harmonicSky(sky, bad)).toThrow(AstroError);
    }
    expect(fixOf(() => harmonicSky(sky, 0))).toMatch(/whole-number harmonic from 1 to 10000/);
  });

  it("finds a transit to the harmonic natal chart: both sides multiplied by H, then transitAspects", () => {
    // Sun 10 is at 30 in H 3, and Mars 130 is at 30 in H 3: a conjunction of orb 0 in the harmonic chart.
    const chartH3 = harmonicPositions(handPositions({ Sun: 10 }, 200, 300), 3);
    const skyH3 = harmonicSky(sky, 3);
    const limits = [{ type: aspectType("conjunction", 0, 1), orb: 2 }];
    expect(transitAspects(chartH3, skyH3, limits)).toEqual([
      {
        transit: "Mar",
        natal: "Sun",
        aspect: "conjunction",
        angle: 0,
        orb: 0,
        limit: 2,
        strength: 1,
        phase: "separating",
        applying: false,
      },
    ]);
  });
});

// The parity block: the committed golden fixtures from the Python reference implementation (the oracle). No reference toolkit and no astrolog are
// needed; the golden files hold the oracle's numbers. `npm run test:parity` runs only this block.
describe("parity against the oracle", () => {
  interface GoldenContact {
    focus: string;
    a: string;
    b: string;
    aspect: string;
    midpoint: number;
    orb: number;
    limit: number;
    strength: number;
  }
  interface Golden {
    positions: Positions;
    midpoints: Record<string, GoldenContact[]>;
    harmonics: Array<{
      harmonic: number;
      old: number;
      oldStructures: Array<{ focus: string; a: string; b: string; aspect: string; strength: number }>;
    }>;
  }
  const FIXTURES = ["parity-ny-1990.json", "parity-sydney-1985.json", "parity-london-2000.json"];
  // The oracle's pattern bodies: the ten planets, without Chiron, the North Node and the angles.
  const PATTERN_BODIES = new Set(["Sun", "Moo", "Mer", "Ven", "Mar", "Jup", "Sat", "Ura", "Nep", "Plu"]);
  const DEGREE_TOLERANCE = 1e-6;
  // The oracle rounds strength to 4 decimals and the old sum to 3, so the honest bound is half a unit
  // in that place. The epsilon covers float noise on the exact boundary, where a tie can round either way.
  const STRENGTH_TOLERANCE = 5e-5 + 1e-9;
  const SUM_TOLERANCE = 5e-4 + 1e-9;

  const load = (file: string): Golden =>
    JSON.parse(readFileSync(new URL(`../test/fixtures/${file}`, import.meta.url), "utf8")) as Golden;

  // A contact's identity: the focus, the unordered pair and the aspect.
  const keyOf = (c: { focus: string; a: string; b: string; aspect: string }) =>
    `${c.focus}|${[c.a, c.b].sort().join("|")}|${c.aspect}`;

  for (const file of FIXTURES) {
    describe(file, () => {
      const golden = load(file);

      it("has the same midpoint contacts at every harmonic, within 1e-6 degrees", () => {
        for (const [h, expected] of Object.entries(golden.midpoints)) {
          const actual = midpointContacts(golden.positions, Number(h), config);
          const actualByKey = new Map(actual.map((c) => [keyOf(c), c]));
          expect(actual.length, `contact count at H${h}`).toBe(expected.length);
          for (const e of expected) {
            const a = actualByKey.get(keyOf(e));
            expect(a, `${keyOf(e)} at H${h}`).toBeDefined();
            expect(Math.abs(a!.midpoint - e.midpoint), `midpoint ${keyOf(e)} at H${h}`).toBeLessThanOrEqual(
              DEGREE_TOLERANCE,
            );
            expect(Math.abs(a!.orb - e.orb), `orb ${keyOf(e)} at H${h}`).toBeLessThanOrEqual(DEGREE_TOLERANCE);
            expect(Math.abs(a!.limit - e.limit), `limit ${keyOf(e)} at H${h}`).toBeLessThanOrEqual(DEGREE_TOLERANCE);
            expect(Math.abs(a!.strength - e.strength), `strength ${keyOf(e)} at H${h}`).toBeLessThanOrEqual(
              STRENGTH_TOLERANCE,
            );
          }
        }
      });

      it("gives the same contacts from the harmonic chart as from the natal chart, within 1e-6 degrees", () => {
        // A tool that reads a harmonic chart through harmonicPositions must agree with midpointContacts(natal, H).
        for (const h of Object.keys(golden.midpoints).map(Number)) {
          const direct = midpointContacts(golden.positions, h, config);
          const viaChart = midpointContacts(harmonicPositions(golden.positions, h), 1, config);
          const byKey = new Map(viaChart.map((c) => [keyOf(c), c]));
          expect(viaChart.length, `contact count at H${h}`).toBe(direct.length);
          for (const e of direct) {
            const a = byKey.get(keyOf(e));
            expect(a, `${keyOf(e)} at H${h}`).toBeDefined();
            expect(Math.abs(a!.midpoint - e.midpoint), `midpoint ${keyOf(e)} at H${h}`).toBeLessThanOrEqual(
              DEGREE_TOLERANCE,
            );
            expect(Math.abs(a!.orb - e.orb), `orb ${keyOf(e)} at H${h}`).toBeLessThanOrEqual(DEGREE_TOLERANCE);
          }
        }
      });

      it("matches the oracle's harmonic rows: the old sum and the top three axis structures", () => {
        // The oracle's `harmonics` old measure: conjunctions and oppositions on the axis among the ten
        // pattern bodies, orb 1.5. Restricting the classic contacts to those bodies gives the same set.
        const axisOnly: MidpointConfig = {
          aspects: VIBRATIONAL_ASPECTS.filter((t) => t.harmonic <= 2),
          orb: VIBRATIONAL_MIDPOINT_ORB,
        };
        for (const row of golden.harmonics) {
          const structures = midpointContacts(golden.positions, row.harmonic, axisOnly)
            .filter((c) => PATTERN_BODIES.has(c.focus) && PATTERN_BODIES.has(c.a) && PATTERN_BODIES.has(c.b))
            .map((c) => ({ ...c, strength: Number(c.strength.toFixed(4)) }))
            .sort((x, y) => y.strength - x.strength);
          const sum = structures.reduce((total, c) => total + c.strength, 0);
          expect(Math.abs(sum - row.old), `old sum at H${row.harmonic}`).toBeLessThanOrEqual(SUM_TOLERANCE);
          const top = structures.slice(0, row.oldStructures.length);
          expect(
            top.map((c) => ({ focus: c.focus, a: c.a, b: c.b, aspect: c.aspect, strength: c.strength })),
            `top structures at H${row.harmonic}`,
          ).toEqual(row.oldStructures);
        }
      });
    });
  }
});

// The transit parity block: the oracle's transits for one UT date to the ny-1990 natal chart. The oracle rounds
// orb and strength to 4 decimals, and the fixture's longitudes have 6, so each can differ by 5e-5 plus 2e-6.
describe("transit parity against the oracle", () => {
  interface GoldenTransit {
    transit: ObjectCode;
    natal: string;
    aspect: string;
    angle: number;
    orb: number;
    limit: number;
    strength: number;
    applying: boolean;
  }
  const golden = JSON.parse(
    readFileSync(new URL("../test/fixtures/parity-transits-ny-1990.json", import.meta.url), "utf8"),
  ) as { sky: Omit<SkyPositions, "missing">; transits: GoldenTransit[] };
  const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/parity-ny-1990.json", import.meta.url), "utf8")) as {
    positions: Positions;
  };
  // The oracle's files were cast tropical, which they do not record. The sky file records no moment,
  // and transitAspects reads only the zodiac from it, so it takes the natal chart's provenance.
  const natal: Positions = {
    ...fixture.positions,
    provenance: { ...fixture.positions.provenance, ayanamsa: "tropical" },
  };
  const sky: SkyPositions = { ...golden.sky, missing: [], provenance: natal.provenance };
  // The oracle's transit limits for the vibrational pack: the natal orb 16 ÷ H, capped by transit_orb.
  const limits = VIBRATIONAL_ASPECTS.map((type) => ({
    type,
    orb: transitLimit(vibrationalNatalLimit(type.harmonic), type.harmonic),
  }));
  const ROUNDING_TOLERANCE = 5e-5 + 2e-6 + 1e-9;

  it("has the oracle's transit aspects: the same pairs, aspects, angles, orbs, strengths and applying flags", () => {
    const hits = transitAspects(natal, sky, limits);
    expect(hits).toHaveLength(golden.transits.length);
    const byPair = new Map(hits.map((h) => [`${h.transit}|${h.natal}`, h]));
    for (const e of golden.transits) {
      const h = byPair.get(`${e.transit}|${e.natal}`);
      expect(h, `${e.transit} to ${e.natal}`).toBeDefined();
      expect(h!.aspect).toBe(e.aspect);
      expect(h!.angle).toBe(e.angle);
      // The oracle steps in a straight line, so it reads a contact that is passed inside the look-ahead as applying. The reading
      // says unknown there, and unknown is never applying; every other phase is the oracle's.
      if (h!.phase === "unknown") {
        expect(h!.applying).toBe(false);
      } else {
        expect(h!.applying).toBe(e.applying);
      }
      expect(h!.limit).toBeCloseTo(e.limit, 12);
      expect(Math.abs(h!.orb - e.orb), `orb ${e.transit} to ${e.natal}`).toBeLessThanOrEqual(ROUNDING_TOLERANCE);
      expect(Math.abs(h!.strength - e.strength), `strength ${e.transit} to ${e.natal}`).toBeLessThanOrEqual(
        ROUNDING_TOLERANCE,
      );
    }
  });
});
