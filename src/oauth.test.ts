import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "./limits.js";
import { createTokenEndpoint, discoveryDocuments, parseAuthMode, parseOAuthConfig, signJwt, type OAuthConfig } from "./oauth.js";
import { createApp } from "./app.js";

const EXPECTED_PROTECTED_RESOURCE = {
  resource: "https://mcp.example.com/mcp",
  authorization_servers: ["https://mcp.example.com"],
  scopes_supported: ["mcp:service"],
};

const EXPECTED_AUTHORIZATION_SERVER = {
  issuer: "https://mcp.example.com",
  token_endpoint: "https://mcp.example.com/token",
  authorization_endpoint: "https://mcp.example.com/authorize",
  response_types_supported: ["code"],
  grant_types_supported: ["client_credentials"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["mcp:service"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
};

// ---------------------------------------------------------------------------
// parseAuthMode
// ---------------------------------------------------------------------------

describe("parseAuthMode", () => {
  it('returns "oauth" for AUTH_MODE=oauth', () => {
    expect(parseAuthMode("oauth")).toBe("oauth");
  });

  it("returns undefined when AUTH_MODE is unset", () => {
    expect(parseAuthMode(undefined)).toBeUndefined();
  });

  it("returns undefined when AUTH_MODE is empty", () => {
    expect(parseAuthMode("")).toBeUndefined();
  });

  it("returns undefined when AUTH_MODE is off", () => {
    expect(parseAuthMode("off")).toBeUndefined();
  });

  it("throws for an unknown AUTH_MODE", () => {
    expect(() => parseAuthMode("magic")).toThrow(/AUTH_MODE must be/);
  });
});

// ---------------------------------------------------------------------------
// parseOAuthConfig
// ---------------------------------------------------------------------------

describe("parseOAuthConfig", () => {
  const GOOD_ENV = {
    PUBLIC_URL: "https://mcp.example.com",
    OAUTH_CLIENT_ID: "test-client",
    OAUTH_CLIENT_SECRET: "test-secret-value-long-enough-0123456789",
    OAUTH_SIGNING_KEY: "a]very_secret_key_at_least_32_chars!",
  };

  it("accepts valid env vars", () => {
    const config = parseOAuthConfig(GOOD_ENV);
    expect(config.publicUrl).toBe("https://mcp.example.com");
    expect(config.clientId).toBe("test-client");
    expect(config.clientSecret).toBe("test-secret-value-long-enough-0123456789");
    expect(config.signingKey).toBe("a]very_secret_key_at_least_32_chars!");
  });

  it("strips trailing slashes from PUBLIC_URL", () => {
    const config = parseOAuthConfig({ ...GOOD_ENV, PUBLIC_URL: "https://mcp.example.com///" });
    expect(config.publicUrl).toBe("https://mcp.example.com");
  });

  it("throws when PUBLIC_URL is missing", () => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, PUBLIC_URL: undefined })).toThrow(/PUBLIC_URL/);
  });

  it("throws when PUBLIC_URL has no scheme", () => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, PUBLIC_URL: "mcp.example.com" })).toThrow(/not a valid URL/);
  });

  it("throws when OAUTH_CLIENT_ID is missing", () => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_CLIENT_ID: undefined })).toThrow(/OAUTH_CLIENT_ID/);
  });

  it("throws when OAUTH_CLIENT_SECRET is missing", () => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_CLIENT_SECRET: undefined })).toThrow(/OAUTH_CLIENT_SECRET/);
  });

  it("throws when OAUTH_SIGNING_KEY is missing", () => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_SIGNING_KEY: undefined })).toThrow(/OAUTH_SIGNING_KEY/);
  });

  it("throws when OAUTH_SIGNING_KEY is too short", () => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_SIGNING_KEY: "short" })).toThrow(/at least 32 characters/);
  });

  it("throws when OAUTH_CLIENT_SECRET is under 32 bytes", () => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_CLIENT_SECRET: "x" })).toThrow(/OAUTH_CLIENT_SECRET must be at least 32 bytes/);
  });

  it("throws when OAUTH_SIGNING_KEY is one repeated character", () => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_SIGNING_KEY: "a".repeat(40) })).toThrow(/repeated character/);
  });

  it("refuses an http:// PUBLIC_URL with a non-loopback host, with a fix line", () => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, PUBLIC_URL: "http://mcp.example.com" })).toThrow(/non-loopback host/);
    expect(() => parseOAuthConfig({ ...GOOD_ENV, PUBLIC_URL: "http://mcp.example.com" })).toThrow(/Fix:/);
  });

  it.each([
    "http://localhost.evil.com",
    "http://127.0.0.1.evil.com",
    "http://0.0.0.0",
    "http://[::ffff:127.0.0.1]",
    "http://192.168.1.10",
    "http://localhost.",
  ])("refuses an http:// PUBLIC_URL for a non-loopback host like %s with a fix line", (url) => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, PUBLIC_URL: url })).toThrow(/non-loopback host/);
    expect(() => parseOAuthConfig({ ...GOOD_ENV, PUBLIC_URL: url })).toThrow(/Fix:/);
  });

  it.each(["http://localhost", "http://localhost:3000", "http://127.0.0.1", "http://127.0.0.1:8080", "http://[::1]", "http://[::1]:3000"])(
    "accepts an http:// PUBLIC_URL on a loopback host (%s)",
    (url) => {
      const config = parseOAuthConfig({ ...GOOD_ENV, PUBLIC_URL: url });
      expect(config.publicUrl).toBe(new URL(url).origin);
    },
  );

  it("refuses OAUTH_CLIENT_SECRET when it is one repeated character", () => {
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_CLIENT_SECRET: "a".repeat(40) })).toThrow(/OAUTH_CLIENT_SECRET must not be one repeated character/);
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_CLIENT_SECRET: "a".repeat(40) })).toThrow(/Fix:/);
  });

  it("refuses OAUTH_CLIENT_SECRET when it is one repeated multi-byte character", () => {
    const secret = "😀".repeat(20);
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_CLIENT_SECRET: secret })).toThrow(/must not be one repeated character/);
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_CLIENT_SECRET: secret })).toThrow(/Fix:/);
  });

  it("refuses OAUTH_CLIENT_SECRET when it equals OAUTH_SIGNING_KEY", () => {
    const same = "a_different_random_secret_of_at_least_32_chars";
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_CLIENT_SECRET: same, OAUTH_SIGNING_KEY: same })).toThrow(
      /must not be the same value as OAUTH_SIGNING_KEY/,
    );
    expect(() => parseOAuthConfig({ ...GOOD_ENV, OAUTH_CLIENT_SECRET: same, OAUTH_SIGNING_KEY: same })).toThrow(/Fix:/);
  });

  it.each(["https://mcp.example.com/?x=1", "https://mcp.example.com#frag", "https://mcp.example.com/v1", "ftp://mcp.example.com", "https://u:p@mcp.example.com"])(
    "throws for PUBLIC_URL %s with a fix line",
    (url) => {
      expect(() => parseOAuthConfig({ ...GOOD_ENV, PUBLIC_URL: url })).toThrow(/Fix: Set PUBLIC_URL/);
    },
  );

  it("does not echo a bad AUTH_MODE value", () => {
    expect(() => parseAuthMode("s3cret-value")).not.toThrow(/s3cret-value/);
  });
});

// Runs the built entry, as stdio.test.ts does, into its own directory so the two cannot race.
describe("startup", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const buildDir = join(repoRoot, "node_modules", ".cache", "astrolog-mcp-oauth");
  const entry = join(buildDir, "index.js");
  beforeAll(() => {
    rmSync(buildDir, { recursive: true, force: true });
    execFileSync(process.execPath, [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json", "--outDir", buildDir], { cwd: repoRoot });
  }, 60_000);
  it("exits 1 with a fix line for a weak client secret and prints no secret", () => {
    const run = spawnSync(process.execPath, [entry], {
      env: {
        PATH: process.env.PATH,
        PORT: "3999",
        ENGINE: "stub",
        AUTH_MODE: "oauth",
        PUBLIC_URL: "https://mcp.example.com",
        OAUTH_CLIENT_ID: "c",
        OAUTH_CLIENT_SECRET: "weaksecret",
        OAUTH_SIGNING_KEY: "k".repeat(10) + "z".repeat(30),
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("OAUTH_CLIENT_SECRET must be at least 32 bytes");
    expect(run.stderr).toContain("Fix:");
    expect(run.stderr).not.toContain("weaksecret");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// signJwt
// ---------------------------------------------------------------------------

describe("signJwt", () => {
  it("produces a three-part JWT with a valid JSON header and payload", () => {
    const token = signJwt(
      { iss: "https://example.com", aud: "https://example.com/mcp", scope: "mcp:service", iat: 1000, exp: 4600 },
      "a_secret_key_that_is_long_enough_32",
    );
    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });

    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    expect(payload).toMatchObject({ iss: "https://example.com", scope: "mcp:service", iat: 1000, exp: 4600 });
  });
});

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

const TEST_CONFIG: OAuthConfig = {
  publicUrl: "https://mcp.example.com",
  clientId: "test-client",
  clientSecret: "test-secret-value",
  signingKey: "a_very_secret_signing_key_at_least_32b",
};

describe("token endpoint", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    const endpoint = createTokenEndpoint(TEST_CONFIG, { rateLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }) });
    server = createServer((req, res) => {
      endpoint(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: "server_error" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function basicAuth(id: string, secret: string): string {
    return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
  }

  function postToken(
    body: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body,
    });
  }

  // ---- Happy path ----

  it("issues a Bearer token for a valid client_credentials request with Basic auth", async () => {
    const response = await postToken(
      "grant_type=client_credentials",
      { authorization: basicAuth("test-client", "test-secret-value") },
    );
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(3600);
    expect(json.scope).toBe("mcp:service");
    expect(typeof json.access_token).toBe("string");
    expect(json).not.toHaveProperty("refresh_token");
  });

  it("issues a Bearer token for a valid request with form credentials", async () => {
    const response = await postToken(
      "grant_type=client_credentials&client_id=test-client&client_secret=test-secret-value",
    );
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(json.token_type).toBe("Bearer");
    expect(typeof json.access_token).toBe("string");
  });

  it("returns a valid JWT with iss, aud, scope, iat, exp", async () => {
    const response = await postToken(
      `grant_type=client_credentials&resource=${encodeURIComponent("https://mcp.example.com/mcp")}`,
      { authorization: basicAuth("test-client", "test-secret-value") },
    );
    const json = await response.json() as { access_token: string };
    const parts = json.access_token.split(".");

    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    expect(payload.iss).toBe("https://mcp.example.com");
    expect(payload.aud).toBe("https://mcp.example.com/mcp");
    expect(payload.scope).toBe("mcp:service");
    expect(typeof payload.iat).toBe("number");
    expect(payload.exp).toBe(payload.iat + 3600);
  });

  it("defaults scope to mcp:service when omitted", async () => {
    const response = await postToken(
      "grant_type=client_credentials",
      { authorization: basicAuth("test-client", "test-secret-value") },
    );
    const json = await response.json() as Record<string, unknown>;

    expect(json.scope).toBe("mcp:service");
  });

  it("accepts the resource with a trailing slash", async () => {
    const response = await postToken(
      `grant_type=client_credentials&resource=${encodeURIComponent("https://mcp.example.com/mcp/")}`,
      { authorization: basicAuth("test-client", "test-secret-value") },
    );

    expect(response.status).toBe(200);
  });

  it("sets no-store cache headers on the response", async () => {
    const response = await postToken(
      "grant_type=client_credentials",
      { authorization: basicAuth("test-client", "test-secret-value") },
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  // ---- Error cases ----

  it("rejects GET with 405", async () => {
    const response = await fetch(baseUrl, { method: "GET" });
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(405);
    expect(json.error).toBe("invalid_request");
  });

  it("returns 400 invalid_request when grant_type is missing", async () => {
    const response = await postToken(
      "client_id=test-client&client_secret=test-secret-value",
    );
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(json.error).toBe("invalid_request");
  });

  it("returns 400 unsupported_grant_type for authorization_code", async () => {
    const response = await postToken(
      "grant_type=authorization_code&code=abc",
      { authorization: basicAuth("test-client", "test-secret-value") },
    );
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(json.error).toBe("unsupported_grant_type");
  });

  it("returns 401 invalid_client when credentials are missing", async () => {
    const response = await postToken("grant_type=client_credentials");
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(json.error).toBe("invalid_client");
  });

  it("returns 401 invalid_client for a wrong client_id", async () => {
    const response = await postToken(
      "grant_type=client_credentials",
      { authorization: basicAuth("wrong-client", "test-secret-value") },
    );
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(json.error).toBe("invalid_client");
  });

  it("returns 401 invalid_client for a wrong client_secret", async () => {
    const response = await postToken(
      "grant_type=client_credentials",
      { authorization: basicAuth("test-client", "wrong-secret") },
    );
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(json.error).toBe("invalid_client");
  });

  it("returns 403 access_denied for a wrong resource", async () => {
    const response = await postToken(
      `grant_type=client_credentials&resource=${encodeURIComponent("https://other-server.com/mcp")}`,
      { authorization: basicAuth("test-client", "test-secret-value") },
    );
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(json.error).toBe("access_denied");
  });

  it("returns 400 invalid_scope for an unsupported scope", async () => {
    const response = await postToken(
      "grant_type=client_credentials&scope=admin",
      { authorization: basicAuth("test-client", "test-secret-value") },
    );
    const json = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(json.error).toBe("invalid_scope");
  });

  it("returns 400 invalid_request for a malformed form body", async () => {
    const response = await postToken("grant_type=%E0%A4%A");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("ignores credentials sent in the query string", async () => {
    const response = await fetch(`${baseUrl}/?client_id=test-client&client_secret=test-secret-value`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    expect(response.status).toBe(401);
  });

  it("returns 401 for a Basic header with malformed percent-encoding", async () => {
    const response = await postToken("grant_type=client_credentials", {
      authorization: "Basic " + Buffer.from("a%E0%A4%A:b").toString("base64"),
    });
    expect(response.status).toBe(401);
  });

  it("returns 401 for a malformed Basic header even when the body has valid credentials", async () => {
    const response = await postToken("grant_type=client_credentials&client_id=test-client&client_secret=test-secret-value", {
      authorization: "Basic !!!",
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_client");
  });

  it("decodes a Basic secret with + as a space, like the form body", async () => {
    const response = await postToken("grant_type=client_credentials", {
      authorization: basicAuth("test-client", "test-secret-value"),
    });
    expect(response.status).toBe(200);
  });

  it("returns 400 invalid_request for a duplicate parameter", async () => {
    const response = await postToken("grant_type=client_credentials&grant_type=client_credentials", {
      authorization: basicAuth("test-client", "test-secret-value"),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("returns 400 invalid_request when Basic and body credentials are both sent", async () => {
    const response = await postToken("grant_type=client_credentials&client_id=test-client&client_secret=test-secret-value", {
      authorization: basicAuth("test-client", "test-secret-value"),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_request");
  });

  it("returns 400 invalid_request for a body over the limit", async () => {
    const response = await postToken("grant_type=client_credentials&x=" + "a".repeat(5000));
    expect(response.status).toBe(400);
    const json = (await response.json()) as { error: string; error_description: string };
    expect(json.error).toBe("invalid_request");
    expect(json.error_description).toMatch(/too large/);
  });

  it("returns no refresh_token", async () => {
    const response = await postToken("grant_type=client_credentials", {
      authorization: basicAuth("test-client", "test-secret-value"),
    });
    expect(await response.json()).not.toHaveProperty("refresh_token");
  });

  it("sends no WWW-Authenticate header on any error", async () => {
    // Check on 401
    const r1 = await postToken("grant_type=client_credentials");
    expect(r1.status).toBe(401);
    expect(r1.headers.get("www-authenticate")).toBeNull();

    // Check on 400
    const r2 = await postToken("scope=admin", { authorization: basicAuth("test-client", "test-secret-value") });
    expect(r2.status).toBe(400);
    expect(r2.headers.get("www-authenticate")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration with createApp
// ---------------------------------------------------------------------------

const CONFIG: OAuthConfig = {
  publicUrl: "https://mcp.example.com",
  clientId: "test-client",
  clientSecret: "test-secret-value",
  signingKey: "a_very_secret_signing_key_at_least_32b",
};
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } },
});

function basePayload() {
  const now = Math.floor(Date.now() / 1000);
  return { iss: CONFIG.publicUrl, aud: `${CONFIG.publicUrl}/mcp`, scope: "mcp:service", iat: now, exp: now + 3600 };
}

function tokenWith(overrides: Record<string, unknown>): string {
  return signJwt({ ...basePayload(), ...overrides } as ReturnType<typeof basePayload>, CONFIG.signingKey);
}

describe("createApp with AUTH_MODE=oauth", () => {
  let server: Server;
  let baseUrl: string;

  function basicAuth(id: string, secret: string): string {
    return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
  }

  beforeEach(async () => {
    server = createApp({
      oauthConfig: {
        publicUrl: "https://mcp.example.com",
        clientId: "test-client",
        clientSecret: "test-secret-value",
        signingKey: "a_very_secret_signing_key_at_least_32b",
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("serves POST /token when oauthConfig is set", async () => {
    const response = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth("test-client", "test-secret-value"),
      },
      body: "grant_type=client_credentials",
    });

    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, unknown>;
    expect(json.token_type).toBe("Bearer");
  });

  it("ignores query-string credentials through createApp", async () => {
    const response = await fetch(`${baseUrl}/token?client_id=test-client&client_secret=test-secret-value`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    expect(response.status).toBe(401);
  });

  it("still serves GET /health normally", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("serves POST /mcp with a valid Bearer token", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: `Bearer ${tokenWith({})}` },
      body: INIT_BODY,
    });
    expect(response.status).toBe(200);
  });

  it("serves the protected resource metadata as public JSON at its exact path", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(EXPECTED_PROTECTED_RESOURCE);
  });

  it("serves the authorization server metadata as public JSON at its exact path", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(EXPECTED_AUTHORIZATION_SERVER);
  });

  it("answers HEAD on both metadata paths with no body", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      const response = await fetch(`${baseUrl}${path}`, { method: "HEAD" });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
    }
  });

  it("returns 404 for a metadata path with a trailing slash or another method", async () => {
    expect((await fetch(`${baseUrl}/.well-known/oauth-protected-resource/`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/.well-known/oauth-authorization-server/`)).status).toBe(404);
    const posted = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`, { method: "POST" });
    expect(posted.status).toBe(404);
  });

  it("returns 404 for /authorize, which is named in the metadata but not built", async () => {
    const response = await fetch(`${baseUrl}/authorize?response_type=code&client_id=test-client`);
    expect(response.status).toBe(404);
  });

  it("refuses a token issued by POST /token that was altered", async () => {
    const issued = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: basicAuth("test-client", "test-secret-value") },
      body: "grant_type=client_credentials",
    });
    const { access_token } = await issued.json() as { access_token: string };
    const ok = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${access_token}` }, body: INIT_BODY });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${access_token}x` }, body: INIT_BODY });
    expect(bad.status).toBe(401);
  });

  async function expect401(headers: Record<string, string>, path = "/mcp", method = "POST") {
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { ...MCP_HEADERS, ...headers }, body: method === "POST" ? INIT_BODY : undefined });
    expect(response.status).toBe(401);
    expect(response.headers.has("www-authenticate")).toBe(false);
    const json = await response.json() as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["error", "message"]);
    expect(JSON.stringify(json)).not.toContain("Bearer eyJ");
  }

  it("returns 401 JSON without WWW-Authenticate when there is no token", async () => {
    await expect401({});
    await expect401({}, "/mcp", "GET");
    await expect401({}, "/mcp", "DELETE");
  });

  it("returns 401 for a malformed Authorization header", async () => {
    await expect401({ authorization: "Basic abc" });
    await expect401({ authorization: "Bearer" });
    await expect401({ authorization: "Bearer a b" });
    await expect401({ authorization: "Bearer not-a-jwt" });
    await expect401({ authorization: "Bearer a.b.c" });
  });

  it("returns 401 for a bad signature, a tampered payload and alg none", async () => {
    const good = tokenWith({});
    const [h, p, s] = good.split(".") as [string, string, string];
    await expect401({ authorization: `Bearer ${signJwt(basePayload(), "another_signing_key_that_is_32_chars_x")}` });
    const forged = Buffer.from(JSON.stringify({ ...basePayload(), scope: "mcp:service admin" })).toString("base64url");
    await expect401({ authorization: `Bearer ${h}.${forged}.${s}` });
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    await expect401({ authorization: `Bearer ${none}.${p}.` });
    await expect401({ authorization: `Bearer ${none}.${p}.${s}` });
  });

  it("returns 401 for an expired token", async () => {
    await expect401({ authorization: `Bearer ${tokenWith({ exp: Math.floor(Date.now() / 1000) - 1 })}` });
  });

  it("returns 401 for a wrong audience", async () => {
    await expect401({ authorization: `Bearer ${tokenWith({ aud: "https://mcp.example.com" })}` });
    await expect401({ authorization: `Bearer ${tokenWith({ aud: "https://other.example.com/mcp" })}` });
  });

  it("returns 401 for a wrong or missing scope", async () => {
    await expect401({ authorization: `Bearer ${tokenWith({ scope: "mcp:user" })}` });
    await expect401({ authorization: `Bearer ${tokenWith({ scope: "mcp:service-admin" })}` });
    await expect401({ authorization: `Bearer ${tokenWith({ scope: undefined })}` });
  });

  it("returns 401 for a wrong or missing issuer", async () => {
    await expect401({ authorization: `Bearer ${tokenWith({ iss: "https://other.example.com" })}` });
    await expect401({ authorization: `Bearer ${tokenWith({ iss: `${CONFIG.publicUrl}/` })}` });
    await expect401({ authorization: `Bearer ${tokenWith({ iss: undefined })}` });
  });

  it("returns 401 for a scope that is not exactly mcp:service", async () => {
    await expect401({ authorization: `Bearer ${tokenWith({ scope: "mcp:service mcp:user" })}` });
    await expect401({ authorization: `Bearer ${tokenWith({ scope: " mcp:service" })}` });
    await expect401({ authorization: `Bearer ${tokenWith({ scope: "mcp:service " })}` });
  });

  it("returns 401 for a non-canonical base64url spelling of a valid signature", async () => {
    const [h, p, s] = tokenWith({}).split(".") as [string, string, string];
    // 32 bytes leave 2 spare bits in the last character; flipping them keeps the decoded bytes.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(s.slice(-1));
    const variant = s.slice(0, -1) + alphabet[last ^ 1];
    expect(Buffer.from(variant, "base64url").equals(Buffer.from(s, "base64url"))).toBe(true);
    await expect401({ authorization: `Bearer ${h}.${p}.${variant}` });
    expect((await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${h}.${p}.${s}` }, body: INIT_BODY })).status).toBe(200);
  });

  it("never accepts a token in the query string", async () => {
    const t = tokenWith({});
    await expect401({}, `/mcp?access_token=${t}`);
    await expect401({}, `/mcp?token=${t}&bearer_token=${t}`);
  });

  it("checks the token before the rate limiter spends budget", async () => {
    const limited = createApp({
      oauthConfig: CONFIG,
      rateLimiter: createRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    await new Promise<void>((resolve) => limited.listen(0, "127.0.0.1", resolve));
    const address = limited.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP");
    const url = `http://127.0.0.1:${address.port}/mcp`;
    try {
      for (let i = 0; i < 3; i++) {
        expect((await fetch(url, { method: "POST", headers: MCP_HEADERS, body: INIT_BODY })).status).toBe(401);
      }
      const ok = await fetch(url, { method: "POST", headers: { ...MCP_HEADERS, authorization: `Bearer ${tokenWith({})}` }, body: INIT_BODY });
      expect(ok.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });

  it("does not log tokens or Authorization headers", async () => {
    const logged: string[] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.join(" "))));
    try {
      const t = tokenWith({ exp: 1 });
      await expect401({ authorization: `Bearer ${t}` });
      expect(logged.join("\n")).not.toContain(t);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it("does not require a token for /health or the well-known paths", async () => {
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toBeTypeOf("object");
    }
  });
});

describe("createApp without OAuth", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createApp();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("returns 404 for POST /token when oauthConfig is not set", async () => {
    const response = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });

    expect(response.status).toBe(404);
  });

  it("returns 404 for both discovery metadata paths when oauthConfig is not set", async () => {
    expect((await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// discoveryDocuments
// ---------------------------------------------------------------------------

describe("discoveryDocuments", () => {
  const config: OAuthConfig = {
    publicUrl: "https://mcp.example.com",
    clientId: "test-client",
    clientSecret: "test-secret-value-long-enough-0123456789",
    signingKey: "a_very_secret_signing_key_at_least_32b",
  };

  it("has exactly the two well-known paths", () => {
    expect([...discoveryDocuments(config).keys()].sort()).toEqual([
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
    ]);
  });

  it("builds the protected resource document from the one PUBLIC_URL", () => {
    const body = discoveryDocuments(config).get("/.well-known/oauth-protected-resource");
    expect(JSON.parse(body ?? "null")).toEqual(EXPECTED_PROTECTED_RESOURCE);
  });

  it("builds the authorization server document from the one PUBLIC_URL, with S256 and client_credentials", () => {
    const body = discoveryDocuments(config).get("/.well-known/oauth-authorization-server");
    expect(JSON.parse(body ?? "null")).toEqual(EXPECTED_AUTHORIZATION_SERVER);
  });

  it("takes every URL from the origin parseOAuthConfig returns, not the raw PUBLIC_URL", () => {
    const parsed = parseOAuthConfig({
      PUBLIC_URL: "https://mcp.example.com/",
      OAUTH_CLIENT_ID: "test-client",
      OAUTH_CLIENT_SECRET: "test-secret-value-long-enough-0123456789",
      OAUTH_SIGNING_KEY: "a_very_secret_signing_key_at_least_32b",
    });
    const documents = discoveryDocuments(parsed);
    expect(JSON.parse(documents.get("/.well-known/oauth-protected-resource") ?? "null")).toEqual(EXPECTED_PROTECTED_RESOURCE);
    expect(JSON.parse(documents.get("/.well-known/oauth-authorization-server") ?? "null")).toEqual(EXPECTED_AUTHORIZATION_SERVER);
  });
});

describe("POST /token rate limit", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createApp({
      rateLimiter: createRateLimiter({ limit: 1000, windowMs: 60_000 }),
      tokenRateLimiter: createRateLimiter({ limit: 2, windowMs: 60_000 }),
      oauthConfig: {
        publicUrl: "https://mcp.example.com",
        clientId: "test-client",
        clientSecret: "test-secret-value",
        signingKey: "a_very_secret_signing_key_at_least_32b",
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("expected TCP");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const post = () =>
    fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });

  it("returns 429 with Retry-After past the limit, and /mcp does not share the budget", async () => {
    expect((await post()).status).toBe(401);
    expect((await post()).status).toBe(401);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    const mcp = await fetch(`${baseUrl}/mcp`, { method: "DELETE" });
    expect(mcp.status).not.toBe(429);
  });
});
