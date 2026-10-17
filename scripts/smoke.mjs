// Starts the built server on a free port, lists its tools, calls get_chart_data and exits 0 only
// when both work. With ASTROLOG_BIN set it runs ENGINE=astrolog and also fails on a placeholder
// result; without it, ENGINE=stub. Run it through `npm run smoke`, which builds first.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, exited) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (exited.code !== undefined) {
      throw new Error(`server exited with ${exited.code} before answering GET /health${exited.stderr ? `:\n${exited.stderr.trim()}` : ""}`);
    }
    try {
      if ((await fetch(`${baseUrl}/health`)).status === 200) {
        return;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not answer GET /health within 30 seconds");
}

const port = await freePort();
const engine = process.env.ASTROLOG_BIN ? "astrolog" : "stub";
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["dist/index.js"], {
  env: { ...process.env, PORT: String(port), ENGINE: engine },
  stdio: ["ignore", "inherit", "pipe"],
});
const exited = { code: undefined, stderr: "" };
child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
  exited.stderr += chunk;
});
child.on("exit", (code, signal) => {
  exited.code = code ?? signal;
});

let client;
try {
  await waitForHealth(baseUrl, exited);
  client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));

  const { tools } = await client.listTools();
  if (!tools.some((tool) => tool.name === "get_chart_data")) {
    throw new Error(`get_chart_data is not listed; tools: ${tools.map((tool) => tool.name).join(", ")}`);
  }

  const result = await client.callTool({
    name: "get_chart_data",
    arguments: {
      birth_date: "1990-06-15",
      birth_time: "19:30",
      latitude: 30.2672,
      longitude: -97.7431,
      timezone: "America/Chicago",
    },
  });
  if (result.isError || typeof result.structuredContent?.headline !== "string") {
    throw new Error(`get_chart_data failed: ${JSON.stringify(result)}`);
  }

  const text = result.content?.[0]?.text ?? "";
  if (engine === "astrolog" && (text.includes("PLACEHOLDER") || result.structuredContent.meta?.astrolog_version === undefined)) {
    throw new Error("ENGINE=astrolog returned a placeholder result");
  }
  console.log(`engine: ${engine}`);
  console.log(`tools: ${tools.map((tool) => tool.name).join(", ")}`);
  console.log(`headline: ${result.structuredContent.headline}`);
  console.log("smoke ok");
} catch (error) {
  console.error(`smoke failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  child.kill();
}
