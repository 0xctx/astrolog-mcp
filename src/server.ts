import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createMcpHandler, McpServer, type McpHttpHandler } from "@modelcontextprotocol/server";
import { BodyTooLargeError, clientKey, MAX_BODY_BYTES, readBody, type RateLimiter } from "./limits.js";
import type { Registry } from "./registry.js";
import { AstroError } from "./types.js";

export const SERVER_NAME = "astrolog-mcp";

// Walks up from `fromDir` to the package.json that declares this package and
// returns its version. `../package.json` would break when the file is compiled
// or copied into a layout (a test build cache, or a tool's copy) whose parent
// is not the package root, so the walk-up matches by `name` and never a
// neighbor's manifest. `fromDir` is overridable so tests can prove the
// function fails loud rather than inventing a version: a missing manifest is a
// broken install, not a zero version.
export function packageVersion(fromDir: string = dirname(fileURLToPath(import.meta.url))): string {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "package.json");
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (parsed.name === SERVER_NAME && typeof parsed.version === "string" && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // No package.json here (or unreadable); keep walking up the tree.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new AstroError(
        `could not resolve ${SERVER_NAME} version: no package.json named "${SERVER_NAME}" was found walking up from ${fromDir}`,
        `Reinstall ${SERVER_NAME} so its package.json is in place, then start it again.`,
      );
    }
    dir = parent;
  }
}

// The version is constant for a build, so it is resolved once and cached. The
// entry points call this at start-up so a missing manifest fails fast with a
// reported error instead of a per-request 500 or a silent 0.0.0.
let cachedServerVersion: string | undefined;
export function resolveServerVersion(): string {
  if (cachedServerVersion === undefined) {
    cachedServerVersion = packageVersion();
  }
  return cachedServerVersion;
}

export const MCP_PATH = "/mcp";

const METHODS = ["GET", "POST", "DELETE"] as const;

// One McpServer per request, built from the registry. Nothing about a client carries over
// between requests, so the endpoint is stateless.
export function createMcpServer(registry: Registry): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: resolveServerVersion() });
  registry.register(server);
  return server;
}

// The stateless Streamable HTTP handler. The SDK also answers 2025-era clients through its
// stateless fallback. Errors go to the console by name only, because a message can echo input.
function createHandler(registry: Registry): McpHttpHandler {
  return createMcpHandler(() => createMcpServer(registry), {
    legacy: "stateless",
    maxRequestBodySize: MAX_BODY_BYTES,
    onerror: (error) => console.error("mcp endpoint error:", error.name),
  });
}

// Reports whether an Accept header explicitly names `mediaType` (case-insensitive) with a
// positive q-value. `q=0` excludes it, and a wildcard (`*`, `*/*`, `text/*`) does not count as
// accepting a specific media type: a client that sends only `*/*` (or no Accept) is served plain
// JSON, as the contract requires for generic clients that do not advertise SSE.
function acceptsMediaType(header: string | null | undefined, mediaType: string): boolean {
  if (!header) {
    return false;
  }
  const target = mediaType.toLowerCase();
  for (const part of header.split(",")) {
    const [range, ...params] = part.trim().split(";");
    const qParam = params.find((p) => p.trim().toLowerCase().startsWith("q="));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2).trim());
    if (Number.isNaN(q) || q <= 0) {
      continue;
    }
    if ((range ?? "").trim().toLowerCase() === target) {
      return true;
    }
  }
  return false;
}

// Turns a Node request into a web Request for the SDK. The base URL is fixed, so a Host header
// cannot change how the target is read. The SDK answers 406 unless the request advertises both
// application/json and text/event-stream, so it is always given both. This layer then re-frames
// the reply as JSON for clients that do not take event-stream. The request signal is carried
// through so a client that disconnects mid-stream aborts the SDK request (see the per-request
// AbortController in createMcpEndpoint).
function toWebRequest(req: IncomingMessage, url: URL, body: Buffer | undefined, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  // The SDK tests Accept by case-sensitive substring, so a mixed-case or `q=0` header would be
  // refused or misread. This layer has already read the client's real Accept (acceptsMediaType),
  // so the SDK always gets the canonical pair.
  headers.set("accept", "application/json, text/event-stream");
  return new Request(url, {
    method: req.method,
    headers,
    body: body === undefined ? undefined : new Uint8Array(body),
    signal,
  });
}

// Extracts the JSON-RPC message(s) carried as `data:` lines in an SSE body. Tolerant of CRLF
// and lone-CR framing. The shape follows the posted body, not the event count: a single
// request yields one object; a batch yields an array (even a one-event batch), so a one-request
// batch is answered with an array rather than a bare object.
export function parseJsonRpcFromSse(text: string, isBatch: boolean): unknown {
  const messages: unknown[] = [];
  for (const frame of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    const dataLines = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length > 0) {
      try {
        messages.push(JSON.parse(dataLines.join("\n")));
      } catch {
        // Unparseable data chunk; skipped.
      }
    }
  }
  if (isBatch) {
    return messages;
  }
  if (messages.length === 0) {
    return JSON.parse(text);
  }
  return messages.length === 1 ? messages[0] : messages[messages.length - 1];
}

// Whether the posted body is a JSON-RPC batch (a top-level array). The buffered SSE reply is
// shaped to match: a batch in, an array out.
function isBatchRequest(body: Buffer | undefined): boolean {
  if (body === undefined || body.length === 0) {
    return false;
  }
  try {
    return Array.isArray(JSON.parse(body.toString("utf8")));
  } catch {
    return false;
  }
}

// The JSON-RPC message objects a posted body carries: the body itself, or each entry of a batch.
// Anything that is not an object is left out.
function postedMessages(body: Buffer | undefined): Record<string, unknown>[] {
  if (body === undefined || body.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  } catch {
    return [];
  }
}

// Reads a web body to its end as UTF-8 text. A missing reader (no body) reads as empty.
async function readText(reader: ReadableStreamDefaultReader<Uint8Array> | undefined): Promise<string> {
  if (reader === undefined) {
    return "";
  }
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    text += decoder.decode(value, { stream: true });
  }
}

// Generic clients may send clientInfo without a version string. The SDK schema requires
// a version string on initialize; supply a placeholder version if omitted so the handshake succeeds.
function patchClientInfoVersion(body: Buffer | undefined): Buffer | undefined {
  if (body === undefined || body.length === 0) {
    return body;
  }
  try {
    const parsed = JSON.parse(body.toString("utf8")) as {
      method?: unknown;
      params?: { clientInfo?: { name?: unknown; version?: unknown } };
    };
    if (
      parsed &&
      parsed.method === "initialize" &&
      parsed.params?.clientInfo &&
      typeof parsed.params.clientInfo.name === "string" &&
      parsed.params.clientInfo.version === undefined
    ) {
      parsed.params.clientInfo.version = "0.0.0";
      return Buffer.from(JSON.stringify(parsed), "utf8");
    }
  } catch {
    // Non-JSON or malformed payload; left for the SDK handler to validate.
  }
  return body;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

// Streams the SDK's response back, so SSE replies flow as they are produced.
async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  // A client that disconnects mid-stream ends the pipeline with an error. That is not a server
  // fault, so it is not reported.
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res).catch(() => {});
}

export interface McpEndpoint {
  (req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export interface McpEndpointOptions {
  // Key the rate limit on the rightmost X-Forwarded-For entry. Only set this behind a proxy that
  // overwrites the header, because otherwise a caller chooses its own key.
  trustProxy?: boolean;
}

// The /mcp route: rate limit by client address, cap the body, then hand the request to the SDK.
// No request is authenticated, and none of its contents are stored.
export function createMcpEndpoint(
  registry: Registry,
  rateLimiter: RateLimiter,
  { trustProxy = false }: McpEndpointOptions = {},
): McpEndpoint {
  const handler = createHandler(registry);
  return async (req, res) => {
    const decision = rateLimiter.check(clientKey(req, trustProxy));
    if (!decision.allowed) {
      sendJson(
        res,
        429,
        { error: "rate limit exceeded", fix: `Wait ${decision.retryAfterSeconds} seconds, then retry.` },
        { "retry-after": String(decision.retryAfterSeconds) },
      );
      return;
    }

    const method = req.method ?? "GET";
    if (!(METHODS as readonly string[]).includes(method)) {
      sendJson(res, 405, { error: "method not allowed", fix: "Send POST /mcp, or GET or DELETE for a stream." }, {
        allow: METHODS.join(", "),
      });
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? MCP_PATH, "http://localhost");
    } catch {
      sendJson(res, 400, { error: "malformed request target", fix: "Send the request to /mcp with a valid URL." });
      return;
    }

    let body: Buffer | undefined;
    if (method === "POST") {
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, {
            error: "request body too large",
            fix: `Send at most ${MAX_BODY_BYTES} bytes, for example one tools/call with a short argument list.`,
          });
          return;
        }
        throw error;
      }
    }

    const clientAcceptsSse = acceptsMediaType(
      Array.isArray(req.headers.accept) ? req.headers.accept.join(", ") : req.headers.accept,
      "text/event-stream",
    );

    // The SDK keeps an event-stream reply open until the request's signal aborts, so each request
    // gets its own controller, aborted on the response's `close` event (a client disconnect). `req`
    // close is NOT used: a request's close fires once its body has been read, before the reply is
    // written, so it would abort every request.
    const controller = new AbortController();
    res.on("close", () => controller.abort());

    const patchedBody = patchClientInfoVersion(body);
    // A subscriptions/listen reply is a stream that stays open. A client that cannot take
    // event-stream is refused here, before the SDK opens a subscription for it.
    const listen = postedMessages(patchedBody).find((message) => message.method === "subscriptions/listen");
    if (!clientAcceptsSse && listen !== undefined) {
      sendJson(res, 406, {
        jsonrpc: "2.0",
        id: listen.id ?? null,
        error: { code: -32600, message: "subscriptions/listen needs Accept: text/event-stream" },
      });
      return;
    }
    try {
      const response = await handler.fetch(toWebRequest(req, url, patchedBody, controller.signal));
      if (!clientAcceptsSse && response.headers.get("content-type")?.includes("text/event-stream")) {
        // The reply is SSE and the client does not take event-stream, so buffer it and re-serve
        // as JSON. A client that disconnects mid-buffer cancels the body and aborts the request;
        // there is then no answer to send, so the response is just ended.
        const reader = response.body?.getReader();
        res.once("close", () => {
          reader?.cancel().catch(() => {});
        });
        const text = await readText(reader).catch(() => "");
        if (controller.signal.aborted) {
          res.end();
        } else {
          sendJson(res, response.status, parseJsonRpcFromSse(text, isBatchRequest(patchedBody)));
        }
      } else {
        await sendWebResponse(res, response);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        // A client that disconnected mid-request is not a server fault.
        res.end();
      } else {
        console.error("mcp endpoint failed:", error instanceof Error ? error.name : "unknown");
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal error", fix: "Retry the request; if it fails again, report it." });
        } else {
          res.end();
        }
      }
    }
  };
}
