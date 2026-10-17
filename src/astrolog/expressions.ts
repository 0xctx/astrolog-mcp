import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AstroError, type Ayanamsa, type HouseSystem, type ObjectCode } from "../types.js";
import { MAX_EPHEM_PATH, ephemDir, spawnAstrolog } from "./binary.js";
import { pinArgs } from "./pins.js";

// Astrolog stops reading a command line after roughly 100 arguments (each `-~ 'expr'` is two),
// and -Yq takes at most 9 lines: one to cast, up to 8 to evaluate.
export const EXPRS_PER_LINE = 40;
export const MAX_EXPRESSIONS = EXPRS_PER_LINE * 8;

const MISSING_FILE = /SwissEph file '?([^'\n]*?)'? not found/i;
const RETURNED = /Expression returned: (-?\d+(?:\.\d+)?)/g;

export interface RunRequest {
  binary: string;
  // The chart selection switches, without pins: `-qa ...`, or `-rc a.as b.as`, plus anything such
  // as `-o file`. Pins are appended here and cannot be left out.
  chartArgs: readonly string[];
  // Switches placed after the pins, such as `-o file`, which may take trailing parameters.
  afterPins?: readonly string[];
  houseSystem: HouseSystem;
  // The zodiac for the run: "tropical" or a sidereal ayanamsa. Every run in a call must pass the
  // same value.
  ayanamsa: Ayanamsa;
  // Objects switched on for the run; expressions can only read these.
  codes: readonly ObjectCode[];
  expressions: readonly string[];
  // A directory to run in. Omitted: a fresh one is made and removed for this call.
  cwd?: string;
}

// The one function that runs astrolog for chart data. It always applies the pins, always runs in
// a directory that is not the install directory, and returns one number per expression.
export async function runExpressions(request: RunRequest): Promise<number[]> {
  const { expressions } = request;
  if (expressions.length > MAX_EXPRESSIONS) {
    throw new AstroError(
      `${expressions.length} expressions in one call, over the ${MAX_EXPRESSIONS} limit`,
      "Split the request into smaller calls.",
    );
  }
  const cast = [
    ...request.chartArgs,
    ...pinArgs(request.houseSystem, request.codes, ephemDir(request.binary), request.ayanamsa),
    ...(request.afterPins ?? []),
    "-Y0",
  ].join(" ");
  const lines: string[] = [];
  for (let i = 0; i < expressions.length; i += EXPRS_PER_LINE) {
    const chunk = expressions.slice(i, i + EXPRS_PER_LINE);
    lines.push(`${chunk.map((e) => `-~ '${e}'`).join(" ")} -Y0`);
  }
  if (lines.length === 0) {
    lines.push("-Y0");
  }
  const argv = [`-Yq${1 + lines.length}`, cast, ...lines];

  const ownDir = request.cwd === undefined;
  let cwd = request.cwd;
  if (cwd === undefined) {
    try {
      cwd = await mkdtemp(path.join(tmpdir(), "astrolog-run-"));
    } catch (e) {
      throw new AstroError(
        `could not create a working directory (${(e as NodeJS.ErrnoException).code ?? "error"})`,
        "Make sure the system temp directory exists and is writable.",
      );
    }
  }
  try {
    const done = await spawnAstrolog(request.binary, argv, cwd);
    const absent = MISSING_FILE.exec(done.stderr);
    if (absent) {
      // The client gets the file name only: the install directory is the operator's business.
      const dir = ephemDir(request.binary);
      console.error(`astrolog could not find the ephemeris file ${absent[1]} in ${dir}`);
      const tooLong = path.join(dir, "sepl_18.se1").length >= MAX_EPHEM_PATH;
      throw new AstroError(
        `astrolog could not find the ephemeris file ${path.basename(absent[1] ?? "")}`,
        "Install the Swiss Ephemeris files beside the astrolog binary with the project's ephemeris installer, then restart." +
          (tooLong ? " The ephemeris path may be too long: install Astrolog under a shorter folder, for example ~/astrolog8." : ""),
      );
    }
    const values = [...done.stderr.matchAll(RETURNED)].map((m) => Number(m[1]));
    if (values.length !== expressions.length) {
      throw new AstroError(
        `astrolog returned ${values.length} of ${expressions.length} values`,
        "Check that ASTROLOG_BIN is astrolog 7.80 or newer with its ephem directory beside it.",
      );
    }
    return values;
  } finally {
    if (ownDir) {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
