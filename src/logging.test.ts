import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { execFile, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import type { OAuthConfig } from "./oauth.js";
import { createRegistry } from "./registry.js";
import { StubEngine } from "./stub-engine.js";
import { createStubDeps, type ToolDeps } from "./tools/deps.js";

// Every console method the server can write through. A log line may name a failure, but it must
// never carry what a caller sent or got back: birth data, a token, or an Authorization header.
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

// The stdio entry is run as a built file, the same one `npm start` would run, so its start-up path
// is the real one. It is built into its own folder so it does not race the stdio tests' build.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const stdioBuildDir = join(repoRoot, "node_modules", ".cache", "astrolog-mcp-logging");
const stdioEntry = join(stdioBuildDir, "stdio.js");
// The SDK's latest protocol version. A client that sends it gets the modern handshake.
const PROTOCOL_VERSION = "2025-11-25";

function buildStdioEntry(): Promise<void> {
  rmSync(stdioBuildDir, { recursive: true, force: true });
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [tsc, "-p", "tsconfig.build.json", "--outDir", stdioBuildDir],
      { cwd: repoRoot },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`tsc failed:\n${stdout}${stderr}`));
          return;
        }
        resolve();
      },
    );
  });
}

const CLIENT_SECRET = "logging-client-secret-0123456789abcdef0123";
const OAUTH: OAuthConfig = {
  publicUrl: "https://astrolog-logging.invalid",
  clientId: "logging-client",
  clientSecret: CLIENT_SECRET,
  signingKey: "logging-signing-key-0123456789abcdef0123",
};

// Birth values that appear nowhere else in a log line, so finding one means the input was logged.
const BIRTH = {
  birth_date: "1987-03-22",
  birth_time: "06:41",
  latitude: 48.8566,
  longitude: 2.3522,
  timezone: "Europe/Paris",
};
const BIRTH_VALUES = ["1987-03-22", "06:41", "48.8566", "2.3522", "Europe/Paris"];

// An engine whose chart call fails with a message that echoes the birth input. The server must log
// the error's name at most, not this message.
function failingDeps(): ToolDeps {
  const stub = new StubEngine();
  return {
    ...createStubDeps(),
    engine: {
      cast: async (input) => {
        throw new Error(`cannot cast ${input.utc} at ${input.latitude}, ${input.longitude}`);
      },
      sky: (input) => stub.sky(input),
      composite: (input) => stub.composite(input),
    },
  };
}

// Starts the app on a free loopback port. The caller closes it.
async function start(options: Parameters<typeof createApp>[0]): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createApp(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function requestToken(url: string, secret: string): Promise<Response> {
  return fetch(`${url}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: OAUTH.clientId, client_secret: secret }),
  });
}

// One chart call through the MCP client, with the Bearer token on every request.
async function callChart(url: string, token: string, args: Record<string, unknown>) {
  const client = new Client({ name: "logging", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    return await client.callTool({ name: "get_chart_data", arguments: args });
  } finally {
    await client.close();
  }
}

describe("log lines with auth on", () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const method of CONSOLE_METHODS) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === "string" ? arg : inspect(arg))).join(" "));
      });
    }
    // Direct writes to the two streams are copied too. Each write still reaches the real stream.
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
      vi.spyOn(stream, "write").mockImplementation((...args: unknown[]) => {
        logged.push(String(args[0]));
        return write(...args);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes no tool input or output, token or Authorization header to any log call", async () => {
    const app = await start({ registry: createRegistry(createStubDeps()), oauthConfig: OAUTH });
    const failing = await start({ registry: createRegistry(failingDeps()), oauthConfig: OAUTH });
    try {
      const good = await requestToken(app.url, CLIENT_SECRET);
      expect(good.status).toBe(200);
      const { access_token: token } = (await good.json()) as { access_token: string };
      expect((await requestToken(app.url, "wrong-secret-0123456789abcdef0123456789")).status).toBe(401);
      const forged = await fetch(`${app.url}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer forged.token.value", "content-type": "application/json" },
        body: "{}",
      });
      expect(forged.status).toBe(401);

      const answered = await callChart(app.url, token, BIRTH);
      expect(answered.isError).not.toBe(true);
      const headline = String((answered.structuredContent as { headline?: string } | undefined)?.headline);
      const failed = await callChart(failing.url, token, BIRTH);
      expect(failed.isError).toBe(true);

      // The failure path must have logged, or the check below proves nothing.
      expect(logged.some((line) => line.includes("get_chart_data failed:"))).toBe(true);

      const secrets = [CLIENT_SECRET, token, "Bearer", "authorization", headline, ...BIRTH_VALUES];
      const leaks = logged.flatMap((line) =>
        secrets.filter((secret) => line.toLowerCase().includes(secret.toLowerCase())).map((secret) => `${secret} in "${line}"`),
      );
      expect(leaks).toEqual([]);
    } finally {
      await app.close();
      await failing.close();
    }
  });

  describe("the stdio start-up path", () => {
    beforeAll(buildStdioEntry, 120_000);

    it("writes no tool input or output, token or Authorization header to stderr", async () => {
      // A real stdio run: the start-up reads the limits and the engine, then a host calls a tool. The
      // child's stdout is the protocol, not a log, so it is not searched; its stderr is copied in.
      const child = spawn(process.execPath, [stdioEntry], {
        env: { ...getDefaultEnvironment(), ENGINE_CONCURRENCY: "2", ENGINE_QUEUE: "3" },
        stdio: "pipe",
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => logged.push(chunk));
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
      const answered = (id: number) => stdout.includes(`"id":${id}`);

      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "logging", version: "0.0.0" } },
      });
      await vi.waitFor(() => expect(answered(1)).toBe(true), { timeout: 10_000 });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_chart_data", arguments: BIRTH } });
      await vi.waitFor(() => expect(answered(2)).toBe(true), { timeout: 10_000 });

      // Closing stdin ends the stdio transport, and the entry exits 0 on its own.
      child.stdin.end();
      expect(await exited).toBe(0);

      // The start-up path ran: it warns on stderr that ENGINE is unset, before any request.
      expect(logged.some((line) => line.includes("ENGINE is not set"))).toBe(true);
      const secrets = [...BIRTH_VALUES, "Bearer", "authorization"];
      const leaks = logged.flatMap((line) =>
        secrets.filter((secret) => line.toLowerCase().includes(secret.toLowerCase())).map((secret) => `${secret} in "${line}"`),
      );
      expect(leaks).toEqual([]);
    }, 30_000);
  });
});
