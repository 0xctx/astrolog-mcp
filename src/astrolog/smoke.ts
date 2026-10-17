import { AstroError, type ObjectCode } from "../types.js";
import { runExpressions } from "./expressions.js";

// Einstein, 14 Mar 1879 11:30 LMT at Ulm, which is 10:50 UT. Sun is 353.5077 degrees (23:30 Pisces).
export const SMOKE_CHART: readonly string[] = ["-qa", "3", "14", "1879", "10:50:00", "0", "10:00:00E", "48:24:00N"];
export const SMOKE_SUN = 353.5077;
export const SMOKE_TOLERANCE = 0.001;

// Reference longitudes for the chart above, measured on the pinned Astrolog 7.80 with its Swiss
// Ephemeris files (placidus, mean node, tropical): Sun 353.507747, Moon 254.5259, Ceres 47.331976,
// Eris 344.851668. Moon, a main-belt asteroid and a dwarf planet prove the asteroid and dwarf
// ephemeris files are installed, which the Sun alone cannot.
export const SMOKE_REFERENCE: Readonly<Partial<Record<ObjectCode, number>>> = {
  Sun: SMOKE_SUN,
  Moo: 254.5259,
  Cer: 47.331976,
  Eri: 344.851668,
};

// The same chart measured on the installer's Astrolog 8.00 with the files it downloads
// (aloistr/swisseph master). Sun, Moon and Ceres moved by at most 0.0002 degrees; Eris moved by
// 0.0012, past SMOKE_TOLERANCE, because the installed s136199s.se1 is a different file from the
// one measured on 7.80 (17694 bytes there, 14514 here). The other 8.00 values are measured, not copied.
export const SMOKE_REFERENCE_800: Readonly<Partial<Record<ObjectCode, number>>> = {
  Sun: 353.507748,
  Moo: 254.525911,
  Cer: 47.332084,
  Eri: 344.850516,
};

// The versions the references were measured on.
export const MEASURED_VERSIONS: readonly string[] = ["7.80", "8.00"];

// The measured version whose reference applies: 8.x and later use 8.00, 7.x use 7.80.
export function referenceVersion(version: string): "7.80" | "8.00" {
  return Number(version.split(".")[0]) >= 8 ? "8.00" : "7.80";
}

export function smokeReference(version: string): Readonly<Partial<Record<ObjectCode, number>>> {
  return referenceVersion(version) === "8.00" ? SMOKE_REFERENCE_800 : SMOKE_REFERENCE;
}

// Throws AstroError unless the pinned binary puts the smoke chart's bodies where they belong.
export async function runSmoke(binary: string, version = "7.80"): Promise<void> {
  const reference = smokeReference(version);
  if (!MEASURED_VERSIONS.includes(version)) {
    console.error(`Astrolog ${version} was not measured; using the ${referenceVersion(version)} reference values`);
  }
  const codes = Object.keys(reference) as ObjectCode[];
  const values = await runExpressions({
    binary,
    chartArgs: SMOKE_CHART,
    houseSystem: "placidus",
    ayanamsa: "tropical",
    codes,
    expressions: codes.map((code) => `ObjLon O_${code}`),
  });
  codes.forEach((code, i) => {
    const got = values[i];
    const want = reference[code] as number;
    if (got === undefined || Math.abs(got - want) > SMOKE_TOLERANCE) {
      throw new AstroError(
        `the smoke chart put ${code} at ${got} degrees, expected ${want} within ${SMOKE_TOLERANCE}`,
        `ASTROLOG_BIN does not calculate like astrolog ${version} with its ephemeris; reinstall astrolog and its ephem directory.`,
      );
    }
  });
}
