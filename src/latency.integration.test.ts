import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createRateLimiter } from "./limits.js";
import type { OAuthConfig } from "./oauth.js";
import { createRegistry } from "./registry.js";
import { depsFromEngine } from "./tools/deps.js";

// The voice-assistant budget: a warm call answers in under 500 ms (p95 over 20 calls), through the real HTTP
// server with AUTH_MODE=oauth on and the real binary. The token is fetched once from POST /token, and
// every call sends it. Skipped unless ASTROLOG_BIN is set. The numbers are printed so a run
// can be recorded; they depend on the machine.
const bin = process.env.ASTROLOG_BIN;
const suite = bin ? describe : describe.skip;
const BUDGET_MS = 500;
const CALLS = 20;

// Test-only credentials for the loopback server. Nothing outside this file uses them.
const OAUTH: OAuthConfig = {
  publicUrl: "https://astrolog-latency.invalid",
  clientId: "latency-client",
  clientSecret: "latency-client-secret-0123456789abcdef0123",
  signingKey: "latency-signing-key-0123456789abcdef0123",
};

const NATAL = { birth_date: "1990-06-15", birth_time: "14:30", latitude: 40.7, longitude: -73.9, timezone: "UTC" };
// Every pairing, every aspect of the all set, at the default list length: the heaviest transit call.
const EVERYTHING_ON = {
  ...NATAL,
  transit_date: "2000-06-15",
  transit_time: "12:00",
  transit_timezone: "UTC",
  aspects: "all",
  include: ["points", "to_natal_midpoints", "transit_midpoints", "midpoint_to_midpoint"],
};
// The second person of the composite: a different place and zone, so the two charts differ.
const PARTNER = { birth_date: "1985-01-02", birth_time: "08:00", latitude: 51.5, longitude: -0.12, timezone: "Europe/London" };
const CALLS_UNDER_TEST: [string, string, Record<string, unknown>][] = [
  ["get_chart_data", "get_chart_data", NATAL],
  ["get_transit_data", "get_transit_data", { ...NATAL, transit_date: "2000-06-15", transit_time: "12:00", transit_timezone: "UTC" }],
  ["get_composite_data", "get_composite_data", { person_a: NATAL, person_b: PARTNER, kind: "composite", house_system: "placidus" }],
  ["get_harmonic_midpoints", "get_harmonic_midpoints", { ...NATAL, harmonic: 7 }],
  ["get_transit_data, everything on", "get_transit_data", EVERYTHING_ON],
  ["get_transit_data, everything on, no cut", "get_transit_data", { ...EVERYTHING_ON, aspect_limit: 0 }],
  ["get_daily_transits", "get_daily_transits", { ...NATAL, date: "2026-10-14" }],
];

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

suite("warm latency through the real HTTP server", () => {
  let server: Server;
  let client: Client;

  beforeAll(async () => {
    const registry = createRegistry(await depsFromEngine("astrolog", { ...process.env, ASTROLOG_BIN: bin }));
    // The per-minute limit is raised for this run: 21 calls per tool would trip the default of 60 per client.
    server = createApp({
      registry,
      rateLimiter: createRateLimiter({ limit: 10_000, windowMs: 60_000 }),
      oauthConfig: OAUTH,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    // Without a token the endpoint refuses, so the timings below are for the authenticated path.
    const unauthenticated = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthenticated.status).toBe(401);

    const issued = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: OAUTH.clientId,
        client_secret: OAUTH.clientSecret,
      }),
    });
    expect(issued.status).toBe(200);
    const { access_token: token } = (await issued.json()) as { access_token: string };

    client = new Client({ name: "latency", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  async function timed(name: string, args: Record<string, unknown>): Promise<number> {
    const start = performance.now();
    const result = await client.callTool({ name, arguments: args });
    const ms = performance.now() - start;
    expect(result.isError).not.toBe(true);
    return ms;
  }

  for (const [label, name, args] of CALLS_UNDER_TEST) {
    it(`${label}: p95 of ${CALLS} warm calls is under ${BUDGET_MS} ms`, async () => {
      const cold = await timed(name, args);
      const warm: number[] = [];
      for (let i = 0; i < CALLS; i++) {
        warm.push(await timed(name, args));
      }
      const sorted = [...warm].sort((a, b) => a - b);
      const p50 = percentile(sorted, 50);
      const p95 = percentile(sorted, 95);
      console.log(`LATENCY ${label}: cold ${cold.toFixed(0)} ms, warm p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${sorted.at(-1)?.toFixed(0)} ms (${CALLS} calls)`);
      expect(p95).toBeLessThan(BUDGET_MS);
    }, 60_000);
  }
});
