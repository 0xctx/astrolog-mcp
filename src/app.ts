import { createServer, type Server } from "node:http";
import { createMcpEndpoint, MCP_PATH, type McpEndpoint } from "./server.js";
import { createRateLimiter, DEFAULT_RATE_LIMIT_PER_MINUTE, RATE_WINDOW_MS, type RateLimiter } from "./limits.js";
import { createRegistry, type Registry } from "./registry.js";
import { createStubDeps } from "./tools/deps.js";
import { bearerToken, createTokenEndpoint, discoveryDocuments, verifyJwt, type OAuthConfig, type TokenEndpoint } from "./oauth.js";

// Path of a request target, in origin form or absolute form. new URL() throws on some
// authority-form targets such as "//[". A throw in the request listener kills the process,
// so an unparseable target falls back to its raw path, which matches no route.
function targetPath(target: string): string {
  try {
    return new URL(target, "http://localhost").pathname;
  } catch {
    return target.split("?")[0] ?? target;
  }
}

export interface AppOptions {
  // The tools to serve. Defaults to the stub engine.
  registry?: Registry;
  // Requests per client address per minute, for each of the two default limiters. Defaults to
  // DEFAULT_RATE_LIMIT_PER_MINUTE; index.ts passes RATE_LIMIT_PER_MINUTE.
  ratePerMinute?: number;
  rateLimiter?: RateLimiter;
  // The limiter for POST /token. It is separate from rateLimiter, so /mcp calls do not use up token requests.
  tokenRateLimiter?: RateLimiter;
  // Read the client address from X-Forwarded-For. See McpEndpointOptions.
  trustProxy?: boolean;
  // When set, the server exposes POST /token for client_credentials grants.
  oauthConfig?: OAuthConfig;
}

// The HTTP surface: GET /health and the stateless MCP endpoint at /mcp.
// With an oauthConfig, POST /token is also served for client_credentials grants, and the two
// public discovery documents are served at their .well-known paths.
export function createApp(options: AppOptions = {}): Server {
  const ratePerMinute = options.ratePerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const mcp: McpEndpoint = createMcpEndpoint(
    options.registry ?? createRegistry(createStubDeps()),
    options.rateLimiter ?? createRateLimiter({ limit: ratePerMinute, windowMs: RATE_WINDOW_MS }),
    { trustProxy: options.trustProxy ?? false },
  );
  const tokenEndpoint: TokenEndpoint | undefined = options.oauthConfig
    ? createTokenEndpoint(options.oauthConfig, {
        rateLimiter: options.tokenRateLimiter ?? createRateLimiter({ limit: ratePerMinute, windowMs: RATE_WINDOW_MS }),
        trustProxy: options.trustProxy ?? false,
      })
    : undefined;
  const discovery: Map<string, string> | undefined = options.oauthConfig
    ? discoveryDocuments(options.oauthConfig)
    : undefined;
  return createServer((req, res) => {
    const pathname = targetPath(req.url ?? "/");
    if ((req.method === "GET" || req.method === "HEAD") && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
      return;
    }
    const document = discovery?.get(pathname);
    if (document !== undefined && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : document);
      return;
    }
    if (pathname === MCP_PATH) {
      // With auth on, the Bearer header is checked before the rate limiter or any tool code.
      // The query string is never read, and no WWW-Authenticate header is sent.
      if (options.oauthConfig) {
        const token = bearerToken(req.headers.authorization);
        const verdict = token === undefined ? undefined : verifyJwt(token, options.oauthConfig);
        if (!verdict?.ok) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({
            error: "unauthorized",
            message: token === undefined
              ? "Send a valid Bearer token in the Authorization header."
              : "The token is invalid or expired. Request a new one from POST /token.",
          }));
          return;
        }
      }
      mcp(req, res).catch(() => {
        if (res.headersSent) {
          res.end();
          return;
        }
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error", fix: "Retry the request; if it fails again, report it." }));
      });
      return;
    }
    if (tokenEndpoint && pathname === "/token") {
      tokenEndpoint(req, res).catch((error: unknown) => {
        // The name only: a message could carry request contents or a secret.
        console.error(`POST /token failed: ${error instanceof Error ? error.name : "unknown error"}`);
        if (res.headersSent) {
          res.end();
          return;
        }
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "server_error" }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found", fix: "Send GET /health, or send POST /mcp." }));
  });
}
