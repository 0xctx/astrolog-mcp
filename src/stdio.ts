#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer, resolveServerVersion } from "./server.js";
import { createRegistry, type Registry } from "./registry.js";
import { parseEngineLimits } from "./limits.js";
import { depsFromEngine } from "./tools/deps.js";
import { reportStartFailure } from "./tools/start-failure.js";

// The stdio entry for MCP hosts that start the server as a child process, such as Claude Desktop,
// Claude Code and Cursor. It serves the same registry as the HTTP entry in index.ts, and reads the
// same ENGINE, ENGINE_CONCURRENCY and ENGINE_QUEUE settings. RATE_LIMIT_PER_MINUTE belongs to the HTTP
// entry, so this entry does not read it. stdout belongs to the protocol, so every log line here goes to stderr.

let registry: Registry;
try {
  // Resolved up front so a broken install (no package.json) fails fast at
  // start-up with a reported error, not on the first connection.
  resolveServerVersion();
  const limits = parseEngineLimits(process.env);
  registry = createRegistry(await depsFromEngine(process.env.ENGINE), limits);
} catch (error) {
  reportStartFailure(error);
  process.exit(1);
}
if (!process.env.ENGINE) {
  console.error("ENGINE is not set; using the stub engine, whose numbers are placeholders");
}

// Errors go out by name only, the same rule the HTTP endpoint follows, because a message can echo input.
const connection = serveStdio(() => createMcpServer(registry), {
  onerror: (error) => console.error("mcp stdio error:", error.name),
});

// A host that stops the server signals it. Closing the transport ends the connection cleanly, and
// the exit is 0 whether or not the close reports an error, because the host asked us to stop.
function stop(): void {
  connection
    .close()
    .catch((error: unknown) => console.error("mcp stdio close error:", error instanceof Error ? error.name : "unknown"))
    .finally(() => process.exit(0));
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
