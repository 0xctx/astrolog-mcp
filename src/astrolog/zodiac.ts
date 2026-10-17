import { AstroError, AYANAMSAS, type Ayanamsa, type SiderealAyanamsa } from "../types.js";

// Astrolog's name for each sidereal ayanamsa, as its `-s` switch takes it. Each name was measured
// on the pinned binary, as is the Sun's shift from tropical. Astrolog's `-s` also
// takes a number, but a number is not an ayanamsa (`-s 23.85` moves the Sun by 0.76 degrees), so
// only names are listed. The `Record` makes a value with no name a type error.
export const SIDEREAL_NAMES: Record<SiderealAyanamsa, string> = {
  lahiri: "Lahiri",
  fagan_bradley: "Fagan-Bradley",
  raman: "Raman",
  krishnamurti: "Krishnamurti",
};

// The zodiac switch for one call. Tropical is the `_s` pin every call carried before, so its argv
// is unchanged. A sidereal value is `_s` then `-s <name>`. The `_s` is needed: measured, a user's
// astrolog.as with `=s` makes a bare `-s <name>` toggle sidereal off (the Sun comes back tropical),
// while `_s -s <name>` gives the named ayanamsa whatever the settings file says. A value with no
// name is refused here, so no run is made in a zodiac nobody measured.
export function zodiacArgs(ayanamsa: Ayanamsa): string[] {
  if (ayanamsa === "tropical") {
    return ["_s"];
  }
  const name = Object.hasOwn(SIDEREAL_NAMES, ayanamsa) ? SIDEREAL_NAMES[ayanamsa] : undefined;
  if (name === undefined) {
    throw new AstroError(
      `ayanamsa ${String(ayanamsa)} has no astrolog name`,
      `Use one of ${AYANAMSAS.join(", ")}.`,
    );
  }
  return ["_s", "-s", name];
}
