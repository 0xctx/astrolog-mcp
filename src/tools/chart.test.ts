import pLimit from "p-limit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AstroError, HOUSE_SYSTEMS, OBJECT_CODES, type Engine, type ObjectCode, type Place, type Positions } from "../types.js";
import { StubEngine } from "../stub-engine.js";
import { CallTimeoutError, withTimeout } from "../limits.js";
import {
  ASPECT_LIST_LIMIT,
  chartInputSchema,
  chartInputShape,
  chartOutputSchema,
  getChart,
  majorAspects,
  type ChartArgs,
  type ChartOutput,
} from "./chart.js";
import { createStubDeps, type ToolDeps } from "./deps.js";

const BIRTH = { birth_date: "1990-06-15", birth_time: "19:30", place: "Austin, TX" };

const AUSTIN: Place = {
  name: "Austin, TX",
  latitude: { degrees: 30.2672, hemisphere: "N" },
  longitude: { degrees: 97.7431, hemisphere: "W" },
  timezone: "America/Chicago",
};

// Records what the tool passed to each dependency, so a test can see which inputs were honored.
function recordingDeps(overrides: Partial<ToolDeps> = {}) {
  const calls = {
    resolvePlace: [] as string[],
    toUtc: [] as { date: string; time: string; timezone: string }[],
    cast: [] as Parameters<Engine["cast"]>[0][],
  };
  const deps: ToolDeps = {
    engine: new StubEngine(),
    resolvePlace: (text) => {
      calls.resolvePlace.push(text);
      return AUSTIN;
    },
    toUtc: (local) => {
      calls.toUtc.push({ date: local.date, time: local.time, timezone: local.timezone });
      return "1990-06-15T00:30:00Z";
    },
    ...overrides,
  };
  const engine = deps.engine;
  deps.engine = {
    cast: (input) => {
      calls.cast.push(input);
      return engine.cast(input);
    },
    sky: (input) => engine.sky(input),
    composite: (input) => engine.composite(input),
  };
  return { deps, calls };
}

// The stub with the sidereal refusal lifted, so a sidereal row can see the value reach the engine.
// Its answers are the stub's tropical placeholders, which every row compares against.
function siderealStandIn(): Engine {
  const stub = new StubEngine();
  return {
    cast: (input) => stub.cast({ ...input, ayanamsa: undefined }),
    sky: (input) => stub.sky({ ...input, ayanamsa: undefined }),
    composite: (input) => stub.composite({ ...input, ayanamsa: undefined }),
  };
}

function parse(raw: Record<string, unknown>): ChartArgs {
  return chartInputSchema.parse(raw);
}

function run(args: ChartArgs, deps: ToolDeps) {
  return getChart(args, deps, pLimit(4));
}

// A Positions with the given longitudes for the named bodies and nothing else.
function positionsWith(longitudes: Partial<Record<ObjectCode, number>>): Positions {
  const bodies: Positions["bodies"] = {};
  for (const [code, longitude] of Object.entries(longitudes) as [ObjectCode, number][]) {
    bodies[code] = { longitude, speed: 1, retrograde: false, house: 1 };
  }
  const cusps = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, i * 30])) as Positions["houses"];
  return {
    bodies,
    houses: cusps,
    angles: { ASC: 0, MC: 270, DSC: 180, IC: 90 },
    missing: [],
    housesFrom: "placidus",
    provenance: { astrologVersion: "test", source: "astrolog", utc: "1990-06-15T23:30:00Z", ayanamsa: "tropical" },
  };
}

// An engine that answers with the given positions, or never answers when given null.
function engineReturning(positions: Positions | null): Engine {
  return {
    cast: positions === null ? () => new Promise<Positions>(() => {}) : async () => positions,
    sky: async () => {
      throw new Error("unused");
    },
    composite: async () => {
      throw new Error("unused");
    },
  };
}

describe("getChart output", () => {
  it("returns the stub's positions with a headline of the Sun, Moon and Ascendant", async () => {
    const { deps } = recordingDeps();
    const output = await run(parse({ ...BIRTH }), deps);

    expect(output.headline).toBe("Sun 0°00′ Aries, Moon 18°00′ Aries, Ascendant 15°00′ Aries");
    expect(output.meta.astrolog_version).toBe("stub (no astrolog run)");
    expect(output.meta.utc).toBe("1990-06-15T00:30:00Z");
  });

  it("lists every body in object-code order with the fields the contract names", async () => {
    const { deps } = recordingDeps();
    const output = await run(parse({ ...BIRTH }), deps);

    expect(output.bodies.map((body) => body.code)).toEqual([...OBJECT_CODES]);
    expect(output.bodies[0]).toEqual({
      code: "Sun",
      name: "Sun",
      sign: "Aries",
      degree: 0,
      minute: 0,
      retrograde: false,
      // Cusp 12 is at 345 and cusp 1 at 15 in the stub, so 0 degrees falls in house 12.
      house: 12,
      text: "0°00′ Aries",
      longitude: 0,
    });
  });

  it("returns twelve houses and four angles", async () => {
    const { deps } = recordingDeps();
    const output = await run(parse({ ...BIRTH }), deps);

    expect(output.houses).toHaveLength(12);
    expect(output.houses[0]).toMatchObject({ house: 1, text: "15°00′ Aries", longitude: 15 });
    expect(output.angles.map((angle) => angle.code)).toEqual(["ASC", "MC", "DSC", "IC"]);
    expect(output.angles[1]).toMatchObject({ code: "MC", name: "Midheaven", longitude: 285 });
  });

  it("gives the requested bodies only and reports the house system astrolog used", async () => {
    const { deps, calls } = recordingDeps();
    const output = await run(parse({ ...BIRTH, bodies: ["Sun", "Moo"], house_system: "equal" }), deps);

    expect(output.bodies.map((body) => body.code)).toEqual(["Sun", "Moo"]);
    expect(calls.cast[0]).toMatchObject({ houseSystem: "equal", bodies: ["Sun", "Moo"] });
    expect(output.meta.house_system).toBe("equal");
    expect(output.meta.housesFrom).toBe("equal");
  });

  it("gives the place with its coordinate letters and time zone", async () => {
    const { deps } = recordingDeps();
    const output = await run(parse({ ...BIRTH }), deps);

    expect(output.meta.place).toEqual({
      name: "Austin, TX",
      latitude: "30°16′N",
      longitude: "97°45′W",
      timezone: "America/Chicago",
    });
  });

  it("names the explicit coordinates when no place name is given", async () => {
    const { deps, calls } = recordingDeps();
    const output = await run(
      parse({
        birth_date: "1990-06-15",
        birth_time: "19:30",
        latitude: -33.9,
        longitude: 151.2,
        timezone: "Australia/Sydney",
      }),
      deps,
    );

    expect(calls.resolvePlace).toEqual([]);
    expect(calls.cast[0]?.latitude).toEqual({ degrees: 33.9, hemisphere: "S" });
    expect(output.meta.place).toMatchObject({
      name: "33°54′S 151°12′E",
      latitude: "33°54′S",
      longitude: "151°12′E",
    });
  });
});

describe("getChart inputs", () => {
  // Every field the schema declares, paired with a change to it that the tool must act on. The
  // table must list every declared field, so a field added without a test fails here.
  // `seen` gets the recorded calls and the output, for a field that changes the output only (harmonic).
  const honored: Record<
    keyof typeof chartInputShape,
    {
      change: Record<string, unknown>;
      seen: (calls: ReturnType<typeof recordingDeps>["calls"], output: ChartOutput) => unknown;
    }
  > = {
    birth_date: { change: { birth_date: "2001-01-02" }, seen: (c) => c.toUtc[0]?.date },
    birth_time: { change: { birth_time: "07:05" }, seen: (c) => c.toUtc[0]?.time },
    place: { change: { place: "Lisbon" }, seen: (c) => c.resolvePlace[0] },
    latitude: {
      change: { place: undefined, latitude: 51.5, longitude: 0.1, timezone: "Europe/London" },
      seen: (c) => c.cast[0]?.latitude.degrees,
    },
    longitude: {
      change: { place: undefined, latitude: 51.5, longitude: 0.1, timezone: "Europe/London" },
      seen: (c) => c.cast[0]?.longitude.hemisphere,
    },
    timezone: {
      change: { place: undefined, latitude: 51.5, longitude: 0.1, timezone: "Europe/London" },
      seen: (c) => c.toUtc[0]?.timezone,
    },
    house_system: { change: { house_system: "whole_sign" }, seen: (c) => c.cast[0]?.houseSystem },
    ayanamsa: { change: { ayanamsa: "lahiri" }, seen: (c) => c.cast[0]?.ayanamsa },
    harmonic: { change: { harmonic: 5 }, seen: (_c, output) => output.bodies.find((body) => body.code === "Moo")?.longitude },
    bodies: { change: { bodies: ["Ves"] }, seen: (c) => c.cast[0]?.bodies },
    aspects: { change: { aspects: "all" }, seen: (_c, output) => output.aspects.total },
    aspect_limit: { change: { aspect_limit: 1 }, seen: (_c, output) => output.aspects.items.length },
  };

  it("has a row for every declared input field", () => {
    expect(Object.keys(honored).sort()).toEqual(Object.keys(chartInputShape).sort());
  });

  it.each(Object.keys(honored) as (keyof typeof honored)[])("honors %s", async (field) => {
    const row = honored[field];
    const baseline = recordingDeps({ engine: siderealStandIn() });
    const baselineOutput = await run(parse({ ...BIRTH }), baseline.deps);
    const changed = recordingDeps({ engine: siderealStandIn() });
    const changedOutput = await run(parse({ ...BIRTH, ...row.change }), changed.deps);

    expect(row.seen(changed.calls, changedOutput)).not.toEqual(row.seen(baseline.calls, baselineOutput));
  });
});

describe("retrograde", () => {
  // The flag follows the speed, so an engine flag that disagrees with it does not reach the caller.
  it("is true exactly when the body's speed is negative", async () => {
    const positions = positionsWith({ Sun: 0, Mer: 36 });
    positions.bodies.Mer = { longitude: 36, speed: -1.2, retrograde: false, house: 1 };
    positions.bodies.Sun = { longitude: 0, speed: 0.9, retrograde: true, house: 1 };
    const { deps } = recordingDeps({ engine: engineReturning(positions) });
    const output = await run(parse({ ...BIRTH, bodies: ["Sun", "Mer"] }), deps);

    expect(output.bodies.map((body) => [body.code, body.retrograde])).toEqual([
      ["Sun", false],
      ["Mer", true],
    ]);
  });
});

describe("majorAspects", () => {
  const pair = (a: number, b: number) =>
    majorAspects([
      { code: "Sun", longitude: a },
      { code: "Moo", longitude: b },
    ]);

  it.each([
    ["conjunction", 0, 4, "conjunction", 4],
    ["sextile", 0, 62, "sextile", 2],
    ["square", 0, 88, "square", 2],
    ["trine", 0, 118, "trine", 2],
    ["opposition", 0, 178, "opposition", 2],
  ])("finds a %s within its orb", (_name, a, b, type, deviation) => {
    const [aspect] = pair(a, b);
    expect(aspect?.type).toBe(type);
    expect(aspect?.deviation).toBeCloseTo(deviation, 10);
  });

  it("finds nothing outside every orb", () => {
    expect(pair(0, 160)).toEqual([]);
  });

  it("measures the short way round the zodiac", () => {
    const [aspect] = pair(359, 1);
    expect(aspect?.type).toBe("conjunction");
    expect(aspect?.deviation).toBeCloseTo(2, 10);
  });

  it("ranks the tightest aspect first", () => {
    const aspects = majorAspects([
      { code: "Sun", longitude: 0 },
      { code: "Moo", longitude: 7 },
      { code: "Mer", longitude: 2 },
    ]);
    expect(aspects.map((aspect) => aspect.deviation)).toEqual([...aspects.map((aspect) => aspect.deviation)].sort((x, y) => x - y));
    expect(aspects[0]).toMatchObject({ a: "Sun", b: "Mer" });
  });

  it("shows the orb as degrees to two places and as a text line", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith({ Sun: 0, Moo: 0.0833 })) });
    const output = await run(parse({ ...BIRTH, bodies: ["Sun", "Moo"] }), deps);

    expect(output.aspects.items).toEqual([
      { a: "Sun", b: "Moo", type: "conjunction", orb: 0.08, text: "Sun conjunction Moon, orb 0°05′" },
    ]);
  });

  it("lists the eight tightest aspects and says how many there were", async () => {
    const longitudes: Partial<Record<ObjectCode, number>> = {};
    OBJECT_CODES.forEach((code, i) => {
      longitudes[code] = i * 7;
    });
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith(longitudes)) });
    const output = await run(parse({ ...BIRTH }), deps);

    expect(output.aspects.items).toHaveLength(ASPECT_LIST_LIMIT);
    expect(output.aspects.total).toBeGreaterThan(ASPECT_LIST_LIMIT);
    expect(output.aspects.truncated).toBe(true);
    const orbs = output.aspects.items.map((aspect) => aspect.orb);
    expect(orbs).toEqual([...orbs].sort((x, y) => x - y));
  });

  it("adds no strength and no set to the default aspects, and both to the all set", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith({ Sun: 0, Moo: 3, Mer: 41 })) });
    const major = await run(parse({ ...BIRTH }), deps);
    const all = await run(parse({ ...BIRTH, aspects: "all", aspect_limit: 0 }), deps);

    expect(Object.keys(major.aspects)).toEqual(["items", "total", "truncated"]);
    expect(major.aspects.items.every((item) => !("strength" in item))).toBe(true);
    expect(all.aspects.set).toBe("all");
    expect(all.aspects.items.every((item) => typeof item.strength === "number")).toBe(true);
  });

  it("reports no truncation when every aspect fits in the list", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith({ Sun: 0, Moo: 4 })) });
    const output = await run(parse({ ...BIRTH, bodies: ["Sun", "Moo"] }), deps);

    expect(output.aspects).toMatchObject({ total: 1, truncated: false });
  });
});

describe("getChart aspect sets", () => {
  // The bodies and the ASC and MC of a fixed chart. ASC is moved to 45 in the ASC test; MC stays at 270.
  const MINOR = { Sun: 0, Moo: 45, Mer: 150, Ven: 72, Mar: 360 / 7, Jup: 40 };
  const fixed = (longitudes: Partial<Record<ObjectCode, number>>, angles: Partial<Positions["angles"]> = {}) => {
    const positions = positionsWith(longitudes);
    return { ...positions, angles: { ...positions.angles, ...angles } };
  };

  it("keeps the default output the same as the explicit major set with the usual list length", async () => {
    const positions = fixed({ Sun: 0, Moo: 4, Mer: 72, Ven: 120 });
    const defaults = await run(parse({ ...BIRTH }), recordingDeps({ engine: engineReturning(positions) }).deps);
    const explicit = await run(
      parse({ ...BIRTH, aspects: "major", aspect_limit: ASPECT_LIST_LIMIT }),
      recordingDeps({ engine: engineReturning(positions) }).deps,
    );

    expect(explicit).toEqual(defaults);
    expect(parse({ ...BIRTH })).toMatchObject({ aspects: "major", aspect_limit: ASPECT_LIST_LIMIT });
  });

  it("lists the minor aspects with aspect_limit 0, with the total and no truncation", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(fixed(MINOR)) });
    const output = await run(parse({ ...BIRTH, aspects: "all", aspect_limit: 0 }), deps);

    expect(output.aspects.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ a: "Sun", b: "Moo", type: "semisquare" }),
        expect.objectContaining({ a: "Sun", b: "Mer", type: "quincunx" }),
        expect.objectContaining({ a: "Sun", b: "Ven", type: "quintile" }),
        expect.objectContaining({ a: "Sun", b: "Mar", type: "septile" }),
        expect.objectContaining({ a: "Sun", b: "Jup", type: "novile" }),
      ]),
    );
    expect(output.aspects.total).toBe(output.aspects.items.length);
    expect(output.aspects.truncated).toBe(false);
  });

  it("lists ASC and MC as aspect targets in the all set, and not in the major set", async () => {
    const positions = fixed({ Sun: 0 }, { ASC: 45 });
    const all = await run(parse({ ...BIRTH, aspects: "all", aspect_limit: 0 }), recordingDeps({ engine: engineReturning(positions) }).deps);
    const major = await run(parse({ ...BIRTH, aspects: "major", aspect_limit: 0 }), recordingDeps({ engine: engineReturning(positions) }).deps);

    expect(all.aspects.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ a: "Sun", b: "ASC", type: "semisquare" }),
        expect.objectContaining({ a: "Sun", b: "MC", type: "square" }),
      ]),
    );
    expect(major.aspects.items.flatMap((item) => [item.a, item.b]).some((code) => code === "ASC" || code === "MC")).toBe(false);
  });

  it("works in a harmonic 5 chart: Moon at 9 is at 45 in harmonic 5, a semisquare to the Sun", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(fixed({ Sun: 0, Moo: 9 })) });
    const output = await run(parse({ ...BIRTH, harmonic: 5, aspects: "all", aspect_limit: 0 }), deps);

    expect(output.meta.harmonic).toBe(5);
    expect(output.bodies.find((body) => body.code === "Moo")?.longitude).toBeCloseTo(45, 6);
    expect(output.aspects.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ a: "Sun", b: "Moo", type: "semisquare", orb: 0 })]),
    );
  });

  it("cuts the all set to aspect_limit and says how many there were", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(fixed(MINOR)) });
    const output = await run(parse({ ...BIRTH, aspects: "all", aspect_limit: 2 }), deps);

    expect(output.aspects.items).toHaveLength(2);
    expect(output.aspects.total).toBeGreaterThan(2);
    expect(output.aspects.truncated).toBe(true);
  });

  it("refuses an unknown aspects value and a bad aspect_limit, each with a fix line", () => {
    const badSet = chartInputSchema.safeParse({ ...BIRTH, aspects: "minor" });
    expect(badSet.success).toBe(false);
    expect(badSet.error?.issues[0]?.message).toBe('Give the aspect set as "major" or "all".');

    const negative = chartInputSchema.safeParse({ ...BIRTH, aspect_limit: -1 });
    expect(negative.success).toBe(false);
    expect(negative.error?.issues[0]?.message).toContain("aspect limit");
  });
});

describe("getChart errors", () => {
  it("passes an AstroError from the place lookup through unchanged", async () => {
    const { deps } = recordingDeps({
      resolvePlace: () => {
        throw new AstroError("no place named Nowhere", "Give a place name the lookup knows, or pass coordinates.");
      },
    });
    await expect(run(parse({ ...BIRTH, place: "Nowhere" }), deps)).rejects.toMatchObject({
      message: "no place named Nowhere",
      fix: "Give a place name the lookup knows, or pass coordinates.",
    });
  });

  it("refuses place names in the stub build with a fix line", async () => {
    await expect(run(parse({ ...BIRTH }), createStubDeps())).rejects.toBeInstanceOf(AstroError);
  });

  it("stops a call that runs past the timeout", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(null) });
    await expect(withTimeout(run(parse({ ...BIRTH }), deps), 20)).rejects.toBeInstanceOf(CallTimeoutError);
  });
});

describe("schemas", () => {
  it("names every house system and object code in the input descriptions", () => {
    const json = z.toJSONSchema(chartInputSchema) as { properties: Record<string, { description?: string }> };
    for (const name of Object.keys(HOUSE_SYSTEMS)) {
      expect(json.properties.house_system?.description).toContain(name);
    }
    for (const code of OBJECT_CODES) {
      expect(json.properties.bodies?.description).toContain(code);
    }
  });

  it("refuses an unknown field instead of dropping it", () => {
    const result = chartInputSchema.safeParse({ ...BIRTH, house_sytem: "koch" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("gives an actionable message when birth_date or birth_time is missing", () => {
    const missingDate = chartInputSchema.safeParse({ birth_time: "19:30", place: "Austin, TX" });
    expect(missingDate.error?.issues[0]?.message).toBe("Give the birth date as YYYY-MM-DD, for example 1990-06-15.");
    const missingTime = chartInputSchema.safeParse({ birth_date: "1990-06-15", place: "Austin, TX" });
    expect(missingTime.error?.issues[0]?.message).toBe("Give the birth time as 24-hour HH:MM, for example 19:30.");
  });

  it("describes every input field to the caller", () => {
    const json = z.toJSONSchema(chartInputSchema) as { properties: Record<string, { description?: string }> };
    for (const field of Object.keys(chartInputShape)) {
      expect(json.properties[field]?.description, field).toBeTruthy();
    }
  });

  it("describes every output field", () => {
    const json = z.toJSONSchema(chartOutputSchema) as Record<string, unknown>;
    expect(JSON.stringify(json)).toContain('"description"');
    expect(chartOutputSchema.shape.headline).toBeDefined();
  });

  it("rejects a place and coordinates together, with a fix line", () => {
    const result = chartInputSchema.safeParse({ ...BIRTH, latitude: 1, longitude: 2, timezone: "Europe/London" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/not both/);
  });

  it("requires a place or all three coordinates", () => {
    const result = chartInputSchema.safeParse({ birth_date: "1990-06-15", birth_time: "19:30", latitude: 1 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/all three/);
  });

  it("rejects a repeated object code", () => {
    const result = chartInputSchema.safeParse({ ...BIRTH, bodies: ["Sun", "Sun"] });
    expect(result.success).toBe(false);
  });

  it("rejects a house system that is not one of the seven", () => {
    expect(chartInputSchema.safeParse({ ...BIRTH, house_system: "sidereal" }).success).toBe(false);
  });
});

describe("output wording", () => {
  it("contains no interpretation words", async () => {
    const { deps } = recordingDeps();
    const output = await run(parse({ ...BIRTH }), deps);
    const text = JSON.stringify(output);
    const interpretation =
      /\b(good|bad|favou?rable|challenging|harmonious|difficult|opportunit\w*|strengths?|weakness\w*|you|your|should|suggests?|indicates?|tends?|destiny|fate|luck)\b/i;

    expect(text).not.toMatch(interpretation);
  });
});

describe("the harmonic parameter", () => {
  // The stub's Moon is at 18 and its Ascendant at 15, so harmonic 5 puts the Moon at 90 (Cancer) and the Ascendant at 75 (Gemini).
  it("leaves the default output as it was: no harmonic is the same as harmonic 1", async () => {
    const { deps } = recordingDeps();
    const omitted = await run(parse({ ...BIRTH }), deps);
    const explicit = await run(parse({ ...BIRTH, harmonic: 1 }), recordingDeps().deps);

    expect(omitted).toEqual(explicit);
    expect(omitted.meta.harmonic).toBe(1);
    expect(omitted.headline).toBe("Sun 0°00′ Aries, Moon 18°00′ Aries, Ascendant 15°00′ Aries");
  });

  it("multiplies every body longitude by the harmonic and wraps at 360", async () => {
    const { deps } = recordingDeps();
    const output = await run(parse({ ...BIRTH, harmonic: 5, bodies: ["Sun", "Moo", "Mer", "Ven", "Mar"] }), deps);

    expect(output.bodies.map((body) => [body.code, body.longitude])).toEqual([
      ["Sun", 0],
      ["Moo", 90],
      ["Mer", 180],
      ["Ven", 270],
      // 72 × 5 is 360, which is 0 on the circle.
      ["Mar", 0],
    ]);
    expect(output.meta.harmonic).toBe(5);
  });

  it("keeps the house each body falls in, and the retrograde flag, from the natal chart", async () => {
    const { deps: natalDeps } = recordingDeps();
    const natal = await run(parse({ ...BIRTH }), natalDeps);
    const { deps } = recordingDeps();
    const harmonic = await run(parse({ ...BIRTH, harmonic: 5 }), deps);

    expect(harmonic.bodies.map((body) => [body.code, body.house, body.retrograde])).toEqual(
      natal.bodies.map((body) => [body.code, body.house, body.retrograde]),
    );
    // Mercury is retrograde in the stub at every harmonic: its speed times H keeps the sign.
    expect(harmonic.bodies.find((body) => body.code === "Mer")?.retrograde).toBe(true);
  });

  it("multiplies the houses and the angles, and gives the harmonic headline", async () => {
    const { deps } = recordingDeps();
    const output = await run(parse({ ...BIRTH, harmonic: 5 }), deps);

    expect(output.houses[0]).toMatchObject({ house: 1, text: "15°00′ Gemini", longitude: 75 });
    expect(output.angles.find((angle) => angle.code === "ASC")).toMatchObject({ text: "15°00′ Gemini", longitude: 75 });
    expect(output.angles.find((angle) => angle.code === "MC")).toMatchObject({ text: "15°00′ Pisces", longitude: 345 });
    expect(output.headline).toBe("Sun 0°00′ Aries, Moon 0°00′ Cancer, Ascendant 15°00′ Gemini");
  });

  it("computes the aspects on the harmonic positions, not the natal ones", async () => {
    // Sun 0 and Moon 18 have no major aspect at harmonic 1; at harmonic 5 they are 0 and 90, a square.
    const natal = await run(parse({ ...BIRTH, bodies: ["Sun", "Moo"] }), recordingDeps().deps);
    const harmonic = await run(parse({ ...BIRTH, bodies: ["Sun", "Moo"], harmonic: 5 }), recordingDeps().deps);

    expect(natal.aspects.total).toBe(0);
    expect(harmonic.aspects.items).toEqual([
      { a: "Sun", b: "Moo", type: "square", orb: 0, text: "Sun square Moon, orb 0°00′" },
    ]);
  });

  it("refuses a harmonic outside 1 to 10000, or one that is not a whole number, with a fix line", () => {
    for (const bad of [0, 10001, 1.5, -2]) {
      const result = chartInputSchema.safeParse({ ...BIRTH, harmonic: bad });
      expect(result.success, String(bad)).toBe(false);
      expect(result.error?.issues[0]?.message, String(bad)).toBe(
        "Give the harmonic as a whole number from 1 to 10000, for example 5.",
      );
    }
  });

  it("names the harmonic in the field's description", () => {
    const json = z.toJSONSchema(chartInputSchema) as { properties: Record<string, { description?: string }> };

    expect(json.properties.harmonic?.description).toMatch(/1 to 10000/);
    expect(json.properties.harmonic?.description).toMatch(/not recalculated cusps/);
  });
});
