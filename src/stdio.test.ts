import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { STUB_MARKER, type ChartOutput } from "./tools/chart.js";
import { toolNames } from "./registry.js";

// The spawned-entry tests run the built file, the same one `npm start` would run. npm test does
// not build, so the test compiles the project into node_modules/.cache first. That directory is
// inside the repo, so the compiled file resolves the installed SDK packages.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const buildDir = join(repoRoot, "node_modules", ".cache", "astrolog-mcp-stdio");
const entry = join(buildDir, "stdio.js");
const TEST_TIMEOUT_MS = 30_000;
// The SDK's latest protocol version. A client that sends it gets the modern handshake.
const PROTOCOL_VERSION = "2025-11-25";

const COORDINATES = {
  birth_date: "1990-06-15",
  birth_time: "19:30",
  latitude: 30.2672,
  longitude: -97.7431,
  timezone: "America/Chicago",
};

function buildEntry(): Promise<void> {
  rmSync(buildDir, { recursive: true, force: true });
  const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [tsc, "-p", "tsconfig.build.json", "--outDir", buildDir],
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

// Starts the built entry with only the environment the SDK passes by default, so ENGINE and
// ASTROLOG_MCP_DATA from the test runner cannot leak in unless a test sets them.
function childEnv(env: Record<string, string>): Record<string, string> {
  return { ...getDefaultEnvironment(), ...env };
}

interface Session {
  client: Client;
  // Everything the child wrote to stderr so far.
  stderr: string[];
}

async function openSession(env: Record<string, string>): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: childEnv(env),
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  const client = new Client({ name: "stdio-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("condition not met within 10 seconds");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// Speaks newline-delimited JSON-RPC to the entry and keeps every byte it writes to stdout. The SDK
// client cannot make this check: its reader skips a stdout line that is not JSON without reporting
// it, so a stray console.log would go unseen there.
async function rawExchange(): Promise<{ stdout: string; exitCode: number | null }> {
  const child = spawn(process.execPath, [entry], { env: childEnv({ ENGINE: "stub" }), stdio: "pipe" });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.resume();
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  // The ids of the lines that parse as JSON, so a waiting step can see its own answer.
  const answeredIds = (): number[] =>
    stdout.split("\n").flatMap((line) => {
      try {
        const message = JSON.parse(line) as { id?: unknown };
        return typeof message.id === "number" ? [message.id] : [];
      } catch {
        return [];
      }
    });

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw", version: "0" } },
  });
  await waitFor(() => answeredIds().includes(1));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await waitFor(() => answeredIds().includes(2));
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_chart_data", arguments: COORDINATES } });
  await waitFor(() => answeredIds().includes(3));

  // Closing stdin ends the stdio transport, and the entry exits on its own.
  child.stdin.end();
  const exitCode = await exited;
  return { stdout, exitCode };
}

describe("stdio entry", () => {
  let session: Session | undefined;

  beforeAll(buildEntry, 120_000);

  afterEach(async () => {
    await session?.client.close().catch(() => {});
    session = undefined;
  });

  it(
    "lists and calls get_chart_data through the SDK stdio client",
    async () => {
      session = await openSession({ ENGINE: "stub" });

      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(toolNames());
      expect(tools.map((tool) => tool.name)).toContain("get_chart_data");

      const result = await session.client.callTool({ name: "get_chart_data", arguments: COORDINATES });
      expect(result.isError).not.toBe(true);
      const chart = result.structuredContent as ChartOutput;
      expect(chart.meta.astrolog_version).toMatch(/^stub/);

      // A text-only host reads the text: the placeholder marker, the headline, then the full JSON.
      const [marker, headline, json] = (result.content[0] as { text: string }).text.split("\n");
      expect(marker).toBe("PLACEHOLDER numbers (ENGINE=stub), not astrolog output.");
      expect(headline).toBe(chart.headline);
      expect(JSON.parse(json ?? "")).toEqual(chart);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "writes only JSON-RPC messages to stdout",
    async () => {
      const { stdout, exitCode } = await rawExchange();

      const lines = stdout.split("\n").filter((line) => line.length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        const message = JSON.parse(line) as { jsonrpc?: unknown };
        expect(message.jsonrpc, `stdout line is not JSON-RPC: ${line}`).toBe("2.0");
      }
      expect(exitCode).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "advertises no astrolog wording under the stub, except inside the placeholder marker",
    async () => {
      session = await openSession({ ENGINE: "stub" });

      const { tools } = await session.client.listTools();
      // Every description and title in the advertised list, at any depth: the tool's own and those
      // in the input and output schemas. Field names are not wording, and the output field
      // astrolog_version is part of the contract, so they are not checked.
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
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "warns on stderr when ENGINE is unset, and still serves the stub",
    async () => {
      session = await openSession({});

      await waitFor(() => session?.stderr.join("").includes("ENGINE is not set") === true);
      const { tools } = await session.client.listTools();

      expect(tools.map((tool) => tool.name).sort()).toEqual(toolNames());
      expect(tools.map((tool) => tool.name)).toContain("get_chart_data");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 1 with the reason on stderr and nothing on stdout when ENGINE=astrolog",
    () => {
      const run = spawnSync(process.execPath, [entry], {
        env: childEnv({ ENGINE: "astrolog" }),
        encoding: "utf8",
        timeout: TEST_TIMEOUT_MS,
      });

      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("ASTROLOG_BIN is not set");
      expect(run.stderr).toContain("fix: Set ASTROLOG_BIN");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts with a bad RATE_LIMIT_PER_MINUTE, which only the HTTP entry reads",
    async () => {
      session = await openSession({ ENGINE: "stub", RATE_LIMIT_PER_MINUTE: "abc" });

      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(toolNames());
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 1 with the fix line on stderr when ENGINE_QUEUE is below its minimum of 3",
    () => {
      const run = spawnSync(process.execPath, [entry], {
        env: childEnv({ ENGINE: "stub", ENGINE_QUEUE: "2" }),
        encoding: "utf8",
        timeout: TEST_TIMEOUT_MS,
      });

      expect(run.status).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain('ENGINE_QUEUE must be a whole number from 3 to 1000, got "2"');
      expect(run.stderr).toContain("Fix: Set ENGINE_QUEUE");
    },
    TEST_TIMEOUT_MS,
  );

  it.each(["SIGTERM", "SIGINT"] as const)("exits 0 when the host sends %s", async (signal) => {
    const child = spawn(process.execPath, [entry], { env: childEnv({ ENGINE: "stub" }), stdio: "pipe" });
    child.stderr.resume();
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );

    // Signal only after the server has answered, so the handler is installed before the signal.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw", version: "0" } },
      })}\n`,
    );
    await waitFor(() => stdout.includes('"id":1'));
    child.kill(signal);

    expect(await exited).toEqual({ code: 0, signal: null });
  }, TEST_TIMEOUT_MS);

  it(
    "answers initialize at protocolVersion 2025-03-26 with 2025-03-26 and the package.json version over stdio",
    async () => {
      const child = spawn(process.execPath, [entry], { env: childEnv({ ENGINE: "stub" }), stdio: "pipe" });
      child.stderr.resume();
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      const exited = new Promise<{ code: number | null }>((resolve) =>
        child.once("exit", (code) => resolve({ code })),
      );

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "Generic MCP Client", version: "1.0.0" },
          },
        })}\n`,
      );
      await waitFor(() => stdout.includes('"id":1'));
      child.stdin.end();
      await exited;

      const response = JSON.parse(stdout.trim().split("\n")[0] ?? "{}") as {
        result?: { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
      };
      const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
      expect(response.result?.protocolVersion).toBe("2025-03-26");
      expect(response.result?.serverInfo?.name).toBe("astrolog-mcp");
      expect(response.result?.serverInfo?.version).toBe(manifest.version);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stays strict over stdio: an initialize whose clientInfo has no version is refused, not patched",
    async () => {
      const child = spawn(process.execPath, [entry], { env: childEnv({ ENGINE: "stub" }), stdio: "pipe" });
      child.stderr.resume();
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      const exited = new Promise<unknown>((resolve) => child.once("exit", resolve));

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "Generic MCP Client" } },
        })}\n`,
      );
      await waitFor(() => stdout.includes('"id":1'));
      child.stdin.end();
      await exited;

      const response = JSON.parse(stdout.trim().split("\n")[0] ?? "{}") as { result?: unknown; error?: unknown };
      expect(response.result).toBeUndefined();
      expect(response.error).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  it("packs only dist, the README, the licence files and package.json: no tests or fixtures", () => {
    const [pack] = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as { files: { path: string }[] }[];
    const paths = (pack?.files ?? []).map((file) => file.path);

    expect(paths).toContain("README.md");
    expect(paths).toContain("package.json");
    expect(paths).toContain("LICENSE");
    expect(paths).toContain("NOTICE");
    for (const path of paths) {
      expect(
        ["package.json", "README.md", "LICENSE", "NOTICE"].includes(path) || path.startsWith("dist/"),
        path,
      ).toBe(true);
      expect(path, path).not.toMatch(/\.test\.[cm]?[jt]s$/);
      expect(path, path).not.toMatch(/(^|\/)fixtures?\//);
    }
  }, TEST_TIMEOUT_MS);

  it("names the built entry as the astrolog-mcp bin, and keeps its node shebang", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(manifest.bin).toEqual({ "astrolog-mcp": "dist/stdio.js" });
    expect(readFileSync(entry, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("does not write to stdout from its own source", () => {
    const source = readFileSync(join(repoRoot, "src", "stdio.ts"), "utf8");

    expect(source).not.toMatch(/console\.log|process\.stdout/);
  });

  describe("start-up without a package.json", () => {
    // The build is copied under a directory that has no package.json above it, so the version
    // walk-up finds none. node_modules is linked in so the copy still imports the SDK.
    let isolated: string;

    beforeAll(() => {
      isolated = mkdtempSync(join(tmpdir(), "astrolog-no-manifest-"));
      cpSync(buildDir, join(isolated, "dist"), { recursive: true });
      symlinkSync(join(repoRoot, "node_modules"), join(isolated, "node_modules"), "dir");
    });

    afterAll(() => {
      rmSync(isolated, { recursive: true, force: true });
    });

    it.each(["stdio.js", "index.js"])(
      "%s exits 1 with the fix line on stderr and nothing on stdout",
      (file) => {
        const run = spawnSync(process.execPath, [join(isolated, "dist", file)], {
          env: childEnv({ ENGINE: "stub" }),
          encoding: "utf8",
          timeout: TEST_TIMEOUT_MS,
        });

        expect(run.status).toBe(1);
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("could not resolve astrolog-mcp version");
        expect(run.stderr).toContain(
          "fix: Reinstall astrolog-mcp so its package.json is in place, then start it again.",
        );
      },
      TEST_TIMEOUT_MS,
    );
  });
});
