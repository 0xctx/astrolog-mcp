# Contributing to astrolog-mcp 🔭

Thanks for helping. Bug reports, ideas, docs fixes and code are all welcome.

## Reporting a bug

Open an issue with:

- the tool you called and its arguments (change real birth data to a made-up example),
- what you expected and what you got, including the `Fix:` line if there was one,
- your OS, Node version (`node -v`) and Astrolog version (shown in `meta.astrolog_version` for `get_chart_data`, and in `meta.provenance.astrolog_version` for the other tools).

## Suggesting a feature

Open an issue first. This server returns **numbers and facts only**, with no interpretation, no accounts, and no birth data kept after a call, so ideas that keep to that are the easiest to accept.

## Setting up

```sh
git clone https://github.com/<you>/astrolog-mcp.git && cd astrolog-mcp
npm ci
npm run typecheck && npm test      # no Astrolog needed
```

Unit tests need Node 22; the installer tests also need `tar`, `make` and a C++ compiler. No Astrolog binary and no network. The integration tests need a real binary: run `npm run install:astrolog`, then:

```sh
ASTROLOG_BIN="$PWD/.astrolog/astrolog" npm run test:integration
```

The layout and the verification story are in [docs/development.md](docs/development.md).

## Ground rules

- Every planetary, house and angle position comes from an Astrolog run. Don't compute ephemeris in TypeScript.
- Tests sit next to the code (`src/**/*.test.ts`). A change needs `npm run typecheck && npm test` green; CI runs the same.
- Change dependencies with npm and commit the resulting `package-lock.json`. Never edit the lockfile by hand.
- Never commit `node_modules/`, `dist/`, Astrolog binaries, Swiss Ephemeris files or GeoNames tables. The installer fetches them.
- Keep the docs in step with behaviour: a change to a tool updates [docs/tools.md](docs/tools.md).

## Pull requests

1. Fork, then branch from `main`.
2. Keep each pull request to one change, with tests.
3. Describe what changed and why. Mention anything that affects licensing or the data the installer downloads.

## Licence

By contributing you agree that your contribution is licensed under the project's [AGPL-3.0-only](LICENSE) licence.
