# Configuration

The server is configured with environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `ENGINE` | `stub` | `astrolog` runs the real binary. `stub` returns clearly labelled placeholder numbers, for trying the plumbing without an install; it has tropical positions only, so a sidereal `ayanamsa` needs `ENGINE=astrolog`. Any other value exits 1. |
| `ASTROLOG_BIN` | none | Path to the `astrolog` executable, with its `ephem/` folder beside it. Required for `ENGINE=astrolog`. |
| `ASTROLOG_MCP_DATA` | `./data` (the installer puts the tables in `./data/geonames`, so set this to that folder) | Folder with the GeoNames tables (`cities500.txt`, `admin1CodesASCII.txt`, `countryInfo.txt`) for place-name lookup. The stub engine does not look up place names, so this is unused when `ENGINE=stub`. |
| `PORT` | `3000` | HTTP port, 1 to 65535, on `0.0.0.0`. |
| `TRUST_PROXY` | `false` | Set to `true` only behind a proxy that overwrites `X-Forwarded-For`; it changes what the rate limit keys on. See [deploy](deploy.md#behind-a-proxy). |
| `RATE_LIMIT_PER_MINUTE` | `60` | Requests per caller per minute on `/mcp`, and a separate limit of the same size on `POST /token`, 1 to 10000. A request past it gets 429 with `Retry-After`. Shared addresses, such as a NAT or a proxy without `TRUST_PROXY`, share one count. |
| `ENGINE_CONCURRENCY` | `4` | Engine calls running at once, 1 to 64. Each one can run an astrolog child process. |
| `ENGINE_QUEUE` | `16` | Engine calls waiting for a slot, 3 to 1000. A call past that gets an error with a fix line. One `get_daily_transits` request queues four engine calls, so the minimum of 3 lets a single daily request through with one slot. |
| `AUTH_MODE` | unset (off) | Set to `oauth` to enable the built-in authorization server at `POST /token`, and its public discovery documents at `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-authorization-server`. It also requires `Authorization: Bearer <JWT>` on every `/mcp` request: a missing, malformed, badly signed, expired, wrong-issuer, wrong-audience or wrong-scope token gets 401 JSON `{error, message}` with no `WWW-Authenticate` header, and a token in the query string is ignored. `/health`, `/token` and both discovery paths stay open. When unset or `off`, every route behaves exactly as before, and `/token` and both discovery paths return 404. |
| `PUBLIC_URL` | none | The public origin of this server (e.g. `https://mcp.example.com`), with no path, query or fragment; startup fails otherwise. `http://` is accepted only for a loopback host (`localhost`, `127.0.0.1` or `[::1]`); any other `http://` origin stops start-up. Required when `AUTH_MODE=oauth`. Used as the JWT issuer, to validate the `resource` parameter, and for every URL in the discovery documents. |
| `OAUTH_CLIENT_ID` | none | The single static client identifier. Required when `AUTH_MODE=oauth`. |
| `OAUTH_CLIENT_SECRET` | none | The client secret for authentication: at least 32 bytes, not one repeated character, and not equal to `OAUTH_SIGNING_KEY` (for example `openssl rand -hex 32`). Required when `AUTH_MODE=oauth`. Never logged. |
| `OAUTH_SIGNING_KEY` | none | HS256 signing key for JWTs, used as its UTF-8 bytes: at least 32 characters, and not one repeated character (for example `openssl rand -hex 32`). Required when `AUTH_MODE=oauth`. Never logged. |
| `PATH` | your shell's | Read by the installer only, to find `make`, `tar` and the compiler. |

For `RATE_LIMIT_PER_MINUTE`, `ENGINE_CONCURRENCY` and `ENGINE_QUEUE`, unset or empty means the default in the table. The HTTP entry reads `RATE_LIMIT_PER_MINUTE`; the stdio entry reads only `ENGINE_CONCURRENCY` and `ENGINE_QUEUE`.

Two system variables are also read, through Node's `os` module: `HOME` (`os.homedir()` expands `~/` in the installer's `--prefix`) and `TMPDIR` (`os.tmpdir()` is where the installer and engine create temporary folders).

With `ENGINE=astrolog` the server runs a smoke chart before it listens, and exits 1 with the reason and a fix line on stderr if Astrolog cannot start. Without `ASTROLOG_MCP_DATA` data the server still starts: a `place` call returns an error with a fix line, and explicit coordinates keep working.
