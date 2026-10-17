# Running a server

## Local HTTP server

```sh
npm ci
npm run install:astrolog
export ENGINE=astrolog
export ASTROLOG_BIN="$PWD/.astrolog/astrolog"
export ASTROLOG_MCP_DATA="$PWD/data/geonames"
PORT=3000 npm start            # builds first, then serves
curl -i http://localhost:3000/health
```

The endpoint is `POST /mcp`: stateless Streamable HTTP, on `0.0.0.0`, with no authentication by default. With `AUTH_MODE=oauth` it needs a bearer token (see [Authentication](#-authentication-and-access-controls)). `GET /health` returns `200 {"ok":true}`.

Start-up takes a few seconds because the server runs a smoke chart and reads the GeoNames table before it listens. If Astrolog cannot start, the process exits 1 with the reason and a fix line on stderr.

## Stdio

`dist/stdio.js` serves the same five tools over stdio. An MCP host starts it as a child process, so there is no port, no network and no authentication. Logs go to stderr; stdout carries only protocol messages. See [clients](clients.md) for the client configs.

## Docker

```sh
docker compose up --build
```

- Three stages: the TypeScript build, the installer (Astrolog 8.00 headless plus the full ephemeris and GeoNames tables), and a Node 22 slim runtime running as the `node` user with production dependencies only.
- The image sets `ENGINE=astrolog`, `ASTROLOG_BIN=/opt/astrolog/astrolog` and `ASTROLOG_MCP_DATA=/app/data/geonames`, and has a health check on `/health`.
- Compose publishes `127.0.0.1:3000` only. Put a TLS proxy in front before exposing it.
- If the build cannot reach `github.com` or the npm registry from Docker's default network, build with host networking: `docker build --network host -t astrolog-mcp:local .` and then `docker compose up -d`.

Before you publish an image or run a public endpoint, read [licensing](licensing.md).

## 🔐 Authentication and access controls

`AUTH_MODE=oauth` adds a built-in authorization server to the HTTP server: `POST /token` mints bearer JWTs for the `client_credentials` grant, and `POST /mcp` then requires `Authorization: Bearer <JWT>`. With `AUTH_MODE` unset or `off` (the default), `/mcp` is open and `/token` plus both discovery paths return 404. The other four settings are required when `AUTH_MODE=oauth`; start-up exits 1 with a fix line if one is missing or invalid.

| Variable | Rule |
| --- | --- |
| `AUTH_MODE` | `oauth` turns on `/token`, both discovery paths and the `/mcp` bearer check; unset, empty or `off` leaves them off; any other value stops start-up |
| `PUBLIC_URL` | `http` or `https` origin only: no path, query, fragment or credentials; `http://` only for a loopback host (`localhost`, `127.0.0.1` or `[::1]`) for local testing, any other `http://` origin stops start-up |
| `OAUTH_CLIENT_ID` | the static client identifier |
| `OAUTH_CLIENT_SECRET` | at least 32 bytes, not one repeated character, and not equal to `OAUTH_SIGNING_KEY`; never logged |
| `OAUTH_SIGNING_KEY` | HS256, at least 32 characters, not one repeated character; never logged |

A loopback `http://` `PUBLIC_URL` is for a server that listens on loopback only: the server binds `0.0.0.0` by default, so behind a container or proxy use the `https://` address clients really use.

The two discovery documents are public (no token): `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-authorization-server`.

Tokens last one hour: `POST /token` mints a JWT whose `exp` is 3600 seconds after issue and returns `expires_in` of 3600; there are no refresh tokens. Rotating `OAUTH_CLIENT_SECRET` does not revoke issued tokens, since a token is signed with `OAUTH_SIGNING_KEY` and the client secret is only what the client authenticates with. Rotating `OAUTH_SIGNING_KEY` does revoke issued tokens, because each bearer token is verified against the current signing key. These values are read once at start-up, so changing `OAUTH_CLIENT_SECRET`, `OAUTH_SIGNING_KEY` or `PUBLIC_URL` only takes effect after a restart. As with rotating the signing key, changing `PUBLIC_URL` invalidates every issued token, because the issuer and audience of each token are bound to it.

`RATE_LIMIT_PER_MINUTE` also limits `POST /token`, with its own count. `ENGINE_CONCURRENCY` and `ENGINE_QUEUE` limit `/mcp` tool calls; see [Limits](#limits).

Verify the flow: fetch a token, then call `tools/list`. Set `URL` to your `PUBLIC_URL` (or `http://localhost:3000` on the same host), and `ID` and `SECRET` to the client credentials; the check needs `jq`.

```sh
TOKEN=$(curl -s -X POST "$URL/token" -u "$ID:$SECRET" -d grant_type=client_credentials | jq -r .access_token)
curl -s -X POST "$URL/mcp" -H "authorization: bearer $TOKEN" -H 'accept: application/json' \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Limits

Per process, in memory:

| Limit | Value |
| --- | --- |
| Request body | 64 KB |
| Requests per caller | `RATE_LIMIT_PER_MINUTE`, 60 per minute by default, on `/mcp`, and a separate limit of the same size on `POST /token` (when `AUTH_MODE=oauth`); a request past the limit gets 429 with `Retry-After` |
| Engine calls at once | `ENGINE_CONCURRENCY`, 4 by default, with up to `ENGINE_QUEUE` (16 by default) waiting; a call past that gets an error with a fix line |
| One tool call | 10 seconds, then an error. A call still waiting for an engine slot when it times out does no engine work; one already in the engine finishes in the background. |

## Behind a proxy

`TRUST_PROXY=false` (default): the rate limit keys each caller on its socket address and ignores `X-Forwarded-For`, so a caller cannot choose its own key.

`TRUST_PROXY=true`: it keys on the rightmost `X-Forwarded-For` entry. Set this only behind a proxy that overwrites that header. A missing or invalid entry falls back to the socket address. IPv6 clients are keyed by their /64 in both modes.

## Latency

Measured through the real HTTP server on loopback with Astrolog 8.00 (AMD Ryzen 7 3750H, Node 22), 20 warm calls after one cold call (`src/latency.integration.test.ts`), one run each:

| Tool | Cold first call | Warm p50 | Warm p95 |
| --- | --- | --- | --- |
| `get_chart_data` | 78 ms | 25 ms | 33 ms |
| `get_transit_data` | 50 ms | 31 ms | 40 ms |
| `get_harmonic_midpoints` | 50 ms | 32 ms | 48 ms |
| `get_daily_transits` | 152 ms | 63 ms | 76 ms |

The `get_daily_transits` row was measured the same way with Astrolog 7.80, the binary its reading is checked against; the other rows are 8.00.

These are loopback numbers: network time to a public host and a slower CPU are on top.
