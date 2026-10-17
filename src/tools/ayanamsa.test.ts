import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import pLimit from "p-limit";
import { describe, expect, it } from "vitest";
import { AYANAMSAS, type Ayanamsa, type Engine } from "../types.js";
import { StubEngine } from "../stub-engine.js";
import { registerChartTool } from "./chart.js";
import { registerCompositeTool } from "./composite.js";
import { createStubDeps, type ToolDeps } from "./deps.js";
import { registerHarmonicTool } from "./harmonic.js";
import { registerTransitTool } from "./transit.js";

// The ayanamsa input on every chart tool, seen through the SDK as a client sees it: the stub
// refuses a sidereal value with a fix line, a bad value is refused with a fix line, a default call
// and a tropical call give the same result, and the tool descriptions name the input.

const SIDEREAL = AYANAMSAS.filter((name) => name !== "tropical");

const CHART = { birth_date: "1990-06-15", birth_time: "19:30", latitude: 30.2672, longitude: -97.7431, timezone: "America/Chicago" };
const PERSON = { birth_date: "1990-06-15", birth_time: "19:30", latitude: 30.2672, longitude: -97.7431, timezone: "America/Chicago" };

interface ToolCase {
  name: string;
  args: Record<string, unknown>;
  register: (server: McpServer, deps: ToolDeps) => void;
}

const limit = pLimit(4);

const TOOLS: ToolCase[] = [
  {
    name: "get_chart_data",
    args: { ...CHART },
    register: (server, deps) => registerChartTool(server, deps, limit),
  },
  {
    name: "get_transit_data",
    args: { ...CHART, transit_date: "2000-06-15", transit_time: "12:00" },
    register: (server, deps) => registerTransitTool(server, deps, limit),
  },
  {
    name: "get_composite_data",
    args: { person_a: PERSON, person_b: { ...PERSON, birth_date: "1992-03-02" }, kind: "composite" },
    register: (server, deps) => registerCompositeTool(server, deps, limit),
  },
  {
    name: "get_harmonic_midpoints",
    args: { ...CHART, harmonic: 7 },
    register: (server, deps) => registerHarmonicTool(server, deps, limit),
  },
];

// The result with its provenance in the zodiac the engine was asked for, as the real engine reports
// it. The stub's placeholders are tropical, so this stamps the zodiac and nothing else.
function inZodiac<T extends { provenance: object }>(result: T, ayanamsa: Ayanamsa | undefined): T {
  return { ...result, provenance: { ...result.provenance, ayanamsa: ayanamsa ?? "tropical" } };
}

// The stub with the sidereal refusal lifted: a stand-in for the real engine, which accepts the
// value. It answers with the stub's tropical placeholders, stamped with the zodiac it was asked for,
// so the tool's own handling of the value (the meta echo) is what the test sees.
function siderealStandIn(): Engine {
  const stub = new StubEngine();
  return {
    cast: async (input) => inZodiac(await stub.cast({ ...input, ayanamsa: undefined }), input.ayanamsa),
    sky: async (input) => inZodiac(await stub.sky({ ...input, ayanamsa: undefined }), input.ayanamsa),
    composite: async (input) => inZodiac(await stub.composite({ ...input, ayanamsa: undefined }), input.ayanamsa),
  };
}

// An engine whose natal chart and sky come back in the zodiacs given, whatever the request says.
function engineInZodiacs(natal: Ayanamsa, sky: Ayanamsa): Engine {
  const stub = new StubEngine();
  return {
    cast: async (input) => inZodiac(await stub.cast({ ...input, ayanamsa: undefined }), natal),
    sky: async (input) => inZodiac(await stub.sky({ ...input, ayanamsa: undefined }), sky),
    composite: async (input) => inZodiac(await stub.composite({ ...input, ayanamsa: undefined }), natal),
  };
}

async function connect(tool: ToolCase, deps: ToolDeps): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  tool.register(server, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "in-process", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

function textOf(result: { content: unknown }): string {
  return (result.content as Array<{ text: string }>)[0]?.text ?? "";
}

type Meta = { meta: Record<string, unknown> };

describe.each(TOOLS)("$name ayanamsa", (tool) => {
  it("refuses a sidereal value on the stub, with a fix line that names tropical", async () => {
    const client = await connect(tool, createStubDeps());
    for (const name of SIDEREAL) {
      const result = await client.callTool({ name: tool.name, arguments: { ...tool.args, ayanamsa: name } });
      const text = textOf(result);
      expect(result.isError, name).toBe(true);
      expect(text, name).toContain(`The ${name} zodiac needs the real Astrolog engine`);
      expect(text, name).toMatch(/\nFix: Use the tropical zodiac, or ask the server\'s operator to run the real Astrolog engine/);
    }
  });

  it("refuses an unknown value with a fix line that lists the values", async () => {
    const client = await connect(tool, createStubDeps());
    const result = await client.callTool({ name: tool.name, arguments: { ...tool.args, ayanamsa: "vedic" } });
    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).toContain("Invalid input: ayanamsa");
    expect(text).toMatch(/\nFix: Give the zodiac as one of tropical, lahiri, fagan_bradley, raman, krishnamurti\./);
  });

  it("gives the same result for an omitted ayanamsa and for tropical, with no ayanamsa in meta", async () => {
    const client = await connect(tool, createStubDeps());
    const omitted = await client.callTool({ name: tool.name, arguments: { ...tool.args } });
    const tropical = await client.callTool({ name: tool.name, arguments: { ...tool.args, ayanamsa: "tropical" } });
    expect(omitted.isError).not.toBe(true);
    expect(textOf(tropical)).toBe(textOf(omitted));
    expect(tropical.structuredContent).toEqual(omitted.structuredContent);
    expect((omitted.structuredContent as Meta).meta).not.toHaveProperty("ayanamsa");
  });

  it("names a sidereal ayanamsa in meta when the engine accepts it", async () => {
    const client = await connect(tool, { ...createStubDeps(), engine: siderealStandIn() });
    for (const name of SIDEREAL) {
      const result = await client.callTool({ name: tool.name, arguments: { ...tool.args, ayanamsa: name } });
      expect(result.isError, name).not.toBe(true);
      expect((result.structuredContent as Meta).meta.ayanamsa, name).toBe(name);
    }
  });

  it("reads the zodiac from the engine's provenance, not from the request", async () => {
    const client = await connect(tool, { ...createStubDeps(), engine: engineInZodiacs("lahiri", "lahiri") });
    const result = await client.callTool({ name: tool.name, arguments: { ...tool.args } });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as Meta).meta.ayanamsa).toBe("lahiri");
  });

  it("names the ayanamsa input and every value in its description, and lists the values in its schema", async () => {
    const client = await connect(tool, createStubDeps());
    const { tools } = await client.listTools();
    const listed = tools.find((item) => item.name === tool.name);
    expect(listed?.description).toContain("ayanamsa");
    // Both ways: the sentence names every sidereal value and nothing else.
    expect(listed?.description).toContain(`tropical by default, or ${SIDEREAL.slice(0, -1).join(", ")} or ${SIDEREAL.at(-1)} for sidereal longitudes`);
    for (const name of SIDEREAL) {
      expect(listed?.description, name).toContain(name);
    }
    const property = (listed?.inputSchema.properties as Record<string, { enum?: string[]; default?: string }>).ayanamsa;
    expect(property?.enum).toEqual([...AYANAMSAS]);
    expect(property?.default).toBe("tropical");
  });
});

describe("the transit tool and the zodiac of its two charts", () => {
  it("refuses a natal chart and a sky in different zodiacs, with a fix line", async () => {
    const client = await connect(TOOLS[1]!, { ...createStubDeps(), engine: engineInZodiacs("lahiri", "tropical") });
    const result = await client.callTool({ name: "get_transit_data", arguments: { ...CHART, transit_date: "2000-06-15", transit_time: "12:00" } });
    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).toContain("the two results are in different zodiacs: lahiri and tropical");
    expect(text).toMatch(/\nFix: Cast both with the same ayanamsa, or read both in tropical\./);
  });
});

describe("the ayanamsa values in the docs", () => {
  it("name exactly the values the code offers, in the ayanamsa row of docs/tools.md", () => {
    const tools = readFileSync(new URL("../../docs/tools.md", import.meta.url), "utf8");
    const row = tools.split("\n").find((line) => line.startsWith("| `ayanamsa` |")) ?? "";
    const named = [...row.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]).filter((word) => word !== "ayanamsa" && word !== "meta");
    expect(named).toEqual([...AYANAMSAS]);
  });
});

describe("the ayanamsa input across the engine", () => {
  it("the stub engine itself refuses a sidereal value in cast, sky and composite", async () => {
    const stub = new StubEngine();
    await expect(stub.cast({ utc: "1990-06-15T19:30:00Z", latitude: { degrees: 30, hemisphere: "N" }, longitude: { degrees: 97, hemisphere: "W" }, ayanamsa: "lahiri" })).rejects.toMatchObject({
      name: "AstroError",
      fix: "Use the tropical zodiac, or ask the server's operator to run the real Astrolog engine for sidereal positions.",
    });
    await expect(stub.sky({ utc: "1990-06-15T19:30:00Z", ayanamsa: "raman" })).rejects.toMatchObject({ name: "AstroError" });
  });
});
