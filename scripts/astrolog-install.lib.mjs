// Testable pieces of the Astrolog installer: flags, path and checksum checks, the manifests, the
// download-and-verify loop, the headless build, the smoke chart and the GeoNames checks. The CLI
// (scripts/install-astrolog.mjs) wires them together. Node 22 only, no runtime dependencies.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export const REPO = "aloistr/swisseph";
export const DEFAULT_INSTALL_DIR = ".astrolog";
export const GEONAMES_BASE = "https://download.geonames.org/export/dump/";
// Astrolog's own `#define X11` switch: commenting it out builds without X Window libraries.
const X11_DEFINE = /^#define X11(\s|$)/;
// Longest <install>/ephem/sepl_18.se1 path that Astrolog reads. Measured with the real Astrolog 7.80
// binary and its ephem folder: paths of 127 characters or fewer work; from 128 the file reads as "not found"
// although it exists, or the run returns 0 values or segfaults. The installed 8.00 is confirmed by the
// post-build smoke chart, which runs from the installed folder.
export const MAX_EPHEM_PATH = 127;
export const SMOKE_SUN = 353.5077;
export const SMOKE_TOLERANCE = 0.001;
// Einstein, 14 Mar 1879 11:30 LMT, Ulm (Rodden AA), with the neutral pins from src/astrolog/pins.ts.
export const SMOKE_CHART = [
  "-qa", "3", "14", "1879", "11:30", "LMT", "10:00E", "48:24N",
  "=b", "_YT", "_YV", "_h", "_sr", "_Yh", "_p", "_1", "_Ys", "_c3",
  "-x", "1", "-Yz", "0", "-YzO", "0", "-YzC", "0",
  "_s", "-c", "0",
];
// Files of the Astrolog release that go next to the binary. astrolog.as holds `-Yi1 "ephem"`.
export const DATA_FILES = ["astrolog.as", "atlas.as", "timezone.as", "astexo.csv", "astrolog.htm", "changes.htm", "license.htm"];
// Upstream ephe/ top-level names that belong to the core set besides the .se1 families.
export const CORE_TEXT_FILES = ["sefstars.txt", "seorbel.txt", "seasnam.txt", "astlistn.md", "swe_deltat.inactive.txt"];
export const CORE_PATTERN = /^(sepl_|semo_|seas_|seplm|semom|seasm)[^/]*\.se1$/;
// Numbered asteroid files: se00010s.se1 and s136108s.se1, with or without the s before .se1.
// Swiss reads only the s form in ast<N>/ (checked: ast136/s136199.se1 gives 0.0; s136199s.se1 gives the
// value), so copies are renamed to it.
export const ASTEROID_FILE = /^(se\d{5}|s\d{6})s?\.se1$/;
// The eight dwarf-planet files shipped in the Astrolog source's ephem/ folder. Upstream ephe/ does not
// hold them at the pinned commit, so they are pinned in astrolog.json and copied only from the verified tarball.
export const BUNDLED_EPHEM_NAMES = [
  "s136108s.se1", "s136199s.se1", "s136472s.se1", "s225088s.se1",
  "se00010s.se1", "se50000s.se1", "se90377s.se1", "se90482s.se1",
];
// The Swiss manifest must name these and hold at least this many files per group. The pinned release has
// 158 core, 70 ep4 and 33 sat files; the floors catch a truncated manifest.
export const REQUIRED_SWISS_NAMES = ["sepl_18.se1", "semo_18.se1", "seas_18.se1", "sefstars.txt"];
export const MIN_SWISS_FILES = { core: 150, ep4: 60, sat: 30 };
// Written last, after the smoke chart passes. An install without it is treated as incomplete.
export const COMPLETE_MARKER = ".install-complete";
// The version probe is stopped after this long. The three causes below cover a crash, a timeout and no output.
export const PROBE_TIMEOUT_MS = 15_000;
const UNUSABLE_FIX =
  "check in this order: astrolog.as missing next to the binary (run the command again to copy it); an incomplete install (run the command again); an unusable binary (delete it and run the command again so it is rebuilt)";

const USER_AGENT = "astrolog-mcp-installer";

export const USAGE = `Usage: npm run install:astrolog -- [options]

Builds Astrolog 8.00 headless and installs it with the full Swiss Ephemeris core set, then
downloads GeoNames city and admin tables. Nothing is committed; everything lands in ignored folders.

Options:
  --prefix <dir>        install folder (default ./.astrolog; <dir>/ephem/sepl_18.se1 must be 127 characters or fewer; ~/ is expanded)
  --force               rebuild Astrolog and re-download GeoNames (ephemeris files are always checked)
  --skip-geonames       do not download the GeoNames files
  --with-ep4            also download ephe/ep4 (25 MB)
  --with-moons          also download ephe/sat, the planetary moons (238 MB)
  --asteroids-from <dir>  copy a folder of ast<N>/ and se*s.se1 files you already have
  --dry-run             print the plan and sizes; download nothing
  --write-manifest      maintainers only: regenerate scripts/manifest/swisseph.json
  --commit <ref>        with --write-manifest: the swisseph commit or branch (default master)
  --help                show this text`;

// The one error the installer raises. \`fix\` is one line the user can act on.
export class InstallError extends Error {
  constructor(message, fix) {
    super(message);
    this.name = "InstallError";
    this.fix = fix;
  }
}

// ---------------------------------------------------------------- flags

const VALUE_FLAGS = new Set(["--prefix", "--asteroids-from", "--commit"]);
const BOOLEAN_FLAGS = {
  "--force": "force",
  "--skip-geonames": "skipGeonames",
  "--with-ep4": "withEp4",
  "--with-moons": "withMoons",
  "--dry-run": "dryRun",
  "--write-manifest": "writeManifest",
  "--help": "help",
  "-h": "help",
};

export function parseArgs(argv) {
  const options = {
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
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (BOOLEAN_FLAGS[arg]) {
      options[BOOLEAN_FLAGS[arg]] = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new InstallError(`${arg} needs a value`, `pass it a value, for example ${arg} <dir>`);
      }
      i++;
      if (arg === "--prefix") options.prefix = value;
      if (arg === "--asteroids-from") options.asteroidsFrom = value;
      if (arg === "--commit") options.commit = value;
    } else {
      throw new InstallError(`unknown option ${arg}`, "run with --help to see the options");
    }
  }
  if (options.commit !== null && !options.writeManifest) {
    throw new InstallError("--commit only applies with --write-manifest", "remove --commit, or add --write-manifest");
  }
  if (options.writeManifest) {
    const others = Object.keys(options).filter(
      (key) => key !== "writeManifest" && key !== "commit" && key !== "help" && options[key] !== null && options[key] !== false,
    );
    if (others.length > 0) {
      throw new InstallError("--write-manifest only takes --commit", "run --write-manifest on its own");
    }
  }
  return options;
}

// ---------------------------------------------------------------- paths

// Refuses an install folder whose <install>/ephem/sepl_18.se1 path is longer than MAX_EPHEM_PATH characters.
// Returns the folder.
export function checkInstallPath(installDir) {
  const probe = path.join(installDir, "ephem", "sepl_18.se1");
  if (probe.length > MAX_EPHEM_PATH) {
    throw new InstallError(
      `the install path is too long for Astrolog: ${probe} is ${probe.length} characters (must be ${MAX_EPHEM_PATH} or fewer)`,
      "choose a shorter folder with --prefix, for example --prefix ~/astrolog8",
    );
  }
  return installDir;
}

// ---------------------------------------------------------------- checksums and files

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// True when the file exists with the expected size and SHA-256. A missing file is false, not an error.
export async function verifyFile(file, expected) {
  let size;
  try {
    size = (await stat(file)).size;
  } catch {
    return false;
  }
  if (size !== expected.bytes) return false;
  return (await sha256File(file)) === expected.sha256;
}

// Writes through a .part file and renames, so a failed write never leaves a half file in place.
export async function writeAtomic(dest, data) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try {
    await fs.promises.writeFile(part, data);
    await fs.promises.rename(part, dest);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

export async function copyAtomic(from, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  try {
    await fs.promises.copyFile(from, part);
    await fs.promises.rename(part, dest);
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------- manifests

export function parseAstrologManifest(text) {
  const data = parseJson(text, "scripts/manifest/astrolog.json");
  if (data.version !== "8.00") {
    throw new InstallError(`astrolog.json pins version ${data.version}, expected 8.00`, "restore the file from git");
  }
  if (typeof data.url !== "string" || !data.url.startsWith("https://github.com/CruiserOne/Astrolog/")) {
    throw new InstallError("astrolog.json url is not an official Astrolog release", "restore the file from git");
  }
  if (!/^[0-9a-f]{64}$/.test(data.sha256)) {
    throw new InstallError("astrolog.json sha256 is not a SHA-256 hex digest", "restore the file from git");
  }
  if (!Number.isInteger(data.bytes) || data.bytes <= 0) {
    throw new InstallError("astrolog.json bytes must be a positive integer", "restore the file from git");
  }
  if (!Array.isArray(data.ephem)) {
    throw new InstallError("astrolog.json has no ephem list", "restore the file from git");
  }
  const seen = new Set();
  const ephem = data.ephem.map((entry) => checkEntry(entry, "bundled", seen));
  const names = ephem.map((entry) => entry.path).sort();
  if (JSON.stringify(names) !== JSON.stringify([...BUNDLED_EPHEM_NAMES].sort())) {
    throw new InstallError("astrolog.json ephem list is not the eight bundled dwarf-planet files", "restore the file from git");
  }
  return { ...data, ephem, textSha256: sha256Buffer(text) };
}

// Parses and checks the Swiss manifest. Entries are relative to upstream ephe/ and to <install>/ephem/.
export function parseSwissManifest(text) {
  const data = parseJson(text, "scripts/manifest/swisseph.json");
  if (data.repo !== REPO) {
    throw new InstallError(`swisseph.json repo is ${data.repo}, expected ${REPO}`, "restore the file from git");
  }
  if (!/^[0-9a-f]{40}$/.test(data.commit ?? "")) {
    throw new InstallError("swisseph.json commit is not a full 40-character SHA", "regenerate with --write-manifest");
  }
  const groups = data.groups ?? {};
  const seen = new Set();
  const checked = {};
  for (const name of ["core", "ep4", "sat"]) {
    if (!Array.isArray(groups[name])) {
      throw new InstallError(`swisseph.json has no "${name}" group`, "regenerate with --write-manifest");
    }
    checked[name] = groups[name].map((entry) => checkEntry(entry, name, seen));
  }
  for (const name of REQUIRED_SWISS_NAMES) {
    if (!checked.core.some((entry) => entry.path === name)) {
      throw new InstallError(`swisseph.json does not list ${name}`, "restore the file from git");
    }
  }
  for (const [name, floor] of Object.entries(MIN_SWISS_FILES)) {
    if (checked[name].length < floor) {
      throw new InstallError(`swisseph.json lists ${checked[name].length} ${name} files, expected at least ${floor}`, "restore the file from git");
    }
  }
  return { repo: data.repo, commit: data.commit, groups: checked, textSha256: sha256Buffer(text) };
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new InstallError(`${label} is not valid JSON`, "restore the file from git");
  }
}

function checkEntry(entry, group, seen) {
  if (typeof entry !== "object" || entry === null) {
    throw new InstallError(`a ${group} entry is not an object`, "regenerate with --write-manifest");
  }
  const { path: rel, sha256, bytes } = entry;
  const safe = typeof rel === "string" && /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?$/.test(rel) && !rel.includes("..");
  if (!safe) {
    throw new InstallError(`manifest path ${JSON.stringify(rel)} is not a plain file name`, "regenerate with --write-manifest");
  }
  if (group === "bundled") {
    if (!ASTEROID_FILE.test(rel)) {
      throw new InstallError(`bundled entry ${rel} is not a dwarf-planet file name`, "restore the file from git");
    }
  } else if (group === "core" && rel.includes("/")) {
    throw new InstallError(`core entry ${rel} sits in a folder`, "regenerate with --write-manifest");
  } else if (group !== "core" && !rel.startsWith(`${group}/`)) {
    throw new InstallError(`${group} entry ${rel} is outside the ${group}/ folder`, "regenerate with --write-manifest");
  }
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) {
    throw new InstallError(`manifest sha256 for ${rel} is not a SHA-256 hex digest`, "regenerate with --write-manifest");
  }
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new InstallError(`manifest size for ${rel} is not a positive integer`, "regenerate with --write-manifest");
  }
  if (seen.has(rel)) {
    throw new InstallError(`manifest lists ${rel} twice`, "regenerate with --write-manifest");
  }
  seen.add(rel);
  return { path: rel, sha256, bytes };
}

export function rawUrl(commit, rel) {
  return `https://raw.githubusercontent.com/${REPO}/${commit}/ephe/${rel}`;
}

// Which upstream files each group holds. `listings` maps a group to its GitHub contents array.
// ep4 and sat are taken whole, because ep4 files have no .se1 extension.
export function selectUpstreamFiles(listings) {
  const selected = [];
  for (const item of listings.core) {
    if (item.type === "file" && (CORE_PATTERN.test(item.name) || CORE_TEXT_FILES.includes(item.name))) {
      selected.push({ group: "core", rel: item.name, item });
    }
  }
  for (const group of ["ep4", "sat"]) {
    for (const item of listings[group]) {
      if (item.type === "file") selected.push({ group, rel: `${group}/${item.name}`, item });
    }
  }
  return selected;
}

// Turns the GitHub listings into manifest entries. `hashes` maps each rel path to its real hash and size.
export function manifestFromListings(listings, commit, hashes) {
  const groups = { core: [], ep4: [], sat: [] };
  for (const { group, rel, item } of selectUpstreamFiles(listings)) {
    const hashed = hashes.get(rel);
    if (!hashed) throw new InstallError(`no hash was computed for ${rel}`, "rerun --write-manifest");
    if (hashed.bytes !== item.size) {
      throw new InstallError(`${rel} is ${hashed.bytes} bytes but GitHub lists ${item.size}`, "rerun --write-manifest");
    }
    groups[group].push({ path: rel, sha256: hashed.sha256, bytes: hashed.bytes });
  }
  for (const list of Object.values(groups)) list.sort((a, b) => a.path.localeCompare(b.path));
  return { repo: REPO, commit, groups };
}

// Maintainers only: resolves the ref, lists the three folders and downloads each selected file once to hash it.
export async function buildSwissManifest(ref, { fetchJson, fetchBytes, log }) {
  const commitInfo = await fetchJson(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`);
  const commit = commitInfo.sha;
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
    throw new InstallError(`GitHub did not resolve ${ref} to a commit`, "pass --commit with a full commit SHA");
  }
  const base = `https://api.github.com/repos/${REPO}/contents`;
  const listings = {
    core: await fetchJson(`${base}/ephe?ref=${commit}`),
    ep4: await fetchJson(`${base}/ephe/ep4?ref=${commit}`),
    sat: await fetchJson(`${base}/ephe/sat?ref=${commit}`),
  };
  const selected = selectUpstreamFiles(listings);
  const hashes = new Map();
  for (const [index, { rel }] of selected.entries()) {
    log(`[${index + 1}/${selected.length}] hashing ${rel}`);
    const data = await fetchBytes(rawUrl(commit, rel));
    hashes.set(rel, { sha256: sha256Buffer(data), bytes: data.length });
  }
  return manifestFromListings(listings, commit, hashes);
}

// ---------------------------------------------------------------- network

export async function httpGetBytes(url) {
  let response;
  try {
    response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(300_000) });
  } catch (error) {
    throw new InstallError(`download failed: ${url} (${error.message})`, "check your internet connection and run the command again; files already in place are kept");
  }
  if (!response.ok) {
    throw new InstallError(`download failed: ${url} returned HTTP ${response.status}`, "check the URL, then run the command again");
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function httpGetJson(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new InstallError(`GitHub request failed: ${url} (${error.message})`, "check your internet connection and run the command again");
  }
  if (!response.ok) {
    throw new InstallError(`GitHub returned HTTP ${response.status} for ${url}`, "wait a few minutes if this is a rate limit, then run it again");
  }
  return response.json();
}

// ---------------------------------------------------------------- ephemeris

// Compares each manifest entry with what is on disk. `dest` is under <install>/ephem/.
export async function planEphemeris(entries, ephemDir) {
  const plan = [];
  for (const entry of entries) {
    const dest = path.join(ephemDir, ...entry.path.split("/"));
    plan.push({ ...entry, dest, current: await verifyFile(dest, entry) });
  }
  return plan;
}

// Downloads only the entries whose hash does not match. Each download is verified before it lands.
export async function installEphemeris(plan, { fetchBytes, commit, log }) {
  let downloaded = 0;
  let kept = 0;
  for (const [index, entry] of plan.entries()) {
    const label = `[${index + 1}/${plan.length}] ${entry.path}`;
    if (entry.current) {
      kept++;
      continue;
    }
    log(`${label} (${formatBytes(entry.bytes)})`);
    const data = await fetchBytes(rawUrl(commit, entry.path));
    const got = sha256Buffer(data);
    if (data.length !== entry.bytes || got !== entry.sha256) {
      throw new InstallError(
        `${entry.path} does not match the manifest (got ${data.length} bytes, sha256 ${got.slice(0, 12)}...)`,
        "nothing was replaced; run it again, and if it repeats regenerate the manifest with --write-manifest",
      );
    }
    await writeAtomic(entry.dest, data);
    downloaded++;
  }
  return { downloaded, kept };
}

// Finds numbered asteroid files at the top of a user-supplied directory and in its ast<N>/ folders.
// Returns entries relative to <install>/ephem/, named the way Swiss Ephemeris reads them.
export async function planAsteroidCopy(dir) {
  const files = [];
  const skipped = [];
  const add = (from, name, folder) => {
    const rel = folder ? `${folder}/${canonicalAsteroidName(name)}` : canonicalAsteroidName(name);
    if (files.some((file) => file.rel === rel)) {
      throw new InstallError(
        `${dir} holds two files that both become ${rel}`,
        "keep one of each numbered asteroid file in the folder",
      );
    }
    files.push({ from, rel });
  };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const from = path.join(dir, entry.name);
    if (entry.isFile() && ASTEROID_FILE.test(entry.name)) {
      // A top-level copy of a pinned file would replace the verified one after the manifest check.
      if (BUNDLED_EPHEM_NAMES.includes(canonicalAsteroidName(entry.name))) {
        throw new InstallError(
          `${from} is a bundled dwarf-planet file that the installer pins`,
          "move it out of the folder: the installer pins this file",
        );
      }
      add(from, entry.name, null);
    } else if (entry.isDirectory() && /^ast\d+$/.test(entry.name)) {
      for (const child of await readdir(from, { withFileTypes: true })) {
        if (child.isFile() && ASTEROID_FILE.test(child.name)) {
          add(path.join(from, child.name), child.name, entry.name);
        } else {
          skipped.push(`${entry.name}/${child.name}`);
        }
      }
    } else {
      skipped.push(entry.name);
    }
  }
  if (files.length === 0) {
    throw new InstallError(`${dir} holds no asteroid files`, "pass a folder that holds ast<N>/ folders or se*s.se1 / s*s.se1 files");
  }
  for (const file of files) file.bytes = (await stat(file.from)).size;
  return { files, skipped };
}

// se00001.se1 becomes se00001s.se1, and s136199.se1 becomes s136199s.se1.
export function canonicalAsteroidName(name) {
  return name.replace(/s?\.se1$/, "s.se1");
}

export async function copyAsteroids(files, ephemDir, log) {
  let copied = 0;
  let kept = 0;
  for (const file of files) {
    const dest = path.join(ephemDir, ...file.rel.split("/"));
    const same = await verifyFile(dest, { bytes: file.bytes, sha256: await sha256File(file.from) });
    if (same) {
      kept++;
      continue;
    }
    log(`copying ${file.rel}`);
    await copyAtomic(file.from, dest);
    copied++;
  }
  return { copied, kept };
}

// Lists every regular file under ephem/ with its size, for the summary.
export async function inventoryEphemeris(ephemDir) {
  const out = [];
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) out.push({ rel, bytes: (await stat(full)).size });
    }
  }
  if (fs.existsSync(ephemDir)) await walk(ephemDir, "");
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// Plain facts about what the files cover, read from Swiss Ephemeris file names (swephlib.cpp
// swi_gen_filename): sepl_NN and semo_NN cover 600 years from century NN*100 (AD). A "m" file is
// BC: seplm06 covers -600 to -1, seplm132 covers -13200 to -12601. Numbered objects are one file each.
export function describeCoverage(relNames) {
  const names = relNames.map((rel) => rel.split("/").pop());
  const families = {
    planets: names.some((n) => /^sepl_/.test(n) || /^seplm/.test(n)),
    moon: names.some((n) => /^semo_/.test(n) || /^semom/.test(n)),
    asteroidsSix: names.some((n) => /^seas_/.test(n) || /^seasm/.test(n)),
  };
  let from = null;
  let to = null;
  for (const name of names) {
    const block = name.match(/^(sepl|semo|seas)(m?)[_]?(\d{2,3})\.se1$/);
    if (!block) continue;
    const start = Number(block[3]) * 100 * (block[2] === "m" ? -1 : 1);
    const end = start + 599;
    from = from === null ? start : Math.min(from, start);
    to = to === null ? end : Math.max(to, end);
  }
  const numbered = [];
  for (const name of names) {
    const match = name.match(ASTEROID_FILE);
    if (match) numbered.push(Number(match[1].replace(/^s[e]?/, "")));
  }
  return {
    ...families,
    eraFrom: from,
    eraTo: to,
    numbered: [...new Set(numbered)].sort((a, b) => a - b),
  };
}

// ---------------------------------------------------------------- Astrolog build

// Comments out the one `#define X11` line. Refuses if the release has none or more than one.
export function disableX11(text) {
  const lines = text.split("\n");
  const hits = [];
  lines.forEach((line, index) => {
    if (X11_DEFINE.test(line)) hits.push(index);
  });
  if (hits.length !== 1) {
    throw new InstallError(`astrolog.h has ${hits.length} "#define X11" lines, expected 1`, "the Astrolog release changed; check scripts/manifest/astrolog.json");
  }
  lines[hits[0]] = `//${lines[hits[0]]}`;
  return lines.join("\n");
}

export function libsFor(platform) {
  return platform === "darwin" ? "-lm" : "-lm -ldl";
}

export function makeArgs({ jobs, platform, cxx }) {
  return [`-j${jobs}`, `LIBS=${libsFor(platform)}`, `CXX=${cxx}`];
}

// The tools the build needs. Astrolog's Makefile compiles with $(CXX) and links with `cc`.
export function findExecutable(name, pathEnv, isExecutable = defaultIsExecutable) {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function defaultIsExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function findBuildTools(pathEnv, isExecutable) {
  return {
    make: findExecutable("make", pathEnv, isExecutable),
    cc: findExecutable("cc", pathEnv, isExecutable),
    cxx: findExecutable("g++", pathEnv, isExecutable) ?? findExecutable("c++", pathEnv, isExecutable) ?? findExecutable("clang++", pathEnv, isExecutable),
    tar: findExecutable("tar", pathEnv, isExecutable),
  };
}

// The one command that installs make and a C++ compiler on this system.
export function buildToolsHint(platform, osReleaseText = "") {
  if (platform === "darwin") return "xcode-select --install";
  const ids = (osReleaseText.match(/^(ID|ID_LIKE)=.*$/gm) ?? []).join(" ").replace(/"/g, "");
  if (/\b(fedora|rhel|centos)\b/.test(ids)) return "sudo dnf install gcc-c++ make tar";
  if (/\b(debian|ubuntu)\b/.test(ids)) return "sudo apt install build-essential tar";
  return "install gcc, g++, make and tar with your package manager";
}

// Names of the missing tools. The source download needs tar; the compile needs make, cc and a C++ compiler.
export function missingBuildTools(tools, needBinary = true) {
  const names = needBinary ? ["make", "cc", "cxx", "tar"] : ["tar"];
  return names.filter((name) => tools[name] === null);
}

export function tailLines(text, count = 30) {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}

export function runCommand(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024, encoding: "utf8", ...options }, (error, stdout, stderr) => {
      if (error && typeof error.code === "string") reject(error);
      else resolve({ stdout, stderr, code: error ? error.code : 0 });
    });
  });
}

// Runs the Astrolog binary with stdin closed and a timeout. Astrolog prompts on a terminal, so
// an open stdin can hang the installer. It is started as ./astrolog from its own folder: Astrolog builds its
// Swiss search path from argv[0]; with the absolute path, a 69-character install folder crashes (SIGSEGV) and
// a 66-character one works (measured with the 8.00 binary).
export function runAstrolog(binary, args, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      `./${path.basename(binary)}`,
      args,
      { cwd: path.dirname(binary), timeout: timeoutMs, encoding: "latin1", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          const stopped = new InstallError(`Astrolog took longer than ${timeoutMs / 1000}s and was stopped`, "run the command again; if it repeats, check that ephem/ is complete");
          reject(Object.assign(stopped, { timedOut: true }));
          return;
        }
        if (error && typeof error.code === "string") {
          reject(new InstallError(`Astrolog could not run (${error.code}): ${binary}`, "run the install again so the binary is rebuilt"));
          return;
        }
        resolve({ stdout, stderr, code: error ? error.code ?? null : 0, signal: error ? error.signal ?? null : null });
      },
    );
    child.stdin?.end();
  });
}

const VERSION = /Astrolog version (\d+)\.(\d+)/;

// Returns the version Astrolog prints (or null), the signal that stopped it if it crashed, and whether it timed out.
export async function astrologVersion(binary, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = await runAstrolog(binary, ["-Hc"], { timeoutMs });
  } catch (error) {
    if (!error.timedOut) throw error;
    return { version: null, signal: null, timedOut: true };
  }
  const match = (result.stdout + result.stderr).match(VERSION);
  return { version: match ? `${match[1]}.${match[2]}` : null, signal: result.signal, timedOut: false };
}

// The probe printed no version. Names the signal or the timeout, then the three causes in the order to check
// them. None of them is the folder length, so --force is not suggested.
export function probeFailure(binary, { signal = null, timedOut = false } = {}) {
  const detail = timedOut ? ` and timed out after ${PROBE_TIMEOUT_MS / 1000}s` : signal ? ` and stopped with ${signal}` : "";
  return new InstallError(`${binary} printed no version${detail}`, UNUSABLE_FIX);
}

// Runs the smoke chart and returns Sun's longitude. A crash is named by its signal; without the check it would
// read as zero values.
export async function runSmokeChart(binary) {
  const run = await runAstrolog(binary, smokeCommand());
  if (run.signal) {
    throw new InstallError(`the test chart stopped with ${run.signal}`, UNUSABLE_FIX);
  }
  return checkSmoke(parseExpressionValues(run.stderr));
}

export function smokeCommand() {
  const cast = [...SMOKE_CHART, "-Y0"].join(" ");
  return ["-Yq2", cast, "-~ 'ObjLon O_Sun' -Y0"];
}

const EXPRESSION = /Expression returned: (-?\d+(?:\.\d+)?)/g;

export function parseExpressionValues(text) {
  return [...text.matchAll(EXPRESSION)].map((match) => Number(match[1]));
}

// Returns Sun's longitude, or throws. A missing ephemeris file makes astrolog print 0.0, so the
// tolerance check is what catches it.
export function checkSmoke(values) {
  if (values.length !== 1) {
    throw new InstallError(`Astrolog returned ${values.length} values for the test chart, expected 1`, "check that ephem/ holds the Swiss files and that the install path is short");
  }
  const sun = values[0];
  if (Math.abs(sun - SMOKE_SUN) > SMOKE_TOLERANCE) {
    throw new InstallError(
      `the test chart is wrong: Sun ${sun.toFixed(4)} degrees, expected ${SMOKE_SUN.toFixed(4)}`,
      "run the install again; if it repeats, check that ephem/ holds sepl_18.se1 and seas_18.se1",
    );
  }
  return sun;
}

// ---------------------------------------------------------------- zip and GeoNames

// Reads a zip archive with node:zlib: stored and deflated entries only, each checked by CRC-32.
export function readZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let pos = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw zipError("the central directory is damaged");
    const method = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    const size = buffer.readUInt32LE(pos + 20);
    const rawSize = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString("utf8", pos + 46, pos + 46 + nameLength);
    if (size === 0xffffffff || rawSize === 0xffffffff || localOffset === 0xffffffff) throw zipError("zip64 archives are not supported");
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw zipError(`${name} has a damaged local header`);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const packed = buffer.subarray(start, start + size);
    let data;
    if (method === 0) data = packed;
    else if (method === 8) data = zlib.inflateRawSync(packed);
    else throw zipError(`${name} uses compression method ${method}, which is not supported`);
    if (data.length !== rawSize || zlib.crc32(data) !== crc) throw zipError(`${name} fails its CRC-32 check`);
    entries.set(name, data);
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - 65557);
  for (let pos = buffer.length - 22; pos >= floor; pos--) {
    if (buffer.readUInt32LE(pos) === 0x06054b50) return pos;
  }
  throw zipError("no zip directory found");
}

function zipError(detail) {
  return new InstallError(`the GeoNames archive is not a readable zip: ${detail}`, "run the command with --force to download it again");
}

// A GeoNames table: enough rows, enough columns, and numeric coordinates where they belong. An HTML
// error page fails here, not at lookup time.
export function checkTable(text, { label, minLines, minColumns, numericColumns = [] }) {
  if (/^\s*</.test(text)) {
    throw new InstallError(`${label} is an HTML page, not a GeoNames table`, "run the command with --force to download it again");
  }
  const rows = text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
  if (rows.length < minLines) {
    throw new InstallError(`${label} has ${rows.length} rows, expected at least ${minLines}`, "run the command with --force to download it again");
  }
  for (const row of rows.slice(0, 200)) {
    const cells = row.split("\t");
    const wide = cells.length >= minColumns;
    const numeric = numericColumns.every((index) => Number.isFinite(Number(cells[index])) && cells[index] !== "");
    if (!wide || !numeric) {
      throw new InstallError(`${label} has a row that does not parse: ${row.slice(0, 60)}`, "run the command with --force to download it again");
    }
  }
  return rows.length;
}

export const GEONAMES_FILES = [
  { name: "cities500.zip", url: `${GEONAMES_BASE}cities500.zip` },
  { name: "admin1CodesASCII.txt", url: `${GEONAMES_BASE}admin1CodesASCII.txt` },
  { name: "countryInfo.txt", url: `${GEONAMES_BASE}countryInfo.txt` },
];

export const CITIES_MIN_ROWS = 100_000;

export function citiesCheck(text) {
  return checkTable(text, { label: "cities500.txt", minLines: CITIES_MIN_ROWS, minColumns: 19, numericColumns: [4, 5] });
}

export function admin1Check(text) {
  return checkTable(text, { label: "admin1CodesASCII.txt", minLines: 1000, minColumns: 4 });
}

export function countryCheck(text) {
  return checkTable(text, { label: "countryInfo.txt", minLines: 200, minColumns: 19 });
}

// ---------------------------------------------------------------- output

export function formatBytes(bytes) {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function sumBytes(items) {
  return items.reduce((total, item) => total + item.bytes, 0);
}

export function ephemGroups(options) {
  const groups = ["core"];
  if (options.withEp4) groups.push("ep4");
  if (options.withMoons) groups.push("sat");
  return groups;
}

// The default install folder is next to the repo root, not the shell's working directory. A prefix
// starting with ~/ is taken from the home folder, because a shell does not expand ~ inside quotes.
export function resolveInstallDir(options, repoRoot, home = os.homedir()) {
  if (!options.prefix) return path.join(repoRoot, DEFAULT_INSTALL_DIR);
  if (options.prefix === "~" || options.prefix.startsWith("~/")) return path.join(home, options.prefix.slice(1));
  return path.resolve(options.prefix);
}

export function writeTempDir(prefix, tmpdir = os.tmpdir()) {
  return mkdtemp(path.join(tmpdir, prefix));
}

// ---------------------------------------------------------------- install

// Everything that touches the outside world comes in through `deps`, so tests can replace it:
// repoRoot, log, platform, env, isExecutable, osRelease, fetchBytes, tmpdir, cpus, manifests.
// Order: plan, preflight, build only when needed, restore the bundled files, version check, then the Swiss
// files (planned after the build), asteroids, GeoNames, the smoke chart, and the completion marker last.
export async function runInstall(options, deps) {
  const { repoRoot, log, platform, env, isExecutable, osRelease, fetchBytes, tmpdir, cpus, manifests } = deps;
  const installDir = resolveInstallDir(options, repoRoot);
  const ephemDir = path.join(installDir, "ephem");
  const binary = path.join(installDir, "astrolog");
  const dataDir = path.join(repoRoot, "data", "geonames");
  checkInstallPath(installDir);
  if (platform === "win32") {
    throw new InstallError("this installer builds Astrolog from source, which needs Linux or macOS", "on Windows, run it under WSL2");
  }
  const { astrolog, swiss } = manifests;
  const swissEntries = ephemGroups(options).flatMap((group) => swiss.groups[group]);
  const tools = findBuildTools(env.PATH, isExecutable);
  const complete = await hasCompletionMarker(installDir, manifests);
  const needBinary = options.force || !complete || !(await binaryComplete(installDir));
  const bundled = await planEphemeris(astrolog.ephem, ephemDir);
  const needSource = needBinary || bundled.some((entry) => !entry.current);
  const asteroids = options.asteroidsFrom ? await readAsteroidDir(options.asteroidsFrom) : null;

  if (options.dryRun) {
    const ephem = await planEphemeris(swissEntries, ephemDir);
    const plan = formatPlan({ installDir, astrolog, needBinary, needSource, tools, platform, osRelease, bundled, ephem, asteroids, options, dataDir });
    for (const line of plan) log(line);
    log("Dry run: nothing was downloaded, built or written.");
    return { dryRun: true };
  }

  const missing = needSource ? missingBuildTools(tools, needBinary) : [];
  if (missing.length > 0) {
    const names = missing.map((name) => (name === "cxx" ? "a C++ compiler" : name)).join(", ");
    throw new InstallError(`building Astrolog needs ${names}, which is missing`, `run \`${buildToolsHint(platform, osRelease)}\`, then run this command again`);
  }
  if (!complete && fs.existsSync(binary)) {
    log("no completion marker: an earlier run did not finish, so Astrolog is rebuilt and every file is checked");
  }
  await rm(completionPath(installDir), { force: true });

  let restored = 0;
  if (!needBinary) {
    log(`Astrolog ${astrolog.version} is already built at ${binary}; use --force to rebuild it.`);
  }
  if (needSource) {
    await withAstrologSource({ astrolog, tar: tools.tar, tmpdir, fetchBytes, log }, async (root) => {
      if (needBinary) await compileAstrolog({ root, tools, installDir, binary, platform, cpus, log });
      restored = await restoreBundled(root, ephemDir, bundled.filter((entry) => !entry.current), log);
    });
  }

  // The probe runs with astrolog.as already copied next to the binary: compileAstrolog copies it, and
  // binaryComplete requires it when the build is skipped.
  const probe = await astrologVersion(binary);
  const { version } = probe;
  if (version === null) throw probeFailure(binary, probe);
  if (version !== astrolog.version) {
    throw new InstallError(`${binary} reports Astrolog ${version}, expected ${astrolog.version}`, "run this command with --force to rebuild it");
  }

  // Planned after the build, so the build can never change a Swiss file that the plan then counts as matched.
  const ephem = await planEphemeris(swissEntries, ephemDir);
  const fetched = await installEphemeris(ephem, { fetchBytes, commit: swiss.commit, log });
  const copied = asteroids ? await copyAsteroids(asteroids.files, ephemDir, log) : null;
  const geonames = options.skipGeonames ? null : await installGeonames({ dataDir, force: options.force, fetchBytes, log });

  const smoke = await runSmokeChart(binary);
  const inventory = await inventoryEphemeris(ephemDir);
  const coverage = describeCoverage([
    ...swissEntries.map((entry) => entry.path),
    ...astrolog.ephem.map((entry) => entry.path),
    ...(asteroids ? asteroids.files.map((file) => file.rel) : []),
  ]);
  const marker = completionPath(installDir);
  await writeAtomic(marker, `${JSON.stringify(completionRecord(manifests), null, 2)}\n`);
  const report = {
    version, binary, installDir, inventory, coverage, copied, geonames, smoke, fetched,
    restored, bundledCount: bundled.length, dataDir, marker,
  };
  return { ...report, summary: formatSummary(report) };
}

async function readAsteroidDir(dir) {
  try {
    return await planAsteroidCopy(dir);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new InstallError(`--asteroids-from ${dir} is not a folder`, "pass the folder that holds ast<N>/ and se*s.se1 files");
    }
    throw error;
  }
}

// True when the binary and the Astrolog files it needs are already in place.
export async function binaryComplete(installDir) {
  const names = ["astrolog", ...DATA_FILES];
  for (const name of names) {
    if (!fs.existsSync(path.join(installDir, name))) return false;
  }
  return true;
}

// The install marker: written last, and only when every step above has finished.
export function completionPath(installDir) {
  return path.join(installDir, COMPLETE_MARKER);
}

// What the marker records: the Astrolog version and the text hashes of the two manifests it was checked against.
export function completionRecord({ astrolog, swiss }) {
  return {
    version: astrolog.version,
    swissCommit: swiss.commit,
    astrologManifestSha256: astrolog.textSha256,
    swissManifestSha256: swiss.textSha256,
  };
}

// True only when the marker exists and records these manifests. An install without it is incomplete.
export async function hasCompletionMarker(installDir, manifests) {
  let saved;
  try {
    saved = JSON.parse(await fs.promises.readFile(completionPath(installDir), "utf8"));
  } catch {
    return false;
  }
  if (typeof saved !== "object" || saved === null) return false;
  const record = completionRecord(manifests);
  return Object.keys(record).every((key) => saved[key] === record[key]);
}

// Downloads the pinned Astrolog tarball, checks its size and SHA-256, and unpacks it with tar into a temp
// folder. `use` receives the source root; the folder is removed afterwards.
async function withAstrologSource({ astrolog, tar, tmpdir, fetchBytes, log }, use) {
  const tmp = await writeTempDir("astrolog-build-", tmpdir);
  try {
    log(`downloading Astrolog ${astrolog.version} from ${astrolog.url}`);
    const archive = await fetchBytes(astrolog.url);
    const got = sha256Buffer(archive);
    if (archive.length !== astrolog.bytes || got !== astrolog.sha256) {
      throw new InstallError(
        `the Astrolog download does not match its pinned SHA-256 (got ${got.slice(0, 12)}...)`,
        "nothing was installed; run it again later, and report it if it persists",
      );
    }
    const archivePath = path.join(tmp, "astrolog.tar.gz");
    const src = path.join(tmp, "src");
    await fs.promises.writeFile(archivePath, archive);
    await fs.promises.mkdir(src);
    const untar = await runCommand(tar, ["-xzf", archivePath, "-C", src], { timeout: 120_000 });
    if (untar.code !== 0) throw new InstallError(`tar could not unpack the Astrolog source: ${tailLines(untar.stderr, 5)}`, "run the command again");
    return await use(await findSourceRoot(src));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Switches X11 off in astrolog.h, runs make in the source folder, and copies the binary and data files into
// place. The source's ephem/ folder is not copied: every Swiss file is fetched and checked on its own.
async function compileAstrolog({ root, tools, installDir, binary, platform, cpus, log }) {
  const header = path.join(root, "astrolog.h");
  await fs.promises.writeFile(header, disableX11(await fs.promises.readFile(header, "latin1")), "latin1");
  const jobs = String(cpus || 2);
  log(`compiling Astrolog headless (${jobs} jobs)`);
  const make = await runCommand(tools.make, makeArgs({ jobs, platform, cxx: tools.cxx }), { cwd: root, timeout: 1_800_000 });
  if (make.code !== 0) {
    throw new InstallError(`the Astrolog build failed (exit ${make.code}). Last lines:\n${tailLines(make.stdout + make.stderr)}`, "fix the compiler error above, then run this command again");
  }
  log(`installing into ${installDir}`);
  await copyAtomic(path.join(root, "astrolog"), binary);
  await fs.promises.chmod(binary, 0o755);
  for (const name of DATA_FILES) await copyAtomic(path.join(root, name), path.join(installDir, name));
}

// Places the bundled dwarf-planet files from the verified source. Each is checked against its manifest entry
// first. Only the bundled names are taken from the source; its copies of the Swiss names (for example
// seas_18.se1, which differs from the pinned upstream file) are never used.
async function restoreBundled(root, ephemDir, entries, log) {
  for (const entry of entries) {
    const from = path.join(root, "ephem", entry.path);
    log(`restoring ${entry.path} from the Astrolog source`);
    if (!(await verifyFile(from, entry))) {
      throw new InstallError(
        `the Astrolog source's ${entry.path} does not match scripts/manifest/astrolog.json`,
        "nothing was replaced; report it with the release URL from scripts/manifest/astrolog.json",
      );
    }
    await copyAtomic(from, path.join(ephemDir, entry.path));
  }
  return entries.length;
}

async function findSourceRoot(src) {
  const dirs = (await readdir(src, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  for (const dir of dirs) {
    const root = path.join(src, dir.name);
    if (fs.existsSync(path.join(root, "astrolog.h")) && fs.existsSync(path.join(root, "ephem"))) return root;
  }
  throw new InstallError("the downloaded source does not look like Astrolog", "report it with the release URL from scripts/manifest/astrolog.json");
}

// Each file: keep it if it is already there and matches, otherwise fetch and verify before replacing.
async function installGeonames({ dataDir, force, fetchBytes, log }) {
  const cities = path.join(dataDir, "cities500.txt");
  const admin1 = path.join(dataDir, "admin1CodesASCII.txt");
  const country = path.join(dataDir, "countryInfo.txt");
  const result = {};
  const existing = async (file, check) => {
    if (force || !fs.existsSync(file)) return null;
    try {
      return check(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };

  result.cities = await existing(cities, citiesCheck);
  if (result.cities === null) {
    log(`downloading ${GEONAMES_FILES[0].url}`);
    const zip = await fetchBytes(GEONAMES_FILES[0].url);
    const text = readZip(zip).get("cities500.txt");
    if (!text) throw new InstallError("cities500.zip has no cities500.txt inside", "run the command with --force to download it again");
    result.cities = citiesCheck(text.toString("utf8"));
    await writeAtomic(path.join(dataDir, "cities500.zip"), zip);
    await writeAtomic(cities, text);
  }

  result.admin1 = await existing(admin1, admin1Check);
  if (result.admin1 === null) {
    log(`downloading ${GEONAMES_FILES[1].url}`);
    const bytes = await fetchBytes(GEONAMES_FILES[1].url);
    result.admin1 = admin1Check(bytes.toString("utf8"));
    await writeAtomic(admin1, bytes);
  }

  result.country = await existing(country, countryCheck);
  if (result.country === null) {
    log(`downloading ${GEONAMES_FILES[2].url}`);
    const bytes = await fetchBytes(GEONAMES_FILES[2].url);
    result.country = countryCheck(bytes.toString("utf8"));
    await writeAtomic(country, bytes);
  }
  return { ...result, dataDir };
}

// ---------------------------------------------------------------- plan and summary text

export function formatPlan({ installDir, astrolog, needBinary, needSource, tools, platform, osRelease, bundled, ephem, asteroids, options, dataDir }) {
  const lines = [
    "Install plan",
    `  install folder   ${installDir}`,
  ];
  if (needBinary) {
    lines.push(`  Astrolog         ${astrolog.version} from ${astrolog.url} (${formatBytes(astrolog.bytes)})`);
    lines.push(`                   sha256 ${astrolog.sha256}; built headless, X11 off, LIBS=${libsFor(platform)}`);
  } else {
    lines.push(`  Astrolog         ${astrolog.version} already built; not rebuilt (use --force to rebuild)`);
  }
  const restore = bundled.filter((entry) => !entry.current);
  lines.push(
    `  bundled          ${bundled.length} dwarf-planet files, ${formatBytes(sumBytes(bundled))}; ` +
      `${bundled.length - restore.length} already match, ${restore.length} to restore from the Astrolog source`,
  );
  if (needSource) {
    const missing = missingBuildTools(tools, needBinary);
    lines.push(
      missing.length > 0
        ? `  build tools      missing: ${missing.join(", ")}; install them with \`${buildToolsHint(platform, osRelease)}\``
        : `  build tools      make ${tools.make}, cc ${tools.cc}, c++ ${tools.cxx}, tar ${tools.tar}`,
    );
  }
  for (const group of ephemGroups(options)) {
    const items = ephem.filter((entry) => entryGroup(entry.path) === group);
    const todo = items.filter((entry) => !entry.current);
    lines.push(
      `  ephemeris ${group.padEnd(5)}  ${items.length} files, ${formatBytes(sumBytes(items))}; ` +
        `${items.length - todo.length} already match, ${todo.length} to download (${formatBytes(sumBytes(todo))})`,
    );
  }
  if (asteroids) {
    lines.push(`  asteroids        ${asteroids.files.length} files (${formatBytes(sumBytes(asteroids.files))}) from ${options.asteroidsFrom}; ${asteroids.skipped.length} other names skipped`);
  }
  if (options.skipGeonames) {
    lines.push("  GeoNames         skipped (--skip-geonames)");
  } else {
    lines.push(`  GeoNames         cities500.zip, admin1CodesASCII.txt, countryInfo.txt into ${dataDir} (sizes not pinned)`);
  }
  lines.push("  smoke chart      Einstein, 14 Mar 1879 11:30 LMT Ulm: Sun must be 353.5077 +/- 0.001");
  return lines;
}

// Core, ep4 and sat by upstream folder: a rel path with a folder belongs to that folder's group.
function entryGroup(rel) {
  if (rel.startsWith("ep4/")) return "ep4";
  if (rel.startsWith("sat/")) return "sat";
  return "core";
}

export function formatSummary({ version, binary, installDir, inventory, coverage, copied, geonames, smoke, fetched, restored, bundledCount, dataDir, marker }) {
  const total = sumBytes(inventory);
  const swiss = inventory.filter((file) => file.rel.endsWith(".se1")).length;
  const lines = [
    `Astrolog ${version} installed: ${binary}`,
    `Install folder: ${installDir}`,
    `Ephemeris: ${inventory.length} files, ${formatBytes(total)} under ephem/ (${swiss} Swiss .se1 files)`,
    `  Swiss files: ${fetched.downloaded} downloaded, ${fetched.kept} already matched`,
    `  bundled dwarf planets: ${restored} restored from the Astrolog source, ${bundledCount - restored} already matched`,
    `Covers (from the manifest): planets ${yesNo(coverage.planets)}, Moon ${yesNo(coverage.moon)}, Chiron and Ceres, Pallas, Juno, Vesta ${yesNo(coverage.asteroidsSix)}, years ${coverage.eraFrom} to ${coverage.eraTo}`,
    `Numbered objects: ${coverage.numbered.length > 0 ? coverage.numbered.join(", ") : "none"}`,
  ];
  if (copied) lines.push(`Asteroids copied in: ${copied.copied} new, ${copied.kept} already matched`);
  if (geonames) {
    lines.push(`Place table: ${geonames.cities} cities (cities500.txt), ${geonames.admin1} admin1 rows, ${geonames.country} country rows in ${dataDir}`);
  } else {
    lines.push("Place table: skipped (--skip-geonames)");
  }
  lines.push(`Smoke chart: Sun ${smoke.toFixed(4)} degrees, expected ${SMOKE_SUN.toFixed(4)} +/- ${SMOKE_TOLERANCE}: ok`);
  lines.push(`Install complete: ${marker} written (Astrolog ${version}, both manifest hashes recorded)`);
  return lines.join("\n");
}

function yesNo(flag) {
  return flag ? "yes" : "no";
}
