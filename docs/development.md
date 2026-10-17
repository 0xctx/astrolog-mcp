# Development

TypeScript, Node 22, ESM, strict mode.

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | Install dependencies from the lockfile. |
| `npm run typecheck` | Type-check without emitting. |
| `npm test` | Run the unit tests once (vitest). They need no network and no Astrolog binary. |
| `npm run build` | Compile to `dist/`. |
| `npm start` | Build, then serve HTTP on `$PORT` (default 3000). |
| `npm run test:integration` | Tests against a real binary: `ASTROLOG_BIN=/path/to/astrolog npm run test:integration`. Not part of `npm test`; fails when `ASTROLOG_BIN` is unset. |
| `npm run test:parity` | Only the parity block: server arithmetic against golden fixtures. |
| `npm run smoke` | Build, then run the built server's smoke script. |

CI runs `typecheck` and `test`.

## Layout

| Path | What lives there |
| --- | --- |
| `src/types.ts` | The shared contract: chart input, positions, the engine interface, errors, validators. |
| `src/objects.ts` | Astrolog's name for each object, as its `-R0` switch and `O_` expressions take it. |
| `src/astrolog/` | The real engine: `binary.ts` finds the binary, `pins.ts` holds the neutral settings, `expressions.ts` runs and reads expressions, `engine.ts` ties them together, and `smoke.ts` checks the start-up chart. `zodiac.ts` and `coord.ts` name the ayanamsas and format coordinates. |
| `src/stub-engine.ts` | The placeholder engine for `ENGINE=stub`. |
| `src/math.ts` | Pure arithmetic: aspects, midpoints, harmonics, transit orbs, and the daily reading's exact times and scores. |
| `src/place.ts`, `src/time.ts` | Offline GeoNames place lookup and DST-aware local-time conversion. |
| `src/place-aliases.ts` | The fixed shorthand table (`NYC`, `LA`, `DC` and the rest), each spelling mapped to a GeoNames id with the name and country code that id must name. `src/place.ts` reads it only when the name search finds nothing. |
| `src/tools/chart.ts`, `transit.ts`, `composite.ts`, `harmonic.ts`, `daily.ts` | One file per tool: its input schema, its engine calls and its output shaping. |
| `src/tools/aspect-list.ts` | The aspect sets (`major` and `all`), the `aspects` input and the orbs of the `all` set, shared by the chart, composite, transit and daily tools. |
| `src/tools/input.ts`, `output.ts`, `format.ts` | The birth fields and their checks, the output shapes and aspect table shared by the tools, and the text formats. |
| `src/tools/call.ts`, `deps.ts`, `start-failure.ts` | Running a tool call and its errors, the stub or real engine the tools are given, and the start-up failure message. |
| `src/registry.ts`, `src/server.ts`, `src/app.ts` | The one tool registry both transports use, the MCP endpoint, and the HTTP app with `/mcp`, `/health` and, with `AUTH_MODE=oauth`, `POST /token` and the two `.well-known` discovery documents. |
| `src/oauth.ts` | The opt-in token endpoint and discovery documents: OAuth config checks, client authentication, HS256 JWT signing for the `client_credentials` grant, and the protected resource and authorization server metadata. |
| `src/limits.ts`, `src/port.ts` | The request body, rate and engine-queue limits, and the `PORT` value. |
| `src/index.ts`, `src/stdio.ts` | The HTTP entry and the stdio entry. |
| `src/**/*.integration.test.ts` | Tests against the real binary, run by `npm run test:integration`, including the daily reading's checks and the latency measurements. |
| `scripts/` | The installer and its manifests (pinned SHA-256 for the Astrolog source and the Swiss Ephemeris files; GeoNames is checked by structure, not by hash), the smoke script, and the parity fixture generator. |
| `test/` | Installer tests (`test/installer/`), packaging and docs tests (`test/packaging/`), and the golden fixtures (`test/fixtures/`). |

## Rules of the road

- Every planetary, house and angle position comes from an Astrolog run. Do not compute ephemeris in TypeScript. Aspects, midpoints and harmonics are arithmetic on those positions and live in `src/math.ts`.
- Tests sit next to the code as `src/**/*.test.ts`. The installer is Node ESM under `scripts/`, so its tests are in `test/installer/*.test.mjs`.
- A new tool adds its name to `toolNames()` in `src/registry.ts`; the stdio tests take the tool list from there.
- Change dependencies with npm and commit the resulting `package-lock.json`.
- Do not commit `node_modules/`, `dist/`, Astrolog binaries or ephemeris files.

## How results are verified

- **Reference values** (the integration tests) reproduce on Astrolog 7.80 and 8.00. On the smoke chart, Eris differs by 0.0012° between them because its ephemeris file differs; Sun, Moon and Ceres agree within 0.0002°.
- **Parity.** `src/math.ts` is checked against golden numbers produced by the `astro` CLI, a Python reference implementation. The fixtures are committed in `test/fixtures/`; `npm run test:parity` runs only this block and never runs the generator. `scripts/generate-parity-fixtures.sh` regenerates the fixtures and needs `astro`, `uv`, the Astrolog binary and Node 22, so it is for maintainers.
- **Reference inputs** in `src/astrolog/engine.integration.test.ts`: the natal chart is 14:30 UT, not 14:30 local at UT-5, and the second chart and transit moment were chosen to reproduce reference numbers rather than real birth data. Do not "fix" them.
