import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { BodyTooLargeError, clientKey, readBody, type RateLimiter } from "./limits.js";
import { MCP_PATH } from "./server.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface OAuthConfig {
  /** The public URL of this server (e.g. "https://mcp.example.com"). */
  publicUrl: string;
  /** The single static client ID. */
  clientId: string;
  /** The single static client secret. */
  clientSecret: string;
  /** HS256 signing key, used as its UTF-8 bytes (at least 32 characters, not one repeated character). */
  signingKey: string;
}

const MIN_SECRET_BYTES = 32;
const MIN_SIGNING_KEY_CHARS = 32;

// The host names safe to serve over http://: the client secret and bearer tokens would otherwise
// cross the network in cleartext. The IPv6 literal [::1] is bracketed by the URL grammar, so its
// brackets are stripped before the comparison.
function isLoopbackHost(host: string): boolean {
  const normalized = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/** Reads and validates OAuth env vars. Throws with a fix line on any problem. */
export function parseOAuthConfig(env: Record<string, string | undefined>): OAuthConfig {
  const rawUrl = env.PUBLIC_URL;
  if (!rawUrl) {
    throw new Error("AUTH_MODE=oauth requires PUBLIC_URL.\nFix: Set PUBLIC_URL to the public base URL of this server.");
  }
  const urlFix = "Fix: Set PUBLIC_URL to the origin only, like https://mcp.example.com, with no path, query or fragment.";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL.\n${urlFix}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`PUBLIC_URL must start with http:// or https://.\n${urlFix}`);
  }
  if (rawUrl.includes("?") || rawUrl.includes("#") || url.username !== "" || url.password !== "" || url.pathname.replace(/\/+$/, "") !== "") {
    throw new Error(`PUBLIC_URL must be an origin with no path, query, fragment or credentials.\n${urlFix}`);
  }

  // http:// must point at the loopback host: over plain http:// the client secret and bearer tokens
  // would travel in cleartext. https:// is required otherwise; loopback stays for local testing.
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `PUBLIC_URL uses http:// with a non-loopback host, so the client secret and bearer tokens would travel in cleartext.\nFix: Use https://, or run on http://localhost, http://127.0.0.1 or http://[::1] for local testing only.`,
    );
  }

  const clientId = env.OAUTH_CLIENT_ID;
  if (!clientId) {
    throw new Error("AUTH_MODE=oauth requires OAUTH_CLIENT_ID.\nFix: Set OAUTH_CLIENT_ID to a non-empty client identifier.");
  }

  const clientSecret = env.OAUTH_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error("AUTH_MODE=oauth requires OAUTH_CLIENT_SECRET.\nFix: Set OAUTH_CLIENT_SECRET to a random secret of at least 32 bytes, for example the output of `openssl rand -hex 32`.");
  }
  if (Buffer.byteLength(clientSecret, "utf8") < MIN_SECRET_BYTES) {
    throw new Error(`OAUTH_CLIENT_SECRET must be at least ${MIN_SECRET_BYTES} bytes, got ${Buffer.byteLength(clientSecret, "utf8")}.\nFix: Set OAUTH_CLIENT_SECRET to a random secret of at least 32 bytes, for example the output of \`openssl rand -hex 32\`.`);
  }

  if (/^(.)\1*$/su.test(clientSecret)) {
    throw new Error("OAUTH_CLIENT_SECRET must not be one repeated character.\nFix: Set OAUTH_CLIENT_SECRET to a random secret of at least 32 bytes, for example the output of `openssl rand -hex 32`.");
  }

  const signingKey = env.OAUTH_SIGNING_KEY;
  const keyFix = "Fix: Set OAUTH_SIGNING_KEY to a random string of at least 32 characters, for example the output of `openssl rand -hex 32`.";
  if (!signingKey) {
    throw new Error(`AUTH_MODE=oauth requires OAUTH_SIGNING_KEY.\n${keyFix}`);
  }
  if ([...signingKey].length < MIN_SIGNING_KEY_CHARS) {
    throw new Error(`OAUTH_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_CHARS} characters, got ${[...signingKey].length}.\n${keyFix}`);
  }
  if (/^(.)\1*$/su.test(signingKey)) {
    throw new Error(`OAUTH_SIGNING_KEY must not be one repeated character.\n${keyFix}`);
  }

  if (clientSecret === signingKey) {
    throw new Error("OAUTH_CLIENT_SECRET must not be the same value as OAUTH_SIGNING_KEY.\nFix: Use a different random value for each, for example `openssl rand -hex 32` for the client secret and another run for the signing key.");
  }

  return { publicUrl: url.origin, clientId, clientSecret, signingKey };
}

/** Reads AUTH_MODE. Returns "oauth" or undefined (off). */
export function parseAuthMode(value: string | undefined): "oauth" | undefined {
  if (value === undefined || value === "" || value === "off") {
    return undefined;
  }
  if (value === "oauth") {
    return "oauth";
  }
  throw new Error(`AUTH_MODE must be "oauth" or unset, got an unsupported value.\nFix: Set AUTH_MODE=oauth to enable the token endpoint, or leave it unset.`);
}

// ---------------------------------------------------------------------------
// JWT (HS256, compact serialisation)
// ---------------------------------------------------------------------------

function base64url(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

export interface JwtPayload {
  iss: string;
  aud: string;
  scope: string;
  iat: number;
  exp: number;
}

export function signJwt(payload: JwtPayload, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/** Why a token was refused. Never carries the token. */
export type JwtFailure = "malformed" | "signature" | "expired" | "issuer" | "audience" | "scope";

const B64URL = /^[A-Za-z0-9_-]+$/;

function decodeJson(part: string): Record<string, unknown> | undefined {
  if (!B64URL.test(part)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Checks an HS256 JWT: structure, algorithm, signature, expiry, issuer, audience and a scope of exactly mcp:service. */
export function verifyJwt(token: string, config: OAuthConfig, nowSeconds = Math.floor(Date.now() / 1000)): { ok: true } | { ok: false; reason: JwtFailure } {
  const parts = token.split(".");
  const [h, p, sig] = parts;
  if (parts.length !== 3 || !h || !p || !sig || !B64URL.test(sig)) return { ok: false, reason: "malformed" };
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload || header.alg !== "HS256") return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", config.signingKey).update(`${h}.${p}`).digest();
  const actual = Buffer.from(sig, "base64url");
  // Only the canonical spelling is accepted: the re-encoded signature must equal the one sent.
  if (actual.toString("base64url") !== sig || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return { ok: false, reason: "signature" };

  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds) return { ok: false, reason: "expired" };
  if (payload.iss !== config.publicUrl) return { ok: false, reason: "issuer" };
  if (payload.aud !== `${config.publicUrl}/mcp`) return { ok: false, reason: "audience" };
  if (payload.scope !== ALLOWED_SCOPE) return { ok: false, reason: "scope" };
  return { ok: true };
}

/** The token from an "Authorization: Bearer <token>" header value, or undefined. Only the header is read. */
export function bearerToken(header: string | undefined): string | undefined {
  return header === undefined ? undefined : /^Bearer +(\S+)$/i.exec(header)?.[1];
}

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  // Hash both sides so the compared buffers always have the same length.
  const aDigest = createHash("sha256").update(a, "utf8").digest();
  const bDigest = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(aDigest, bDigest);
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

const TOKEN_BODY_LIMIT = 4096;
const EXPIRES_IN = 3600;
const ALLOWED_SCOPE = "mcp:service";

interface TokenRequest {
  grantType: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
  resource: string | undefined;
  scope: string | undefined;
}

// application/x-www-form-urlencoded decoding, shared by the body and the Basic header
// (RFC 6749 2.3.1 form-encodes the id and secret before base64). Throws on bad percent-encoding.
function formDecode(text: string): string {
  return decodeURIComponent(text.replace(/\+/g, " "));
}

function parseBasicAuth(header: string): { id: string; secret: string } | undefined {
  const match = /^Basic\s+(\S+)$/i.exec(header);
  if (!match?.[1]) return undefined;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return undefined;
  try {
    return { id: formDecode(decoded.slice(0, colon)), secret: formDecode(decoded.slice(colon + 1)) };
  } catch {
    return undefined;
  }
}

type FormResult = { params: Map<string, string> } | { malformed: true } | { duplicate: true };

function parseFormBody(body: string): FormResult {
  const params = new Map<string, string>();
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    let key: string;
    let value: string;
    try {
      key = formDecode(pair.slice(0, eq));
      value = formDecode(pair.slice(eq + 1));
    } catch {
      return { malformed: true };
    }
    if (params.has(key)) return { duplicate: true };
    params.set(key, value);
  }
  return { params };
}

type TokenParse = { request: TokenRequest } | { status: number; error: string; description: string };

function parseTokenRequest(authHeader: string | undefined, bodyText: string): TokenParse {
  const form = parseFormBody(bodyText);
  if ("malformed" in form) {
    return { status: 400, error: "invalid_request", description: "The request body is not valid application/x-www-form-urlencoded." };
  }
  if ("duplicate" in form) {
    return { status: 400, error: "invalid_request", description: "A parameter appears more than once." };
  }
  const { params } = form;
  let clientId = params.get("client_id");
  let clientSecret = params.get("client_secret");
  if (authHeader !== undefined) {
    const basic = parseBasicAuth(authHeader);
    if (!basic) {
      return { status: 401, error: "invalid_client", description: "Client authentication failed." };
    }
    if (clientId !== undefined || clientSecret !== undefined) {
      return { status: 400, error: "invalid_request", description: "Send client credentials with one method only: the Authorization header or the body." };
    }
    clientId = basic.id;
    clientSecret = basic.secret;
  }
  return {
    request: {
      grantType: params.get("grant_type"),
      clientId,
      clientSecret,
      resource: params.get("resource"),
      scope: params.get("scope"),
    },
  };
}

interface ErrorBody {
  error: string;
  error_description?: string;
}

function errorResponse(
  status: number,
  error: string,
  description?: string,
): { status: number; body: ErrorBody } {
  const body: ErrorBody = { error };
  if (description) body.error_description = description;
  return { status, body };
}

export interface TokenEndpoint {
  (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void>;
}

export interface TokenEndpointOptions {
  // Its own limiter, not the one /mcp uses, so token requests and tool calls do not share a budget.
  rateLimiter: RateLimiter;
  trustProxy?: boolean;
}

export function createTokenEndpoint(config: OAuthConfig, { rateLimiter, trustProxy = false }: TokenEndpointOptions): TokenEndpoint {
  const expectedResource = `${config.publicUrl}/mcp`;

  return async (req, res) => {
    const decision = rateLimiter.check(clientKey(req, trustProxy));
    if (!decision.allowed) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(decision.retryAfterSeconds) });
      res.end(JSON.stringify({
        error: "invalid_request",
        error_description: `Rate limit exceeded. Wait ${decision.retryAfterSeconds} seconds, then retry.`,
      }));
      return;
    }

    // Only POST is allowed on the token endpoint.
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ error: "invalid_request", error_description: "The token endpoint accepts POST only." }));
      return;
    }

    // Read the body (application/x-www-form-urlencoded).
    let bodyBuf: Buffer;
    try {
      bodyBuf = await readBody(req, TOKEN_BODY_LIMIT);
    } catch (error) {
      const description = error instanceof BodyTooLargeError ? "Request body too large." : "The request body could not be read.";
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request", error_description: description }));
      return;
    }
    const bodyText = bodyBuf.toString("utf8");

    const parsed = parseTokenRequest(req.headers.authorization, bodyText);
    if (!("request" in parsed)) {
      const { status, body } = errorResponse(parsed.status, parsed.error, parsed.description);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    const tokenReq = parsed.request;

    // grant_type is required.
    if (!tokenReq.grantType) {
      const { status, body } = errorResponse(400, "invalid_request", "Missing required parameter: grant_type.");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Only client_credentials is supported.
    if (tokenReq.grantType !== "client_credentials") {
      const { status, body } = errorResponse(400, "unsupported_grant_type", `Grant type "${tokenReq.grantType}" is not supported.`);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Client authentication: both id and secret are required.
    if (!tokenReq.clientId || !tokenReq.clientSecret) {
      const { status, body } = errorResponse(401, "invalid_client", "Client authentication failed.");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Constant-time comparison of client credentials.
    const idMatch = safeEqual(tokenReq.clientId, config.clientId);
    const secretMatch = safeEqual(tokenReq.clientSecret, config.clientSecret);
    if (!idMatch || !secretMatch) {
      const { status, body } = errorResponse(401, "invalid_client", "Client authentication failed.");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Resource check: if provided, must match PUBLIC_URL/mcp (trailing slash tolerated).
    if (tokenReq.resource !== undefined) {
      const normalizedResource = tokenReq.resource.replace(/\/+$/, "");
      if (normalizedResource !== expectedResource) {
        const { status, body } = errorResponse(403, "access_denied", "The requested resource is not served by this server.");
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
    }

    // Scope check: only mcp:service is accepted, and it is the default when omitted.
    const requestedScope = tokenReq.scope ?? ALLOWED_SCOPE;
    if (requestedScope !== ALLOWED_SCOPE) {
      const { status, body } = errorResponse(400, "invalid_scope", `Only scope "${ALLOWED_SCOPE}" is supported.`);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }

    // Issue the token.
    const now = Math.floor(Date.now() / 1000);
    const aud = tokenReq.resource ? tokenReq.resource.replace(/\/+$/, "") : expectedResource;
    const payload: JwtPayload = {
      iss: config.publicUrl,
      aud,
      scope: ALLOWED_SCOPE,
      iat: now,
      exp: now + EXPIRES_IN,
    };
    const token = signJwt(payload, config.signingKey);

    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    });
    res.end(JSON.stringify({
      access_token: token,
      token_type: "Bearer",
      expires_in: EXPIRES_IN,
      scope: ALLOWED_SCOPE,
    }));
  };
}

// ---------------------------------------------------------------------------
// Discovery metadata
// ---------------------------------------------------------------------------

// RFC 9728 protected resource metadata and RFC 8414 authorization server metadata. Clients read
// these to find the token endpoint and to see that S256 is offered. No authorization endpoint is
// built: /authorize is only named in the metadata, so a request to it gets the normal 404.
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

// The JSON body of each discovery document, keyed by path. Every URL comes from config.publicUrl.
export function discoveryDocuments(config: OAuthConfig): Map<string, string> {
  const protectedResource = {
    resource: `${config.publicUrl}${MCP_PATH}`,
    authorization_servers: [config.publicUrl],
    scopes_supported: [ALLOWED_SCOPE],
  };
  const authorizationServer = {
    issuer: config.publicUrl,
    token_endpoint: `${config.publicUrl}/token`,
    authorization_endpoint: `${config.publicUrl}/authorize`,
    response_types_supported: ["code"],
    grant_types_supported: ["client_credentials"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [ALLOWED_SCOPE],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  };
  return new Map([
    [PROTECTED_RESOURCE_METADATA_PATH, JSON.stringify(protectedResource)],
    [AUTHORIZATION_SERVER_METADATA_PATH, JSON.stringify(authorizationServer)],
  ]);
}
