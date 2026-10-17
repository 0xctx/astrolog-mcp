import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as lib from "../../scripts/astrolog-install.lib.mjs";

// ---- Astrolog build helpers

describe("disableX11", () => {
  it("comments out the one #define X11 line and leaves the rest alone", () => {
    const header = "#define A 1\n#define X11 /* Comment out this #define if you don't have X windows */\n#define B 2";
    const patched = lib.disableX11(header);
    expect(patched).toBe("#define A 1\n//#define X11 /* Comment out this #define if you don't have X windows */\n#define B 2");
  });

  it("does not match a longer macro name that begins with X11", () => {
    const header = "#define X11_EXTRA 1\n#define X11 1";
    expect(lib.disableX11(header)).toBe("#define X11_EXTRA 1\n//#define X11 1");
  });

  it("refuses a header with no #define X11, or with two", () => {
    expect(() => lib.disableX11("#define A 1")).toThrow(/has 0 "#define X11" lines, expected 1/);
    expect(() => lib.disableX11("#define X11 1\n#define X11 1")).toThrow(/has 2/);
  });
});

describe("the headless link line and make arguments", () => {
  it("links with -lm -ldl on Linux and -lm on macOS, with the compiler named once", () => {
    expect(lib.libsFor("linux")).toBe("-lm -ldl");
    expect(lib.libsFor("darwin")).toBe("-lm");
    expect(lib.makeArgs({ jobs: 8, platform: "linux", cxx: "/usr/bin/g++" })).toEqual([
      "-j8",
      "LIBS=-lm -ldl",
      "CXX=/usr/bin/g++",
    ]);
  });
});

describe("build tool detection", () => {
  // Fake PATH: only the names in `present` count as executable, so no real tools are used.
  const exists = (present) => (candidate) => present.includes(path.basename(candidate)) && path.dirname(candidate) !== "";

  it("finds make, cc, tar and the first available C++ compiler on PATH", () => {
    const tools = lib.findBuildTools("/bin:/usr/bin", exists(["make", "cc", "clang++", "tar"]));
    expect(tools).toEqual({ make: "/bin/make", cc: "/bin/cc", cxx: "/bin/clang++", tar: "/bin/tar" });
    expect(lib.missingBuildTools(tools)).toEqual([]);
  });

  it("names what is missing, and needs only tar when the binary is already built", () => {
    const tools = lib.findBuildTools("/bin", exists(["make"]));
    expect(lib.missingBuildTools(tools)).toEqual(["cc", "cxx", "tar"]);
    expect(lib.missingBuildTools(tools, false)).toEqual(["tar"]);
  });

  it("skips empty PATH entries and only accepts executable files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astrolog-path-test-"));
    try {
      const notExecutable = path.join(dir, "make");
      fs.writeFileSync(notExecutable, "#!/bin/sh\n");
      fs.chmodSync(notExecutable, 0o644);
      expect(lib.findExecutable("make", `::${dir}`)).toBeNull();
      fs.chmodSync(notExecutable, 0o755);
      expect(lib.findExecutable("make", `::${dir}`)).toBe(notExecutable);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives the one install command for Fedora, Debian and macOS, and a generic line otherwise", () => {
    expect(lib.buildToolsHint("linux", "NAME=Fedora\nID=fedora\n")).toBe("sudo dnf install gcc-c++ make tar");
    expect(lib.buildToolsHint("linux", 'ID=ubuntu\nID_LIKE="debian"\n')).toBe("sudo apt install build-essential tar");
    expect(lib.buildToolsHint("linux", "ID=debian\n")).toBe("sudo apt install build-essential tar");
    expect(lib.buildToolsHint("darwin", "")).toBe("xcode-select --install");
    expect(lib.buildToolsHint("linux", "ID=arch\n")).toBe("install gcc, g++, make and tar with your package manager");
  });

  it("keeps the last lines of build output for the error", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    expect(lib.tailLines(text, 2)).toBe("line 49\nline 50");
  });
});

// ---- smoke chart

describe("smoke chart", () => {
  it("builds the -Yq argv with the cast and one Sun expression, with no shell quoting", () => {
    const [flag, cast, expression] = lib.smokeCommand();
    expect(flag).toBe("-Yq2");
    expect(cast.endsWith(" -Y0")).toBe(true);
    expect(cast).toContain("3 14 1879 11:30 LMT 10:00E 48:24N");
    expect(expression).toBe("-~ 'ObjLon O_Sun' -Y0");
  });

  it("reads Astrolog's expression values from its output", () => {
    const stderr = "Expression returned: 353.507748\nsomething else\nExpression returned: -2.5\n";
    expect(lib.parseExpressionValues(stderr)).toEqual([353.507748, -2.5]);
  });

  it("accepts Sun within 0.001 of 353.5077 and refuses anything else", () => {
    expect(lib.checkSmoke([353.507748])).toBeCloseTo(353.507748);
    expect(() => lib.checkSmoke([353.5098])).toThrow(/the test chart is wrong: Sun 353.5098/);
    expect(() => lib.checkSmoke([0])).toThrow(/Sun 0.0000 degrees/);
  });

  it("refuses when astrolog returns the wrong number of values", () => {
    expect(() => lib.checkSmoke([])).toThrow(/returned 0 values/);
    expect(() => lib.checkSmoke([353.5077, 1])).toThrow(/returned 2 values/);
  });
});

describe("runAstrolog", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "astrolog-run-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("closes stdin, so a program that reads a prompt returns instead of hanging", async () => {
    const script = path.join(dir, "reads-stdin");
    fs.writeFileSync(script, "#!/bin/sh\ncat\necho finished\n");
    fs.chmodSync(script, 0o755);
    const result = await lib.runAstrolog(script, [], { timeoutMs: 10_000 });
    expect(result.stdout.trim()).toBe("finished");
  });

  it("stops a program that runs past the timeout, with a fix line", async () => {
    const script = path.join(dir, "hangs");
    fs.writeFileSync(script, "#!/bin/sh\nsleep 30\n");
    fs.chmodSync(script, 0o755);
    await expect(lib.runAstrolog(script, [], { timeoutMs: 300 })).rejects.toThrow(/took longer than 0.3s/);
    await expect(lib.runAstrolog(script, [], { timeoutMs: 300 })).rejects.toMatchObject({ timedOut: true });
  });

  it("reports a binary that is not there, with a fix line", async () => {
    await expect(lib.runAstrolog(path.join(dir, "missing"), [], { timeoutMs: 1000 })).rejects.toThrow(/could not run/);
  });

  it("starts the program as ./name from its own folder, so argv[0] stays short", async () => {
    const script = path.join(dir, "argv-check");
    fs.writeFileSync(script, "#!/bin/sh\necho \"$0 $(pwd)\"\n");
    fs.chmodSync(script, 0o755);
    const result = await lib.runAstrolog(script, [], { timeoutMs: 10_000 });
    expect(result.stdout.trim()).toBe(`./argv-check ${fs.realpathSync(dir)}`);
  });

  it("returns the signal that stopped a crashing program, and no version", async () => {
    const script = path.join(dir, "crashes");
    fs.writeFileSync(script, "#!/bin/sh\nkill -SEGV $$\n");
    fs.chmodSync(script, 0o755);
    const result = await lib.runAstrolog(script, ["-Hc"], { timeoutMs: 10_000 });
    expect(result.signal).toBe("SIGSEGV");
    expect(await lib.astrologVersion(script)).toEqual({ version: null, signal: "SIGSEGV", timedOut: false });
  });

  it("reports a version probe that runs past its timeout as timed out, not as a crash", async () => {
    const script = path.join(dir, "hangs-on-probe");
    fs.writeFileSync(script, "#!/bin/sh\nsleep 30\n");
    fs.chmodSync(script, 0o755);
    expect(await lib.astrologVersion(script, { timeoutMs: 300 })).toEqual({ version: null, signal: null, timedOut: true });
  });

  it("reads the version from a program that prints it", async () => {
    const script = path.join(dir, "prints-version");
    fs.writeFileSync(script, "#!/bin/sh\necho 'Astrolog version 8.00'\n");
    fs.chmodSync(script, 0o755);
    expect(await lib.astrologVersion(script)).toEqual({ version: "8.00", signal: null, timedOut: false });
  });
});

describe("probeFailure and the smoke crash", () => {
  const CAUSES = /astrolog\.as missing next to the binary.*an incomplete install.*an unusable binary/;

  it("says a probe that crashed stopped with its signal, names the three causes in order, and never suggests --force", () => {
    const error = lib.probeFailure("/x/astrolog", { signal: "SIGSEGV", timedOut: false });
    expect(error).toBeInstanceOf(lib.InstallError);
    expect(error.message).toBe("/x/astrolog printed no version and stopped with SIGSEGV");
    expect(error.fix).toMatch(CAUSES);
    expect(error.fix).not.toMatch(/--force/);
  });

  it("gives the same three causes for a probe that timed out", () => {
    const error = lib.probeFailure("/x/astrolog", { signal: null, timedOut: true });
    expect(error.message).toBe("/x/astrolog printed no version and timed out after 15s");
    expect(error.fix).toMatch(CAUSES);
    expect(error.fix).not.toMatch(/--force/);
  });

  it("gives the same three causes for a probe that printed nothing and exited", () => {
    const error = lib.probeFailure("/x/astrolog", { signal: null, timedOut: false });
    expect(error.message).toBe("/x/astrolog printed no version");
    expect(error.fix).toMatch(CAUSES);
  });

  it("names the signal when the smoke chart crashes, instead of reporting zero values", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astrolog-smoke-test-"));
    try {
      const script = path.join(dir, "crashes-on-smoke");
      fs.writeFileSync(script, "#!/bin/sh\nkill -SEGV $$\n");
      fs.chmodSync(script, 0o755);
      const failure = await lib.runSmokeChart(script).catch((error) => error);
      expect(failure).toBeInstanceOf(lib.InstallError);
      expect(failure.message).toBe("the test chart stopped with SIGSEGV");
      expect(failure.fix).toMatch(CAUSES);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads Sun from a smoke run that exits normally", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astrolog-smoke-test-"));
    try {
      const script = path.join(dir, "prints-sun");
      fs.writeFileSync(script, "#!/bin/sh\necho 'Expression returned: 353.5077' >&2\n");
      fs.chmodSync(script, 0o755);
      expect(await lib.runSmokeChart(script)).toBeCloseTo(353.5077);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- zip and GeoNames

// Writes a zip archive by hand, so the reader is tested against bytes it did not produce.
function zipOf(entries, { badCrc = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const nameBuf = Buffer.from(name);
    const packed = deflate ? zlib.deflateRawSync(data) : data;
    const crc = badCrc ? (zlib.crc32(data) ^ 1) >>> 0 : zlib.crc32(data);
    const method = deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("readZip", () => {
  it("reads stored and deflated entries", () => {
    const text = Buffer.from("1\tAlpha\t\t\t1.5\t2.5\n");
    const archive = zipOf([
      { name: "stored.txt", data: text, deflate: false },
      { name: "cities500.txt", data: text, deflate: true },
    ]);
    const entries = lib.readZip(archive);
    expect(entries.get("cities500.txt")).toEqual(text);
    expect(entries.get("stored.txt")).toEqual(text);
  });

  it("refuses an entry that fails its CRC-32 check", () => {
    const archive = zipOf([{ name: "cities500.txt", data: Buffer.from("payload"), deflate: true }], { badCrc: true });
    expect(() => lib.readZip(archive)).toThrow(/fails its CRC-32 check/);
  });

  it("refuses bytes that are not a zip", () => {
    expect(() => lib.readZip(Buffer.from("<html>not a zip</html>"))).toThrow(/no zip directory found/);
  });
});

describe("checkTable", () => {
  const row19 = (lat, lon) => ["1", "Name", "Name", "Asc", lat, lon, "P", "PPL", "US", "", "", "", "", "", "100", "10", "", "America/Chicago", "2020-01-01"].join("\t");

  it("accepts rows with enough columns and numeric coordinates", () => {
    expect(lib.checkTable([row19("30.1", "-97.7"), row19("40", "-73")].join("\n"), { label: "t", minLines: 2, minColumns: 19, numericColumns: [4, 5] })).toBe(2);
  });

  it("refuses an HTML error page, with a fix line", () => {
    try {
      lib.citiesCheck("<!DOCTYPE html><html>Service unavailable</html>");
      expect.unreachable("an HTML page must be refused");
    } catch (error) {
      expect(error.message).toMatch(/is an HTML page/);
      expect(error.fix).toMatch(/--force/);
    }
  });

  it("refuses a table with too few rows", () => {
    expect(() => lib.checkTable(row19("30", "-97"), { label: "cities", minLines: 5, minColumns: 19 })).toThrow(/has 1 rows, expected at least 5/);
  });

  it("refuses a row with a non-numeric coordinate, or too few columns", () => {
    expect(() => lib.checkTable(row19("north", "-97"), { label: "cities", minLines: 1, minColumns: 19, numericColumns: [4, 5] })).toThrow(/does not parse/);
    expect(() => lib.checkTable("a\tb", { label: "admin", minLines: 1, minColumns: 4 })).toThrow(/does not parse/);
  });

  it("checks the real GeoNames files by name and column count", () => {
    expect(lib.GEONAMES_FILES.map((file) => file.name)).toEqual(["cities500.zip", "admin1CodesASCII.txt", "countryInfo.txt"]);
    expect(lib.CITIES_MIN_ROWS).toBe(100000);
  });
});
