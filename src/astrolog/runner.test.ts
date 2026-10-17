import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AstroError } from "../types.js";
import { AstrologEngine } from "./engine.js";
import { MAX_EPHEM_PATH, ephemDir, locateBinary, readVersion, spawnAstrolog } from "./binary.js";
import { MAX_EXPRESSIONS, runExpressions } from "./expressions.js";
import { SMOKE_REFERENCE, SMOKE_REFERENCE_800, SMOKE_SUN } from "./smoke.js";

// Stand-ins for the astrolog binary: POSIX sh scripts that need no PATH, because the runner
// gives the child an empty environment.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A short base for scratch dirs, so no test depends on how long os.tmpdir() is.
function scratchBase(): string {
  return tmpdir().length <= 20 ? tmpdir() : "/tmp";
}

function stub(body: string): { bin: string; dir: string } {
  const dir = mkdtempSync(path.join(scratchBase(), "stub-astrolog-"));
  dirs.push(dir);
  const bin = path.join(dir, "astrolog");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

// Prints "Expression returned: <value>" on stderr once per `-~ '` it sees, and logs its argv and
// working directory next to the script. `-H` prints a version banner.
function echoStub(value: string, version = "7.80"): { bin: string; dir: string } {
  return stub(`
dir="\${0%/*}"
if [ "$3" = "-H" ]; then echo "Astrolog (version ${version}) command switches:"; exit 0; fi
printf '%s\\n' "$PWD" "$@" > "$dir/argv.log"
for a in "$@"; do
  rest="$a"
  while case "$rest" in *"-~ '"*) true;; *) false;; esac; do
    echo "Expression returned: ${value}" >&2
    rest="\${rest#*"-~ '"}"
  done
done`);
}

describe("spawnAstrolog", () => {
  it("closes stdin so a prompt cannot hang the call", async () => {
    const { bin, dir } = stub(`if read line; then echo "got:$line"; else echo "eof"; fi`);
    const done = await spawnAstrolog(bin, [], dir);
    expect(done.stdout.trim()).toBe("eof");
  });

  it("kills a binary that outlives the timeout", async () => {
    const { bin, dir } = stub("while :; do :; done");
    const started = Date.now();
    await expect(spawnAstrolog(bin, [], dir, 200)).rejects.toBeInstanceOf(AstroError);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("decodes output as latin-1", async () => {
    const { bin, dir } = stub(`printf 'caf\\351'`);
    const done = await spawnAstrolog(bin, [], dir);
    expect(done.stdout).toBe("café");
  });

  it("reports a missing executable as an AstroError", async () => {
    await expect(spawnAstrolog("/nonexistent/astrolog", [], scratchBase())).rejects.toBeInstanceOf(AstroError);
  });
});

describe("locateBinary and readVersion", () => {
  it("needs ASTROLOG_BIN to name an executable file", () => {
    expect(() => locateBinary({})).toThrow(AstroError);
    expect(() => locateBinary({ ASTROLOG_BIN: "/nonexistent/astrolog" })).toThrow(AstroError);
    const { bin, dir } = echoStub("1");
    expect(() => locateBinary({ ASTROLOG_BIN: dir })).toThrow(AstroError);
    expect(locateBinary({ ASTROLOG_BIN: bin })).toBe(bin);
  });

  it("accepts an ephemeris path of 127 characters and refuses 128", () => {
    const { bin } = echoStub("1");
    const root = mkdtempSync(path.join(scratchBase(), "stub-long-"));
    dirs.push(root);
    // The longest ephemeris file path is <folder>/ephem/sepl_18.se1, 18 characters past the folder (/ephem/sepl_18.se1).
    const withPath = (length: number): string => {
      const dir = path.join(root, "x".repeat(length - 18 - root.length - 1));
      mkdirSync(dir);
      copyFileSync(bin, path.join(dir, "astrolog"));
      chmodSync(path.join(dir, "astrolog"), 0o755);
      return path.join(dir, "astrolog");
    };
    const ok = withPath(MAX_EPHEM_PATH - 1);
    expect(path.join(path.dirname(ok), "ephem", "sepl_18.se1").length).toBe(MAX_EPHEM_PATH - 1);
    expect(locateBinary({ ASTROLOG_BIN: ok })).toBe(ok);
    const long = withPath(MAX_EPHEM_PATH);
    expect(() => locateBinary({ ASTROLOG_BIN: long })).toThrow(/ephemeris path is too long/);
    try {
      locateBinary({ ASTROLOG_BIN: long });
    } catch (e) {
      expect((e as AstroError).fix).toMatch(/shorter folder.*~\/astrolog8.*installer/);
    }
  });

  it("lists the likely causes when -H dies with a signal or prints nothing", async () => {
    const crash = stub("kill -SEGV $$");
    await expect(readVersion(crash.bin, crash.dir)).rejects.toThrow(/crashed \(SIGSEGV\).*astrolog\.as is missing/);
    const silent = stub("exit 0");
    await expect(readVersion(silent.bin, silent.dir)).rejects.toThrow(/printed no version.*astrolog\.as is missing/);
  });

  it("reads the version from -H and refuses anything older than 7.80", async () => {
    const ok = echoStub("1", "7.80");
    expect(await readVersion(ok.bin, ok.dir)).toBe("7.80");
    const old = echoStub("1", "7.70");
    await expect(readVersion(old.bin, old.dir)).rejects.toThrow(/older/);
    const junk = stub("echo hello");
    await expect(readVersion(junk.bin, junk.dir)).rejects.toThrow(AstroError);
  });
});

describe("runExpressions", () => {
  const request = (bin: string, expressions: string[]) => ({
    binary: bin,
    chartArgs: ["-qa", "6", "15", "1990", "14:30:00", "0", "73:54:00W", "40:42:00N"],
    houseSystem: "koch" as const,
    ayanamsa: "tropical" as const,
    codes: ["Sun" as const, "Moo" as const],
    expressions,
  });

  it("applies the pins to the cast line and runs outside the install directory", async () => {
    const { bin, dir } = echoStub("1.5");
    await runExpressions(request(bin, ["ObjLon O_Sun"]));
    const [cwd, yq, cast = "", line] = readFileSync(path.join(dir, "argv.log"), "utf8").split("\n");
    expect(cwd).not.toBe(dir);
    expect(yq).toBe("-Yq2");
    expect(cast).toContain("73:54:00W 40:42:00N");
    expect(cast).toContain("_Yh");
    expect(cast).toContain("-c 1");
    expect(cast).toContain("-R0 Sun Moo");
    expect(cast.endsWith("-Y0")).toBe(true);
    expect(line).toBe("-~ 'ObjLon O_Sun' -Y0");
  });

  it("removes its own working directory", async () => {
    const { bin, dir } = echoStub("1");
    await runExpressions(request(bin, ["a"]));
    const cwd = readFileSync(path.join(dir, "argv.log"), "utf8").split("\n")[0] as string;
    expect(existsSync(cwd)).toBe(false);
  });

  it("chunks 40 expressions per line and caps a call at 320", async () => {
    const { bin, dir } = echoStub("2");
    const exprs = Array.from({ length: 85 }, (_, i) => `e${i}`);
    const values = await runExpressions(request(bin, exprs));
    expect(values).toHaveLength(85);
    const lines = readFileSync(path.join(dir, "argv.log"), "utf8").split("\n");
    expect(lines[1]).toBe("-Yq4");
    expect(lines.slice(3, 6).map((l) => (l.match(/-~/g) ?? []).length)).toEqual([40, 40, 5]);

    const full = Array.from({ length: MAX_EXPRESSIONS }, (_, i) => `e${i}`);
    expect(await runExpressions(request(bin, full))).toHaveLength(320);
    await expect(runExpressions(request(bin, [...full, "one more"]))).rejects.toBeInstanceOf(AstroError);
  });

  it("fails when astrolog returns fewer values than expressions", async () => {
    const { bin } = stub('echo "Expression returned: 1.0" >&2');
    await expect(runExpressions(request(bin, ["a", "b"]))).rejects.toThrow(/1 of 2/);
  });
});

describe("AstrologEngine.start", () => {
  // Prints the smoke reference values in order, one per expression.
  function smokeStub(values: readonly number[], version = "7.80"): { bin: string; dir: string } {
    const lines = values.map((v) => `echo "Expression returned: ${v}" >&2`).join("\n");
    return stub(`if [ "$3" = "-H" ]; then echo "Astrolog (version ${version}) command switches:"; exit 0; fi\n${lines}`);
  }

  it("starts when the smoke chart's Sun, Moon, Ceres and Eris are right", async () => {
    const { bin } = smokeStub(Object.values(SMOKE_REFERENCE) as number[]);
    await expect(AstrologEngine.start({ ASTROLOG_BIN: bin })).resolves.toBeInstanceOf(AstrologEngine);
    expect(SMOKE_REFERENCE.Sun).toBe(SMOKE_SUN);
  });

  it("checks an 8.00 binary against the 8.00 values, whose Eris differs from 7.80 beyond the tolerance", async () => {
    const ok = smokeStub(Object.values(SMOKE_REFERENCE_800) as number[], "8.00");
    await expect(AstrologEngine.start({ ASTROLOG_BIN: ok.bin })).resolves.toBeInstanceOf(AstrologEngine);
    const old = smokeStub(Object.values(SMOKE_REFERENCE) as number[], "8.00");
    await expect(AstrologEngine.start({ ASTROLOG_BIN: old.bin })).rejects.toThrow(/Eri/);
    expect(Math.abs((SMOKE_REFERENCE.Eri ?? 0) - (SMOKE_REFERENCE_800.Eri ?? 0))).toBeGreaterThan(0.001);
  });

  it("refuses to start when only the Eris value is wrong", async () => {
    const values = Object.values(SMOKE_REFERENCE) as number[];
    values[3] = 0;
    const { bin } = smokeStub(values);
    await expect(AstrologEngine.start({ ASTROLOG_BIN: bin })).rejects.toThrow(/Eri/);
  });

  it("turns a SwissEph file not found line into an AstroError naming the file", async () => {
    const { bin, dir } = stub(
      `if [ "$3" = "-H" ]; then echo "Astrolog (version 7.80) command switches:"; exit 0; fi\necho "SwissEph file 'seas_18.se1' not found in PATH '/x'" >&2\necho "Expression returned: 1.0" >&2`,
    );
    const err = await runExpressions({
      binary: bin,
      chartArgs: ["-qa"],
      houseSystem: "placidus",
      ayanamsa: "tropical",
      codes: ["Sun"],
      expressions: ["a"],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AstroError);
    expect((err as AstroError).message).toContain("seas_18.se1");
    // The client sees the file name, never the install directory.
    expect((err as AstroError).fix).not.toContain(dir);
    expect((err as AstroError).message).not.toContain(dir);
  });

  it("adds a too-long hint to a missing ephemeris file at the engine's MAX_EPHEM_PATH characters or more", async () => {
    const root = mkdtempSync(path.join(scratchBase(), "stub-miss-"));
    dirs.push(root);
    const folder = path.join(root, "y".repeat(MAX_EPHEM_PATH - 18 - root.length - 1));
    mkdirSync(folder);
    const bin = path.join(folder, "astrolog");
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$3" = "-H" ]; then echo "Astrolog (version 7.80) command switches:"; exit 0; fi\necho "SwissEph file 'seas_18.se1' not found in PATH '/x'" >&2\n`,
    );
    chmodSync(bin, 0o755);
    const err = await runExpressions({ binary: bin, chartArgs: ["-qa"], houseSystem: "placidus", ayanamsa: "tropical", codes: ["Sun"], expressions: ["a"] }).catch((e: unknown) => e);
    expect((err as AstroError).fix).toMatch(/may be too long/);
  });

  it("refuses a binary path with whitespace or quotes", () => {
    for (const bad of ["/tmp/a b/astrolog", "/tmp/it's/astrolog"]) {
      expect(() => ephemDir(bad)).toThrow(AstroError);
    }
  });

  it("refuses to start when the smoke value is wrong", async () => {
    const { bin } = echoStub("353.6000");
    await expect(AstrologEngine.start({ ASTROLOG_BIN: bin })).rejects.toThrow(/smoke chart/);
  });

  it("refuses to start without a binary", async () => {
    await expect(AstrologEngine.start({})).rejects.toBeInstanceOf(AstroError);
  });
});

describe("client-visible messages carry no filesystem path", () => {
  it("a binary that cannot be spawned names the executable only", async () => {
    const err = await spawnAstrolog("/nonexistent/astrolog", [], scratchBase()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AstroError);
    expect((err as AstroError).message).not.toContain("/");
    expect((err as AstroError).fix).not.toContain("/nonexistent");
  });

  it("a file that is not executable names its basename only", async () => {
    const dir = mkdtempSync(path.join(scratchBase(), "stub-noexec-"));
    dirs.push(dir);
    const bin = path.join(dir, "astrolog");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o644);
    const err = await spawnAstrolog(bin, [], dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AstroError);
    expect((err as AstroError).message).toContain("astrolog");
    expect((err as AstroError).message).not.toContain("/");
    expect((err as AstroError).fix).not.toContain(dir);
  });

  it("a missing ephemeris file names the file, not the directory", async () => {
    const { bin } = stub(`echo "SwissEph file 'seas_18.se1' not found in PATH '/x/ephem'" >&2`);
    const err = await runExpressions({ binary: bin, chartArgs: ["-qa"], houseSystem: "placidus", ayanamsa: "tropical", codes: ["Sun"], expressions: ["a"] }).catch((e: unknown) => e);
    expect((err as AstroError).message).toContain("seas_18.se1");
    expect((err as AstroError).message).not.toContain("/");
    expect((err as AstroError).fix).not.toContain(path.dirname(bin));
  });

  it("an unwritable temp directory gives a generic message with the error code", async () => {
    const { bin } = echoStub("1");
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = "/nonexistent-tmp-dir";
    try {
      const err = await runExpressions({ binary: bin, chartArgs: ["-qa"], houseSystem: "placidus", ayanamsa: "tropical", codes: ["Sun"], expressions: ["a"] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AstroError);
      expect((err as AstroError).message).toBe("could not create a working directory (ENOENT)");
    } finally {
      if (saved === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = saved;
      }
    }
  });
});
