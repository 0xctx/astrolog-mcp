# AGENTS.md

TypeScript (Node 22, ESM, strict) MCP server for astrology charts. It serves five tools (chart, transit, composite, harmonic midpoints, daily transits) over HTTP and stdio, on the real Astrolog engine or a placeholder stub. See `docs/development.md` for the layout and rules.

## Commands

Run from the repo root.

- Install: `npm ci`
- Typecheck: `npm run typecheck`
- Test: `npm test`
- Build: `npm run build`
- Start: `PORT=3000 npm start`, then `curl -i http://localhost:3000/health`
- Integration (real binary): `ASTROLOG_BIN=/path/to/astrolog npm run test:integration`
- Gate: `npm run typecheck && npm test` (CI runs the same two)

## Rules

- Every planetary, house and angle position comes from an Astrolog run. Do not compute ephemeris in TypeScript.
- Tests sit next to the code as `src/**/*.test.ts`; installer tests are in `test/installer/*.test.mjs`.
- Change dependencies with npm and commit `package-lock.json`. Never edit the lockfile by hand.
- Do not commit `node_modules/`, `dist/`, Astrolog binaries or Swiss Ephemeris files.
- Do not "fix" the reference inputs in `src/astrolog/engine.integration.test.ts`; they are chosen on purpose.
