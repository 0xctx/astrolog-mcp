import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as lib from "../../scripts/astrolog-install.lib.mjs";

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "astrolog-ast-test-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function touch(rel, text = "x") {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe("planAsteroidCopy", () => {
  it("takes numbered files at the top and in ast<N>/ folders, renamed to the form Swiss reads", async () => {
    // Pallas and Eros: not pinned, so they may sit at the top. The pinned dwarf names are refused (see below).
    touch("se00002s.se1", "pallas");
    touch("s000433s.se1", "eros");
    touch("se00001.se1", "ceres without the s");
    touch("ast0/se00001.se1", "ceres");
    touch("ast136/s136199.se1", "eris");
    touch("ast136/notes.txt", "not an asteroid");
    touch("other/readme.md", "a folder that is not ast<N>");
    touch("readme.txt", "a file that is not an asteroid");

    const { files, skipped } = await lib.planAsteroidCopy(root);
    expect(files.map((f) => f.rel).sort()).toEqual([
      "ast0/se00001s.se1",
      "ast136/s136199s.se1",
      "s000433s.se1",
      "se00001s.se1",
      "se00002s.se1",
    ]);
    expect(files.every((f) => f.bytes > 0)).toBe(true);
    expect(skipped.sort()).toEqual(["ast136/notes.txt", "other", "readme.txt"]);
  });

  it("refuses two source files that would both become the same name", async () => {
    touch("se00002.se1", "one");
    touch("se00002s.se1", "two");
    await expect(lib.planAsteroidCopy(root)).rejects.toThrow(/both become se00002s.se1/);
  });

  it("refuses a folder with no asteroid files, with a fix line", async () => {
    touch("readme.txt", "not an asteroid");
    touch("ast136/notes.txt", "not an asteroid");
    try {
      await lib.planAsteroidCopy(root);
      expect.unreachable("a folder with no asteroid files must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(lib.InstallError);
      expect(error.message).toMatch(/holds no asteroid files/);
      expect(error.fix).toMatch(/ast<N>\/ folders or se\*s\.se1/);
    }
  });
});

describe("planAsteroidCopy and the pinned dwarf-planet files", () => {
  it("refuses a top-level file whose canonical name is a pinned dwarf-planet file, before anything is copied", async () => {
    touch("s136108.se1", "a haumea copy that would replace the verified one");
    touch("se00010s.se1", "hygiea");
    await expect(lib.planAsteroidCopy(root)).rejects.toThrow(/s136108.se1 is a bundled dwarf-planet file/);
    try {
      await lib.planAsteroidCopy(root);
      expect.unreachable("a pinned dwarf-planet name must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(lib.InstallError);
      expect(error.fix).toBe("move it out of the folder: the installer pins this file");
    }
  });

  it("still accepts the same dwarf-planet number inside an ast<N>/ folder, which the installer does not pin", async () => {
    touch("ast136/s136108.se1", "haumea in a numbered folder");
    const { files } = await lib.planAsteroidCopy(root);
    expect(files.map((f) => f.rel)).toEqual(["ast136/s136108s.se1"]);
  });
});

describe("canonicalAsteroidName", () => {
  it("adds the s before .se1 when it is missing and leaves the canonical form alone", () => {
    expect(lib.canonicalAsteroidName("se00001.se1")).toBe("se00001s.se1");
    expect(lib.canonicalAsteroidName("s136199.se1")).toBe("s136199s.se1");
    expect(lib.canonicalAsteroidName("s136199s.se1")).toBe("s136199s.se1");
  });
});

describe("describeCoverage", () => {
  it("reads the eras and the families from Swiss file names", () => {
    const coverage = lib.describeCoverage([
      "sepl_18.se1",
      "semo_18.se1",
      "seas_18.se1",
      "seplm06.se1",
      "seplm132.se1",
      "s136108s.se1",
      "ast0/se00010.se1",
      "se00010s.se1",
      "sefstars.txt",
    ]);
    expect(coverage.planets).toBe(true);
    expect(coverage.moon).toBe(true);
    expect(coverage.asteroidsSix).toBe(true);
    // sepl_18 covers 1800-2399; seplm132 covers -13200 to -12601; seplm06 covers -600 to -1.
    expect(coverage.eraFrom).toBe(-13200);
    expect(coverage.eraTo).toBe(2399);
    expect(coverage.numbered).toEqual([10, 136108]);
  });

  it("reports nothing covered for an empty folder", () => {
    const coverage = lib.describeCoverage([]);
    expect(coverage).toMatchObject({ planets: false, moon: false, asteroidsSix: false, eraFrom: null, eraTo: null, numbered: [] });
  });
});

describe("inventoryEphemeris", () => {
  it("lists every file under ephem/ with its size", async () => {
    touch("ephem/sepl_18.se1", "12345");
    touch("ephem/ep4/sep4_196", "1");
    const inventory = await lib.inventoryEphemeris(path.join(root, "ephem"));
    expect(inventory).toEqual([
      { rel: "ep4/sep4_196", bytes: 1 },
      { rel: "sepl_18.se1", bytes: 5 },
    ]);
  });
});
