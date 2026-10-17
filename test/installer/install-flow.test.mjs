import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as lib from "../../scripts/astrolog-install.lib.mjs";

// Whole-install tests. The source tarball, the Swiss files and the Astrolog binary are fixtures, served by an
// injected fetch. The real make and tar run on a fixture source tree. No network, no astrolog binary.
// The folders live under /tmp, so the ephemeris path stays within the 127-character limit on any system.

const ASTROLOG_URL = "https://github.com/CruiserOne/Astrolog/archive/refs/tags/v8.00.tar.gz";
const COMMIT = "c".repeat(40);
const RAW = `https://raw.githubusercontent.com/aloistr/swisseph/${COMMIT}/ephe/`;

// What upstream serves for the Swiss names, and the different copies the source tarball carries under the same names.
const upstream = {
  "sepl_18.se1": Buffer.from("upstream planets"),
  "seas_18.se1": Buffer.from("upstream six asteroids"),
  "sefstars.txt": Buffer.from("upstream stars"),
};
const sourceCopies = {
  "sepl_18.se1": Buffer.from("the source tarball's planets copy"),
  "seas_18.se1": Buffer.from("the source tarball's asteroid copy"),
};
const bundled = {
  "s136108s.se1": Buffer.from("haumea fixture"),
  "se00010s.se1": Buffer.from("hygiea fixture"),
};

// Stands in for the Astrolog binary: `-Hc` prints the version and the smoke chart prints the Sun. As the real
// binary does, `-Hc` dies with SIGSEGV when astrolog.as is not next to it, and also in a folder named
// crash-folder (an unusable binary).
const FAKE_ASTROLOG = `#!/bin/sh
if [ "$1" = "-Hc" ]; then
  case "$(pwd)" in *crash-folder*) kill -SEGV $$ ;; esac
  [ -f "$(dirname "$0")/astrolog.as" ] || kill -SEGV $$
  echo "Astrolog version 8.00"
  exit 0
fi
echo "Expression returned: 353.5077" >&2
`;

const DATA_FIXTURES = Object.fromEntries(lib.DATA_FILES.map((name) => [name, Buffer.from(`${name} fixture\n`)]));

let base;
let tarball;
beforeEach(() => {
  base = fs.mkdtempSync("/tmp/af-");
  tarball = buildSourceTarball();
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// A source release laid out like Astrolog-8.00: astrolog.h, a Makefile that copies the fake binary, the
// data files, and an ephem/ folder with the bundled files plus the clashing Swiss names.
function buildSourceTarball() {
  const srcParent = path.join(base, "fixture-src");
  const root = path.join(srcParent, "Astrolog-8.00");
  const write = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  };
  write("astrolog.h", "#define X11 /* fixture */\n");
  write("astrolog.sh", FAKE_ASTROLOG);
  fs.chmodSync(path.join(root, "astrolog.sh"), 0o755);
  write("Makefile", "astrolog: astrolog.sh\n\tcp astrolog.sh astrolog\n");
  for (const [name, data] of Object.entries(DATA_FIXTURES)) write(name, data);
  for (const [name, data] of Object.entries(sourceCopies)) write(`ephem/${name}`, data);
  for (const [name, data] of Object.entries(bundled)) write(`ephem/${name}`, data);
  const archive = path.join(base, "astrolog-fixture.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", srcParent, "Astrolog-8.00"]);
  return fs.readFileSync(archive);
}

const entry = (name, data) => ({ path: name, sha256: lib.sha256Buffer(data), bytes: data.length });

// Manifests that pin the fixtures: the tarball, the bundled files and the upstream Swiss files.
function manifestsFor(source) {
  return {
    astrolog: {
      version: "8.00",
      url: ASTROLOG_URL,
      sha256: lib.sha256Buffer(source),
      bytes: source.length,
      textSha256: "3".repeat(64),
      ephem: Object.entries(bundled).map(([name, data]) => entry(name, data)),
    },
    swiss: {
      repo: lib.REPO,
      commit: COMMIT,
      textSha256: "4".repeat(64),
      groups: { core: Object.entries(upstream).map(([name, data]) => entry(name, data)), ep4: [], sat: [] },
    },
  };
}

// Serves the source tarball by its URL and the upstream files by name. `fail` drops one file's download.
function fakeFetch({ source = tarball, fail = null } = {}) {
  const calls = [];
  const fetchBytes = async (url) => {
    calls.push(url);
    if (url === ASTROLOG_URL) return source;
    const name = url.split("/").pop();
    if (name === fail) throw new Error(`connection dropped for ${name}`);
    if (!(name in upstream)) throw new Error(`no fixture for ${name}`);
    return upstream[name];
  };
  return { calls, fetchBytes };
}

const optionsFor = (extra = {}) => ({
  prefix: path.join(base, "inst"),
  asteroidsFrom: null,
  commit: null,
  force: false,
  skipGeonames: true,
  withEp4: false,
  withMoons: false,
  dryRun: false,
  writeManifest: false,
  help: false,
  ...extra,
});

async function install(extra = {}, { fetch = fakeFetch(), lines = [] } = {}) {
  const deps = {
    repoRoot: base,
    log: (line) => lines.push(line),
    platform: "linux",
    env: { PATH: "/usr/bin:/bin" },
    isExecutable: () => true,
    osRelease: "ID=fedora",
    fetchBytes: fetch.fetchBytes,
    tmpdir: base,
    cpus: 1,
    manifests: manifestsFor(tarball),
  };
  return lib.runInstall(optionsFor(extra), deps);
}

const installDir = () => path.join(base, "inst");
const ephemFile = (name) => path.join(installDir(), "ephem", name);
const sha = (file) => lib.sha256Buffer(fs.readFileSync(file));
const rawCalls = (fetch) => fetch.calls.filter((url) => url.startsWith(RAW));

describe("a fresh install", () => {
  it("fetches the Swiss files, restores the bundled ones, and writes the completion marker last", async () => {
    const fetch = fakeFetch();
    const result = await install({}, { fetch });

    expect(fs.readFileSync(ephemFile("sepl_18.se1"))).toEqual(upstream["sepl_18.se1"]);
    expect(fs.readFileSync(ephemFile("seas_18.se1"))).toEqual(upstream["seas_18.se1"]);
    expect(fs.readFileSync(ephemFile("s136108s.se1"))).toEqual(bundled["s136108s.se1"]);
    expect(rawCalls(fetch)).toHaveLength(3);

    const record = JSON.parse(fs.readFileSync(lib.completionPath(installDir()), "utf8"));
    expect(record).toEqual({
      version: "8.00",
      swissCommit: COMMIT,
      astrologManifestSha256: "3".repeat(64),
      swissManifestSha256: "4".repeat(64),
    });
    expect(result.summary).toMatch(/Swiss files: 3 downloaded, 0 already matched/);
    expect(result.summary).toMatch(/bundled dwarf planets: 2 restored from the Astrolog source, 0 already matched/);
    expect(result.summary).toMatch(/Smoke chart: Sun 353.5077 degrees/);
    expect(result.summary).toMatch(/Install complete: .*\.install-complete written/);
  });

  it("refuses a source tarball that does not match its pinned SHA-256, and installs nothing", async () => {
    const fetch = fakeFetch({ source: Buffer.from("not the release") });
    await expect(install({}, { fetch })).rejects.toThrow(/does not match its pinned SHA-256/);
    expect(fs.existsSync(path.join(installDir(), "astrolog"))).toBe(false);
    expect(fs.existsSync(lib.completionPath(installDir()))).toBe(false);
  });
});

describe("a forced rebuild never replaces a verified Swiss file", () => {
  it("keeps the manifest copy of a file that is already in place, and says so", async () => {
    await install({}, { fetch: fakeFetch() });
    const again = fakeFetch();
    const lines = [];
    const result = await install({ force: true }, { fetch: again, lines });

    expect(sha(ephemFile("sepl_18.se1"))).toBe(lib.sha256Buffer(upstream["sepl_18.se1"]));
    expect(sha(ephemFile("seas_18.se1"))).toBe(lib.sha256Buffer(upstream["seas_18.se1"]));
    expect(rawCalls(again)).toEqual([]);
    expect(result.summary).toMatch(/Swiss files: 0 downloaded, 3 already matched/);
    expect(lines.join("\n")).toMatch(/compiling Astrolog headless/);
  });

  it("downloads a Swiss file that is missing, and ends with the manifest hash", async () => {
    await install({}, { fetch: fakeFetch() });
    fs.rmSync(ephemFile("seas_18.se1"));
    const again = fakeFetch();
    const result = await install({ force: true }, { fetch: again });

    expect(rawCalls(again)).toEqual([`${RAW}seas_18.se1`]);
    expect(sha(ephemFile("seas_18.se1"))).toBe(lib.sha256Buffer(upstream["seas_18.se1"]));
    expect(result.summary).toMatch(/Swiss files: 1 downloaded, 2 already matched/);
  });
});

describe("a re-run", () => {
  it("restores a deleted bundled file from the verified source, without rebuilding Astrolog", async () => {
    await install({}, { fetch: fakeFetch() });
    fs.rmSync(ephemFile("s136108s.se1"));
    const again = fakeFetch();
    const lines = [];
    const result = await install({}, { fetch: again, lines });

    expect(fs.readFileSync(ephemFile("s136108s.se1"))).toEqual(bundled["s136108s.se1"]);
    expect(again.calls).toEqual([ASTROLOG_URL]);
    expect(lines.join("\n")).toMatch(/Astrolog 8.00 is already built at/);
    expect(result.summary).toMatch(/bundled dwarf planets: 1 restored from the Astrolog source, 1 already matched/);
  });

  it("treats an interrupted install as incomplete: no marker after the failure, and the next run rebuilds and writes it", async () => {
    await expect(install({}, { fetch: fakeFetch({ fail: "sefstars.txt" }) })).rejects.toThrow(/connection dropped for sefstars.txt/);
    expect(fs.existsSync(lib.completionPath(installDir()))).toBe(false);

    const lines = [];
    const result = await install({}, { fetch: fakeFetch(), lines });
    expect(lines.join("\n")).toMatch(/no completion marker: an earlier run did not finish/);
    expect(fs.existsSync(lib.completionPath(installDir()))).toBe(true);
    expect(result.summary).toMatch(/Install complete/);
  });
});

describe("a binary whose version probe crashes", () => {
  it("names the three causes in order, never suggests --force, and does not blame the folder length", async () => {
    const prefix = path.join(base, "crash-folder");
    let caught = null;
    try {
      await install({ prefix }, { fetch: fakeFetch() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(lib.InstallError);
    expect(caught.message).toMatch(/printed no version and stopped with SIGSEGV/);
    expect(caught.fix).toMatch(/astrolog\.as missing next to the binary.*an incomplete install.*an unusable binary/);
    expect(caught.fix).not.toMatch(/--force/);
    expect(caught.fix).not.toMatch(/too long/);
  });

  it("runs the probe with astrolog.as copied next to the binary, so a normal install passes it", async () => {
    const result = await install({}, { fetch: fakeFetch() });
    expect(fs.existsSync(path.join(installDir(), "astrolog.as"))).toBe(true);
    expect(result.version).toBe("8.00");
  });
});
