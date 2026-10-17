import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import pLimit from "p-limit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CallTimeoutError, withTimeout } from "../limits.js";
import { AstroError, HOUSE_SYSTEMS, HOUSE_NUMBERS, OBJECT_CODES, type Engine, type ObjectCode, type Place, type Positions } from "../types.js";
import { StubEngine } from "../stub-engine.js";
import { STUB_MARKER } from "./call.js";
import { createStubDeps, type ToolDeps } from "./deps.js";
import { CHART_TOOL_NAME, registerChartTool } from "./chart.js";
import {
  getHarmonicMidpoints,
  harmonicInputSchema,
  harmonicInputShape,
  harmonicOutputSchema,
  HARMONIC_TOOL_NAME,
  registerHarmonicTool,
  type HarmonicArgs,
  type HarmonicOutput,
} from "./harmonic.js";

const BIRTH = { birth_date: "1990-06-15", birth_time: "19:30", place: "Austin, TX" };

const AUSTIN: Place = {
  name: "Austin, TX",
  latitude: { degrees: 30.2672, hemisphere: "N" },
  longitude: { degrees: 97.7431, hemisphere: "W" },
  timezone: "America/Chicago",
};

const COORDINATES = {
  birth_date: "1990-06-15",
  birth_time: "19:30",
  latitude: 30.2672,
  longitude: -97.7431,
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

function parse(raw: Record<string, unknown>): HarmonicArgs {
  return harmonicInputSchema.parse({ harmonic: 5, ...raw });
}

// Runs one harmonic. A call that succeeds has cast the natal chart exactly once, however many structures it reads.
async function run(args: HarmonicArgs, deps: ToolDeps): Promise<HarmonicOutput> {
  let casts = 0;
  const engine = deps.engine;
  const counted: ToolDeps = {
    ...deps,
    engine: {
      cast: (input) => {
        casts += 1;
        return engine.cast(input);
      },
      sky: (input) => engine.sky(input),
      composite: (input) => engine.composite(input),
    },
  };
  const output = await getHarmonicMidpoints(args, counted, pLimit(4));
  expect(casts).toBe(1);
  return output;
}

// Positions as an astrolog run would return them, for a fixed set of longitudes. The rest of the
// bodies and the houses are placed away from each other so they make no midpoint of their own.
function positionsWith(longitudes: Partial<Record<ObjectCode, number>>, asc = 200, mc = 300): Positions {
  const bodies: Positions["bodies"] = {};
  for (const [code, longitude] of Object.entries(longitudes) as [ObjectCode, number][]) {
    bodies[code] = { longitude, speed: 1, retrograde: false, house: 1 };
  }
  const houses = Object.fromEntries(HOUSE_NUMBERS.map((house) => [house, (house - 1) * 30])) as Positions["houses"];
  return {
    bodies,
    houses,
    angles: { ASC: asc, MC: mc, DSC: (asc + 180) % 360, IC: (mc + 180) % 360 },
    missing: [],
    housesFrom: "placidus",
    provenance: { astrologVersion: "test build", source: "astrolog", utc: "1990-06-15T23:30:00Z", ayanamsa: "tropical" },
  };
}

// An engine that answers with the given positions, and nothing else.
function engineReturning(positions: Positions): Engine {
  return {
    cast: async () => positions,
    sky: async () => {
      throw new Error("unused");
    },
    composite: async () => {
      throw new Error("unused");
    },
  };
}

// Freezes an object and everything under it, so any write to a frozen value throws in strict code.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

// Connects a fresh server with the harmonic tool to an in-process client.
async function connectInProcess(deps: ToolDeps): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerHarmonicTool(server, deps, pLimit(4));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "in-process", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

// Several structures in harmonic 1: Mercury sits on the midpoint of Sun and Moon, and the other
// bodies are spread so that more contacts fall within the midpoint orb.
const SEVERAL = { Sun: 0, Moo: 10, Mer: 5, Ven: 100, Mar: 103, Jup: 200, Sat: 205, Ura: 320 };

describe("getHarmonicMidpoints output", () => {
  it("returns the harmonic, the count and the tightest structure as plain text", async () => {
    const { deps } = recordingDeps();
    const output = await run(parse({ ...BIRTH, harmonic: 1 }), deps);

    expect(output.headline).toMatch(/^Harmonic 1: \d+ midpoint structures?\. Tightest: .+, orb \d+°\d{2}′\.$/);
  });

  it("gives the harmonic positions: each longitude times H, with the Ascendant and Midheaven last", async () => {
    const { deps } = recordingDeps();
    const output = await run(parse({ ...BIRTH, harmonic: 5 }), deps);

    expect(output.harmonic_positions.bodies.map((body) => body.code)).toEqual([...OBJECT_CODES]);
    expect(output.harmonic_positions.bodies[1]).toEqual({
      code: "Moo",
      name: "Moon",
      sign: "Cancer",
      degree: 0,
      minute: 0,
      text: "0°00′ Cancer",
      longitude: 90,
    });
    expect(output.harmonic_positions.angles.map((angle) => [angle.code, angle.longitude])).toEqual([
      ["ASC", 75],
      ["MC", 345],
    ]);
  });

  it("reports the harmonic, the house system, the moment, the place and where the numbers came from", async () => {
    const { deps } = recordingDeps();
    const output = await run(parse({ ...BIRTH, harmonic: 7, house_system: "koch" }), deps);

    expect(output.meta).toEqual({
      harmonic: 7,
      house_system: "koch",
      housesFrom: "koch",
      utc: "1990-06-15T00:30:00Z",
      place: { name: "Austin, TX", latitude: "30°16′N", longitude: "97°45′W", timezone: "America/Chicago" },
      provenance: { astrolog_version: "stub (no astrolog run)", source: "stub" },
    });
    expect(output.missing).toEqual([]);
  });

  it("gives each structure the fields the contract names, with the orb and strength to four places", async () => {
    // Harmonic 1 reads every vibrational aspect, so these bodies make several exact structures. All
    // of them have orb 0, so the first one listed is the first found: Sun and ASC (midpoint 280) seen from the Moon.
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith({ Sun: 0, Moo: 10, Mer: 5 })) });
    const output = await run(parse({ ...BIRTH, harmonic: 1 }), deps);

    expect(output.structures.items[0]).toEqual({
      a: "Sun",
      b: "ASC",
      midpoint_sign_degree_text: "10°00′ Capricorn",
      focus: "Moo",
      aspect: "square",
      orb: 0,
      strength: 1,
      text: "Moon square the midpoint of Sun and Ascendant, orb 0°00′",
    });
  });

  it("gives orb and strength to four places, not the arcminute", async () => {
    // Mercury 0.6° past the midpoint of Sun and Moon: a conjunction with orb 0.6, and strength 1 − 0.6 ÷ 1.5 = 0.6.
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith({ Sun: 0, Moo: 10, Mer: 5.6 })) });
    const output = await run(parse({ ...BIRTH, harmonic: 1, limit: 50 }), deps);
    const mercury = output.structures.items.find((item) => item.focus === "Mer" && item.aspect === "conjunction");

    expect(mercury).toMatchObject({ a: "Sun", b: "Moo", orb: 0.6, strength: 0.6, text: "Mercury conjunction the midpoint of Sun and Moon, orb 0°36′" });
    expect(mercury?.strength).toBeCloseTo(1 - 0.6 / 1.5, 4);
  });
});

describe("ranking and truncation", () => {
  it("ranks the structures tightest orb first, and equal orbs by the larger strength", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith(SEVERAL)) });
    const output = await run(parse({ ...BIRTH, harmonic: 1, limit: 50 }), deps);
    const items = output.structures.items;

    expect(items.length).toBeGreaterThan(1);
    for (let i = 1; i < items.length; i++) {
      const before = items[i - 1]!;
      const after = items[i]!;
      expect(before.orb <= after.orb, `orb at ${i}`).toBe(true);
      if (before.orb === after.orb) {
        expect(before.strength >= after.strength, `strength at ${i}`).toBe(true);
      }
    }
  });

  it("cuts the list to limit and says how many structures there were in all", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith(SEVERAL)) });
    const all = await run(parse({ ...BIRTH, harmonic: 1, limit: 50 }), deps);
    const three = await run(parse({ ...BIRTH, harmonic: 1, limit: 3 }), deps);

    expect(all.structures.total).toBeGreaterThan(50);
    expect(all.structures.items.length).toBe(50);
    expect(all.structures.truncated).toBe(true);
    expect(three.structures.items).toEqual(all.structures.items.slice(0, 3));
    expect(three.structures).toMatchObject({ total: all.structures.total, truncated: true });
  });

  it("reports no truncation when every structure fits in the list", async () => {
    // Harmonic 3571 has no structure for these bodies, so the list is empty and nothing is cut.
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith({ Sun: 0, Moo: 40 }, 123.456, 77.777)) });
    const output = await run(parse({ ...BIRTH, harmonic: 3571, limit: 1 }), deps);

    expect(output.structures).toEqual({ items: [], total: 0, truncated: false });
  });

  it("lists up to twelve structures when limit is left out", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith(SEVERAL)) });
    const output = await run(parse({ ...BIRTH, harmonic: 1 }), deps);

    expect(output.structures.items.length).toBe(12);
    expect(output.structures.truncated).toBe(true);
  });

  it("says there are no structures in the headline when the harmonic has none", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith({ Sun: 0, Moo: 40 }, 123.456, 77.777)) });
    const output = await run(parse({ ...BIRTH, harmonic: 3571 }), deps);

    expect(output.headline).toBe("Harmonic 3571: 0 midpoint structures.");
  });
});

describe("frozen input", () => {
  it("does not modify the positions the engine returned", async () => {
    const frozen = deepFreeze(positionsWith(SEVERAL));
    const before = JSON.stringify(frozen);
    const { deps } = recordingDeps({ engine: engineReturning(frozen) });

    await expect(run(parse({ ...BIRTH, harmonic: 5 }), deps)).resolves.toBeDefined();
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

describe("harmonic inputs", () => {
  // Every field the schema declares, paired with a change to it that the tool must act on. The
  // table must list every declared field, so a field added without a test fails here.
  const honored: Record<
    keyof typeof harmonicInputShape,
    {
      change: Record<string, unknown>;
      seen: (calls: ReturnType<typeof recordingDeps>["calls"], output: HarmonicOutput) => unknown;
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
    harmonic: { change: { harmonic: 7 }, seen: (_c, output) => output.meta.harmonic },
    limit: { change: { limit: 1 }, seen: (_c, output) => output.structures.items.length },
  };

  it("has a row for every declared input field", () => {
    expect(Object.keys(honored).sort()).toEqual(Object.keys(harmonicInputShape).sort());
  });

  it.each(Object.keys(honored) as (keyof typeof honored)[])("honors %s", async (field) => {
    const row = honored[field];
    const engine = engineReturning(positionsWith(SEVERAL));
    const baseline = recordingDeps({ engine });
    const baselineOutput = await run(parse({ ...BIRTH }), baseline.deps);
    const changed = recordingDeps({ engine });
    const changedOutput = await run(parse({ ...BIRTH, ...row.change }), changed.deps);

    expect(row.seen(changed.calls, changedOutput)).not.toEqual(row.seen(baseline.calls, baselineOutput));
  });

  it("refuses an unknown field instead of dropping it, and names the valid fields", () => {
    const result = harmonicInputSchema.safeParse({ ...BIRTH, harmonic: 5, bodies: ["Sun"] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("requires harmonic, with a fix line that says what to give", () => {
    const result = harmonicInputSchema.safeParse({ ...BIRTH });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/^Give the harmonic as a whole number from 1 to 10000/);
  });

  it.each([0, -3, 10001, 1.5, Number.NaN, "5"])("refuses harmonic %s with a fix line", (bad) => {
    const result = harmonicInputSchema.safeParse({ ...BIRTH, harmonic: bad });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Give the harmonic as a whole number from 1 to 10000, for example 5.");
  });

  it("accepts the lowest and the highest harmonic, 1 and 10000", () => {
    expect(harmonicInputSchema.safeParse({ ...BIRTH, harmonic: 1 }).success).toBe(true);
    expect(harmonicInputSchema.safeParse({ ...BIRTH, harmonic: 10000 }).success).toBe(true);
  });

  it("refuses a limit outside 1 to 50, or not a whole number, with a fix line", () => {
    for (const bad of [0, 51, 2.5, "5"]) {
      const result = harmonicInputSchema.safeParse({ ...BIRTH, harmonic: 5, limit: bad });
      expect(result.success, String(bad)).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("Give the number of structures to list as a whole number from 1 to 50.");
    }
  });

  it("gives the limit a default of 12", () => {
    expect(parse({ ...BIRTH }).limit).toBe(12);
  });

  it("rejects a place and coordinates together, and a missing place with no coordinates", () => {
    const both = harmonicInputSchema.safeParse({ ...BIRTH, harmonic: 5, latitude: 1, longitude: 2, timezone: "Europe/London" });
    expect(both.error?.issues[0]?.message).toMatch(/not both/);
    const neither = harmonicInputSchema.safeParse({ birth_date: "1990-06-15", birth_time: "19:30", harmonic: 5 });
    expect(neither.error?.issues[0]?.message).toMatch(/all three/);
  });

  it("names every house system in the house_system description and describes every field", () => {
    const json = z.toJSONSchema(harmonicInputSchema) as { properties: Record<string, { description?: string }> };
    for (const name of Object.keys(HOUSE_SYSTEMS)) {
      expect(json.properties.house_system?.description).toContain(name);
    }
    for (const field of Object.keys(harmonicInputShape)) {
      expect(json.properties[field]?.description, field).toBeTruthy();
    }
  });
});

describe("harmonic errors", () => {
  it("refuses a harmonic outside 1 to 10000 with an AstroError and a fix line, before any engine call", async () => {
    const { deps, calls } = recordingDeps();
    for (const bad of [0, 10001]) {
      const args = { ...parse({ ...BIRTH }), harmonic: bad };
      await expect(run(args, deps)).rejects.toBeInstanceOf(AstroError);
      await expect(run(args, deps)).rejects.toMatchObject({
        fix: "Use a whole-number harmonic from 1 to 10000, for example 5.",
      });
    }
    expect(calls.cast).toEqual([]);
    expect(calls.resolvePlace).toEqual([]);
  });

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

  it("stops a call that runs past the timeout", async () => {
    const { deps } = recordingDeps({
      engine: { ...engineReturning(positionsWith({})), cast: () => new Promise<Positions>(() => {}) },
    });
    await expect(withTimeout(run(parse({ ...BIRTH }), deps), 20)).rejects.toBeInstanceOf(CallTimeoutError);
  });
});

describe("the tool as a client sees it", () => {
  it("returns isError with a fix line for a harmonic of 0, and for a missing harmonic", async () => {
    const client = await connectInProcess(createStubDeps());
    const zero = await client.callTool({ name: HARMONIC_TOOL_NAME, arguments: { ...COORDINATES, harmonic: 0 } });
    const missing = await client.callTool({ name: HARMONIC_TOOL_NAME, arguments: COORDINATES });

    expect(zero.isError).toBe(true);
    expect((zero.content[0] as { text: string }).text).toBe(
      "Invalid input: harmonic\nFix: Give the harmonic as a whole number from 1 to 10000, for example 5.",
    );
    expect(missing.isError).toBe(true);
    expect((missing.content[0] as { text: string }).text).toMatch(/\nFix: Give the harmonic as a whole number/);
    await client.close();
  });

  it("answers a call with the placeholder marker, the headline and the structured output", async () => {
    const client = await connectInProcess(createStubDeps());
    const result = await client.callTool({ name: HARMONIC_TOOL_NAME, arguments: { ...COORDINATES, harmonic: 5 } });

    expect(result.isError).toBeFalsy();
    const [marker, headline, json] = (result.content[0] as { text: string }).text.split("\n");
    expect(marker).toBe(STUB_MARKER);
    expect(headline).toBe((result.structuredContent as { headline: string }).headline);
    expect(JSON.parse(json ?? "")).toEqual(result.structuredContent);
    await client.close();
  });

  it("returns isError with a fix line when a call runs past the timeout", async () => {
    const stub = new StubEngine();
    const deps: ToolDeps = {
      ...createStubDeps(),
      engine: {
        cast: () => new Promise<Positions>(() => {}),
        sky: (input) => stub.sky(input),
        composite: (input) => stub.composite(input),
      },
      timeoutMs: 30,
    };
    const client = await connectInProcess(deps);
    const result = await client.callTool({ name: HARMONIC_TOOL_NAME, arguments: { ...COORDINATES, harmonic: 5 } });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(
      "The harmonic chart did not finish within 0.03 seconds.\nFix: Retry in a moment; if it repeats, report it with the time it happened.",
    );
    await client.close();
  });
});

describe("the advertised tool", () => {
  it("opens its description with a sentence that no other tool opens with", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerChartTool(server, createStubDeps(), pLimit(4));
    registerHarmonicTool(server, createStubDeps(), pLimit(4));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "in-process", version: "0.0.0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    const firstSentences = tools.map((tool) => tool.description?.split(/(?<=\.) /)[0]);

    expect(tools.map((tool) => tool.name)).toEqual([CHART_TOOL_NAME, HARMONIC_TOOL_NAME]);
    expect(new Set(firstSentences).size).toBe(tools.length);
    await client.close();
  });

  it("keeps the forbidden words out of every output field", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith(SEVERAL)) });
    const output = await run(parse({ ...BIRTH, harmonic: 1, limit: 50 }), deps);

    expect(JSON.stringify(output)).not.toMatch(/strong|significant|stands out/i);
    expect(JSON.stringify(z.toJSONSchema(harmonicOutputSchema))).not.toMatch(/strong|significant|stands out/i);
  });

  it("has an output schema that accepts the result of a call", async () => {
    const { deps } = recordingDeps({ engine: engineReturning(positionsWith(SEVERAL)) });
    const output = await run(parse({ ...BIRTH, harmonic: 3 }), deps);

    expect(harmonicOutputSchema.safeParse(output).success).toBe(true);
  });
});
