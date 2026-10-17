import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { AstroError } from "../types.js";

export const RUN_TIMEOUT_MS = 5000;
// A `<ephem dir>/sepl_18.se1` path must be shorter than this. Measured with the real 7.80 binary and
// its real ephem directory, by installing copies under folders of growing length: results are
// identical to the baseline (Sun 84.229045) up to 127 characters, and from 128 astrolog fails
// (seas_18.se1 "not found" though it exists, 0 values, or SIGSEGV). Not caused by a missing
// astrolog.as. The installer's smoke test re-confirms it on 8.00 and uses the same number.
export const MAX_EPHEM_PATH = 128;
const LONGEST_EPHEM_FILE = "sepl_18.se1";
export const MIN_VERSION: readonly [number, number] = [7, 80];
const OUTPUT_CAP = 4 * 1024 * 1024;

const INSTALL_FIX = "Set ASTROLOG_BIN to the astrolog executable, for example /opt/astrolog/astrolog.";

export interface Completed {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

// The one place a process is spawned. argv array, no shell, stdin closed so a prompt cannot hang
// the call, output decoded as latin-1, killed at the timeout. `cwd` is required: callers pass a
// fresh per-request directory.
export function spawnAstrolog(
  binary: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number = RUN_TIMEOUT_MS,
): Promise<Completed> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: {} });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new AstroError(
            `astrolog took longer than ${timeoutMs / 1000} s and was stopped`,
            "Check the astrolog install: run the binary with -H and make sure its ephem directory is readable.",
          ),
        ),
      );
    }, timeoutMs);
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_CAP) {
        child.kill("SIGKILL");
        return;
      }
      into.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    child.on("error", (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          new AstroError(
            e.code === "EACCES"
              ? `astrolog (${path.basename(binary)}) is not executable`
              : `astrolog could not be started (${e.code ?? "error"})`,
            e.code === "EACCES" ? "Run chmod +x on the file ASTROLOG_BIN names." : INSTALL_FIX,
          ),
        ),
      ),
    );
    child.on("close", (code, signal) =>
      finish(() =>
        resolve({
          stdout: Buffer.concat(out).toString("latin1"),
          stderr: Buffer.concat(err).toString("latin1"),
          code,
          signal,
        }),
      ),
    );
  });
}

// The ephemeris directory next to the binary, as an absolute path. Every cast pins it with -Yi1,
// and the cast line is space-joined, so a path with whitespace or quotes is refused.
export function ephemDir(binary: string): string {
  const resolved = path.resolve(binary);
  if (/[\s'"`\\]/.test(resolved)) {
    throw new AstroError(
      `the astrolog path contains whitespace or a quote character: ${resolved}`,
      "Move astrolog to a path without spaces or quotes and point ASTROLOG_BIN at it.",
    );
  }
  return path.join(path.dirname(resolved), "ephem");
}

// ASTROLOG_BIN must name an executable file in a folder short enough for astrolog's search buffer.
export function locateBinary(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.ASTROLOG_BIN;
  if (!value) {
    throw new AstroError("ASTROLOG_BIN is not set", INSTALL_FIX);
  }
  const resolved = path.resolve(value);
  ephemDir(resolved);
  try {
    if (!statSync(resolved).isFile()) {
      throw new Error("not a file");
    }
    accessSync(resolved, constants.X_OK);
  } catch {
    throw new AstroError(
      `ASTROLOG_BIN does not point at an executable file: ${resolved}`,
      `${INSTALL_FIX} Make sure the file exists and has the execute bit.`,
    );
  }
  const longest = path.join(ephemDir(resolved), LONGEST_EPHEM_FILE);
  if (longest.length >= MAX_EPHEM_PATH) {
    throw new AstroError(
      `the ephemeris path ${longest} is ${longest.length} characters, over the ${MAX_EPHEM_PATH - 1} astrolog can search; the ephemeris path is too long`,
      "Install Astrolog under a shorter folder, for example ~/astrolog8, with the project's installer, and point ASTROLOG_BIN at it.",
    );
  }
  return resolved;
}

const VERSION = /Astrolog \(version (\d+)\.(\d+)\)/;

// The version from the `-H` banner, as "7.80". Needs a cwd that is not the astrolog directory.
export async function readVersion(binary: string, cwd: string): Promise<string> {
  const done = await spawnAstrolog(binary, ["-YQ", "0", "-H"], cwd);
  const match = VERSION.exec(done.stdout + done.stderr);
  // Measured: with the default scroll limit (-YQ 24, which an absent or minimal astrolog.as leaves
  // in place) the binary prints the banner, asks to scroll, hits stdin at EOF and dies with SIGSEGV.
  // The probe passes `-YQ 0`, so a signal here is a real crash.
  if (!match || done.signal) {
    const how = done.signal ? `crashed (${done.signal})` : "printed no version";
    throw new AstroError(
      `astrolog ${how} on -H; likely causes, in order: astrolog.as is missing next to the binary, the install is incomplete, or the binary is unusable`,
      "Run the project's installer to reinstall astrolog, then point ASTROLOG_BIN at the new astrolog executable.",
    );
  }
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (major < MIN_VERSION[0] || (major === MIN_VERSION[0] && minor < MIN_VERSION[1])) {
    throw new AstroError(
      `astrolog ${match[1]}.${match[2]} is older than the required ${MIN_VERSION[0]}.${MIN_VERSION[1]}`,
      "Install astrolog 7.80 or newer and point ASTROLOG_BIN at it.",
    );
  }
  return `${match[1]}.${match[2]}`;
}
