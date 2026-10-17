#!/usr/bin/env node
// Installs Astrolog 8.00 headless, with the full Swiss Ephemeris core set and the GeoNames tables.
// The steps and the rules live in scripts/astrolog-install.lib.mjs. Run `npm run install:astrolog -- --help`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "./astrolog-install.lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readOsRelease() {
  try {
    return fs.readFileSync("/etc/os-release", "utf8");
  } catch {
    return "";
  }
}

function loadManifests() {
  const dir = path.join(repoRoot, "scripts", "manifest");
  return {
    astrolog: lib.parseAstrologManifest(fs.readFileSync(path.join(dir, "astrolog.json"), "utf8")),
    swiss: lib.parseSwissManifest(fs.readFileSync(path.join(dir, "swisseph.json"), "utf8")),
  };
}

async function main(argv) {
  const options = lib.parseArgs(argv);
  if (options.help) {
    console.log(lib.USAGE);
    return 0;
  }
  const deps = {
    repoRoot,
    log: (line) => console.log(line),
    platform: process.platform,
    env: process.env,
    osRelease: readOsRelease(),
    fetchBytes: lib.httpGetBytes,
    fetchJson: lib.httpGetJson,
    tmpdir: os.tmpdir(),
    cpus: os.cpus().length,
  };

  if (options.writeManifest) {
    const manifest = await lib.buildSwissManifest(options.commit ?? "master", deps);
    const file = path.join(repoRoot, "scripts", "manifest", "swisseph.json");
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    const count = Object.values(manifest.groups).reduce((total, list) => total + list.length, 0);
    console.log(`wrote ${file}: ${count} files at commit ${manifest.commit}`);
    return 0;
  }

  const result = await lib.runInstall(options, { ...deps, manifests: loadManifests() });
  if (!result.dryRun) console.log(result.summary);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof lib.InstallError) {
      console.error(`error: ${error.message}`);
      console.error(`fix: ${error.fix}`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  },
);
