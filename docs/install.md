# Installing Astrolog

`npm run install:astrolog` sets up everything the server needs, in one command, and prints what it is doing.

## What it does

1. Downloads the Astrolog 8.00 source from its official release and **verifies its SHA-256** before unpacking.
2. Builds it headless (without X11) into `.astrolog/`.
3. Downloads the full Swiss Ephemeris core set into `.astrolog/ephem/`, **checking every file** against `scripts/manifest/swisseph.json`. That is 158 files, about 127 MB, covering astronomical years -13200 to 17399 for the planets, the Moon, Chiron, Ceres, Pallas, Juno, Vesta and the dwarf planets.
4. Downloads the GeoNames city, region and country tables into `data/geonames/` for place lookup.
5. Runs a smoke chart (Einstein's Sun at 353.5077°, 14 March 1879, Ulm) and only then writes `.astrolog/.install-complete`.

Re-running keeps every file that still passes its check and fetches only what is missing or wrong. An install without the marker is treated as incomplete and is rebuilt.

## Requirements

- Node.js 22.2 or later.
- `make`, `tar` and a C/C++ compiler (`g++`). If one is missing the installer prints the command that installs it:
  - Fedora: `sudo dnf install gcc-c++ make tar`
  - Debian or Ubuntu: `sudo apt install build-essential tar`
  - macOS: `xcode-select --install`
- Astrolog builds from source, so the server runs on Linux or macOS, or on Windows through WSL2. Windows itself is not supported.
- About 130 MB of disk for the ephemeris, plus the Astrolog build and the GeoNames tables.
- Network access to `github.com` (its archive downloads redirect to `codeload.github.com`), `raw.githubusercontent.com` and `download.geonames.org`. Regenerating the manifest (maintainers only) also needs `api.github.com`.

## Options

Pass options after `--`: `npm run install:astrolog -- --prefix ~/astrolog8`.

| Option | What it does |
| --- | --- |
| `--prefix <dir>` | Install folder (default `.astrolog`). `~/` is expanded. See the path limit below. |
| `--force` | Rebuild Astrolog and download the GeoNames tables again. Swiss files are always checked. |
| `--skip-geonames` | Do not download the GeoNames files. Explicit coordinates still work. |
| `--with-ep4` | Also download `ephe/ep4` (25 MB). Optional. |
| `--with-moons` | Also download `ephe/sat`, the planetary moons (238 MB). |
| `--asteroids-from <dir>` | Copy asteroid files you already have (`ast<N>/` folders and `se*s.se1` / `s*s.se1` files). The very large asteroid sets are never downloaded. |
| `--dry-run` | Print the plan and sizes; download, build and write nothing. |
| `--help` | List the options. |

## The 127-character path limit

Astrolog cannot read an ephemeris path longer than 127 characters: `<install>/ephem/sepl_18.se1` must fit. A longer path fails with "file not found" for a file that exists, zero values, or a crash. The installer refuses a longer path up front.

A path with spaces, quotes, backticks or backslashes is also refused at start-up, because Astrolog reads the ephemeris path as a single argument: move the binary to a plain path.

The default `.astrolog/` fits when the repository's own path is 99 characters or shorter. For a deeper checkout, use a short prefix such as `--prefix ~/astrolog8`, then point `ASTROLOG_BIN` at `~/astrolog8/astrolog`.

## Using an Astrolog you built yourself

Set `ASTROLOG_BIN` to your binary, with an `ephem/` folder beside it that holds the Swiss Ephemeris files. The server checks the binary at start-up: versions 7.80 and later run, 7.80 and 8.00 are measured against the smoke chart, and older versions are refused. Other versions run against the nearest measured reference and print a warning.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| The server exits with "astrolog … smoke chart" | Re-run `npm run install:astrolog`; check `.astrolog/.install-complete` exists. |
| `place` calls return an error with a fix line | The GeoNames tables are missing. Point `ASTROLOG_MCP_DATA` at `data/geonames`, or pass coordinates. |
| The installer says the path is too long | Use a shorter `--prefix` (see above). |
| A download is rejected as not matching the manifest | Do not bypass it. Re-run to fetch the file again; if it persists, the upstream file changed. |

## Maintainers: regenerating the manifest

`npm run install:astrolog -- --write-manifest --commit <sha>` downloads all 261 pinned files (about 390 MB) once to hash them and rewrites `scripts/manifest/swisseph.json`.
