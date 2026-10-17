import path from "node:path";
import { describe, expect, it } from "vitest";
import * as lib from "../../scripts/astrolog-install.lib.mjs";
import { MAX_EPHEM_PATH as ENGINE_REFUSES_AT } from "../../src/astrolog/binary.ts";

// An install folder whose <folder>/ephem/sepl_18.se1 path is exactly `probe` characters.
const prefixWithProbeLength = (probe) => `/${"a".repeat(probe - "/ephem/sepl_18.se1".length - 1)}`;

describe("parseArgs", () => {
  it("defaults every flag off", () => {
    expect(lib.parseArgs([])).toEqual({
      prefix: null,
      asteroidsFrom: null,
      commit: null,
      force: false,
      skipGeonames: false,
      withEp4: false,
      withMoons: false,
      dryRun: false,
      writeManifest: false,
      help: false,
    });
  });

  it("reads boolean and value flags", () => {
    const options = lib.parseArgs([
      "--prefix",
      "/opt/astro",
      "--force",
      "--skip-geonames",
      "--with-ep4",
      "--with-moons",
      "--asteroids-from",
      "/data/ast",
      "--dry-run",
    ]);
    expect(options).toMatchObject({
      prefix: "/opt/astro",
      asteroidsFrom: "/data/ast",
      force: true,
      skipGeonames: true,
      withEp4: true,
      withMoons: true,
      dryRun: true,
    });
  });

  it("refuses an unknown option with a fix line", () => {
    expect(() => lib.parseArgs(["--sidereal"])).toThrowError(
      expect.objectContaining({ name: "InstallError", fix: expect.stringContaining("--help") }),
    );
  });

  it("refuses a value flag with no value", () => {
    expect(() => lib.parseArgs(["--prefix"])).toThrow(/--prefix needs a value/);
    expect(() => lib.parseArgs(["--prefix", "--force"])).toThrow(/--prefix needs a value/);
    expect(() => lib.parseArgs(["--asteroids-from", ""])).toThrow(/needs a value/);
  });

  it("takes --commit only with --write-manifest, and --write-manifest alone", () => {
    expect(() => lib.parseArgs(["--commit", "master"])).toThrow(/only applies with --write-manifest/);
    expect(lib.parseArgs(["--write-manifest", "--commit", "master"])).toMatchObject({
      writeManifest: true,
      commit: "master",
    });
    expect(() => lib.parseArgs(["--write-manifest", "--force"])).toThrow(/only takes --commit/);
    expect(() => lib.parseArgs(["--write-manifest", "--prefix", "/x"])).toThrow(/only takes --commit/);
  });
});

describe("checkInstallPath", () => {
  it("exports the limit: the ephemeris probe must be 127 characters or fewer", () => {
    expect(lib.MAX_EPHEM_PATH).toBe(127);
  });

  it("accepts a path whose ephemeris probe is 127 characters", () => {
    const prefix = prefixWithProbeLength(127);
    expect(path.join(prefix, "ephem", "sepl_18.se1").length).toBe(127);
    expect(lib.checkInstallPath(prefix)).toBe(prefix);
  });

  it("refuses a path whose ephemeris probe is 128 characters, with a fix line", () => {
    const prefix = prefixWithProbeLength(128);
    expect(path.join(prefix, "ephem", "sepl_18.se1").length).toBe(128);
    try {
      lib.checkInstallPath(prefix);
      expect.unreachable("a 128-character path must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(lib.InstallError);
      expect(error.message).toMatch(/too long.*128 characters.*127 or fewer/);
      expect(error.fix).toMatch(/--prefix ~\/astrolog8/);
    }
  });

  it("uses the repo's .astrolog folder by default and the resolved --prefix otherwise", () => {
    expect(lib.resolveInstallDir({ prefix: null }, "/repo")).toBe(path.join("/repo", ".astrolog"));
    expect(lib.resolveInstallDir({ prefix: "rel/dir" }, "/repo")).toBe(path.resolve("rel/dir"));
  });

  it("expands a leading ~/ to the home folder, so a quoted prefix does not make a folder named ~", () => {
    expect(lib.resolveInstallDir({ prefix: "~/astrolog8" }, "/repo", "/home/me")).toBe(path.join("/home/me", "astrolog8"));
    expect(lib.resolveInstallDir({ prefix: "~" }, "/repo", "/home/me")).toBe("/home/me");
    expect(lib.resolveInstallDir({ prefix: "~user/x" }, "/repo", "/home/me")).toBe(path.resolve("~user/x"));
  });
});

describe("the reference smoke chart arguments", () => {
  it("gives every coordinate an explicit hemisphere letter", () => {
    const coords = lib.SMOKE_CHART.filter((arg) => /^\d+:\d+[NSEW]$/.test(arg));
    expect(coords).toEqual(["10:00E", "48:24N"]);
  });
});

describe("the ephemeris path limit", () => {
  it("is one boundary: the engine refuses at the length the installer no longer accepts", () => {
    // The installer's constant is the longest accepted path; the engine's is the first refused one.
    expect(ENGINE_REFUSES_AT).toBe(lib.MAX_EPHEM_PATH + 1);
  });
});
