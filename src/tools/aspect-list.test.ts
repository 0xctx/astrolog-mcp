import { describe, expect, it } from "vitest";
import { harmonicLongitude, VIBRATIONAL_ASPECTS } from "../math.js";
import { aspectLimitField, aspectSetField, allSetLimits, readAspects } from "./aspect-list.js";
import { ASPECT_LIST_LIMIT, ASPECT_TABLE, aspectSummary, majorAspects } from "./output.js";
import { MAJOR_HARMONICS } from "./transit.js";

// Bodies at the given longitudes, and the two angles the "all" set reads.
const input = (longitudes: Record<string, number>, angles = { ASC: 200, MC: 300 }) => ({
  bodies: Object.entries(longitudes).map(([code, longitude]) => ({ code: code as "Sun", longitude })),
  angles,
});

// An aspect's identity in a list, for comparing two sets.
const keyOf = (item: { a: string; b: string; type: string }) => `${item.a}|${item.b}|${item.type}`;

describe("readAspects: the major set", () => {
  it("reads only the five major aspects between the bodies, as before the input existed", () => {
    const bodies = input({ Sun: 0, Moo: 4, Mer: 72 }, { ASC: 45, MC: 90 });
    const summary = readAspects(bodies, "major", ASPECT_LIST_LIMIT);

    expect(summary).toEqual(aspectSummary(majorAspects(bodies.bodies), ASPECT_LIST_LIMIT));
  });

  it("never lists an angle, even when an angle sits on a body", () => {
    const summary = readAspects(input({ Sun: 0 }, { ASC: 0, MC: 90 }), "major", ASPECT_LIST_LIMIT);

    expect(summary.items).toEqual([]);
    expect(summary.total).toBe(0);
  });
});

describe("readAspects: the all set", () => {
  it("lists minor aspects such as semisquare, quincunx, quintile, septile and novile", () => {
    const summary = readAspects(input({ Sun: 0, Moo: 45, Mer: 150, Ven: 72, Mar: 360 / 7, Jup: 40 }), "all", 0);
    const types = summary.items.filter((item) => item.a === "Sun").map((item) => item.type);

    expect(types).toEqual(expect.arrayContaining(["semisquare", "quincunx", "quintile", "septile", "novile"]));
  });

  it("lists ASC and MC as aspect targets, with the body first", () => {
    const summary = readAspects(input({ Sun: 0 }, { ASC: 45, MC: 270 }), "all", 0);

    // ASC and MC are 135 degrees apart, a sesquiquadrate, so the list also holds that pair.
    expect(summary.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ a: "Sun", b: "ASC", type: "semisquare", orb: 0 }),
        expect.objectContaining({ a: "Sun", b: "MC", type: "square", orb: 0 }),
        expect.objectContaining({ a: "ASC", b: "MC", type: "sesquiquadrate", orb: 0 }),
      ]),
    );
  });

  it("lists every aspect when the limit is 0, and says it was not cut", () => {
    const summary = readAspects(input({ Sun: 0, Moo: 9, Mer: 40, Ven: 72, Mar: 150, Jup: 51 }), "all", 0);

    expect(summary.total).toBeGreaterThan(ASPECT_LIST_LIMIT);
    expect(summary.items).toHaveLength(summary.total);
    expect(summary.truncated).toBe(false);
  });

  it("cuts the list to the limit and says it was cut", () => {
    const summary = readAspects(input({ Sun: 0, Moo: 9, Mer: 40, Ven: 72, Mar: 150, Jup: 51 }), "all", 3);

    expect(summary.items).toHaveLength(3);
    expect(summary.total).toBeGreaterThan(3);
    expect(summary.truncated).toBe(true);
  });

  it("names each aspect in text with the angle's name", () => {
    const summary = readAspects(input({ Sun: 0 }, { ASC: 45, MC: 270 }), "all", 0);

    expect(summary.items[0]?.text).toBe("Sun semisquare Ascendant, orb 0°00′");
  });
});

describe("the all set contains every major aspect", () => {
  it("gives the five major aspects the wider of their major orb and 16 over the harmonic", () => {
    const orbs = Object.fromEntries(allSetLimits().map(({ type, orb }) => [type.key, orb]));

    expect(orbs).toMatchObject({ conjunction: 16, opposition: 8, trine: 6, square: 6, sextile: 4, quintile: 3.2, semisquare: 2 });
  });

  it.each([
    ["sextile", 57.1],
    ["trine", 114.5],
    ["square", 84],
  ])("lists a major %s at a separation of %s degrees", (type, separation) => {
    const summary = readAspects(input({ Sun: 0, Moo: separation }), "all", 0);

    expect(summary.items).toEqual(expect.arrayContaining([expect.objectContaining({ a: "Sun", b: "Moo", type })]));
  });

  // A Sun at 0 and a Moon at each separation in 0.05 degree steps, read as a chart in harmonic H: every longitude
  // is multiplied by H, as a harmonic chart is. The major list of each separation must sit inside the all list.
  it.each([1, 2, 5])("at harmonic %s, for every separation from 0 to 360 degrees", (harmonic) => {
    const missing: string[] = [];
    let majorHits = 0;
    for (let step = 0; step < 7200; step++) {
      const separation = step * 0.05;
      const bodies = [
        { code: "Sun" as const, longitude: harmonicLongitude(0, harmonic) },
        { code: "Moo" as const, longitude: harmonicLongitude(separation, harmonic) },
      ];
      const angles = { ASC: harmonicLongitude(200, harmonic), MC: harmonicLongitude(300, harmonic) };
      const major = readAspects({ bodies, angles }, "major", 0);
      const all = new Set(readAspects({ bodies, angles }, "all", 0).items.map(keyOf));
      majorHits += major.items.length;
      for (const item of major.items) {
        if (!all.has(keyOf(item))) {
          missing.push(`${separation} ${keyOf(item)}`);
        }
      }
    }

    expect(majorHits).toBeGreaterThan(1000);
    expect(missing).toEqual([]);
  });
});

describe("strength and set appear only in the all set", () => {
  it("leaves the major list with no strength key and no set key, so its output is unchanged", () => {
    const summary = readAspects(input({ Sun: 0, Moo: 4, Mer: 72 }, { ASC: 45, MC: 90 }), "major", ASPECT_LIST_LIMIT);

    expect(Object.keys(summary)).toEqual(["items", "total", "truncated"]);
    expect(summary.items.length).toBeGreaterThan(0);
    for (const item of summary.items) {
      expect(Object.keys(item)).toEqual(["a", "b", "type", "orb", "text"]);
    }
  });

  it("gives each all item a strength between 0 and 1, says the set, and ranks by strength", () => {
    const summary = readAspects(input({ Sun: 0, Moo: 3, Mer: 41 }, { ASC: 200, MC: 300 }), "all", 0);
    const strengths = summary.items.map((item) => item.strength ?? -1);

    expect(summary.set).toBe("all");
    expect(strengths.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(strengths).toEqual([...strengths].sort((x, y) => y - x));
  });

  it("shows why a conjunction 3 degrees off ranks above a novile 1 degree off", () => {
    const summary = readAspects(input({ Sun: 0, Moo: 3, Mer: 41 }, { ASC: 200, MC: 300 }), "all", 0);
    const conjunction = summary.items.find((item) => item.a === "Sun" && item.b === "Moo" && item.type === "conjunction");
    const novile = summary.items.find((item) => item.a === "Sun" && item.b === "Mer" && item.type === "novile");

    expect(conjunction?.strength).toBe(0.81);
    expect(novile?.strength).toBe(0.44);
    expect(summary.items.indexOf(conjunction!)).toBeLessThan(summary.items.indexOf(novile!));
  });
});

describe("ASPECT_TABLE matches the vibrational aspects at the transit's major harmonics", () => {
  // ASPECT_TABLE (output.ts), the vibrational set's major harmonics (transit.ts MAJOR_HARMONICS) and the
  // vibrational angles (math.ts) must agree: the same five aspects, with the same angles.
  it("names the same five aspects, with the same angles, in both", () => {
    const vibrational = VIBRATIONAL_ASPECTS.filter((type) => MAJOR_HARMONICS.includes(type.harmonic));

    expect(Object.keys(ASPECT_TABLE).sort()).toEqual(vibrational.map((type) => type.key).sort());
    for (const type of vibrational) {
      expect(ASPECT_TABLE[type.key as keyof typeof ASPECT_TABLE].angle).toBe(type.angle);
    }
  });
});

describe("aspect inputs", () => {
  it("defaults to the major set and the usual list length", () => {
    expect(aspectSetField.parse(undefined)).toBe("major");
    expect(aspectLimitField.parse(undefined)).toBe(ASPECT_LIST_LIMIT);
  });

  it("accepts 0 for no truncation and refuses a set other than major or all, with a fix line", () => {
    expect(aspectLimitField.parse(0)).toBe(0);
    const bad = aspectSetField.safeParse("minor");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe('Give the aspect set as "major" or "all".');
  });

  it.each([-1, 1.5])("refuses aspect_limit %s with a fix line", (value) => {
    const result = aspectLimitField.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("whole number");
  });
});
