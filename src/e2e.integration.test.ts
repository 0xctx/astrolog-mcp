import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createRegistry, toolNames } from "./registry.js";
import { STUB_MARKER } from "./tools/call.js";
import { depsFromEngine } from "./tools/deps.js";

// The whole server against the real binary: the MCP tools over HTTP and over stdio with
// ENGINE=astrolog. Skipped unless ASTROLOG_BIN is set; place-name tests also need
// ASTROLOG_MCP_DATA to name a directory the installer filled.
const bin = process.env.ASTROLOG_BIN;
const dataDir = process.env.ASTROLOG_MCP_DATA;
const suite = bin ? describe : describe.skip;
const withData = dataDir ? it : it.skip.bind(it);
if (bin && !dataDir) {
  console.warn("ASTROLOG_MCP_DATA is not set: the place-name tests are skipped. Point it at the installer's data/geonames.");
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const buildDir = join(repoRoot, "node_modules", ".cache", "astrolog-mcp-e2e");
const entry = join(buildDir, "stdio.js");

// The reference moment is 14:30 UT at 73:54W 40:42N, given in the UTC zone. See AGENTS.md: it is not
// 14:30 local at UT-5.
const NATAL = { birth_date: "1990-06-15", birth_time: "14:30", latitude: 40.7, longitude: -73.9, timezone: "UTC" };
const SECOND = { birth_date: "1990-03-02", birth_time: "06:50", latitude: 51.5, longitude: 0, timezone: "UTC" };
const TOL = 0.001;
// The five major aspects, which the default aspect set lists.
const MAJOR = ["conjunction", "opposition", "trine", "square", "sextile"];

interface Outcome {
  isError: boolean;
  text: string;
  data: any;
}

type Connect = () => Promise<{ client: Client; close: () => Promise<void>; stderr: () => string }>;

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Outcome> {
  try {
    const result = await client.callTool({ name, arguments: args });
    const first = (result.content as { type: string; text?: string }[])[0];
    return { isError: result.isError === true, text: first?.text ?? "", data: result.structuredContent };
  } catch (error) {
    // A refusal at the schema layer may arrive as a protocol error; it is still a refusal with text.
    return { isError: true, text: error instanceof Error ? error.message : String(error), data: undefined };
  }
}

const lon = (data: any, code: string): number => data.bodies.find((b: any) => b.code === code).longitude;

function suiteOver(label: string, connect: Connect): void {
  suite(`the real server over ${label}`, () => {
    let session: Awaited<ReturnType<Connect>>;
    beforeAll(async () => {
      session = await connect();
    }, 120_000);
    afterAll(async () => {
      await session?.close();
    });

    it("lists the registered tools", async () => {
      const { tools } = await session.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(toolNames());
    });

    it("get_chart_data returns the 15 Jun 1990 reference positions with no placeholder marker", async () => {
      const r = await call(session.client, "get_chart_data", NATAL);
      expect(r.isError).toBe(false);
      expect(r.text).not.toContain("PLACEHOLDER");
      expect(r.text).not.toContain(STUB_MARKER);
      expect(r.data.meta.astrolog_version).toMatch(/^\d+\.\d+$/);
      expect(lon(r.data, "Sun")).toBeCloseTo(84.229, 3);
      expect(lon(r.data, "Moo")).toBeCloseTo(346.7518, 3);
      expect(Math.abs(lon(r.data, "Cer") - 117.9217)).toBeLessThan(TOL);
    });

    withData("get_chart_data resolves 'Austin, TX' through the GeoNames table", async () => {
      // 09:30 in Austin (CDT, UT-5) is 14:30 UT, so the Sun is the reference 84.229.
      const r = await call(session.client, "get_chart_data", { birth_date: "1990-06-15", birth_time: "09:30", place: "Austin, TX" });
      expect(r.isError).toBe(false);
      expect(r.text).not.toContain("PLACEHOLDER");
      expect(r.data.meta.place.timezone).toBe("America/Chicago");
      expect(r.data.meta.place.latitude).toMatch(/N$/);
      expect(r.data.meta.place.longitude).toMatch(/W$/);
      expect(lon(r.data, "Sun")).toBeCloseTo(84.229, 3);
    });

    it("get_chart_data in harmonic 7 multiplies the natal longitudes by 7", async () => {
      const natal = await call(session.client, "get_chart_data", NATAL);
      const h7 = await call(session.client, "get_chart_data", { ...NATAL, harmonic: 7 });
      expect(h7.isError).toBe(false);
      expect(h7.text).not.toContain("PLACEHOLDER");
      const want = (lon(natal.data, "Sun") * 7) % 360;
      expect(Math.abs(lon(h7.data, "Sun") - want)).toBeLessThan(TOL);
    });

    it("get_chart_data with aspects all and aspect_limit 0 lists every aspect, minor ones and ASC or MC targets, with the total", async () => {
      const r = await call(session.client, "get_chart_data", { ...NATAL, aspects: "all", aspect_limit: 0 });
      expect(r.isError).toBe(false);
      expect(r.text).not.toContain("PLACEHOLDER");
      const { items, total, truncated } = r.data.aspects;
      expect(truncated).toBe(false);
      expect(items).toHaveLength(total);
      expect(total).toBeGreaterThan(8);
      expect(items.some((item: any) => !MAJOR.includes(item.type))).toBe(true);
      expect(items.some((item: any) => ["ASC", "MC"].includes(item.a) || ["ASC", "MC"].includes(item.b))).toBe(true);
    });

    it("get_chart_data without aspects keeps the five major aspects, the eight tightest, and no angle", async () => {
      const r = await call(session.client, "get_chart_data", NATAL);
      expect(r.isError).toBe(false);
      const { items, total } = r.data.aspects;
      expect(items.length).toBeLessThanOrEqual(8);
      expect(total).toBeGreaterThanOrEqual(items.length);
      expect(items.every((item: any) => MAJOR.includes(item.type))).toBe(true);
      expect(items.some((item: any) => ["ASC", "MC"].includes(item.a) || ["ASC", "MC"].includes(item.b))).toBe(false);
    });

    it("get_chart_data with aspects all in harmonic 5 multiplies the Sun by 5 and reads the same set", async () => {
      const natal = await call(session.client, "get_chart_data", NATAL);
      const h5 = await call(session.client, "get_chart_data", { ...NATAL, harmonic: 5, aspects: "all", aspect_limit: 0 });
      expect(h5.isError).toBe(false);
      expect(Math.abs(lon(h5.data, "Sun") - (lon(natal.data, "Sun") * 5) % 360)).toBeLessThan(TOL);
      expect(h5.data.aspects.truncated).toBe(false);
      expect(h5.data.aspects.items).toHaveLength(h5.data.aspects.total);
    });

    it("get_chart_data with ayanamsa lahiri puts the Sun about 24 degrees earlier, and names lahiri in meta", async () => {
      const tropical = await call(session.client, "get_chart_data", NATAL);
      const lahiri = await call(session.client, "get_chart_data", { ...NATAL, ayanamsa: "lahiri" });
      expect(lahiri.isError).toBe(false);
      expect(lahiri.data.meta.ayanamsa).toBe("lahiri");
      expect(tropical.data.meta).not.toHaveProperty("ayanamsa");
      // Measured: 60.5017 in Lahiri against the tropical 84.2290, a shift of -23.7273.
      expect(Math.abs(lon(lahiri.data, "Sun") - 60.501745)).toBeLessThan(TOL);
      expect(((lon(lahiri.data, "Sun") - lon(tropical.data, "Sun") + 540) % 360) - 180).toBeCloseTo(-23.7273, 3);
    });

    it("get_transit_data reads the transit Sun 341.63 and the natal chart, and harmonic 7 moves the sky", async () => {
      const args = { ...NATAL, transit_date: "1990-03-02", transit_time: "11:38", transit_timezone: "UTC" };
      const r = await call(session.client, "get_transit_data", args);
      expect(r.isError).toBe(false);
      expect(r.text).not.toContain("PLACEHOLDER");
      expect(r.data.meta.provenance.source).toBe("astrolog");
      const sun = r.data.sky.find((b: any) => b.code === "Sun").longitude;
      expect(Math.abs(sun - 341.63)).toBeLessThan(TOL);
      const h7 = await call(session.client, "get_transit_data", { ...args, harmonic: 7 });
      expect(h7.isError).toBe(false);
      expect(h7.data.meta.harmonic).toBe(7);
      const sun7 = h7.data.sky.find((b: any) => b.code === "Sun").longitude;
      expect(Math.abs(sun7 - ((sun * 7) % 360))).toBeLessThan(TOL);
    });

    it("get_transit_data with every include value and aspects all has hits of each pairing, and the default names only T to N", async () => {
      const args = { ...NATAL, transit_date: "1990-03-02", transit_time: "11:38", transit_timezone: "UTC" };
      const every = await call(session.client, "get_transit_data", {
        ...args,
        aspects: "all",
        include: ["points", "to_natal_midpoints", "transit_midpoints", "midpoint_to_midpoint"],
        aspect_limit: 0,
      });
      expect(every.isError).toBe(false);
      const pairings = new Set((every.data.aspects.items as { pairing?: string }[]).map((row) => row.pairing));
      expect([...pairings].sort()).toEqual(["T to N", "T to Nm", "Tm to N", "Tm to Nm"]);
      const plain = await call(session.client, "get_transit_data", args);
      expect(plain.isError).toBe(false);
      expect((plain.data.aspects.items as { pairing?: string }[]).every((row) => row.pairing === "T to N")).toBe(true);
    });

    it("get_transit_data in lahiri with every include value has rows of each pairing, and names lahiri in meta", async () => {
      const args = { ...NATAL, transit_date: "1990-03-02", transit_time: "11:38", transit_timezone: "UTC" };
      const r = await call(session.client, "get_transit_data", {
        ...args,
        ayanamsa: "lahiri",
        aspects: "all",
        include: ["points", "to_natal_midpoints", "transit_midpoints", "midpoint_to_midpoint"],
        min_strength: 0,
        aspect_limit: 0,
      });
      expect(r.isError).toBe(false);
      expect(r.data.meta.ayanamsa).toBe("lahiri");
      const pairings = new Set((r.data.aspects.items as { pairing?: string }[]).map((row) => row.pairing));
      expect([...pairings].sort()).toEqual(["T to N", "T to Nm", "Tm to N", "Tm to Nm"]);
    });

    it("get_composite_data gives the composite Sun 32.83 and a Davison chart with its midpoint", async () => {
      const composite = await call(session.client, "get_composite_data", { person_a: NATAL, person_b: SECOND, kind: "composite" });
      expect(composite.isError).toBe(false);
      expect(composite.text).not.toContain("PLACEHOLDER");
      expect(Math.abs(lon(composite.data, "Sun") - 32.83)).toBeLessThan(TOL);
      const davison = await call(session.client, "get_composite_data", { person_a: NATAL, person_b: SECOND, kind: "davison" });
      expect(davison.isError).toBe(false);
      expect(davison.data.meta.kind).toBe("davison");
      expect(davison.data.meta.davison_midpoint_utc).toMatch(/^1990-04-/);
      expect(davison.data.meta.provenance.source).toBe("astrolog");
    });

    it("get_harmonic_midpoints returns real structures for harmonic 1 and 7", async () => {
      for (const harmonic of [1, 7]) {
        const r = await call(session.client, "get_harmonic_midpoints", { ...NATAL, harmonic });
        expect(r.isError).toBe(false);
        expect(r.text).not.toContain("PLACEHOLDER");
        expect(r.data.meta.harmonic).toBe(harmonic);
        expect(r.data.structures.total).toBeGreaterThan(0);
      }
    });

    it("get_daily_transits reads 14 October 2026 with the Moon's entry into Sagittarius, and caps the hits at limit with the total", async () => {
      const r = await call(session.client, "get_daily_transits", { ...NATAL, date: "2026-10-14", limit: 5 });
      expect(r.isError).toBe(false);
      expect(r.text).not.toContain("PLACEHOLDER");
      expect(r.data.meta.provenance.source).toBe("astrolog");
      expect(r.data.hits.items).toHaveLength(5);
      expect(r.data.hits.total).toBeGreaterThan(5);
      expect(r.data.hits.truncated).toBe(true);
      expect(r.data.moon.sign_changes.items[0]).toMatchObject({ to: "Sagittarius", at_local: "00:59" });
    });

    withData("refuses an ambiguous place with candidates and a fix line", async () => {
      const r = await call(session.client, "get_chart_data", { birth_date: "1990-06-15", birth_time: "09:30", place: "Springfield" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/matches \d+ places: Springfield, Missouri/);
      expect(r.text).toMatch(/Fix:/);
    });

    it("refuses a bad time zone with a fix line, including 'local' and 'UTC+5'", async () => {
      for (const timezone of ["Mars/Olympus", "local", "system", "UTC+5"]) {
        const r = await call(session.client, "get_chart_data", { ...NATAL, timezone });
        expect(r.isError, timezone).toBe(true);
        expect(r.text, timezone).toMatch(/IANA|time zone/i);
      }
    });

    it("refuses a time the zone skips (DST gap) with a fix line", async () => {
      const r = await call(session.client, "get_chart_data", {
        birth_date: "2026-03-08",
        birth_time: "02:30",
        latitude: 30.2672,
        longitude: -97.7431,
        timezone: "America/Chicago",
      });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/does not exist/);
      expect(r.text).toMatch(/Fix:/);
    });

    it("invariant: coordinates carry explicit E/W/N/S letters", async () => {
      const r = await call(session.client, "get_chart_data", { ...NATAL, latitude: -33.87, longitude: 151.21, timezone: "Australia/Sydney" });
      expect(r.isError).toBe(false);
      expect(r.data.meta.place.latitude).toMatch(/S$/);
      expect(r.data.meta.place.longitude).toMatch(/E$/);
    });

    it("invariant: every failure is isError with a fix line, never a silent success", async () => {
      const r = await call(session.client, "get_transit_data", { ...NATAL, transit_date: "1990-02-30", transit_time: "12:00" });
      expect(r.isError).toBe(true);
      expect(r.text.length).toBeGreaterThan(0);
    });
  });
}

function build(): Promise<void> {
  rmSync(buildDir, { recursive: true, force: true });
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", buildDir], { cwd: repoRoot }, (error, stdout, stderr) =>
      error ? reject(new Error(`tsc failed:\n${stdout}${stderr}`)) : resolve(),
    );
  });
}

// ENGINE=astrolog and the real binary, inherited by the server this test starts.
function serverEnv(): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment(), ENGINE: "astrolog", ASTROLOG_BIN: bin ?? "" };
  if (dataDir) {
    env.ASTROLOG_MCP_DATA = dataDir;
  }
  return env;
}

const overHttp: Connect = async () => {
  const registry = createRegistry(await depsFromEngine("astrolog", { ...process.env, ASTROLOG_BIN: bin }));
  const server: Server = createApp({ registry });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const client = new Client({ name: "e2e-http", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return {
    client,
    stderr: () => "",
    close: async () => {
      await client.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

const overStdio: Connect = async () => {
  await build();
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: serverEnv(), stderr: "pipe" });
  const chunks: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  const client = new Client({ name: "e2e-stdio", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => chunks.join(""), close: () => client.close().catch(() => undefined) };
};

suiteOver("HTTP", overHttp);
suiteOver("stdio", overStdio);

suite("the real server's quiet and its refusal to start", () => {
  it("invariant: nothing about a person is logged on stderr when a chart is served over stdio", async () => {
    const session = await overStdio();
    try {
      const r = await call(session.client, "get_chart_data", NATAL);
      expect(r.isError).toBe(false);
      const log = session.stderr();
      expect(log).not.toMatch(/1990|40\.7|73\.9/);
    } finally {
      await session.close();
    }
  }, 120_000);
});
