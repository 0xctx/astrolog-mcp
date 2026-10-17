import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as lib from "../../scripts/astrolog-install.lib.mjs";

// Small fixture files stand in for the real ones; the injected fetch serves them by name.
const fixtures = {
  "sepl_18.se1": Buffer.from("planets for the fixture"),
  "sefstars.txt": Buffer.from("star list fixture"),
};
const entriesFor = (files) =>
  Object.entries(files).map(([name, data]) => ({ path: name, sha256: lib.sha256Buffer(data), bytes: data.length }));

let root;
let ephemDir;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "astrolog-eph-test-"));
  ephemDir = path.join(root, "ephem");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeFetch(served = fixtures) {
  const calls = [];
  const fetchBytes = async (url) => {
    calls.push(url);
    const name = url.split("/").pop();
    if (!(name in served)) throw new Error(`no fixture for ${name}`);
    return served[name];
  };
  return { calls, fetchBytes };
}

const run = (plan, fetchBytes) =>
  lib.installEphemeris(plan, { fetchBytes, commit: "c".repeat(40), log: () => {} });

describe("verifyFile", () => {
  it("is true only for the expected size and SHA-256", async () => {
    fs.mkdirSync(ephemDir, { recursive: true });
    const file = path.join(ephemDir, "sepl_18.se1");
    fs.writeFileSync(file, fixtures["sepl_18.se1"]);
    const expected = entriesFor(fixtures)[0];
    expect(await lib.verifyFile(file, expected)).toBe(true);
    fs.writeFileSync(file, Buffer.from("tampered with a fixture"));
    expect(await lib.verifyFile(file, expected)).toBe(false);
    expect(await lib.verifyFile(path.join(ephemDir, "missing.se1"), expected)).toBe(false);
  });
});

describe("installEphemeris", () => {
  it("downloads every file on a fresh install, then makes zero downloads on a re-run", async () => {
    const entries = entriesFor(fixtures);
    const first = fakeFetch();
    const plan = await lib.planEphemeris(entries, ephemDir);
    expect(await run(plan, first.fetchBytes)).toEqual({ downloaded: 2, kept: 0 });
    expect(first.calls).toHaveLength(2);
    expect(first.calls[0]).toBe(`https://raw.githubusercontent.com/aloistr/swisseph/${"c".repeat(40)}/ephe/sepl_18.se1`);

    const second = fakeFetch();
    const replan = await lib.planEphemeris(entries, ephemDir);
    expect(await run(replan, second.fetchBytes)).toEqual({ downloaded: 0, kept: 2 });
    expect(second.calls).toHaveLength(0);
  });

  it("re-downloads only the file whose checksum no longer matches", async () => {
    const entries = entriesFor(fixtures);
    await run(await lib.planEphemeris(entries, ephemDir), fakeFetch().fetchBytes);
    fs.writeFileSync(path.join(ephemDir, "sefstars.txt"), "damaged on disk");

    const again = fakeFetch();
    const outcome = await run(await lib.planEphemeris(entries, ephemDir), again.fetchBytes);
    expect(outcome).toEqual({ downloaded: 1, kept: 1 });
    expect(again.calls.map((url) => url.split("/").pop())).toEqual(["sefstars.txt"]);
    expect(fs.readFileSync(path.join(ephemDir, "sefstars.txt"))).toEqual(fixtures["sefstars.txt"]);
  });

  it("refuses a download that does not match the manifest, and leaves nothing in place", async () => {
    const entries = entriesFor(fixtures);
    const served = { ...fixtures, "sepl_18.se1": Buffer.from("not what the manifest says") };
    const plan = await lib.planEphemeris(entries, ephemDir);
    await expect(run(plan, fakeFetch(served).fetchBytes)).rejects.toThrow(/sepl_18.se1 does not match the manifest/);
    expect(fs.existsSync(path.join(ephemDir, "sepl_18.se1"))).toBe(false);
    expect(fs.existsSync(path.join(ephemDir, "sepl_18.se1.part"))).toBe(false);
  });

  it("keeps the old file when a replacement fails verification", async () => {
    const entries = entriesFor(fixtures);
    await run(await lib.planEphemeris(entries, ephemDir), fakeFetch().fetchBytes);
    fs.writeFileSync(path.join(ephemDir, "sefstars.txt"), "damaged on disk");
    const served = { ...fixtures, "sefstars.txt": Buffer.from("wrong bytes") };
    const plan = await lib.planEphemeris(entries, ephemDir);
    await expect(run(plan, fakeFetch(served).fetchBytes)).rejects.toThrow(/does not match the manifest/);
    expect(fs.readFileSync(path.join(ephemDir, "sefstars.txt"), "utf8")).toBe("damaged on disk");
  });
});

describe("runInstall --dry-run", () => {
  function manifests(extra = {}) {
    return {
      astrolog: {
        version: "8.00",
        url: "https://github.com/CruiserOne/Astrolog/archive/refs/tags/v8.00.tar.gz",
        sha256: "14ef68986e00ca46e7a5703f46348ee8be9b474efde56c060a8a9285e60dc838",
        bytes: 6059321,
        textSha256: "1".repeat(64),
        ephem: [],
      },
      swiss: {
        repo: lib.REPO,
        commit: "d".repeat(40),
        textSha256: "2".repeat(64),
        groups: { core: entriesFor(fixtures), ep4: [], sat: [], ...extra },
      },
    };
  }
  const baseOptions = {
    prefix: null,
    asteroidsFrom: null,
    commit: null,
    force: false,
    skipGeonames: false,
    withEp4: false,
    withMoons: false,
    dryRun: true,
    writeManifest: false,
    help: false,
  };
  const deps = (log, fetchBytes) => ({
    repoRoot: root,
    log,
    platform: "linux",
    env: { PATH: "" },
    isExecutable: () => false,
    osRelease: "ID=fedora",
    fetchBytes,
    tmpdir: os.tmpdir(),
    cpus: 4,
    manifests: manifests(),
  });

  it("prints the plan with sizes, downloads nothing and writes nothing", async () => {
    const lines = [];
    const { calls, fetchBytes } = fakeFetch();
    const result = await lib.runInstall({ ...baseOptions, prefix: path.join(root, "inst") }, {
      ...deps((line) => lines.push(line), fetchBytes),
      manifests: manifests(),
    });
    expect(result).toEqual({ dryRun: true });
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(root, "inst"))).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("Install plan");
    expect(text).toContain(`install folder   ${path.join(root, "inst")}`);
    expect(text).toContain("build tools      missing: make, cc, cxx, tar; install them with `sudo dnf install gcc-c++ make tar`");
    expect(text).toContain("ephemeris core   2 files");
    expect(text).toContain("2 to download");
    expect(text).toContain("Dry run: nothing was downloaded, built or written.");
  });

  it("shows the asteroid copy and the opt-in groups when they are asked for", async () => {
    const asteroidDir = path.join(root, "asteroids");
    fs.mkdirSync(path.join(asteroidDir, "ast136"), { recursive: true });
    fs.writeFileSync(path.join(asteroidDir, "se00002s.se1"), "pallas fixture");
    fs.writeFileSync(path.join(asteroidDir, "ast136", "s136199.se1"), "eris fixture");
    fs.writeFileSync(path.join(asteroidDir, "notes.txt"), "not an asteroid");
    const lines = [];
    const options = { ...baseOptions, asteroidsFrom: asteroidDir, withEp4: true, withMoons: true, skipGeonames: true };
    await lib.runInstall(options, {
      ...deps((line) => lines.push(line), fakeFetch().fetchBytes),
      manifests: manifests({ ep4: [{ path: "ep4/sep4_196", sha256: "e".repeat(64), bytes: 358000 }] }),
    });
    const text = lines.join("\n");
    expect(text).toContain("asteroids        2 files");
    expect(text).toContain("1 other names skipped");
    expect(text).toContain("ephemeris ep4");
    expect(text).toContain("ephemeris sat");
    expect(text).toContain("GeoNames         skipped (--skip-geonames)");
  });

  it("refuses a long --prefix before it plans anything, with the reason and a short --prefix to use", async () => {
    const longPrefix = `/${"a".repeat(200)}`;
    const { calls, fetchBytes } = fakeFetch();
    const failure = await lib.runInstall({ ...baseOptions, prefix: longPrefix }, deps(() => {}, fetchBytes)).catch((error) => error);
    expect(failure).toBeInstanceOf(lib.InstallError);
    expect(failure.message).toMatch(/too long for Astrolog.*must be 127 or fewer/);
    expect(failure.fix).toMatch(/--prefix ~\/astrolog8/);
    expect(calls).toHaveLength(0);
  });

  it("reports an asteroid folder that does not exist, with a fix line", async () => {
    try {
      await lib.runInstall({ ...baseOptions, asteroidsFrom: path.join(root, "nope") }, deps(() => {}, fakeFetch().fetchBytes));
      expect.unreachable("a missing folder must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(lib.InstallError);
      expect(error.message).toMatch(/is not a folder/);
      expect(error.fix).toMatch(/ast<N>/);
    }
  });
});
