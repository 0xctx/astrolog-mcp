# Connect a client

Build first, from the repository root: `npm ci && npm run install:astrolog && npm run build`. On Windows, run the build and the server under WSL2; the installer and binary are Linux/macOS-only.

Every client needs a command plus three environment variables. Use absolute paths. On Windows the stdio configs below do not work from a Windows host; connect over HTTP instead (see [HTTP clients](#http-clients)).

| Value | Example |
| --- | --- |
| Command and script | `node /absolute/path/to/astrolog-mcp/dist/stdio.js` |
| `ENGINE` | `astrolog` |
| `ASTROLOG_BIN` | `/absolute/path/to/astrolog-mcp/.astrolog/astrolog` |
| `ASTROLOG_MCP_DATA` | `/absolute/path/to/astrolog-mcp/data/geonames` |

The three variables are described in [configuration](configuration.md).

## Claude Desktop

Add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`) and restart Claude Desktop:

```json
{
  "mcpServers": {
    "astrolog": {
      "command": "node",
      "args": ["/absolute/path/to/astrolog-mcp/dist/stdio.js"],
      "env": {
        "ENGINE": "astrolog",
        "ASTROLOG_BIN": "/absolute/path/to/astrolog-mcp/.astrolog/astrolog",
        "ASTROLOG_MCP_DATA": "/absolute/path/to/astrolog-mcp/data/geonames"
      }
    }
  }
}
```

If Claude Desktop cannot find `node` (common with nvm or Homebrew), set `command` to the absolute path of your `node`.

## Claude Code

```sh
claude mcp add astrolog \
  -e ENGINE=astrolog \
  -e ASTROLOG_BIN=/absolute/path/to/astrolog-mcp/.astrolog/astrolog \
  -e ASTROLOG_MCP_DATA=/absolute/path/to/astrolog-mcp/data/geonames \
  -- node /absolute/path/to/astrolog-mcp/dist/stdio.js
```

## Cursor, Windsurf, VS Code and other stdio clients

Same three things: command `node`, argument `dist/stdio.js`, and the `env` block above. Check the host's docs for where its MCP config lives. The server writes only protocol messages to stdout and logs to stderr, so a host can show stderr as its log.

## HTTP clients

Start the server and point your client at `POST http://localhost:3000/mcp` (stateless Streamable HTTP, no authentication by default; with `AUTH_MODE=oauth` it needs a bearer token, set up as in [deploy](deploy.md#-authentication-and-access-controls)):

```sh
ENGINE=astrolog ASTROLOG_BIN="$PWD/.astrolog/astrolog" ASTROLOG_MCP_DATA="$PWD/data/geonames" PORT=3000 node dist/index.js
curl http://localhost:3000/health      # {"ok":true}
```

A direct call, to see what comes back:

```sh
curl -s -X POST http://localhost:3000/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_chart_data","arguments":{"birth_date":"1990-06-15","birth_time":"14:30","latitude":48.8566,"longitude":2.3522,"timezone":"Europe/Paris","bodies":["Sun","Moo","Mer"]}}}'
```

See [deploy](deploy.md) before exposing the port beyond your machine.

## Trying it without installing Astrolog

`ENGINE=stub` returns clearly labelled placeholder numbers, handy for testing a client's wiring. It is not astrology.
