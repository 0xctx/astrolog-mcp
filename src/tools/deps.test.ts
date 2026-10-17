import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AstrologEngine } from "../astrolog/engine.js";
import { resolvePlace } from "../place.js";
import { AstroError } from "../types.js";
import { createStubDeps, depsFromEngine } from "./deps.js";

describe("stub toUtc", () => {
  const { toUtc } = createStubDeps();

  it("converts an ordinary local time with the zone's offset", () => {
    expect(toUtc({ date: "1990-06-15", time: "19:30", timezone: "America/Chicago" })).toBe("1990-06-16T00:30:00Z");
  });

  it("refuses a repeated wall time, naming it and giving a fix line", () => {
    // 2026-11-01 01:30 happens twice in Chicago when the clocks go back at 02:00 CDT.
    expect(() => toUtc({ date: "2026-11-01", time: "01:30", timezone: "America/Chicago" })).toThrow(
      "2026-11-01T01:30 happens twice in time zone America/Chicago",
    );
    try {
      toUtc({ date: "2026-11-01", time: "01:30", timezone: "America/Chicago" });
    } catch (error) {
      expect(error).toBeInstanceOf(AstroError);
      expect((error as AstroError).fix).toMatch(/outside the repeated hour/);
    }
  });

  it("accepts the times just outside the repeated hour, on either offset", () => {
    expect(toUtc({ date: "2026-11-01", time: "00:30", timezone: "America/Chicago" })).toBe("2026-11-01T05:30:00Z");
    expect(toUtc({ date: "2026-11-01", time: "02:30", timezone: "America/Chicago" })).toBe("2026-11-01T08:30:00Z");
  });

  it("refuses a time the zone skips", () => {
    // The clocks jump from 02:00 to 03:00 on 2026-03-08.
    expect(() => toUtc({ date: "2026-03-08", time: "02:30", timezone: "America/Chicago" })).toThrow(
      "2026-03-08T02:30 does not exist in time zone America/Chicago",
    );
  });

  it("refuses a date that does not exist", () => {
    expect(() => toUtc({ date: "2026-02-30", time: "10:00", timezone: "Europe/London" })).toThrow(AstroError);
  });
});

describe("depsFromEngine", () => {
  it.each([undefined, "", "stub"])("gives the stub engine for ENGINE=%j", async (engine) => {
    await expect(depsFromEngine(engine)).resolves.toBeDefined();
  });

  it("rejects ENGINE=astrolog with an AstroError and a fix line when ASTROLOG_BIN is unset", async () => {
    const error = await depsFromEngine("astrolog", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AstroError);
    expect((error as AstroError).message).toMatch(/ASTROLOG_BIN is not set/);
    expect((error as AstroError).fix).not.toBe("");
  });

  it("refuses any other value, naming it", async () => {
    await expect(depsFromEngine("bogus")).rejects.toThrow('ENGINE must be "stub" or "astrolog", got "bogus"');
  });
});

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

// A binary that prints the version banner on -H and one value per `-~ '` it sees from `values`.
function fakeAstrolog(version: string, values: readonly string[]): string {
  const dir = mkdtempSync(path.join(tmpdir().length <= 20 ? tmpdir() : "/tmp", "fake-astrolog-"));
  dirs.push(dir);
  const bin = path.join(dir, "astrolog");
  const cases = values.map((v, i) => `${i}) echo "Expression returned: ${v}" >&2;;`).join("\n");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$3" = "-H" ]; then echo "Astrolog (version ${version}) command switches:"; exit 0; fi
n=0
for a in "$@"; do
  rest="$a"
  while case "$rest" in *"-~ '"*) true;; *) false;; esac; do
    case $n in
${cases}
    esac
    n=$((n + 1))
    rest="\${rest#*"-~ '"}"
  done
done
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const EMPTY_DATA = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "empty-geonames-"));
  dirs.push(dir);
  return dir;
};

describe("depsFromEngine with a binary", () => {
  it("rejects with an AstroError and a fix line when the smoke chart fails", async () => {
    const bin = fakeAstrolog("7.80", ["1.0", "2.0", "3.0", "4.0"]);
    const error = await depsFromEngine("astrolog", { ASTROLOG_BIN: bin, ASTROLOG_MCP_DATA: EMPTY_DATA() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AstroError);
    expect((error as AstroError).message).toMatch(/smoke chart/);
    expect((error as AstroError).fix).not.toBe("");
  });

  it("writes the place-table message and fix to stderr once, never stdout, and still serves coordinates", async () => {
    const bin = fakeAstrolog("8.00", ["353.507748", "254.525911", "47.332084", "344.850516"]);
    const data = EMPTY_DATA();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const deps = await depsFromEngine("astrolog", { ASTROLOG_BIN: bin, ASTROLOG_MCP_DATA: data });
    expect(deps.engine).toBeInstanceOf(AstrologEngine);
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.startsWith("place names will not resolve:"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("fix: "))).toHaveLength(1);
    expect(out).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    // A place name fails with a fix line; explicit coordinates never read the table.
    const failure = await Promise.resolve(deps.resolvePlace("Austin, TX")).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AstroError);
    expect((failure as AstroError).fix).not.toBe("");
    const place = await resolvePlace("Birth", { latitude: 30.2672, longitude: -97.7431, timezone: "America/Chicago", dataDir: data });
    expect(place.timezone).toBe("America/Chicago");
  });

  it("warns on stderr, once, for a version that was not measured and still starts", async () => {
    const bin = fakeAstrolog("8.01", ["353.507748", "254.525911", "47.332084", "344.850516"]);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await AstrologEngine.start({ ASTROLOG_BIN: bin });
    expect(err.mock.calls.map((c) => String(c[0]))).toEqual(["Astrolog 8.01 was not measured; using the 8.00 reference values"]);
  });

  it("does not warn for a measured version", async () => {
    const bin = fakeAstrolog("7.80", ["353.507747", "254.5259", "47.331976", "344.851668"]);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await AstrologEngine.start({ ASTROLOG_BIN: bin });
    expect(err).not.toHaveBeenCalled();
  });
});
