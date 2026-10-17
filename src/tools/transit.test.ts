import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import pLimit from "p-limit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  VIBRATIONAL_ASPECTS,
  VIBRATIONAL_ORB_RULE,
  harmonicPositions,
  harmonicSky,
  readPairings,
  transitAspects,
  transitLimit,
  vibrationalNatalLimit,
  type AspectLimit,
} from "../math.js";
import { StubEngine } from "../stub-engine.js";
import {
  AstroError,
  OBJECT_CODES,
  type Body,
  type CompositeInput,
  type ChartInput,
  type Engine,
  type Positions,
  type SkyInput,
  type SkyPositions,
} from "../types.js";
import { STUB_MARKER } from "./call.js";
import { createStubDeps, type ToolDeps } from "./deps.js";
import { birthShape } from "./input.js";
import {
  TRANSIT_DESCRIPTION,
  TRANSIT_INCLUDE,
  getTransit,
  readTransitAspects,
  transitReadingSchema,
  registerTransitTool,
  transitInputSchema,
  transitInputShape,
  transitOutputSchema,
  type TransitOutput,
  type TransitRow,
} from "./transit.js";

const BIRTH = { birth_date: "1990-06-15", birth_time: "19:30", place: "Austin, TX" };

const AUSTIN = {
  name: "Austin, TX",
  latitude: { degrees: 30.2672, hemisphere: "N" as const },
  longitude: { degrees: 97.7431, hemisphere: "W" as const },
  timezone: "America/Chicago",
};

const NOW = new Date("2026-10-14T07:06:00.456Z");

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

// Wraps an engine and records what each call was asked for.
function recordingEngine(engine: Engine = new StubEngine()) {
  const calls = { cast: [] as ChartInput[], sky: [] as SkyInput[], composite: [] as CompositeInput[] };
  const wrapped: Engine = {
    cast: (input) => {
      calls.cast.push(input);
      return engine.cast(input);
    },
    sky: (input) => {
      calls.sky.push(input);
      return engine.sky(input);
    },
    composite: (input) => {
      calls.composite.push(input);
      return engine.composite(input);
    },
  };
  return { engine: wrapped, calls };
}

// Stub dependencies with a recording engine, and a place lookup that records each name it is given.
function harness(engine: Engine = new StubEngine(), extra: Partial<ToolDeps> = {}) {
  const recorded = recordingEngine(engine);
  const places: string[] = [];
  const deps: ToolDeps = {
    ...createStubDeps(),
    engine: recorded.engine,
    resolvePlace: (text) => {
      places.push(text);
      return AUSTIN;
    },
    ...extra,
  };
  return { deps, calls: { ...recorded.calls, places } };
}

async function transit(args: Record<string, unknown>, deps: ToolDeps, now: () => Date = () => NOW) {
  return getTransit(transitInputSchema.parse(args), deps, pLimit(4), now);
}

// The tool as a client sees it: the SDK's transport, so a rejected call comes back as isError.
async function connectTransit(deps: ToolDeps, now: () => Date = () => NOW): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTransitTool(server, deps, pLimit(4), now);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "in-process", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0]?.text ?? "";
}

// The oracle's natal chart (1990, New York) and its sky at one UT moment (2000-06-15 12:00), from the
// committed golden files. The numbers are the oracle's, not ours, so these tests read real data.
const natal = (
  JSON.parse(readFileSync(new URL("../../test/fixtures/parity-ny-1990.json", import.meta.url), "utf8")) as {
    positions: Positions;
  }
).positions;
const golden = JSON.parse(
  readFileSync(new URL("../../test/fixtures/parity-transits-ny-1990.json", import.meta.url), "utf8"),
) as { sky: Omit<SkyPositions, "missing" | "provenance">; provenance: SkyPositions["provenance"] };
const goldenSky: SkyPositions = { ...golden.sky, missing: [], provenance: golden.provenance };

function fixtureEngine(): Engine {
  return {
    cast: async () => natal,
    sky: async () => goldenSky,
    composite: async () => {
      throw new Error("unused");
    },
  };
}

// The five major aspects, each with its own harmonic's orb, as the tool reads them.
const MAJOR = VIBRATIONAL_ASPECTS.filter((type) => [1, 2, 3, 4, 6].includes(type.harmonic));
const MAJOR_LIMITS: AspectLimit[] = MAJOR.map((type) => ({
  type,
  orb: transitLimit(vibrationalNatalLimit(type.harmonic), type.harmonic),
}));

// The trap: every aspect given the chart's harmonic instead of its own.
function chartHarmonicLimits(harmonic: number): AspectLimit[] {
  return MAJOR.map((type) => ({ type, orb: transitLimit(vibrationalNatalLimit(harmonic), harmonic) }));
}

describe("getTransit output", () => {
  it("reads the sky now from the clock when no moment is given", async () => {
    const { deps, calls } = harness();
    const { output } = await transit({ ...BIRTH }, deps);

    expect(calls.sky[0]?.utc).toBe("2026-10-14T07:06:00Z");
    expect(output.meta.utc).toBe("2026-10-14T07:06:00Z");
    expect(output.headline).toBe("Sun 0°00′ Aries, Moon 18°00′ Aries");
  });

  it("reads the sky at the given date and time in the given zone", async () => {
    const { deps, calls } = harness();
    const { output } = await transit(
      { ...BIRTH, transit_date: "2000-06-15", transit_time: "08:00", transit_timezone: "America/New_York" },
      deps,
    );

    expect(calls.sky[0]?.utc).toBe("2000-06-15T12:00:00Z");
    expect(output.meta.utc).toBe("2000-06-15T12:00:00Z");
  });

  it("reads the moment in UT when no zone is given", async () => {
    const { deps, calls } = harness();
    const { output } = await transit({ ...BIRTH, transit_date: "2000-06-15", transit_time: "08:00" }, deps);

    expect(calls.sky[0]?.utc).toBe("2000-06-15T08:00:00Z");
    expect(output.meta.utc).toBe("2000-06-15T08:00:00Z");
  });

  it("does not read the clock when a moment is given", async () => {
    const { deps } = harness();
    const now = vi.fn(() => NOW);
    await transit({ ...BIRTH, transit_date: "2000-06-15", transit_time: "08:00" }, deps, now);

    expect(now).not.toHaveBeenCalled();
  });

  it("gives the birth moment of the natal chart in UT, separate from the sky moment", async () => {
    const { deps, calls } = harness();
    const { output } = await transit({ ...BIRTH, transit_date: "2000-06-15", transit_time: "08:00" }, deps);

    expect(calls.cast[0]?.utc).toBe("1990-06-16T00:30:00Z");
    expect(output.meta.natal_utc).toBe("1990-06-16T00:30:00Z");
  });

  it("lists the transiting bodies in object-code order with sign, degree and retrograde, and no house", async () => {
    const { deps } = harness();
    const { output } = await transit({ ...BIRTH }, deps);

    expect(output.sky.map((body) => body.code)).toEqual(["Sun", "Moo", "Mer", "Ven", "Mar", "Jup", "Sat", "Ura", "Nep", "Plu", "Chi", "Nor", "Cer", "Pal", "Jun", "Ves", "Eri", "Hau", "Mak", "Sed"]);
    expect(output.sky[0]).toEqual({
      code: "Sun",
      name: "Sun",
      sign: "Aries",
      degree: 0,
      minute: 0,
      retrograde: false,
      text: "0°00′ Aries",
      longitude: 0,
    });
    expect(output.sky[2]).toMatchObject({ code: "Mer", retrograde: true });
    expect(output.sky.every((body) => !("house" in body))).toBe(true);
  });

  it("gives only the transiting bodies asked for", async () => {
    const { deps, calls } = harness();
    const { output } = await transit({ ...BIRTH, bodies: ["Sun", "Moo"] }, deps);

    expect(output.sky.map((body) => body.code)).toEqual(["Sun", "Moo"]);
    expect(calls.sky[0]?.bodies).toEqual(["Sun", "Moo"]);
    expect(calls.cast[0]?.bodies).toBeUndefined();
  });

  it("reports the codes the engine did not compute, for the sky or the natal chart", async () => {
    const stub = new StubEngine();
    const engine: Engine = {
      cast: async (input) => ({ ...(await stub.cast(input)), missing: ["Cer"] }),
      sky: async (input) => ({ ...(await stub.sky(input)), missing: ["Ves"] }),
      composite: (input) => stub.composite(input),
    };
    const { deps } = harness(engine);
    const { output } = await transit({ ...BIRTH }, deps);

    expect(output.missing).toEqual(["Cer", "Ves"]);
  });

  it("lists only requested codes as missing when bodies filters the sky", async () => {
    const stub = new StubEngine();
    const engine: Engine = {
      cast: async (input) => ({ ...(await stub.cast(input)), missing: ["Cer", "Sun"] }),
      sky: async (input) => ({ ...(await stub.sky(input)), missing: ["Ves"] }),
      composite: (input) => stub.composite(input),
    };
    const { deps } = harness(engine);
    const { output } = await transit({ ...BIRTH, bodies: ["Sun", "Moo"] }, deps);

    expect(output.missing).toEqual(["Sun"]);
  });

  it("ranks the aspects by orb, tightest first, and says how many there are", async () => {
    const { deps } = harness();
    const { output } = await transit({ ...BIRTH }, deps);
    const orbs = output.aspects.items.map((aspect) => aspect.orb);

    expect(output.aspects.total).toBeGreaterThan(15);
    expect(output.aspects.items).toHaveLength(15);
    expect(output.aspects.truncated).toBe(true);
    expect(orbs).toEqual([...orbs].sort((x, y) => x - y));
  });

  it("gives each aspect its names, orb, applying flag, strength and text", async () => {
    const { deps } = harness();
    const { output } = await transit({ ...BIRTH }, deps);
    const first = output.aspects.items[0];

    // The default row keeps every key it had, with the values it had, and adds the pairing, the phase and the point names.
    expect(first).toEqual({
      pairing: "T to N",
      transit_point: "Sun",
      natal_point: "Sun",
      transit_codes: ["Sun"],
      natal_codes: ["Sun"],
      transit_body: "Sun",
      natal_target: "Sun",
      aspect: "conjunction",
      orb: 0,
      phase: "separating",
      applying: false,
      strength: 1,
      text: "Transiting Sun conjunction natal Sun, orb 0°00′, separating",
    });
  });

  it("names the Ascendant and Midheaven as natal targets", async () => {
    const { deps } = harness();
    const { output } = await transit({ ...BIRTH, bodies: ["Ves"] }, deps);
    const allowed = new Set<string>([...OBJECT_CODES, "ASC", "MC"]);

    expect(defaultRows(output).every((aspect) => allowed.has(aspect.natal_target))).toBe(true);
  });

  it("writes the sky headline with the Sun and Moon when they are in the sky", async () => {
    const { deps } = harness();
    const { output } = await transit({ ...BIRTH, bodies: ["Moo", "Mar"] }, deps);

    expect(output.headline).toBe("Moon 18°00′ Aries");
  });

  it("gives the house system and the housesFrom of the natal chart", async () => {
    const { deps, calls } = harness();
    const { output } = await transit({ ...BIRTH, house_system: "whole_sign" }, deps);

    expect(calls.cast[0]?.houseSystem).toBe("whole_sign");
    expect(output.meta).toMatchObject({ house_system: "whole_sign", harmonic: 1, housesFrom: "whole_sign" });
  });
});

describe("harmonic transits", () => {
  it("reads the ordinary transit at harmonic 1, with every aspect at its own orb", async () => {
    const { output } = await getTransit(
      transitInputSchema.parse({
        birth_date: "1990-06-15",
        birth_time: "14:30",
        latitude: 40.7,
        longitude: -73.9,
        timezone: "America/New_York",
        transit_date: "2000-06-15",
        transit_time: "12:00",
      }),
      harnessFor(fixtureEngine()),
      pLimit(4),
      () => NOW,
    );
    // The tool ranks by orb; the hits come back ranked by strength, so sort them by orb here.
    const expected = transitAspects(natal, goldenSky, MAJOR_LIMITS).sort((x, y) => x.orb - y.orb);

    expect(output.meta.harmonic).toBe(1);
    expect(output.aspects.total).toBe(expected.length);
    const key = (hit: { transit: string; natal: string; aspect: string }) => `${hit.transit}|${hit.natal}|${hit.aspect}`;
    expect(defaultRows(output).map((item) => `${item.transit_body}|${item.natal_target}|${item.aspect}`)).toEqual(
      expected.slice(0, 15).map(key),
    );
  });

  it("multiplies both sides by the harmonic, so the sky reads in the harmonic chart", async () => {
    const { output } = await transitFixture(7);
    const sun = harmonicSky(goldenSky, 7).bodies.Sun;

    expect(output.meta.harmonic).toBe(7);
    expect(output.sky.find((body) => body.code === "Sun")?.longitude).toBe(sun?.longitude);
    expect(output.headline.startsWith("Harmonic 7: ")).toBe(true);
  });

  it("finds the aspects of the harmonic chart with each aspect's own orb, not the chart's harmonic", async () => {
    const { output } = await transitFixture(7);
    const expected = transitAspects(harmonicPositions(natal, 7), harmonicSky(goldenSky, 7), MAJOR_LIMITS);
    const chartHarmonic = transitAspects(harmonicPositions(natal, 7), harmonicSky(goldenSky, 7), chartHarmonicLimits(7));

    expect(output.aspects.total).toBe(expected.length);
    // The trap, pinned on real data: the chart's harmonic for every aspect finds fewer aspects here.
    expect(chartHarmonic.length).toBeLessThan(expected.length);
    expect(output.aspects.total).not.toBe(chartHarmonic.length);
  });
});

// Runs the tool on the committed fixtures, with the sky read at the oracle's UT moment.
async function transitFixture(harmonic: number) {
  return getTransit(
    transitInputSchema.parse({
      birth_date: "1990-06-15",
      birth_time: "14:30",
      latitude: 40.7,
      longitude: -73.9,
      timezone: "America/New_York",
      transit_date: "2000-06-15",
      transit_time: "12:00",
      transit_timezone: "UTC",
      harmonic,
    }),
    harnessFor(fixtureEngine()),
    pLimit(4),
    () => NOW,
  );
}

// Every reading gives the same row: one shape, told apart by its pairing. These names read a row's own keys.
type DefaultRow = TransitRow & { transit_body: string; natal_target: string };
type PairedRow = TransitRow;

function defaultRows(output: TransitOutput): DefaultRow[] {
  return output.aspects.items as DefaultRow[];
}

function pairedRows(output: TransitOutput): PairedRow[] {
  return output.aspects.items as PairedRow[];
}

function harnessFor(engine: Engine): ToolDeps {
  return { ...createStubDeps(), engine, resolvePlace: () => AUSTIN };
}

// A hand-made chart and sky, so each hit below is worked out here, not read from output. The natal chart has the Sun at 0,
// the Moon at 60, the Ascendant at 200 and the MC at 302. Its midpoints are Sun/Moo 30, Sun/ASC 280, Sun/MC 331, Moo/ASC 130,
// Moo/MC 1 and ASC/MC 251. The sky has Mars at 31 moving 0.5 a day and Jupiter at 91 moving back 0.25 a day. Their midpoint
// Mar/Jup is 61, moving 0.125 a day. Point orbs are the transit orbs: 2 degrees for a major aspect, 1 for sextile and above.
// Midpoint orbs are 1.5 degrees for the axis aspects and 3 ÷ harmonic for the rest.
const at = (longitude: number, speed = 0): Body => ({ longitude, speed, retrograde: speed < 0, house: 1 });

function sceneChart(): Positions {
  const { angles } = natal;
  return { ...natal, bodies: { Sun: at(0, 1), Moo: at(60, 13) }, angles: { ...angles, ASC: 200, MC: 302 }, missing: [] };
}

function sceneSky(mars = 31, jupiter = 91): SkyPositions {
  const { provenance } = goldenSky;
  return { bodies: { Mar: at(mars, 0.5), Jup: at(jupiter, -0.25) }, missing: [], provenance };
}

function sceneDeps(sky: SkyPositions = sceneSky()): ToolDeps {
  return harnessFor({
    cast: async () => sceneChart(),
    sky: async () => sky,
    composite: async () => {
      throw new Error("unused");
    },
  });
}

const SCENE_BIRTH = {
  birth_date: "1990-06-15",
  birth_time: "14:30",
  latitude: 40.7,
  longitude: -73.9,
  timezone: "America/New_York",
  transit_date: "2000-06-15",
  transit_time: "12:00",
  transit_timezone: "UTC",
};

async function readScene(args: Record<string, unknown> = {}, sky: SkyPositions = sceneSky()) {
  return getTransit(transitInputSchema.parse({ ...SCENE_BIRTH, ...args }), sceneDeps(sky), pLimit(4), () => NOW);
}

// One paired row as a tuple: pairing, transiting point, natal point, aspect, orb, strength, phase.
type PairedTuple = [string, string, string, string, number, number, string];

function tupleOf({ pairing, transit_point, natal_point, aspect, orb, strength, phase }: PairedRow): PairedTuple {
  return [pairing, transit_point, natal_point, aspect, orb, strength, phase];
}

// The ten major hits of the scene across the four pairings, strongest first. Ties keep the pairing order, then the order of
// the points: moving points first, then still points in chart order.
const MAJOR_HITS: PairedTuple[] = [
  // Strength 1, exact. Mars 31 is 60 from Sun/MC 331, a sextile. Jupiter 91 is 120 from Sun/MC, a trine, and 90 from
  // Moon/MC 1, a square. Mar/Jup 61 is 90 from Sun/MC, a square, and 60 from Moon/MC, a sextile. Exact hits separate.
  ["T to Nm", "Mar", "Sun/MC", "sextile", 0, 1, "separating"],
  ["T to Nm", "Jup", "Sun/MC", "trine", 0, 1, "separating"],
  ["T to Nm", "Jup", "Moo/MC", "square", 0, 1, "separating"],
  ["Tm to Nm", "Mar/Jup", "Sun/MC", "square", 0, 1, "separating"],
  ["Tm to Nm", "Mar/Jup", "Moo/MC", "sextile", 0, 1, "separating"],
  // Strength 0.5. Mars 31 is 89 from the MC 302, 1 short of the square, and its orb shrinks as it moves on. Jupiter 91 is 91
  // from the Sun, 1 past the square, and moves back toward it.
  ["T to N", "Mar", "MC", "square", 1, 0.5, "applying"],
  ["T to N", "Jup", "Sun", "square", 1, 0.5, "applying"],
  // Strength one third. Mars 31 is 1 from Sun/Moo 30, inside the 1.5 degree axis orb. Mar/Jup 61 is 1 from the Moon 60.
  ["T to Nm", "Mar", "Sun/Moo", "conjunction", 1, 0.33, "separating"],
  ["Tm to N", "Mar/Jup", "Moo", "conjunction", 1, 0.33, "separating"],
  // Strength 0. Mar/Jup 61 is 119 from the MC 302, 1 short of a trine, and moves toward it.
  ["Tm to N", "Mar/Jup", "MC", "trine", 1, 0, "applying"],
];

// With aspects "all" the points pairing adds the semisextiles and the quincunx, each 1 degree off, so each has strength 0.
const ALL_POINTS: PairedTuple[] = [
  ["T to N", "Mar", "MC", "square", 1, 0.5, "applying"],
  ["T to N", "Jup", "Sun", "square", 1, 0.5, "applying"],
  ["T to N", "Mar", "Sun", "semisextile", 1, 0, "separating"],
  ["T to N", "Mar", "Moo", "semisextile", 1, 0, "separating"],
  ["T to N", "Jup", "Moo", "semisextile", 1, 0, "applying"],
  ["T to N", "Jup", "MC", "quincunx", 1, 0, "separating"],
];

const ALL_PAIRINGS = ["T to N", "T to Nm", "Tm to N", "Tm to Nm"];

describe("transit readings by pairing", () => {
  it("reads each include value as its own pairing, with the hits worked out by hand", async () => {
    const { output } = await readScene({ include: [...TRANSIT_INCLUDE] });

    expect(pairedRows(output).map(tupleOf)).toEqual(MAJOR_HITS);
    expect(output.aspects.total).toBe(10);
  });

  it.each([
    ["to_natal_midpoints", "T to Nm"],
    ["transit_midpoints", "Tm to N"],
    ["midpoint_to_midpoint", "Tm to Nm"],
  ])("reads include %s as only its own pairing, %s", async (value, pairing) => {
    const { output } = await readScene({ include: [value] });

    expect(pairedRows(output).map(tupleOf)).toEqual(MAJOR_HITS.filter(([label]) => label === pairing));
  });

  it("reads include points with aspects all as the six T to N hits, each named T to N", async () => {
    const { output } = await readScene({ include: ["points"], aspects: "all" });

    expect(pairedRows(output).map(tupleOf)).toEqual(ALL_POINTS);
  });

  it("keeps the default reading in today's row shape, with the same two T to N hits", async () => {
    const { output } = await readScene();

    expect(defaultRows(output).map(({ transit_body, natal_target, aspect, orb, applying }) => [transit_body, natal_target, aspect, orb, applying])).toEqual([
      ["Mar", "MC", "square", 1, true],
      ["Jup", "Sun", "square", 1, true],
    ]);
  });

  it("reads one moment with readTransitAspects, with no engine, the same as the tool", async () => {
    const reading = transitReadingSchema.parse({ aspects: "all", include: [...TRANSIT_INCLUDE], aspect_limit: 0 });
    const { output } = await readScene({ ...reading });

    expect(readTransitAspects(sceneChart(), sceneSky(), reading)).toEqual(output.aspects);
  });

  it("keeps rows with the same shown strength in pairing order", async () => {
    const { output } = await readScene({ include: [...TRANSIT_INCLUDE], aspect_limit: 0 });
    const order = ["T to N", "T to Nm", "Tm to N", "Tm to Nm"];
    const rows = pairedRows(output);
    for (let i = 1; i < rows.length; i++) {
      const [before, row] = [rows[i - 1]!, rows[i]!];
      expect(before.strength).toBeGreaterThanOrEqual(row.strength);
      if (before.strength === row.strength) {
        expect(order.indexOf(before.pairing)).toBeLessThanOrEqual(order.indexOf(row.pairing));
      }
    }
  });

  it("gives each row its pairing, both points, orb, strength and phase in the text", async () => {
    const { output } = await readScene({ include: [...TRANSIT_INCLUDE] });
    const [first] = pairedRows(output);

    expect(first).toEqual({
      pairing: "T to Nm",
      transit_point: "Mar",
      natal_point: "Sun/MC",
      transit_codes: ["Mar"],
      natal_codes: ["Sun", "MC"],
      transit_body: "Mar",
      natal_target: null,
      aspect: "sextile",
      orb: 0,
      phase: "separating",
      applying: false,
      strength: 1,
      text: "Transiting Mars sextile natal midpoint of Sun and Midheaven, orb 0°00′, separating",
    });
  });

  it.each([
    ["min_strength 0 keeps every hit", 0],
    ["min_strength 0.34 drops the one third hits", 0.34],
    ["min_strength 0.5 keeps a hit at exactly 0.5", 0.5],
    ["min_strength 0.51 keeps only the exact hits and more", 0.51],
    ["min_strength 1 keeps only the exact hits", 1],
  ])("%s", async (_name, min) => {
    const { output } = await readScene({ include: [...TRANSIT_INCLUDE], min_strength: min });

    expect(pairedRows(output).map(tupleOf)).toEqual(MAJOR_HITS.filter(([, , , , , strength]) => strength >= min));
    expect(output.aspects.total).toBe(MAJOR_HITS.filter(([, , , , , strength]) => strength >= min).length);
  });

  it("cuts the list to aspect_limit, and says the total before the cut", async () => {
    const { output } = await readScene({ include: [...TRANSIT_INCLUDE], aspect_limit: 3 });

    expect(pairedRows(output).map(tupleOf)).toEqual(MAJOR_HITS.slice(0, 3));
    expect(output.aspects).toMatchObject({ total: 10, truncated: true });
  });

  it("lists every hit when aspect_limit is 0", async () => {
    const { output } = await readScene({ include: [...TRANSIT_INCLUDE], aspect_limit: 0 });

    expect(pairedRows(output)).toHaveLength(10);
    expect(output.aspects).toMatchObject({ total: 10, truncated: false });
  });

  it("applies min_strength to the default reading too", async () => {
    const { output } = await readScene({ min_strength: 0.6 });

    expect(output.aspects).toEqual({ items: [], total: 0, truncated: false });
  });

  it.each([
    ["a conjunction passed inside the look-ahead", 359.998, "conjunction"],
    ["an opposition passed inside the look-ahead", 179.998, "opposition"],
  ])("reads %s as unknown, not applying", async (_name, mars, aspect) => {
    const { output } = await readScene({ include: ["points"], aspects: "all", aspect_limit: 0 }, sceneSky(mars));
    const hit = pairedRows(output).find(
      ({ transit_point, natal_point, aspect: name }) => transit_point === "Mar" && natal_point === "Sun" && name === aspect,
    );

    expect(hit).toMatchObject({ pairing: "T to N", phase: "unknown" });
    expect(hit?.text).toContain("phase unknown");
  });

  it("reads a harmonic 2 chart: the sky doubles, and the two oppositions are found by hand", async () => {
    const { output } = await readScene({ harmonic: 2 });

    // Mars 31 and Jupiter 91 double to 62 and 182. The ASC 200 and MC 302 double to 40 and 244, and Moon 60 to 120.
    // Mars 62 is 178 from the MC 244, a 2 degree opposition, and Jupiter 182 is 178 from the Sun, the same.
    expect(output.sky.map(({ code, longitude }) => [code, longitude])).toEqual([
      ["Mar", 62],
      ["Jup", 182],
    ]);
    expect(output.headline).toBe("Harmonic 2: Mars 2°00′ Gemini, Jupiter 2°00′ Libra");
    expect(defaultRows(output).map(({ transit_body, natal_target, aspect, orb, applying }) => [transit_body, natal_target, aspect, orb, applying])).toEqual([
      ["Mar", "MC", "opposition", 2, true],
      ["Jup", "Sun", "opposition", 2, true],
    ]);
  });

  it("reads a harmonic 5 chart on the harmonic positions, with each pairing counted as the library reads it", async () => {
    const { output } = await readScene({ harmonic: 5, aspects: "all", include: [...TRANSIT_INCLUDE], aspect_limit: 0 });
    const readings = readPairings(harmonicSky(sceneSky(), 5), harmonicPositions(sceneChart(), 5), {
      aspects: VIBRATIONAL_ASPECTS,
      orb: VIBRATIONAL_ORB_RULE,
      minStrength: 0,
    });
    const counts = ALL_PAIRINGS.map((label) => pairedRows(output).filter((row) => row.pairing === label).length);

    // Mars 31 times 5 is 155; it is the one the chart has in the harmonic sky.
    expect(output.sky.find(({ code }) => code === "Mar")?.longitude).toBe(155);
    expect(counts).toEqual(ALL_PAIRINGS.map((label) => readings[label as keyof typeof readings].length));
  });

  it("returns hits of each pairing through the tool, with everything on", async () => {
    const client = await connectTransit(sceneDeps());
    const result = await client.callTool({
      name: "get_transit_data",
      arguments: { ...SCENE_BIRTH, aspects: "all", include: [...TRANSIT_INCLUDE], aspect_limit: 0 },
    });
    const output = result.structuredContent as TransitOutput;
    const pairings = [...new Set(pairedRows(output).map(({ pairing }) => pairing))].sort();

    expect(pairings).toEqual(ALL_PAIRINGS);
    await client.close();
  });

  it.each([
    ["an include value outside the four", { include: ["sun"] }],
    ["an empty include", { include: [] }],
    ["a repeated include value", { include: ["points", "points"] }],
    ["a min_strength above 1", { min_strength: 1.5 }],
    ["a negative min_strength", { min_strength: -0.1 }],
    ["a fractional aspect_limit", { aspect_limit: 1.5 }],
    ["a negative aspect_limit", { aspect_limit: -1 }],
    ["an aspects value other than major or all", { aspects: "minor" }],
  ])("refuses %s", (_name, extra) => {
    expect(transitInputSchema.safeParse({ ...BIRTH, ...extra }).success).toBe(false);
  });
});

describe("transit with an ayanamsa", () => {
  // The scene in one sidereal zodiac: the engine stamps the ayanamsa it was asked for on both results, so the natal chart and
  // the sky agree. The positions are the scene's own, so a sidereal reading must give the same rows as a tropical one.
  function siderealDeps(): ToolDeps {
    return harnessFor({
      cast: async (input) => ({ ...sceneChart(), provenance: { ...sceneChart().provenance, ayanamsa: input.ayanamsa ?? "tropical" } }),
      sky: async (input) => ({ ...sceneSky(), provenance: { ...sceneSky().provenance, ayanamsa: input.ayanamsa ?? "tropical" } }),
      composite: async () => {
        throw new Error("unused");
      },
    });
  }

  it("reads all four pairings with include, aspects, min_strength and aspect_limit, in one sidereal zodiac", async () => {
    const options = { ayanamsa: "lahiri", include: [...TRANSIT_INCLUDE], aspects: "all", min_strength: 0, aspect_limit: 0 };
    const sidereal = await getTransit(transitInputSchema.parse({ ...SCENE_BIRTH, ...options }), siderealDeps(), pLimit(4), () => NOW);
    const tropical = await readScene({ aspects: "all", include: [...TRANSIT_INCLUDE], aspect_limit: 0 });

    expect(sidereal.output.meta.ayanamsa).toBe("lahiri");
    expect(new Set(pairedRows(sidereal.output).map((row) => row.pairing))).toEqual(new Set(ALL_PAIRINGS));
    expect(sidereal.output.aspects).toEqual(tropical.output.aspects);

    const strong = await getTransit(
      transitInputSchema.parse({ ...SCENE_BIRTH, ...options, min_strength: 0.5, aspect_limit: 3 }),
      siderealDeps(),
      pLimit(4),
      () => NOW,
    );
    expect(strong.output.aspects.items).toHaveLength(3);
    expect(strong.output.aspects.truncated).toBe(true);
    expect(strong.output.aspects.items.every((row) => row.strength >= 0.5)).toBe(true);
  });
});

describe("transit inputs", () => {
  // Every declared field, paired with a change to it that the tool must act on. The table must list
  // every declared field, so a field added without a row fails here.
  const honored: Record<
    keyof typeof transitInputShape,
    { base?: Record<string, unknown>; change: Record<string, unknown>; seen: (r: { output: { meta: { utc: string; harmonic: number; house_system: string; natal_utc: string }; sky: { longitude: number }[]; aspects: TransitOutput["aspects"] }; calls: ReturnType<typeof harness>["calls"] }) => unknown }
  > = {
    birth_date: { change: { birth_date: "2001-01-02" }, seen: (r) => r.output.meta.natal_utc },
    birth_time: { change: { birth_time: "07:05" }, seen: (r) => r.output.meta.natal_utc },
    place: { change: { place: "Lisbon" }, seen: (r) => r.calls.places[0] },
    latitude: {
      change: { place: undefined, latitude: 51.5, longitude: 0.1, timezone: "Europe/London" },
      seen: (r) => r.calls.cast[0]?.latitude.degrees,
    },
    longitude: {
      change: { place: undefined, latitude: 51.5, longitude: 0.1, timezone: "Europe/London" },
      seen: (r) => r.calls.cast[0]?.longitude.hemisphere,
    },
    timezone: {
      change: { place: undefined, latitude: 51.5, longitude: 0.1, timezone: "Europe/London" },
      seen: (r) => r.output.meta.natal_utc,
    },
    transit_date: { change: { transit_date: "2001-01-02", transit_time: "12:00" }, seen: (r) => r.output.meta.utc },
    transit_time: { change: { transit_date: "2000-06-15", transit_time: "20:00" }, seen: (r) => r.output.meta.utc },
    transit_timezone: {
      change: { transit_date: "2000-06-15", transit_time: "12:00", transit_timezone: "America/New_York" },
      seen: (r) => r.output.meta.utc,
    },
    house_system: { change: { house_system: "whole_sign" }, seen: (r) => r.calls.cast[0]?.houseSystem },
    ayanamsa: { change: { ayanamsa: "lahiri" }, seen: (r) => [r.calls.cast[0]?.ayanamsa, r.calls.sky[0]?.ayanamsa] },
    harmonic: { change: { harmonic: 7 }, seen: (r) => r.output.sky.map((body) => body.longitude) },
    bodies: { change: { bodies: ["Ves"] }, seen: (r) => r.output.sky.length },
    aspects: { change: { aspects: "all" }, seen: (r) => r.output.aspects },
    include: { change: { include: ["transit_midpoints"] }, seen: (r) => r.output.aspects },
    min_strength: {
      base: { aspects: "all", include: ["points", "midpoint_to_midpoint"] },
      change: { min_strength: 0.5 },
      seen: (r) => r.output.aspects,
    },
    aspect_limit: { change: { aspect_limit: 2 }, seen: (r) => r.output.aspects },
  };

  const BASE = { ...BIRTH, transit_date: "2000-06-15", transit_time: "12:00" };

  it("has a row for every declared input field", () => {
    expect(Object.keys(honored).sort()).toEqual(Object.keys(transitInputShape).sort());
  });

  it.each(Object.keys(honored) as (keyof typeof honored)[])("honors %s", async (field) => {
    const row = honored[field];
    const common = { ...BASE, ...row.base };
    const baseline = harness(siderealStandIn());
    const base = { output: (await transit(common, baseline.deps)).output, calls: baseline.calls };
    const changed = harness(siderealStandIn());
    const next = { output: (await transit({ ...common, ...row.change }, changed.deps)).output, calls: changed.calls };

    expect(row.seen(next)).not.toEqual(row.seen(base));
  });

  it("describes every input field to the caller", () => {
    const json = z.toJSONSchema(transitInputSchema) as { properties: Record<string, { description?: string }> };
    for (const field of Object.keys(transitInputShape)) {
      expect(json.properties[field]?.description, field).toBeTruthy();
    }
  });

  it("describes every output field to the caller", () => {
    // Every object in the output schema, at any depth, describes each of its properties.
    const missing: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node !== "object" || node === null) {
        return;
      }
      const schema = node as { properties?: Record<string, { description?: string }>; items?: unknown };
      for (const [name, child] of Object.entries(schema.properties ?? {})) {
        if (!child.description) {
          missing.push(`${path}.${name}`);
        }
        walk(child, `${path}.${name}`);
      }
      walk(schema.items, `${path}[]`);
    };
    walk(z.toJSONSchema(transitOutputSchema, { io: "output" }), "output");
    expect(missing).toEqual([]);
  });

  it("names every input it honors in the tool description, and every include value and pairing", () => {
    for (const field of Object.keys(transitInputShape)) {
      expect(TRANSIT_DESCRIPTION, field).toContain(field);
    }
    for (const value of TRANSIT_INCLUDE) {
      expect(TRANSIT_DESCRIPTION, value).toContain(value);
    }
    for (const label of ["T to N", "T to Nm", "Tm to N", "Tm to Nm"]) {
      expect(TRANSIT_DESCRIPTION, label).toContain(label);
    }
  });

  it("says in the description that midpoint pairings take the midpoint orb and that include order is ignored", () => {
    const json = z.toJSONSchema(transitInputSchema) as { properties: Record<string, { description?: string }> };
    expect(json.properties.aspects?.description).toContain("classic midpoint orb");
    expect(json.properties.include?.description).toContain("in any order");
    expect(json.properties.include?.description).toContain("Repeating a value is refused");
    expect(json.properties.bodies?.description).toContain("natal chart is always whole");
  });

  it("defaults harmonic to 1", () => {
    expect(transitInputSchema.parse({ ...BIRTH }).harmonic).toBe(1);
  });

  it("refuses an unknown field instead of dropping it", () => {
    const result = transitInputSchema.safeParse({ ...BIRTH, transit_sky: "now" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  it("rejects a harmonic outside 1 to 10000, a fraction and a text value", () => {
    for (const harmonic of [0, 10001, 1.5, "7"]) {
      expect(transitInputSchema.safeParse({ ...BIRTH, harmonic }).success, String(harmonic)).toBe(false);
    }
  });

  it("rejects a repeated object code", () => {
    expect(transitInputSchema.safeParse({ ...BIRTH, bodies: ["Sun", "Sun"] }).success).toBe(false);
  });

  it("uses the same birth fields as the chart", () => {
    expect(Object.keys(transitInputShape).slice(0, Object.keys(birthShape).length)).toEqual(Object.keys(birthShape));
  });
});

describe("transit errors through the tool", () => {
  // Each case returns isError with a fix line the caller can act on.
  it.each([
    [
      "a date without a time",
      { transit_date: "2000-06-15" },
      "Give the transit date and time together, or leave both out for the sky now.",
    ],
    [
      "a time without a date",
      { transit_time: "12:00" },
      "Give the transit date and time together, or leave both out for the sky now.",
    ],
    [
      "a zone with no moment",
      { transit_timezone: "America/New_York" },
      "Give the transit time zone only with the transit date and time, or leave it out for the sky now.",
    ],
    [
      "a date that does not exist",
      { transit_date: "2000-02-30", transit_time: "12:00" },
      "Give the transit date as a date that exists, such as 2000-06-15.",
    ],
    [
      "an unknown zone name",
      { transit_date: "2000-06-15", transit_time: "12:00", transit_timezone: "Mars/Olympus" },
      "Give the transit time zone as an IANA time zone name such as America/New_York.",
    ],
    [
      "a harmonic of zero",
      { harmonic: 0 },
      "Give the harmonic as a whole number from 1 to 10000, for example 5.",
    ],
    [
      "a harmonic above 10000",
      { harmonic: 10001 },
      "Give the harmonic as a whole number from 1 to 10000, for example 5.",
    ],
    [
      "a fractional harmonic",
      { harmonic: 1.5 },
      "Give the harmonic as a whole number from 1 to 10000, for example 5.",
    ],
    [
      "no birth place and no coordinates",
      { place: undefined },
      "Give a place, or all three of latitude, longitude and time zone.",
    ],
  ])("refuses %s with a fix line", async (_name, extra, fix) => {
    const client = await connectTransit(harness().deps);
    const result = await client.callTool({ name: "get_transit_data", arguments: { ...BIRTH, ...extra } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(new RegExp(`\\nFix: ${escape(fix)}$`));
    await client.close();
  });

  it("names the unknown field and lists the valid ones", async () => {
    const client = await connectTransit(harness().deps);
    const result = await client.callTool({
      name: "get_transit_data",
      arguments: { ...BIRTH, transit_sky: "now" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Invalid input: unknown field transit_sky\n/);
    expect(textOf(result)).toMatch(/Fix: Remove that field; this tool takes the birth date, the birth time, the birth place, /);
    await client.close();
  });

  it("refuses a place name in the stub build, with a fix line", async () => {
    const client = await connectTransit(createStubDeps());
    const result = await client.callTool({ name: "get_transit_data", arguments: { ...BIRTH } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "place names are not looked up in this build\nFix: Pass latitude, longitude and time zone instead of a place name.",
    );
    await client.close();
  });

  it("returns isError with a fix line when the call runs past the timeout", async () => {
    const engine: Engine = {
      cast: () => new Promise<Positions>(() => {}),
      sky: (input) => new StubEngine().sky(input),
      composite: (input) => new StubEngine().composite(input),
    };
    const client = await connectTransit({ ...harness(engine).deps, timeoutMs: 30 });
    const result = await client.callTool({ name: "get_transit_data", arguments: { ...BIRTH } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(
      /^The transit did not finish within 0\.03 seconds\.\nFix: Retry in a moment; if it repeats, request fewer bodies\.$/,
    );
    await client.close();
  });

  it("answers an engine failure with a generic fix line and no input", async () => {
    const engine: Engine = {
      cast: async () => {
        throw new Error("boom with 1990-06-15 inside");
      },
      sky: (input) => new StubEngine().sky(input),
      composite: (input) => new StubEngine().composite(input),
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = await connectTransit(harness(engine).deps);
    const result = await client.callTool({ name: "get_transit_data", arguments: { ...BIRTH } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "The transit could not be calculated.\nFix: Retry the call; if it fails again, report it with the time it happened.",
    );
    expect(errorSpy.mock.calls.flat().join(" ")).not.toMatch(/1990-06-15/);
    errorSpy.mockRestore();
    await client.close();
  });

  it("passes an AstroError from the engine through with its fix line", async () => {
    const engine: Engine = {
      cast: async () => {
        throw new AstroError("astrolog exited with status 1", "Check the engine install, then retry.");
      },
      sky: (input) => new StubEngine().sky(input),
      composite: (input) => new StubEngine().composite(input),
    };
    const client = await connectTransit(harness(engine).deps);
    const result = await client.callTool({ name: "get_transit_data", arguments: { ...BIRTH } });

    expect(textOf(result)).toBe("astrolog exited with status 1\nFix: Check the engine install, then retry.");
    await client.close();
  });
});

describe("transit text", () => {
  it("leads a stub result with the placeholder marker, then the headline and the JSON", async () => {
    const client = await connectTransit(createStubDeps());
    const result = await client.callTool({
      name: "get_transit_data",
      arguments: { birth_date: "1990-06-15", birth_time: "19:30", latitude: 30.2672, longitude: -97.7431, timezone: "America/Chicago" },
    });
    const lines = textOf(result).split("\n");

    expect(lines[0]).toBe(STUB_MARKER);
    expect(lines[1]).toBe("Sun 0°00′ Aries, Moon 18°00′ Aries");
    expect(JSON.parse(lines[2] ?? "")).toMatchObject({ meta: { provenance: { source: "stub" } } });
    await client.close();
  });

  it("leaves the marker out of a result from a real engine", async () => {
    const client = await connectTransit(harnessFor(fixtureEngine()));
    const result = await client.callTool({
      name: "get_transit_data",
      arguments: {
        birth_date: "1990-06-15",
        birth_time: "14:30",
        latitude: 40.7,
        longitude: -73.9,
        timezone: "America/New_York",
        transit_date: "2000-06-15",
        transit_time: "12:00",
        transit_timezone: "UTC",
      },
    });

    expect(textOf(result).startsWith(STUB_MARKER)).toBe(false);
    expect(result.structuredContent).toMatchObject({ meta: { provenance: { source: "astrolog" } } });
    await client.close();
  });

  it("contains no interpretation in the text values of a result", async () => {
    const { deps } = harness();
    const { output } = await transit({ ...BIRTH }, deps);
    const values: string[] = [output.headline, ...output.sky.map((body) => body.text), ...output.aspects.items.map((item) => item.text)];
    const interpretation =
      /\b(good|bad|favou?rable|challenging|harmonious|difficult|opportunit\w*|weakness\w*|you|your|should|suggests?|indicates?|tends?|destiny|fate|luck)\b/i;

    expect(values.join("\n")).not.toMatch(interpretation);
  });
});

// Escapes the characters a regular expression would read as syntax.
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
