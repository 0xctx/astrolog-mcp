import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import http, { type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { packageVersion, parseJsonRpcFromSse } from "./server.js";
import { createRateLimiter } from "./limits.js";
import { createRegistry } from "./registry.js";
import { ASPECT_LIST_LIMIT, chartInputShape } from "./tools/chart.js";
import { STUB_MARKER } from "./tools/call.js";
import { harmonicInputShape } from "./tools/harmonic.js";
import { AstroError, HOUSE_NUMBERS, OBJECT_CODES, type Positions } from "./types.js";
import { createStubDeps, type ToolDeps } from "./tools/deps.js";

const COORDINATES = {
  birth_date: "1990-06-15",
  birth_time: "19:30",
  latitude: 30.2672,
  longitude: -97.7431,
  timezone: "America/Chicago",
};

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "raw-test", version: "0.0.0" },
  },
};

const LISTEN = {
  jsonrpc: "2.0",
  id: 1,
  method: "subscriptions/listen",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": { tools: {} },
    },
    notifications: { toolsListChanged: true },
  },
};

// A chart call that a test can leave in flight: it is the one long-lived reply a JSON-only client
// can still reach, because subscriptions/listen is refused for it.
const CHART_CALL = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "get_chart_data", arguments: COORDINATES },
};

// Deps whose engine never answers, so a tool call stays in flight until its client goes away.
function hangingDeps(): ToolDeps {
  const never = (): Promise<never> => new Promise<never>(() => {});
  return { ...createStubDeps(), engine: { cast: never, sky: never, composite: never }, timeoutMs: 60_000 };
}

// Posts with Accept: application/json alone and returns the open request, so a test can drop it.
function postJsonOnly(baseUrl: string, body: unknown): http.ClientRequest {
  const payload = JSON.stringify(body);
  const req = http.request(
    `${baseUrl}/mcp`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      },
    },
    (res) => res.resume(),
  );
  req.end(payload);
  return req;
}

async function waitUntilAtLeast(read: () => number, target: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (read() < target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// The Streamable HTTP endpoint answers with an SSE frame or a JSON body; this reads either.
async function readJsonRpc(response: Response): Promise<unknown> {
  const text = await response.text();
  const data = text.startsWith("event:") || text.includes("\ndata:") ? text.split("\n").find((line) => line.startsWith("data:")) : text;
  return JSON.parse((data ?? "").replace(/^data:\s*/, ""));
}

function rawPost(baseUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// Posts with node:http so no header is added on the client's behalf (fetch always adds Accept).
function httpPost(baseUrl: string, body: unknown): Promise<{ status: number; contentType: string; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${baseUrl}/mcp`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers["content-type"] ?? ""),
            text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("packageVersion", () => {
  it("throws, rather than reporting 0.0.0, when no package.json named astrolog-mcp is found", () => {
    const dir = mkdtempSync(join(tmpdir(), "astrolog-no-manifest-"));
    let thrown: unknown;
    try {
      packageVersion(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AstroError);
    expect(thrown).toHaveProperty("message", expect.stringMatching(/could not resolve astrolog-mcp version/));
    expect(thrown).toHaveProperty(
      "fix",
      "Reinstall astrolog-mcp so its package.json is in place, then start it again.",
    );
  });

  it("reads the version of this package from the repo", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(packageVersion()).toBe(manifest.version);
  });
});

describe("parseJsonRpcFromSse", () => {
  it("reads a message framed with CRLF line endings", () => {
    expect(parseJsonRpcFromSse('event: message\r\ndata: {"id":1}\r\n\r\n', false)).toEqual({ id: 1 });
  });

  it("reads a message framed with lone CR line endings", () => {
    expect(parseJsonRpcFromSse('event: message\rdata: {"id":2}\r\r', false)).toEqual({ id: 2 });
  });

  it("gives the last message of a single request's stream", () => {
    expect(parseJsonRpcFromSse('data: {"id":1}\n\ndata: {"id":2}\n\n', false)).toEqual({ id: 2 });
  });

  it("gives every message as an array for a batch, even a batch of one", () => {
    expect(parseJsonRpcFromSse('data: {"id":1}\n\n', true)).toEqual([{ id: 1 }]);
    expect(parseJsonRpcFromSse('data: {"id":1}\r\n\r\ndata: {"id":2}\r\n\r\n', true)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("reads a body with no data line as plain JSON", () => {
    expect(parseJsonRpcFromSse('{"id":3}', false)).toEqual({ id: 3 });
  });

  it("skips a data chunk that is not JSON", () => {
    expect(parseJsonRpcFromSse('data: not json\n\ndata: {"id":4}\n\n', false)).toEqual({ id: 4 });
  });
});

// Positions as an astrolog run would return them, for a fake engine that is not the stub.
function positionsFromAstrolog(): Positions {
  const bodies = Object.fromEntries(
    OBJECT_CODES.map((code, i) => [code, { longitude: i * 15, speed: 1, retrograde: false, house: 1 }]),
  ) as Positions["bodies"];
  const houses = Object.fromEntries(HOUSE_NUMBERS.map((house) => [house, (house - 1) * 30])) as Positions["houses"];
  return {
    bodies,
    houses,
    angles: { ASC: 0, MC: 270, DSC: 180, IC: 90 },
    missing: [],
    housesFrom: "placidus",
    provenance: { astrologVersion: "astrolog test build", source: "astrolog", utc: "1990-06-15T23:30:00Z", ayanamsa: "tropical" },
  };
}

describe("the /mcp endpoint over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let client: Client | undefined;

  async function start(options: Parameters<typeof createApp>[0] = {}): Promise<void> {
    server = createApp(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function connect(): Promise<Client> {
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
    return client;
  }

  beforeEach(() => {
    client = undefined;
  });

  afterEach(async () => {
    await client?.close();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    vi.restoreAllMocks();
  });

  it("lists get_chart_data to a client with no credentials", async () => {
    await start();
    const { tools } = await (await connect()).listTools();

    const tool = tools.find((item) => item.name === "get_chart_data");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("Call this when");
    expect(tool?.description).toContain("Returns:");
    expect(tool?.description).toContain(`${ASPECT_LIST_LIMIT} tightest`);
    expect(tool?.description).not.toContain("every number comes from an astrolog run");
    expect(tool?.description).toContain("ENGINE=stub");
  });

  it("names the aspects and aspect_limit inputs in the chart and composite descriptions", async () => {
    await start();
    const { tools } = await (await connect()).listTools();

    for (const name of ["get_chart_data", "get_composite_data"]) {
      const description = tools.find((item) => item.name === name)?.description ?? "";
      expect(description, name).toContain('"aspects"');
      expect(description, name).toContain('"aspect_limit"');
      expect(description, name).toContain('"all"');
    }
  });

  it("advertises exactly the input fields the schema declares, each with a description", async () => {
    await start();
    const { tools } = await (await connect()).listTools();
    const properties = (tools.find((item) => item.name === "get_chart_data")?.inputSchema.properties ?? {}) as Record<
      string,
      { description?: string }
    >;

    expect(Object.keys(properties).sort()).toEqual(Object.keys(chartInputShape).sort());
    for (const [field, schema] of Object.entries(properties)) {
      expect(schema.description, field).toBeTruthy();
    }
  });

  it("answers a tools/call with structured numbers and a headline", async () => {
    await start();
    const result = await (await connect()).callTool({ name: "get_chart_data", arguments: COORDINATES });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      headline: expect.stringMatching(/^Sun \d+°\d{2}′ \w+, Moon /),
      bodies: expect.arrayContaining([
        expect.objectContaining({ code: "Sun", sign: expect.any(String), text: expect.any(String) }),
      ]),
      meta: { place: { latitude: "30°16′N", longitude: "97°45′W", timezone: "America/Chicago" } },
    });
  });

  it("marks the text as placeholder numbers when the engine is the stub", async () => {
    await start();
    const result = await (await connect()).callTool({ name: "get_chart_data", arguments: COORDINATES });

    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith("PLACEHOLDER numbers (ENGINE=stub), not astrolog output.\n")).toBe(true);
    expect(text).toContain((result.structuredContent as { headline: string }).headline);
  });

  it("leaves the placeholder marker out when the engine is not the stub", async () => {
    const deps: ToolDeps = {
      ...createStubDeps(),
      engine: {
        cast: async () => positionsFromAstrolog(),
        sky: async () => {
          throw new Error("unused");
        },
        composite: async () => {
          throw new Error("unused");
        },
      },
    };
    await start({ registry: createRegistry(deps) });
    const result = await (await connect()).callTool({ name: "get_chart_data", arguments: COORDINATES });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("PLACEHOLDER");
    expect(text.startsWith("Sun ")).toBe(true);
    expect(result.structuredContent).toMatchObject({ meta: { astrolog_version: "astrolog test build" } });
  });

  it("marks a result by its own provenance source, whatever engine class produced it", async () => {
    const deps: ToolDeps = {
      ...createStubDeps(),
      engine: {
        cast: async () => ({
          ...positionsFromAstrolog(),
          provenance: { astrologVersion: "stub (no astrolog run)", source: "stub", utc: "1990-06-15T23:30:00Z", ayanamsa: "tropical" },
        }),
        sky: async () => {
          throw new Error("unused");
        },
        composite: async () => {
          throw new Error("unused");
        },
      },
    };
    await start({ registry: createRegistry(deps) });
    const result = await (await connect()).callTool({ name: "get_chart_data", arguments: COORDINATES });

    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith("PLACEHOLDER numbers (ENGINE=stub), not astrolog output.\n")).toBe(true);
  });

  it("returns isError with a fix line for a place the build cannot look up", async () => {
    await start();
    const result = await (await connect()).callTool({
      name: "get_chart_data",
      arguments: { birth_date: "1990-06-15", birth_time: "19:30", place: "Austin, TX" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("place names are not looked up in this build");
    expect(text).toMatch(/\nFix: Pass latitude, longitude and time zone instead of a place name\./);
  });

  it("returns isError with a fix line for input the schema rejects", async () => {
    await start();
    const result = await (await connect()).callTool({
      name: "get_chart_data",
      arguments: { ...COORDINATES, birth_time: "25:00" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^Invalid input: birth_time\n/);
    expect(text).toMatch(/\nFix: Write the birth time as 24-hour HH:MM/);
    expect(text).not.toContain("Input validation error");
  });

  it("refuses an unknown input field with a fix line that names the valid fields", async () => {
    await start();
    const result = await (await connect()).callTool({
      name: "get_chart_data",
      arguments: { ...COORDINATES, house_sytem: "koch" },
    });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/^Invalid input: unknown field house_sytem\n/);
    expect(text).toMatch(/\nFix: Remove that field; this tool takes the birth date, the birth time, the birth place, /);
  });

  it("gives an actionable fix line when birth_date is missing", async () => {
    await start();
    const result = await (await connect()).callTool({
      name: "get_chart_data",
      arguments: { birth_time: "19:30", place: "Austin, TX" },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /\nFix: Give the birth date as YYYY-MM-DD, for example 1990-06-15\.$/,
    );
  });

  it("returns isError with a fix line when a required field is missing", async () => {
    await start();
    const result = await (await connect()).callTool({
      name: "get_chart_data",
      arguments: { birth_date: "1990-06-15", birth_time: "19:30" },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/\nFix: Give a place, or all three/);
  });

  it("returns isError with a fix line for an AstroError from the engine", async () => {
    const deps: ToolDeps = {
      ...createStubDeps(),
      engine: {
        cast: async () => {
          throw new AstroError("astrolog exited with status 1", "Check the astrolog install, then retry.");
        },
        sky: async () => {
          throw new Error("unused");
        },
        composite: async () => {
          throw new Error("unused");
        },
      },
    };
    await start({ registry: createRegistry(deps) });
    const result = await (await connect()).callTool({ name: "get_chart_data", arguments: COORDINATES });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(
      "astrolog exited with status 1\nFix: Check the astrolog install, then retry.",
    );
  });

  it("answers a 2025-11-25 initialize, which the stateless fallback serves", async () => {
    await start();
    const response = await rawPost(baseUrl, INITIALIZE);
    const body = (await readJsonRpc(response)) as { result: { protocolVersion: string } };

    expect(response.status).toBe(200);
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  it("answers tools/list with 200 and a JSON-RPC result when Accept is application/json only", async () => {
    await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { jsonrpc: string; id: number; result: { tools: unknown[] } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(Array.isArray(body.result.tools)).toBe(true);
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it("answers tools/list with 200 and a JSON-RPC result when no Accept header is sent", async () => {
    await start();
    // The Accept the server receives, read on the server side: the client cannot show what went out.
    const acceptOnWire: unknown[] = [];
    server.on("request", (req) => acceptOnWire.push(req.headers.accept));
    const sent = await httpPost(baseUrl, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

    expect(acceptOnWire).toEqual([undefined]);
    expect(sent.status).toBe(200);
    expect(sent.contentType).toContain("application/json");
    const body = JSON.parse(sent.text) as { jsonrpc: string; id: number; result: { tools: unknown[] } };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.tools.length).toBeGreaterThan(0);
  });

  it.each([
    ["*/*", "application/json"],
    ["text/event-stream", "text/event-stream"],
    ["APPLICATION/JSON", "application/json"],
    ["application/json;q=0, text/event-stream", "text/event-stream"],
    ["application/json, text/event-stream;q=0", "application/json"],
    ["Application/JSON, Text/Event-Stream", "text/event-stream"],
  ])("frames the reply for Accept %j as %s", async (accept, framing) => {
    await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(framing);
  });

  it("answers a one-request batch from a JSON-only client with an array, and a notification with 202", async () => {
    await start();
    const one = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }]),
    });
    const oneBody = (await one.json()) as { id: number }[];
    expect(one.status).toBe(200);
    expect(Array.isArray(oneBody)).toBe(true);
    expect(oneBody.map((m) => m.id)).toEqual([7]);

    const many = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ]),
    });
    const manyBody = (await many.json()) as { id: number }[];
    expect(manyBody.map((m) => m.id).sort()).toEqual([1, 2]);

    const single = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    expect(Array.isArray(await single.json())).toBe(false);

    const note = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
  });

  it("refuses a JSON-only subscriptions/listen with 406 and a JSON-RPC error naming the Accept it needs", async () => {
    await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(LISTEN),
    });

    expect(response.status).toBe(406);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32600, message: "subscriptions/listen needs Accept: text/event-stream" },
    });
  });

  it("refuses a batch that carries a subscriptions/listen to a JSON-only client", async () => {
    await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }, LISTEN]),
    });

    expect(response.status).toBe(406);
    expect(await response.json()).toMatchObject({ id: 1, error: { code: -32600 } });
  });

  it("opens a subscriptions/listen stream for a client that accepts event-stream", async () => {
    await start();
    const contentType = await new Promise<string>((resolve, reject) => {
      const body = JSON.stringify(LISTEN);
      const req = http.request(
        `${baseUrl}/mcp`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "content-length": String(Buffer.byteLength(body)),
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "subscriptions/listen",
          },
        },
        (res) => {
          resolve(String(res.headers["content-type"] ?? ""));
          req.destroy();
        },
      );
      req.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") {
          reject(error);
        }
      });
      req.end(body);
    });

    expect(contentType).toContain("text/event-stream");
  });

  it("ends a JSON-only reply that is still open when the client disconnects", async () => {
    await start({ registry: createRegistry(hangingDeps()) });
    let ended = false;
    // res.end is only reached once the handler's buffered read settles, so the disconnect has to
    // settle it. The socket closing alone does not end the reply.
    server.on("request", (_req, res) => {
      const end = res.end.bind(res);
      res.end = ((...args: Parameters<typeof end>) => {
        ended = true;
        return end(...args);
      }) as typeof res.end;
    });
    const req = postJsonOnly(baseUrl, CHART_CALL);
    req.on("error", () => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ended).toBe(false);

    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(ended).toBe(true);
  });

  it("settles every handler when 800 JSON-only replies are disconnected mid-stream", async () => {
    const count = 800;
    await start({
      registry: createRegistry(hangingDeps()),
      rateLimiter: createRateLimiter({ limit: count * 2, windowMs: 60_000 }),
    });
    let arrived = 0;
    let settled = 0;
    server.on("request", (_req, res) => {
      arrived += 1;
      const end = res.end.bind(res);
      res.end = ((...args: Parameters<typeof end>) => {
        settled += 1;
        return end(...args);
      }) as typeof res.end;
    });
    const requests = Array.from({ length: count }, () => {
      const req = postJsonOnly(baseUrl, CHART_CALL);
      req.on("error", () => {});
      return req;
    });
    await waitUntilAtLeast(() => arrived, count);

    for (const req of requests) {
      req.destroy();
    }
    await waitUntilAtLeast(() => settled, count);

    expect(settled).toBe(count);
  }, 30_000);

  it("keeps the version-less initialize patch for a client that accepts both types", async () => {
    await start();
    const response = await rawPost(baseUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Generic MCP Client" } },
    });
    const body = (await readJsonRpc(response)) as { result?: { protocolVersion: string } };

    expect(response.status).toBe(200);
    expect(body.result?.protocolVersion).toBe("2025-03-26");
  });

  it("answers initialize at protocolVersion 2025-03-26 with 2025-03-26 and the package.json version over HTTP", async () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "Generic MCP Client", version: "1.0.0" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string; version: string } };
    };
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("astrolog-mcp");
    expect(body.result.serverInfo.version).toBe(manifest.version);
  });

  it("answers initialize with clientInfo without version at protocolVersion 2025-03-26 over HTTP", async () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    await start();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "Generic MCP Client" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string; version: string } };
    };
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("astrolog-mcp");
    expect(body.result.serverInfo.version).toBe(manifest.version);
  });

  it("answers without authentication and sends no WWW-Authenticate challenge", async () => {
    await start();
    const response = await rawPost(baseUrl, INITIALIZE);

    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("answers GET /mcp with 405 because the server keeps no session", async () => {
    await start();
    const response = await fetch(`${baseUrl}/mcp`, { method: "GET", headers: { accept: "text/event-stream" } });

    expect(response.status).toBe(405);
  });

  it("answers an unsupported method with 405 and the methods it accepts", async () => {
    await start();
    const response = await fetch(`${baseUrl}/mcp`, { method: "PUT", body: "{}" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST, DELETE");
  });

  it("refuses a body over the size cap with 413 and a fix line", async () => {
    await start();
    const response = await rawPost(baseUrl, { ...INITIALIZE, padding: "x".repeat(70 * 1024) });
    const body = (await response.json()) as { error: string; fix: string };

    expect(response.status).toBe(413);
    expect(body.fix).toMatch(/Send at most 65536 bytes/);
  });

  it("refuses requests past the per-address limit with 429 and Retry-After", async () => {
    await start({ rateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }) });

    expect((await rawPost(baseUrl, INITIALIZE)).status).toBe(200);
    expect((await rawPost(baseUrl, INITIALIZE)).status).toBe(200);
    const limited = await rawPost(baseUrl, INITIALIZE);
    const body = (await limited.json()) as { error: string; fix: string };

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(body.fix).toMatch(/Wait \d+ seconds, then retry\./);
  });

  it("keys the rate limit on the socket and ignores X-Forwarded-For when TRUST_PROXY is off", async () => {
    await start({ rateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }) });

    expect((await rawPost(baseUrl, INITIALIZE, { "x-forwarded-for": "10.0.0.1" })).status).toBe(200);
    expect((await rawPost(baseUrl, INITIALIZE, { "x-forwarded-for": "10.0.0.2" })).status).toBe(200);
    expect((await rawPost(baseUrl, INITIALIZE, { "x-forwarded-for": "10.0.0.3" })).status).toBe(429);
  });

  it("keys the rate limit on the rightmost X-Forwarded-For entry when TRUST_PROXY is on", async () => {
    await start({ trustProxy: true, rateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }) });

    expect((await rawPost(baseUrl, INITIALIZE, { "x-forwarded-for": "1.1.1.1, 9.9.9.1" })).status).toBe(200);
    expect((await rawPost(baseUrl, INITIALIZE, { "x-forwarded-for": "2.2.2.2, 9.9.9.1" })).status).toBe(200);
    expect((await rawPost(baseUrl, INITIALIZE, { "x-forwarded-for": "3.3.3.3, 9.9.9.1" })).status).toBe(429);
    expect((await rawPost(baseUrl, INITIALIZE, { "x-forwarded-for": "3.3.3.3, 9.9.9.2" })).status).toBe(200);
  });

  it("keys a forwarded IPv6 client by its /64 when TRUST_PROXY is on", async () => {
    await start({ trustProxy: true, rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }) });

    expect((await rawPost(baseUrl, INITIALIZE, { "x-forwarded-for": "2001:db8:1:2:aaaa::1" })).status).toBe(200);
    expect((await rawPost(baseUrl, INITIALIZE, { "x-forwarded-for": "2001:db8:1:2:bbbb::2" })).status).toBe(429);
  });

  it("logs nothing about the birth moment or place while it serves a call", async () => {
    await start();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const connected = await connect();
    await connected.callTool({ name: "get_chart_data", arguments: COORDINATES });
    await connected.callTool({ name: "get_chart_data", arguments: { ...COORDINATES, place: "Austin, TX" } });

    const logged = spies.flatMap((spy) => spy.mock.calls.flat().map(String));
    for (const secret of ["1990-06-15", "19:30", "30.2672", "97.7431", "Austin"]) {
      expect(logged.join(" ")).not.toContain(secret);
    }
  });

  it("lists get_harmonic_midpoints to a client with no credentials, with exactly the fields it declares", async () => {
    await start();
    const { tools } = await (await connect()).listTools();

    const tool = tools.find((item) => item.name === "get_harmonic_midpoints");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("Call this when");
    expect(tool?.description).toContain("Returns:");
    expect(tool?.description).toContain("ENGINE=stub");
    const properties = (tool?.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    expect(Object.keys(properties).sort()).toEqual(Object.keys(harmonicInputShape).sort());
    for (const [field, schema] of Object.entries(properties)) {
      expect(schema.description, field).toBeTruthy();
    }
  });

  it("answers a tools/call for one harmonic with its structures and the placeholder marker over HTTP", async () => {
    await start();
    const result = await (await connect()).callTool({
      name: "get_harmonic_midpoints",
      arguments: { ...COORDINATES, harmonic: 5 },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      headline: expect.stringMatching(/^Harmonic 5: /),
      structures: { items: expect.any(Array), truncated: expect.any(Boolean) },
      meta: { harmonic: 5, place: { latitude: "30°16′N", longitude: "97°45′W" } },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith(`${STUB_MARKER}\n`)).toBe(true);
  });

  it("returns isError with a fix line for a harmonic outside 1 to 10000 over HTTP", async () => {
    await start();
    const result = await (await connect()).callTool({
      name: "get_harmonic_midpoints",
      arguments: { ...COORDINATES, harmonic: 10001 },
    });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /\nFix: Give the harmonic as a whole number from 1 to 10000, for example 5\.$/,
    );
  });

  it("advertises no description or title with astrolog wording, or with the forbidden words", async () => {
    await start();
    const { tools } = await (await connect()).listTools();

    // Every description and title at any depth, in the tool list. Field names are not wording.
    const strings: string[] = [];
    const collect = (value: unknown, key?: string): void => {
      if (typeof value === "string") {
        if (key === "description" || key === "title") {
          strings.push(value);
        }
      } else if (Array.isArray(value)) {
        value.forEach((item) => collect(item));
      } else if (value !== null && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) {
          collect(child, childKey);
        }
      }
    };
    collect(tools);

    expect(strings.length).toBeGreaterThan(0);
    for (const text of strings) {
      expect(text.split(STUB_MARKER).join(""), text).not.toMatch(/astrolog/i);
      expect(text, text).not.toMatch(/strong|significant|stands out/i);
    }
  });
});
