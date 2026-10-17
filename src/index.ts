import { createApp } from "./app.js";
import { resolveServerVersion } from "./server.js";
import { createRegistry, type Registry } from "./registry.js";
import { parsePort } from "./port.js";
import { parseLimitSettings, parseTrustProxy, type LimitSettings } from "./limits.js";
import { depsFromEngine } from "./tools/deps.js";
import { reportStartFailure } from "./tools/start-failure.js";
import { parseAuthMode, parseOAuthConfig, type OAuthConfig } from "./oauth.js";

let port: number;
let trustProxy: boolean;
let limits: LimitSettings;
let oauthConfig: OAuthConfig | undefined;
try {
  port = parsePort(process.env.PORT);
  trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  limits = parseLimitSettings(process.env);
  const authMode = parseAuthMode(process.env.AUTH_MODE);
  if (authMode === "oauth") {
    oauthConfig = parseOAuthConfig(process.env);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

let registry: Registry;
try {
  // Resolved up front so a broken install (no package.json) fails fast at
  // start-up with a reported error, not on the first request.
  resolveServerVersion();
  registry = createRegistry(await depsFromEngine(process.env.ENGINE), limits);
} catch (error) {
  reportStartFailure(error);
  process.exit(1);
}
if (!process.env.ENGINE) {
  console.warn("ENGINE is not set; using the stub engine, whose numbers are placeholders");
}
if (trustProxy) {
  console.warn("TRUST_PROXY is on: the rate limit keys on the rightmost X-Forwarded-For entry");
}
if (oauthConfig) {
  console.error("AUTH_MODE=oauth: token endpoint enabled at POST /token");
}

const app = createApp({ registry, trustProxy, oauthConfig, ratePerMinute: limits.ratePerMinute });
app.once("error", (error) => {
  console.error(`failed to listen on port ${port}: ${error.message}`);
  process.exit(1);
});
app.listen(port, "0.0.0.0", () => {
  // stderr, not stdout: a later stdio transport in this process must own stdout.
  console.error(`listening on 0.0.0.0:${port}`);
});
