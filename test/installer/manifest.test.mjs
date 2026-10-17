import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as lib from "../../scripts/astrolog-install.lib.mjs";

const HEX64 = "a".repeat(64);
const COMMIT = "b".repeat(40);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const goodEntry = (rel) => ({ path: rel, sha256: HEX64, bytes: 10 });
// Enough entries to clear the floors: the required names first, then numbered fillers.
const fill = (prefix, count, first = []) => [
  ...first.map(goodEntry),
  ...Array.from({ length: count - first.length }, (_, i) => goodEntry(`${prefix}${i}.se1`)),
];
const goodSwiss = () => ({
  repo: lib.REPO,
  commit: COMMIT,
  groups: {
    core: fill("extra_", lib.MIN_SWISS_FILES.core, lib.REQUIRED_SWISS_NAMES),
    ep4: fill("ep4/sep4_", lib.MIN_SWISS_FILES.ep4),
    sat: fill("sat/sepm", lib.MIN_SWISS_FILES.sat),
  },
});
const asSwissText = (value) => JSON.stringify(value);

describe("parseSwissManifest", () => {
  it("accepts a well-formed manifest and hashes its text", () => {
    const text = asSwissText(goodSwiss());
    const parsed = lib.parseSwissManifest(text);
    expect(parsed.commit).toBe(COMMIT);
    expect(parsed.groups.core).toHaveLength(lib.MIN_SWISS_FILES.core);
    expect(parsed.textSha256).toBe(lib.sha256Buffer(text));
  });

  it("refuses a manifest for another repository", () => {
    const value = { ...goodSwiss(), repo: "someone/else" };
    expect(() => lib.parseSwissManifest(asSwissText(value))).toThrow(/repo is someone\/else/);
  });

  it("refuses a commit that is not a full 40-character SHA", () => {
    const value = { ...goodSwiss(), commit: "master" };
    expect(() => lib.parseSwissManifest(asSwissText(value))).toThrow(/not a full 40-character SHA/);
  });

  it("refuses a sha256 that is not 64 hex characters", () => {
    const value = goodSwiss();
    value.groups.core[0].sha256 = "xyz";
    expect(() => lib.parseSwissManifest(asSwissText(value))).toThrow(/not a SHA-256 hex digest/);
  });

  it("refuses a size that is not a positive integer", () => {
    const value = goodSwiss();
    value.groups.core[0].bytes = 0;
    expect(() => lib.parseSwissManifest(asSwissText(value))).toThrow(/not a positive integer/);
  });

  it("refuses path traversal and names that are not plain files", () => {
    for (const bad of ["../escape.se1", "sepl_18.se1/../../x", "/abs.se1", "sub dir.se1", "ep4/../x"]) {
      const value = goodSwiss();
      value.groups.core[1].path = bad;
      expect(() => lib.parseSwissManifest(asSwissText(value)), bad).toThrow(/not a plain file name/);
    }
  });

  it("keeps core entries at the top level and ep4 and sat entries in their folders", () => {
    const core = goodSwiss();
    core.groups.core[1].path = "ep4/sepl_1.se1";
    expect(() => lib.parseSwissManifest(asSwissText(core))).toThrow(/sits in a folder/);

    const ep4 = goodSwiss();
    ep4.groups.ep4[0].path = "sepl_1.se1";
    expect(() => lib.parseSwissManifest(asSwissText(ep4))).toThrow(/outside the ep4\/ folder/);
  });

  it("refuses a path listed twice across groups", () => {
    const value = goodSwiss();
    value.groups.core.push(goodEntry("sepl_18.se1"));
    expect(() => lib.parseSwissManifest(asSwissText(value))).toThrow(/lists sepl_18.se1 twice/);
  });

  it("refuses a missing group and text that is not JSON", () => {
    const value = goodSwiss();
    delete value.groups.sat;
    expect(() => lib.parseSwissManifest(asSwissText(value))).toThrow(/no "sat" group/);
    expect(() => lib.parseSwissManifest("{not json")).toThrow(/not valid JSON/);
  });

  it("refuses a manifest that does not name a required file", () => {
    for (const name of lib.REQUIRED_SWISS_NAMES) {
      const value = goodSwiss();
      value.groups.core = value.groups.core.filter((entry) => entry.path !== name);
      value.groups.core.push(goodEntry("filler.se1"));
      expect(() => lib.parseSwissManifest(asSwissText(value)), name).toThrow(new RegExp(`does not list ${name.replace(".", "\\.")}`));
    }
  });

  it("refuses a group below its minimum count", () => {
    const short = goodSwiss();
    short.groups.core = short.groups.core.slice(0, lib.MIN_SWISS_FILES.core - 1);
    expect(() => lib.parseSwissManifest(asSwissText(short))).toThrow(/lists 149 core files, expected at least 150/);

    const sat = goodSwiss();
    sat.groups.sat = sat.groups.sat.slice(0, 2);
    expect(() => lib.parseSwissManifest(asSwissText(sat))).toThrow(/lists 2 sat files, expected at least 30/);
  });

  it("parses the committed manifest with the counts the manifest requires", () => {
    const text = fs.readFileSync(path.join(repoRoot, "scripts", "manifest", "swisseph.json"), "utf8");
    const parsed = lib.parseSwissManifest(text);
    expect(parsed.commit).toBe("aacf962d19d79f8bc921dbcdaacf306d85be1917");
    // 153 .se1 families (29+22+29+22+29+22) plus the five text files.
    expect(parsed.groups.core).toHaveLength(158);
    expect(parsed.groups.ep4).toHaveLength(70);
    expect(parsed.groups.sat).toHaveLength(33);
    expect(parsed.groups.core.every((entry) => /^(sepl_|semo_|seas_|seplm|semom|seasm)/.test(entry.path) || lib.CORE_TEXT_FILES.includes(entry.path))).toBe(true);
  });
});

describe("parseAstrologManifest", () => {
  const astrolog = (overrides = {}) => ({
    version: "8.00",
    url: "https://github.com/CruiserOne/Astrolog/archive/refs/tags/v8.00.tar.gz",
    sha256: HEX64,
    bytes: 6059321,
    ephem: lib.BUNDLED_EPHEM_NAMES.map((name) => goodEntry(name)),
    ...overrides,
  });

  it("accepts the pinned Astrolog release with its eight bundled dwarf-planet files", () => {
    const parsed = lib.parseAstrologManifest(JSON.stringify(astrolog()));
    expect(parsed.version).toBe("8.00");
    expect(parsed.ephem.map((entry) => entry.path).sort()).toEqual([...lib.BUNDLED_EPHEM_NAMES].sort());
  });

  it("refuses a URL outside the official repository and a version other than 8.00", () => {
    expect(() => lib.parseAstrologManifest(JSON.stringify(astrolog({ url: "https://example.com/a.tar.gz" })))).toThrow(
      /not an official Astrolog release/,
    );
    expect(() => lib.parseAstrologManifest(JSON.stringify(astrolog({ version: "7.80" })))).toThrow(/expected 8.00/);
  });

  it("refuses an ephem list that is missing one of the eight files, or has another name", () => {
    const missing = astrolog({ ephem: lib.BUNDLED_EPHEM_NAMES.slice(1).map((name) => goodEntry(name)) });
    expect(() => lib.parseAstrologManifest(JSON.stringify(missing))).toThrow(/not the eight bundled dwarf-planet files/);
    const other = astrolog({ ephem: [...lib.BUNDLED_EPHEM_NAMES.slice(1), "sepl_18.se1"].map((name) => goodEntry(name)) });
    expect(() => lib.parseAstrologManifest(JSON.stringify(other))).toThrow(/bundled entry sepl_18.se1 is not a dwarf-planet file name/);
    expect(() => lib.parseAstrologManifest(JSON.stringify(astrolog({ ephem: undefined })))).toThrow(/has no ephem list/);
  });

  it("parses the committed astrolog.json with the eight bundled files", () => {
    const text = fs.readFileSync(path.join(repoRoot, "scripts", "manifest", "astrolog.json"), "utf8");
    const parsed = lib.parseAstrologManifest(text);
    expect(parsed.ephem).toHaveLength(8);
    expect(parsed.textSha256).toBe(lib.sha256Buffer(text));
  });
});

describe("manifestFromListings", () => {
  const item = (name, size, type = "file") => ({ name, size, type });
  const listings = {
    core: [item("sepl_18.se1", 4), item("semo_18.se1", 6), item("readme.md", 1), item("ephe", 0, "dir")],
    ep4: [item("sep4_196", 3)],
    sat: [item("sepm9401.se1", 5), item("plmolist.txt", 2)],
  };
  const hashes = new Map([
    ["sepl_18.se1", { sha256: HEX64, bytes: 4 }],
    ["semo_18.se1", { sha256: HEX64, bytes: 6 }],
    ["ep4/sep4_196", { sha256: HEX64, bytes: 3 }],
    ["sat/sepm9401.se1", { sha256: HEX64, bytes: 5 }],
    ["sat/plmolist.txt", { sha256: HEX64, bytes: 2 }],
  ]);

  it("selects core families, and whole ep4 and sat folders, without extension filters", () => {
    const manifest = lib.manifestFromListings(listings, COMMIT, hashes);
    expect(manifest.groups.core.map((e) => e.path)).toEqual(["semo_18.se1", "sepl_18.se1"]);
    expect(manifest.groups.ep4.map((e) => e.path)).toEqual(["ep4/sep4_196"]);
    expect(manifest.groups.sat.map((e) => e.path)).toEqual(["sat/plmolist.txt", "sat/sepm9401.se1"]);
  });

  it("refuses a hash that was computed for a file of another size", () => {
    const wrong = new Map(hashes);
    wrong.set("sepl_18.se1", { sha256: HEX64, bytes: 99 });
    expect(() => lib.manifestFromListings(listings, COMMIT, wrong)).toThrow(/is 99 bytes but GitHub lists 4/);
  });
});
