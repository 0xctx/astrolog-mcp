import { DateTime } from "luxon";
import { CALL_TIMEOUT_MS } from "../limits.js";
import { StubEngine } from "../stub-engine.js";
import { AstrologEngine } from "../astrolog/engine.js";
import { loadPlaceTable, resolvePlace } from "../place.js";
import { toUtc } from "../time.js";
import { AstroError, type Engine, type LocalMoment, type Place, type UtcMoment } from "../types.js";

// What the tools need from the outside world. The real resolvePlace and toUtc come from the
// real engine path; tests inject fakes. A resolvePlace may return its Place synchronously or
// through a promise.
export interface ToolDeps {
  engine: Engine;
  resolvePlace: (text: string) => Place | Promise<Place>;
  toUtc: (local: LocalMoment) => UtcMoment;
  // Overrides CALL_TIMEOUT_MS. Tests use it to make a slow call finish quickly.
  timeoutMs?: number;
  // How many engine calls may wait for a slot. createRegistry sets it from ENGINE_QUEUE; unset means
  // DEFAULT_ENGINE_QUEUE.
  engineQueue?: number;
}

// Stub mode: placeholder numbers from StubEngine and the time conversion below. Place names are
// not looked up here, so a caller passes explicit coordinates instead.
export function createStubDeps(): ToolDeps {
  return {
    engine: new StubEngine(),
    resolvePlace: () => {
      throw new AstroError(
        "place names are not looked up in this build",
        "Pass latitude, longitude and time zone instead of a place name.",
      );
    },
    toUtc: localToUtc,
    timeoutMs: CALL_TIMEOUT_MS,
  };
}

// The real engine: AstrologEngine (its start() runs the smoke test and rejects with an AstroError
// when the binary cannot be trusted), the GeoNames place resolver and the strict toUtc.
export async function createAstrologDeps(env: NodeJS.ProcessEnv = process.env): Promise<ToolDeps> {
  const engine = await AstrologEngine.start(env);
  const dataDir = env.ASTROLOG_MCP_DATA || undefined;
  // Read the 40 MB GeoNames table before serving: parsing it blocks the event loop for seconds, so
  // it must not happen under the first caller. A missing table is not fatal: coordinates still
  // work, and a place call reports it.
  await loadPlaceTable(dataDir ?? "./data").catch((error: unknown) => {
    if (error instanceof AstroError) {
      console.error(`place names will not resolve: ${error.message}`);
      console.error(`fix: ${error.fix}`);
    } else {
      console.error("place names will not resolve: the place table could not be loaded");
    }
  });
  return {
    engine,
    resolvePlace: (text) => resolvePlace(text, { dataDir }),
    toUtc,
    timeoutMs: CALL_TIMEOUT_MS,
  };
}

// Picks the dependencies for an ENGINE value. Unset or empty means stub, so the server starts
// without astrolog. "astrolog" starts the real binary and rejects when it cannot.
export async function depsFromEngine(engine: string | undefined, env: NodeJS.ProcessEnv = process.env): Promise<ToolDeps> {
  if (!engine || engine === "stub") {
    return createStubDeps();
  }
  if (engine === "astrolog") {
    return createAstrologDeps(env);
  }
  throw new Error(`ENGINE must be "stub" or "astrolog", got "${engine}"`);
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

// Converts a local clock time in an IANA zone to UT, refusing a time the zone skips (luxon would
// move it forward silently) and a time the zone repeats (it names two moments). Used by the stub deps only.
function localToUtc(local: LocalMoment): UtcMoment {
  const wanted = `${local.date}T${local.time}`;
  const minute = wanted.slice(0, 16);
  const zoned = DateTime.fromISO(wanted, { zone: local.timezone });
  if (!zoned.isValid) {
    throw new AstroError(
      `cannot read ${wanted} in time zone ${local.timezone}: ${zoned.invalidReason ?? "invalid"}`,
      "Check the birth date (YYYY-MM-DD), the birth time (HH:MM) and the IANA time zone name.",
    );
  }
  // Each offset the zone has near this wall time gives one candidate instant. Keep the candidates
  // whose clock in the zone reads the wanted minute: none is a gap, one is a normal time, two is a
  // repeated hour.
  const asUtc = DateTime.fromISO(wanted, { zone: "UTC" }).toMillis();
  const offsets = new Set(
    [-DAY_MS, 0, DAY_MS].map((shift) => DateTime.fromMillis(asUtc + shift, { zone: local.timezone }).offset),
  );
  const instants = [...offsets]
    .map((offset) => asUtc - offset * MINUTE_MS)
    .filter((instant) => clockAt(instant, local.timezone) === minute);
  const [instant, ...others] = instants;
  if (instant === undefined) {
    throw new AstroError(
      `${wanted} does not exist in time zone ${local.timezone}`,
      "Pick a birth time that the clocks in that zone show, for example one outside a daylight-saving change.",
    );
  }
  if (others.length > 0) {
    throw new AstroError(
      `${wanted} happens twice in time zone ${local.timezone}`,
      "Choose a birth time outside the repeated hour when the clocks go back, for example one an hour before or after it.",
    );
  }
  return DateTime.fromMillis(instant, { zone: "UTC" }).toFormat("yyyy-MM-dd'T'HH:mm:ss'Z'") as UtcMoment;
}

// The wall clock in a zone at an instant, to the minute.
function clockAt(instant: number, zone: string): string {
  return DateTime.fromMillis(instant, { zone }).toFormat("yyyy-MM-dd'T'HH:mm");
}
