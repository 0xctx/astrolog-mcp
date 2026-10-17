import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import pLimit from "p-limit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { StubEngine } from "../stub-engine.js";
import { AstroError, type CompositeInput, type CompositePositions, type Engine } from "../types.js";
import { STUB_MARKER } from "./call.js";
import {
  compositeInputSchema,
  compositeInputShape,
  compositeOutputSchema,
  getComposite,
  registerCompositeTool,
  type CompositeArgs,
  type CompositeOutput,
} from "./composite.js";
import { createStubDeps, type ToolDeps } from "./deps.js";
import { birthShape } from "./input.js";

const AUSTIN = {
  name: "Austin, TX",
  latitude: { degrees: 30.2672, hemisphere: "N" as const },
  longitude: { degrees: 97.7431, hemisphere: "W" as const },
  timezone: "America/Chicago",
};

// Two people: A born in Austin, B in New York with explicit coordinates.
const PERSON_A = { birth_date: "1990-06-15", birth_time: "19:30", place: "Austin, TX" };
const PERSON_B = { birth_date: "1990-06-15", birth_time: "08:00", latitude: 40.7, longitude: -73.9, timezone: "America/New_York" };
const ARGS = { person_a: PERSON_A, person_b: PERSON_B, kind: "composite", house_system: "placidus" };

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

// Wraps an engine and records what each composite call was asked for, and each place name looked up.
function harness(engine: Engine = new StubEngine()) {
  const composite: CompositeInput[] = [];
  const places: string[] = [];
  const deps: ToolDeps = {
    ...createStubDeps(),
    engine: {
      cast: (input) => engine.cast(input),
      sky: (input) => engine.sky(input),
      composite: (input) => {
        composite.push(input);
        return engine.composite(input);
      },
    },
    resolvePlace: (text) => {
      places.push(text);
      return AUSTIN;
    },
  };
  return { deps, calls: { composite, places } };
}

async function composite(args: Record<string, unknown>, deps: ToolDeps) {
  return getComposite(compositeInputSchema.parse(args) as CompositeArgs, deps, pLimit(4));
}

// The tool as a client sees it, so a rejected call comes back as isError with its fix line.
async function connectComposite(deps: ToolDeps): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerCompositeTool(server, deps, pLimit(4));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "in-process", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0]?.text ?? "";
}

describe("getComposite output", () => {
  it("merges the two charts through the engine and shapes the headline, bodies, houses and angles", async () => {
    const { deps } = harness();
    const { output } = await composite(ARGS, deps);

    expect(output.headline).toBe("Sun 0°00′ Aries, Moon 18°00′ Aries, Ascendant 15°00′ Aries");
    expect(output.bodies).toHaveLength(20);
    expect(output.bodies[0]).toMatchObject({ code: "Sun", sign: "Aries", house: 12, longitude: 0 });
    expect(output.houses).toHaveLength(12);
    expect(output.angles.map((angle) => angle.code)).toEqual(["ASC", "MC", "DSC", "IC"]);
  });

  it("gives the two input moments in UT, person A first", async () => {
    const { deps, calls } = harness();
    const { output } = await composite(ARGS, deps);

    expect(calls.composite[0]?.a.utc).toBe("1990-06-16T00:30:00Z");
    expect(calls.composite[0]?.b.utc).toBe("1990-06-15T12:00:00Z");
    expect(output.meta.input_utc).toEqual(["1990-06-16T00:30:00Z", "1990-06-15T12:00:00Z"]);
  });

  it("gives no midpoint for a composite, and asks the engine for the composite", async () => {
    const { deps, calls } = harness();
    const { output } = await composite(ARGS, deps);

    expect(calls.composite[0]?.kind).toBe("composite");
    expect(output.meta.kind).toBe("composite");
    expect("davison_midpoint_utc" in output.meta).toBe(false);
  });

  it("gives the Davison midpoint of the two moments, and asks the engine for a davison", async () => {
    const { deps, calls } = harness();
    const { output } = await composite({ ...ARGS, kind: "davison" }, deps);

    expect(calls.composite[0]?.kind).toBe("davison");
    expect(output.meta.kind).toBe("davison");
    // 1990-06-16T00:30Z and 1990-06-15T12:00Z: the midpoint is 6 hours 15 minutes after the second.
    expect(output.meta.davison_midpoint_utc).toBe("1990-06-15T18:15:00Z");
  });

  it("sends each person's moment and place, with no house system", async () => {
    const { deps, calls } = harness();
    await composite(ARGS, deps);

    expect(calls.composite[0]?.a).toEqual({
      utc: "1990-06-16T00:30:00Z",
      latitude: AUSTIN.latitude,
      longitude: AUSTIN.longitude,
    });
    expect(calls.composite[0]).toMatchObject({ houseSystem: "placidus" });
    expect(calls.composite[0]?.a).not.toHaveProperty("houseSystem");
    expect(calls.places).toEqual(["Austin, TX"]);
  });

  it("reports the house system requested and the one the engine used", async () => {
    const { deps, calls } = harness();
    const { output } = await composite({ ...ARGS, house_system: "whole_sign" }, deps);

    expect(calls.composite[0]?.houseSystem).toBe("whole_sign");
    expect(output.meta).toMatchObject({ house_system: "whole_sign", housesFrom: "whole_sign" });
  });

  it("ranks the major aspects between the composite's bodies and says how many there are", async () => {
    const { deps } = harness();
    const { output } = await composite(ARGS, deps);
    const orbs = output.aspects.items.map((aspect) => aspect.orb);

    expect(output.aspects.total).toBeGreaterThan(8);
    expect(output.aspects.items).toHaveLength(8);
    expect(output.aspects.truncated).toBe(true);
    expect(orbs).toEqual([...orbs].sort((x, y) => x - y));
  });

  it("uses the engine's provenance: the version and the source", async () => {
    const { deps } = harness();
    const { output } = await composite(ARGS, deps);

    expect(output.meta.provenance).toEqual({ astrolog_version: "stub (no astrolog run)", source: "stub" });
  });
});

describe("composite aspect sets", () => {
  it("lists the angles as targets in the all set, and every aspect when aspect_limit is 0", async () => {
    const { deps } = harness();
    const { output } = await composite({ ...ARGS, aspects: "all", aspect_limit: 0 }, deps);

    expect(output.aspects.total).toBeGreaterThan(8);
    expect(output.aspects.items).toHaveLength(output.aspects.total);
    expect(output.aspects.truncated).toBe(false);
    expect(output.aspects.items.some((item) => ["ASC", "MC"].includes(item.a) || ["ASC", "MC"].includes(item.b))).toBe(true);
    expect(output.aspects.set).toBe("all");
    expect(output.aspects.items.every((item) => typeof item.strength === "number")).toBe(true);
    expect(compositeOutputSchema.safeParse(output).success).toBe(true);
  });

  it("keeps the default major set free of angles and to the usual length", async () => {
    const { deps } = harness();
    const { output } = await composite(ARGS, deps);

    expect(output.aspects.items.length).toBeLessThanOrEqual(8);
    expect(output.aspects.items.some((item) => ["ASC", "MC"].includes(item.a) || ["ASC", "MC"].includes(item.b))).toBe(false);
  });

  it("refuses an aspects value other than major or all, with a fix line", () => {
    const result = compositeInputSchema.safeParse({ ...ARGS, aspects: "minor" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Give the aspect set as "major" or "all".');
  });
});

describe("composite inputs", () => {
  const BASE = ARGS;

  // Each top-level field, with a change the tool must act on.
  const honored: Record<
    keyof typeof compositeInputShape,
    { change: Record<string, unknown>; seen: (c: ReturnType<typeof harness>["calls"], output: CompositeOutput) => unknown }
  > = {
    person_a: { change: { person_a: { ...PERSON_A, birth_date: "2001-01-02" } }, seen: (c) => c.composite[0]?.a.utc },
    person_b: { change: { person_b: { ...PERSON_B, birth_date: "2001-01-02" } }, seen: (c) => c.composite[0]?.b.utc },
    kind: { change: { kind: "davison" }, seen: (c) => c.composite[0]?.kind },
    house_system: { change: { house_system: "whole_sign" }, seen: (c) => c.composite[0]?.houseSystem },
    aspects: { change: { aspects: "all" }, seen: (_c, output) => output.aspects.total },
    aspect_limit: { change: { aspect_limit: 1 }, seen: (_c, output) => output.aspects.items.length },
    ayanamsa: { change: { ayanamsa: "lahiri" }, seen: (c) => c.composite[0]?.ayanamsa },
  };

  it("has a row for every declared input field", () => {
    expect(Object.keys(honored).sort()).toEqual(Object.keys(compositeInputShape).sort());
  });

  it.each(Object.keys(honored) as (keyof typeof honored)[])("honors %s", async (field) => {
    const row = honored[field];
    // The sidereal stand-in answers as the stub does, so every row, the aspect rows too, compares like with like.
    const baseline = harness(siderealStandIn());
    const baselineOutput = await composite(BASE, baseline.deps);
    const changed = harness(siderealStandIn());
    const changedOutput = await composite({ ...BASE, ...row.change }, changed.deps);

    expect(row.seen(changed.calls, changedOutput.output)).not.toEqual(row.seen(baseline.calls, baselineOutput.output));
  });

  // The same birth fields a person takes as get_chart_data, honored for person A.
  const personRows: Record<keyof typeof birthShape, { change: Record<string, unknown>; seen: (c: ReturnType<typeof harness>["calls"]) => unknown }> = {
    birth_date: { change: { birth_date: "2001-01-02" }, seen: (c) => c.composite[0]?.a.utc },
    birth_time: { change: { birth_time: "07:05" }, seen: (c) => c.composite[0]?.a.utc },
    place: { change: { place: "Lisbon" }, seen: (c) => c.places[0] },
    latitude: {
      change: { place: undefined, latitude: 51.5, longitude: 0.1, timezone: "Europe/London" },
      seen: (c) => c.composite[0]?.a.latitude.degrees,
    },
    longitude: {
      change: { place: undefined, latitude: 51.5, longitude: 0.1, timezone: "Europe/London" },
      seen: (c) => c.composite[0]?.a.longitude.hemisphere,
    },
    timezone: {
      change: { place: undefined, latitude: 51.5, longitude: 0.1, timezone: "Europe/London" },
      seen: (c) => c.composite[0]?.a.utc,
    },
  };

  it("has a row for every birth field of a person", () => {
    expect(Object.keys(personRows).sort()).toEqual(Object.keys(birthShape).sort());
  });

  it.each(Object.keys(personRows) as (keyof typeof personRows)[])("honors person_a.%s", async (field) => {
    const row = personRows[field];
    const baseline = harness();
    await composite(BASE, baseline.deps);
    const changed = harness();
    await composite({ ...BASE, person_a: { ...PERSON_A, ...row.change } }, changed.deps);

    expect(row.seen(changed.calls)).not.toEqual(row.seen(baseline.calls));
  });

  it("describes every field of the request and of each person to the caller", () => {
    const json = z.toJSONSchema(compositeInputSchema) as {
      properties: Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
    };
    for (const field of Object.keys(compositeInputShape)) {
      expect(json.properties[field]?.description, field).toBeTruthy();
    }
    for (const person of ["person_a", "person_b"]) {
      for (const field of Object.keys(birthShape)) {
        expect(json.properties[person]?.properties?.[field]?.description, `${person}.${field}`).toBeTruthy();
      }
    }
  });

  it("refuses an unknown field instead of dropping it", () => {
    expect(compositeInputSchema.safeParse({ ...ARGS, sidereal: true }).success).toBe(false);
  });

  it("refuses an unknown field inside a person", () => {
    expect(compositeInputSchema.safeParse({ ...ARGS, person_a: { ...PERSON_A, zodiac: "sidereal" } }).success).toBe(false);
  });
});

describe("composite errors through the tool", () => {
  it.each([
    [
      "a missing kind",
      { kind: undefined },
      'Give the chart kind as "composite" or "davison".',
    ],
    [
      "a kind that is neither",
      { kind: "sidereal" },
      'Give the chart kind as "composite" or "davison".',
    ],
    [
      "a house system that is not one of the seven",
      { house_system: "sidereal" },
      "Give the house system as one of placidus, koch, equal, campanus, regiomontanus, porphyry, whole_sign.",
    ],
    [
      "person B with both a place and coordinates",
      { person_b: { ...PERSON_B, place: "Austin, TX" } },
      "For the second person: give a place, or latitude, longitude and time zone, not both.",
    ],
    [
      "person A with no birth date",
      { person_a: { birth_time: "19:30", place: "Austin, TX" } },
      "Give the birth date as YYYY-MM-DD, for example 1990-06-15.",
    ],
  ])("refuses %s with a fix line", async (_name, extra, fix) => {
    const client = await connectComposite(harness().deps);
    const result = await client.callTool({ name: "get_composite_data", arguments: { ...ARGS, ...extra } });

    expect(result.isError).toBe(true);
    expect(textOf(result).split("\nFix: ")[1]).toBe(fix);
    await client.close();
  });

  it("names the unknown field inside a person, and lists that person's fields", async () => {
    const client = await connectComposite(harness().deps);
    const result = await client.callTool({
      name: "get_composite_data",
      arguments: { ...ARGS, person_a: { ...PERSON_A, zodiac: "sidereal" } },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Invalid input: unknown field zodiac in person_a\nFix: Remove that field; the first person takes the birth date, the birth time, the birth place, the latitude, the longitude and the time zone.",
    );
    await client.close();
  });

  it("refuses a place name in the stub build, with a fix line", async () => {
    const client = await connectComposite(createStubDeps());
    const result = await client.callTool({ name: "get_composite_data", arguments: { ...ARGS } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "place names are not looked up in this build\nFix: Pass latitude, longitude and time zone instead of a place name.",
    );
    await client.close();
  });

  it("returns isError with a fix line when the call runs past the timeout", async () => {
    const stub = new StubEngine();
    const engine: Engine = {
      cast: (input) => stub.cast(input),
      sky: (input) => stub.sky(input),
      composite: () => new Promise<CompositePositions>(() => {}),
    };
    const { deps } = harness(engine);
    const client = await connectComposite({ ...deps, timeoutMs: 30 });
    const result = await client.callTool({ name: "get_composite_data", arguments: { ...ARGS } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /^The composite did not finish within 0\.03 seconds\.\nFix: Retry in a moment; if it repeats, report it with the time it happened\.$/,
    );
    await client.close();
  });

  it("answers an engine failure with a generic fix line and no birth detail", async () => {
    const stub = new StubEngine();
    const engine: Engine = {
      cast: (input) => stub.cast(input),
      sky: (input) => stub.sky(input),
      composite: async () => {
        throw new Error("failed for 1990-06-15");
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connectComposite(harness(engine).deps);
    const result = await client.callTool({ name: "get_composite_data", arguments: { ...ARGS } });

    expect(textOf(result)).toBe(
      "The composite could not be calculated.\nFix: Retry the call; if it fails again, report it with the time it happened.",
    );
    expect(errorSpy.mock.calls.flat().join(" ")).not.toMatch(/1990-06-15/);
    errorSpy.mockRestore();
    await client.close();
  });

  it("passes an AstroError from the engine through with its fix line", async () => {
    const stub = new StubEngine();
    const engine: Engine = {
      cast: (input) => stub.cast(input),
      sky: (input) => stub.sky(input),
      composite: async () => {
        throw new AstroError("the engine did not write the composite", "Check the engine install, then retry.");
      },
    };
    const client = await connectComposite(harness(engine).deps);
    const result = await client.callTool({ name: "get_composite_data", arguments: { ...ARGS } });

    expect(textOf(result)).toBe("the engine did not write the composite\nFix: Check the engine install, then retry.");
    await client.close();
  });
});

describe("composite text", () => {
  it("leads a stub result with the placeholder marker, then the headline and the JSON", async () => {
    const client = await connectComposite(harness().deps);
    const result = await client.callTool({ name: "get_composite_data", arguments: { ...ARGS, person_a: { ...PERSON_A, place: undefined, latitude: 30.2672, longitude: -97.7431, timezone: "America/Chicago" } } });
    const lines = textOf(result).split("\n");

    expect(lines[0]).toBe(STUB_MARKER);
    expect(lines[1]).toBe("Sun 0°00′ Aries, Moon 18°00′ Aries, Ascendant 15°00′ Aries");
    expect(JSON.parse(lines[2] ?? "")).toMatchObject({ meta: { provenance: { source: "stub" } } });
    await client.close();
  });

  it("leaves the marker out of a result from a real engine", async () => {
    const stub = new StubEngine();
    const engine: Engine = {
      cast: (input) => stub.cast(input),
      sky: (input) => stub.sky(input),
      composite: async (input) => ({
        ...(await stub.composite(input)),
        provenance: { astrologVersion: "7.80", source: "astrolog", inputUtc: [input.a.utc, input.b.utc], ayanamsa: "tropical", kind: "composite" },
      }),
    };
    const client = await connectComposite(harness(engine).deps);
    const result = await client.callTool({ name: "get_composite_data", arguments: { ...ARGS } });

    expect(textOf(result).startsWith(STUB_MARKER)).toBe(false);
    expect(result.structuredContent).toMatchObject({ meta: { provenance: { source: "astrolog", astrolog_version: "7.80" } } });
    await client.close();
  });

  it("gives the output the schema declares", async () => {
    const { deps } = harness();
    const { output } = await composite(ARGS, deps);

    expect(compositeOutputSchema.safeParse(output).success).toBe(true);
  });

  it("contains no interpretation in the text values of a result", async () => {
    const { deps } = harness();
    const { output } = await composite(ARGS, deps);
    const values = [output.headline, ...output.bodies.map((body) => body.text), ...output.aspects.items.map((item) => item.text)];
    const interpretation =
      /\b(good|bad|favou?rable|challenging|harmonious|difficult|opportunit\w*|weakness\w*|you|your|should|suggests?|indicates?|tends?|destiny|fate|luck)\b/i;

    expect(values.join("\n")).not.toMatch(interpretation);
  });
});
