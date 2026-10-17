import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { MIN_ENGINE_QUEUE } from "./limits.js";
import { PLACE_ALIASES } from "./place-aliases.js";
import { createRegistry, toolNames } from "./registry.js";
import { STUB_MARKER } from "./tools/call.js";
import { createStubDeps, type ToolDeps } from "./tools/deps.js";
import { StubEngine } from "./stub-engine.js";
import type { Positions } from "./types.js";

// Connects a fresh server to an in-process client. The registry needs no HTTP to be tested.
async function connectInProcess(registry: ReturnType<typeof createRegistry>): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registry.register(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "in-process", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

// The description of every "place" property in a tool's input schema, including the ones nested under
// person_a and person_b in the composite tool.
function placeDescriptions(node: unknown): string[] {
  if (typeof node !== "object" || node === null) {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === "place" && typeof value === "object" && value !== null && "description" in value) {
      return [String(value.description)];
    }
    return placeDescriptions(value);
  });
}

// The single-quoted spellings in a place description. The example place name is quoted too, but it is a
// name, not a shorthand, so it is left out.
function quotedSpellings(description: string): string[] {
  return [...description.matchAll(/'([^']+)'/g)].map((match) => match[1]!).filter((text) => text !== "Austin, TX");
}

const COORDINATES = {
  birth_date: "1990-06-15",
  birth_time: "19:30",
  latitude: 30.2672,
  longitude: -97.7431,
  timezone: "America/Chicago",
};

describe("createRegistry", () => {
  it("registers the chart, transit, composite, harmonic and daily tools on any server it is given, with no transport involved", async () => {
    const client = await connectInProcess(createRegistry(createStubDeps()));
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      "get_chart_data",
      "get_transit_data",
      "get_composite_data",
      "get_harmonic_midpoints",
      "get_daily_transits",
    ]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(toolNames());
    await client.close();
  });

  it("names every place shorthand, and no docs pointer, in each place description tools/list sends", async () => {
    const client = await connectInProcess(createRegistry(createStubDeps()));
    const { tools } = await client.listTools();

    for (const tool of tools) {
      const descriptions = placeDescriptions(tool.inputSchema);
      expect(descriptions.length, tool.name).toBeGreaterThan(0);
      for (const description of descriptions) {
        for (const { alias } of PLACE_ALIASES) {
          expect(description, `${tool.name} ${alias}`).toContain(`'${alias}'`);
        }
        expect(description, tool.name).not.toContain("docs/tools.md");
        // Both ways: every quoted spelling is an alias, and every alias is quoted. Removing a row fails here.
        expect(quotedSpellings(description).sort(), tool.name).toEqual(PLACE_ALIASES.map(({ alias }) => alias).sort());
      }
    }
    await client.close();
  });

  it("gives each tool a first sentence of its own, and no astrolog wording while the stub is active", async () => {
    const client = await connectInProcess(createRegistry(createStubDeps()));
    const { tools } = await client.listTools();
    const firstSentences = tools.map((tool) => (tool.description ?? "").split(/(?<=\.) /)[0]);

    expect(new Set(firstSentences).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/^Call this when /);
      expect((tool.description ?? "").split(STUB_MARKER).join(""), tool.name).not.toMatch(/astrolog/i);
    }
    await client.close();
  });

  it("calls the tool in process and returns the stub's headline", async () => {
    const client = await connectInProcess(createRegistry(createStubDeps()));
    const result = await client.callTool({ name: "get_chart_data", arguments: COORDINATES });

    expect(result.structuredContent).toMatchObject({
      headline: "Sun 0°00′ Aries, Moon 18°00′ Aries, Ascendant 15°00′ Aries",
    });
    await client.close();
  });

  it("refuses a chart call once engineQueue calls are already waiting for the one slot", async () => {
    const stub = new StubEngine();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const deps: ToolDeps = {
      ...createStubDeps(),
      engine: {
        cast: async (input) => {
          await gate;
          return stub.cast(input);
        },
        sky: (input) => stub.sky(input),
        composite: (input) => stub.composite(input),
      },
    };
    const client = await connectInProcess(createRegistry(deps, { engineConcurrency: 1, engineQueue: 1 }));
    const running = client.callTool({ name: "get_chart_data", arguments: COORDINATES });
    const waiting = client.callTool({ name: "get_chart_data", arguments: COORDINATES });
    const refused = await client.callTool({ name: "get_chart_data", arguments: COORDINATES });

    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("The server is busy, retry shortly.");
    release();
    expect((await running).isError).not.toBe(true);
    expect((await waiting).isError).not.toBe(true);
    await client.close();
  });

  it("answers a daily reading on the smallest allowed limits: one slot and the minimum queue", async () => {
    const client = await connectInProcess(createRegistry(createStubDeps(), { engineConcurrency: 1, engineQueue: MIN_ENGINE_QUEUE }));
    const result = await client.callTool({ name: "get_daily_transits", arguments: { ...COORDINATES, date: "2026-10-14" } });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ meta: { provenance: { source: "stub" } } });
    await client.close();
  });

  it("refuses a daily reading when the queue is one below the minimum, because it queues four engine calls", async () => {
    const client = await connectInProcess(createRegistry(createStubDeps(), { engineConcurrency: 1, engineQueue: MIN_ENGINE_QUEUE - 1 }));
    const result = await client.callTool({ name: "get_daily_transits", arguments: { ...COORDINATES, date: "2026-10-14" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("The server is busy, retry shortly.");
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
    const client = await connectInProcess(createRegistry(deps));
    const result = await client.callTool({ name: "get_chart_data", arguments: COORDINATES });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /^The chart did not finish within 0\.03 seconds\.\nFix: Retry in a moment; if it repeats, request fewer bodies\.$/,
    );
    await client.close();
  });

  it("abandons queued calls that timed out, and refuses the excess once the queue is full", async () => {
    let casts = 0;
    const stub = new StubEngine();
    const deps: ToolDeps = {
      ...createStubDeps(),
      engine: {
        cast: async (input): Promise<Positions> => {
          casts += 1;
          await new Promise((resolve) => setTimeout(resolve, 400));
          return stub.cast(input);
        },
        sky: (input) => stub.sky(input),
        composite: (input) => stub.composite(input),
      },
      timeoutMs: 100,
    };
    const client = await connectInProcess(createRegistry(deps));

    const results = await Promise.all(
      Array.from({ length: 40 }, () => client.callTool({ name: "get_chart_data", arguments: COORDINATES })),
    );
    const texts = results.map((result) => (result.content[0] as { text: string }).text);
    const timedOut = texts.filter((text) => text.startsWith("The chart did not finish within 0.1 seconds.")).length;
    const busy = texts.filter((text) => text.endsWith("\nFix: The server is busy, retry shortly.")).length;

    // Every call is refused or times out; none succeeds. The cap admits at most the four running
    // calls and sixteen waiting ones, so at least 20 of the 40 are refused as busy.
    expect(timedOut + busy).toBe(40);
    expect(timedOut).toBeLessThanOrEqual(4 + 16);
    expect(busy).toBeGreaterThanOrEqual(40 - (4 + 16));

    // The four running casts finish after 400 ms. The waiting ones were abandoned, so they start
    // no engine work when their slot frees.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(casts).toBeLessThanOrEqual(4);
    await client.close();
  });

  it("holds at most four engine calls in flight across concurrent tool calls", async () => {
    let inFlight = 0;
    let peak = 0;
    const stub = new StubEngine();
    const deps: ToolDeps = {
      ...createStubDeps(),
      engine: {
        cast: async (input): Promise<Positions> => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20));
          inFlight -= 1;
          return stub.cast(input);
        },
        sky: (input) => stub.sky(input),
        composite: (input) => stub.composite(input),
      },
    };
    const client = await connectInProcess(createRegistry(deps));

    const results = await Promise.all(
      Array.from({ length: 10 }, () => client.callTool({ name: "get_chart_data", arguments: COORDINATES })),
    );

    expect(results.every((result) => result.isError !== true)).toBe(true);
    expect(peak).toBe(4);
    await client.close();
  });
});
