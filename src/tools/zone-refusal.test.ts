import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import pLimit from "p-limit";
import { describe, expect, it } from "vitest";
import { registerChartTool } from "./chart.js";
import { registerCompositeTool } from "./composite.js";
import { createStubDeps } from "./deps.js";
import { registerHarmonicTool } from "./harmonic.js";
import { registerTransitTool } from "./transit.js";

const BAD_ZONES = ["local", "system", "UTC+5", "Mars/Olympus"];
const COORDS = { latitude: 30.2672, longitude: -97.7431 };
const BIRTH = { birth_date: "1990-06-15", birth_time: "19:30", ...COORDS };
const OK_ZONE = "America/Chicago";

async function connect(register: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  register(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "in-process", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const limit = pLimit(4);
const deps = createStubDeps();

const CASES: Array<{
  tool: string;
  field: string;
  register: (server: McpServer) => void;
  args: (zone: string) => Record<string, unknown>;
}> = [
  {
    tool: "get_chart_data",
    field: "timezone",
    register: (s) => registerChartTool(s, deps, limit),
    args: (zone) => ({ ...BIRTH, timezone: zone }),
  },
  {
    tool: "get_harmonic_midpoints",
    field: "timezone",
    register: (s) => registerHarmonicTool(s, deps, limit),
    args: (zone) => ({ ...BIRTH, timezone: zone, harmonic: 7 }),
  },
  {
    tool: "get_transit_data",
    field: "timezone",
    register: (s) => registerTransitTool(s, deps, limit),
    args: (zone) => ({ ...BIRTH, timezone: zone }),
  },
  {
    tool: "get_transit_data",
    field: "transit_timezone",
    register: (s) => registerTransitTool(s, deps, limit),
    args: (zone) => ({
      ...BIRTH,
      timezone: OK_ZONE,
      transit_date: "2026-10-14",
      transit_time: "12:00",
      transit_timezone: zone,
    }),
  },
  {
    tool: "get_composite_data",
    field: "person_a.timezone",
    register: (s) => registerCompositeTool(s, deps, limit),
    args: (zone) => ({ person_a: { ...BIRTH, timezone: zone }, person_b: { ...BIRTH, timezone: OK_ZONE }, kind: "composite" }),
  },
  {
    tool: "get_composite_data",
    field: "person_b.timezone",
    register: (s) => registerCompositeTool(s, deps, limit),
    args: (zone) => ({ person_a: { ...BIRTH, timezone: OK_ZONE }, person_b: { ...BIRTH, timezone: zone }, kind: "davison" }),
  },
];

describe("a timezone that is not an IANA zone name is refused with a fix line, in every tool", () => {
  for (const c of CASES) {
    for (const zone of BAD_ZONES) {
      it(`${c.tool} ${c.field}=${JSON.stringify(zone)}`, async () => {
        const client = await connect(c.register);
        const result = await client.callTool({ name: c.tool, arguments: c.args(zone) });
        const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
        expect(result.isError).toBe(true);
        expect(text).toContain(`Invalid input: ${c.field}`);
        expect(text).toMatch(/\nFix: .*IANA time zone name/);
      });
    }
    it(`${c.tool} ${c.field} accepts a real zone`, async () => {
      const client = await connect(c.register);
      const result = await client.callTool({ name: c.tool, arguments: c.args(OK_ZONE) });
      expect(result.isError).not.toBe(true);
    });
  }
});
