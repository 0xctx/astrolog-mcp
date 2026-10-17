<div align="center">

# 🔭 astrolog-mcp

**Exact astrology chart data for any AI assistant.**
Calculated by Astrolog and the Swiss Ephemeris, served over MCP.

[![CI](https://github.com/0xctx/astrolog-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/0xctx/astrolog-mcp/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2.svg)](https://modelcontextprotocol.io)

</div>

Ask your assistant about a birth chart and get real positions back, not made-up ones.

> *"What are my Sun, Moon and rising for 15 June 1990, 14:30, born in Paris, France?"*
> → `Sun 24°09′ Gemini, Moon 15°38′ Pisces, Ascendant 2°28′ Libra` — example output (plus houses, aspects, midpoints…)

## Why

- **Accurate.** Real ephemeris maths, not an LLM's guess. Chiron, Ceres and the dwarf planets included.
- **Works anywhere.** Claude Desktop, Claude Code, Cursor, or any MCP client, over stdio or HTTP.
- **Fast.** A typical warm call takes about 25 to 65 ms at the median on loopback (see the [latency table](docs/deploy.md#latency)), quick enough for voice assistants.
- **Offline places.** Type a city name. The installer downloads the GeoNames tables once; no live geocoding service or API keys.
- **Private.** No accounts, no logging of birth data, no birth data is kept after a call.
- **Facts, not fortune-telling.** It returns numbers. Your assistant does the interpreting.

## 🚀 Quick start

```sh
# needs: Node.js 22.2+, make, tar, a C/C++ compiler (Linux/macOS, or Windows via WSL2)
git clone https://github.com/0xctx/astrolog-mcp.git && cd astrolog-mcp
npm ci && npm run install:astrolog && npm run build
```

Then connect it to your assistant: **[docs/clients.md](docs/clients.md)** has copy-paste configs for Claude Desktop, Claude Code and others. Prefer containers? `docker compose up --build`.

## Tools

| Tool | You get |
| --- | --- |
| `get_chart_data` | A natal chart: bodies, houses, angles, aspects |
| `get_transit_data` | The sky for a date (or now) against a natal chart |
| `get_composite_data` | A composite or Davison chart for two people |
| `get_harmonic_midpoints` | A harmonic chart's midpoint structures |
| `get_daily_transits` | One day's ranked aspect hits, sign and house changes, retrograde changes and the Moon, with exact times |

Seven house systems, harmonics from 1 to 10000 (the daily reading caps its own by the day's length), place names or coordinates. See the **[tool reference](docs/tools.md)**.

## 📚 Docs

| | |
| --- | --- |
| [Connect a client](docs/clients.md) | Claude Desktop, Claude Code, Cursor, HTTP |
| [Tool reference](docs/tools.md) | Every input, output and error |
| [Installing Astrolog](docs/install.md) | Installer options, requirements, troubleshooting |
| [Configuration](docs/configuration.md) | Environment variables |
| [Running a server](docs/deploy.md) | Docker, OAuth, limits, proxies, latency |
| [Development](docs/development.md) | Layout, tests, how results are verified |
| [Licensing](docs/licensing.md) | What you must do when you run or share it |

## 🤝 Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## ⭐ Like it?

A star helps other people find it.

## 📜 Licence

[AGPL-3.0-only](LICENSE). It is built on [Astrolog](https://www.astrolog.org/astrolog.htm) (GPL), the [Swiss Ephemeris](https://www.astro.com/swisseph/swephinfo_e.htm) (AGPL or Professional licence) and place data from [GeoNames](https://www.geonames.org/export/) (CC BY 4.0, credited to GeoNames). Details and notices: [docs/licensing.md](docs/licensing.md) and [NOTICE](NOTICE).
