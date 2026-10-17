import { describe, expect, it } from "vitest";
import {
  brokenLinks,
  codeText,
  composeEnvNames,
  docPages,
  dockerfileEnvNames,
  envReadByCode,
  read,
  readmeEnvTableNames,
} from "./repo.mjs";

const dockerfile = read("Dockerfile");
const compose = read("docker-compose.yml");
const readme = read("README.md");
const configuration = read("docs/configuration.md");
const clients = read("docs/clients.md");

// The Dockerfile's stages, split at each FROM. The last one is the image that runs.
const stages = dockerfile.split(/^FROM /m).slice(1);
const runtime = stages[stages.length - 1];

describe("Dockerfile", () => {
  it("builds in three stages on Node 22 slim, and the runtime is the last", () => {
    expect(stages).toHaveLength(3);
    expect(stages.every((stage) => stage.startsWith("node:22-slim"))).toBe(true);
    expect(runtime).toMatch(/^node:22-slim AS runtime/);
  });

  it("installs Astrolog with the project's installer into /opt/astrolog, with make and g++", () => {
    const astrolog = stages.find((stage) => /AS astrolog/.test(stage));
    expect(astrolog).toMatch(/apt-get install -y --no-install-recommends make g\+\+/);
    expect(astrolog).toContain("npm run install:astrolog -- --prefix /opt/astrolog");
  });

  it("keeps the full core ephemeris set the installer fetches: no prune step deletes any file", () => {
    const astrolog = stages.find((stage) => /AS astrolog/.test(stage));
    expect(astrolog).not.toMatch(/-delete|\bfind\b|\brm\b[^\n]*ephem/);
    expect(stages.join("\n")).not.toMatch(/\.se1/);
  });

  it("copies no binary or ephemeris from the host or the repo", () => {
    const hostCopies = dockerfile
      .split("\n")
      .filter((line) => /^\s*COPY\s/.test(line) && !/--from=/.test(line));
    expect(hostCopies.length).toBeGreaterThan(0);
    expect(hostCopies.join("\n")).not.toMatch(/\.se1|astrolog|\.astrolog|\.git|node_modules|test/);
  });

  it("runs the server as a non-root user, installs production dependencies only, and checks /health", () => {
    expect(runtime).toMatch(/^USER node$/m);
    expect(runtime).toContain("npm ci --omit=dev");
    expect(runtime).toMatch(/HEALTHCHECK[\s\S]*\/health/);
    expect(runtime).toMatch(/^EXPOSE 3000$/m);
    expect(runtime).toMatch(/^CMD \["node", "dist\/index\.js"\]$/m);
  });

  it("sets ENGINE=astrolog and keeps no 'until wired' placeholder comment", () => {
    expect(runtime).toMatch(/^ENV ENGINE=astrolog$/m);
    expect(runtime).not.toMatch(/ENGINE=stub/);
    expect(runtime).not.toMatch(/until the server entry point wires/);
  });

  it("points ASTROLOG_BIN at the installed binary and ASTROLOG_MCP_DATA at the GeoNames tables", () => {
    expect(runtime).toContain("ASTROLOG_BIN=/opt/astrolog/astrolog");
    expect(runtime).toContain("ASTROLOG_MCP_DATA=/app/data/geonames");
    expect(runtime).toContain("PORT=3000");
  });
});

describe("docker-compose.yml", () => {
  it("has one service that builds this repo and restarts unless stopped", () => {
    const services = compose.split("\n").filter((line) => /^ {2}[a-z][a-z-]*:\s*$/.test(line));
    expect(services).toHaveLength(1);
    expect(compose).toMatch(/^\s+build: \.$/m);
    expect(compose).toMatch(/restart: unless-stopped/);
  });

  it("publishes port 3000 on the loopback address only, because the endpoint has no authentication", () => {
    expect(compose).toContain('"127.0.0.1:3000:3000"');
  });

  it("runs an init process, so Node does not run as PID 1 without a SIGTERM handler", () => {
    expect(compose).toMatch(/^\s+init: true$/m);
  });
});

describe(".dockerignore", () => {
  it("keeps git state, dependencies, the installed Astrolog and all local data out of the context", () => {
    const ignored = read(".dockerignore").split("\n");
    for (const entry of [".git", "node_modules", ".astrolog", "data"]) {
      expect(ignored).toContain(entry);
    }
  });
});

describe("environment variables across the Dockerfile, compose file and README", () => {
  const codeEnv = envReadByCode();

  it("the code reads the variables the image and README rely on", () => {
    for (const name of ["PORT", "ENGINE", "TRUST_PROXY", "ASTROLOG_BIN", "ASTROLOG_MCP_DATA"]) {
      expect(codeEnv.has(name), name).toBe(true);
    }
    expect(codeText()).toMatch(/process\.env\.ENGINE/);
  });

  it("every variable the Dockerfile sets is read by the code", () => {
    for (const name of dockerfileEnvNames(dockerfile)) {
      expect(codeEnv.has(name), name).toBe(true);
    }
  });

  it("every variable the compose file sets is read by the code", () => {
    for (const name of composeEnvNames(compose)) {
      expect(codeEnv.has(name), name).toBe(true);
    }
  });

  it("the configuration page lists every variable the code reads, and no others", () => {
    expect(readmeEnvTableNames(configuration)).toEqual(codeEnv);
  });

  it("every NAME= that the README shows is a variable the code reads", () => {
    const shown = [...(readme + clients + configuration).matchAll(/\b([A-Z][A-Z0-9_]{2,})=/g)].map((m) => m[1]);
    for (const name of shown) {
      expect(codeEnv.has(name), name).toBe(true);
    }
  });
});

describe("README", () => {
  it("shows the quick start, the tools and Docker, and the client page has both configs", () => {
    expect(readme).toContain("npm run install:astrolog");
    expect(readme).toContain("get_chart_data");
    expect(readme).toContain("get_transit_data");
    expect(readme).toContain("get_composite_data");
    expect(readme).toContain("get_harmonic_midpoints");
    expect(readme).toContain("get_daily_transits");
    expect(readme).toContain("docker compose up --build");
    expect(clients).toContain("claude_desktop_config.json");
    expect(clients).toContain("claude mcp add astrolog");
  });

  it("states the AGPL licence, the third-party licences and the GeoNames credit link", () => {
    expect(readme).toContain("AGPL-3.0-only");
    expect(readme).toContain("GPL");
    expect(readme).toContain("CC BY 4.0");
    expect(readme).toContain("https://www.geonames.org/export/");
    expect(readme).toContain("https://www.astro.com/swisseph/swephinfo_e.htm");
  });

  it("links every guide it names, and each guide exists", () => {
    for (const doc of ["clients", "tools", "install", "configuration", "deploy", "development", "licensing"]) {
      expect(readme, doc).toContain(`docs/${doc}.md`);
      expect(() => read(`docs/${doc}.md`), doc).not.toThrow();
    }
  });

  it("stays short: about 75 lines", () => {
    expect(readme.split("\n").length).toBeLessThanOrEqual(75);
  });
});

describe("docs links", () => {
  for (const page of docPages()) {
    it(`${page}: every relative link names a file, and every anchor a heading on that page`, () => {
      expect(brokenLinks(page)).toEqual([]);
    });
  }
});
