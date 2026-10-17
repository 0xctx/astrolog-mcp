import { houseNumber, ASTROLOG_NAME } from "../objects.js";
import { type Ayanamsa, type HouseSystem, type ObjectCode } from "../types.js";
import { zodiacArgs } from "./zodiac.js";

// Settings a user's astrolog.as could switch on that would change positions. Every astrolog call
// carries these, forced to the neutral value. Ported from the Python reference's NEUTRAL_PINS.
export const NEUTRAL_PINS: readonly string[] = [
  "=b", // use ephemeris files when present
  "_YT",
  "_YV",
  "_h",
  "_sr",
  "_Yh", // apparent, geocentric, ecliptic longitudes
  "_p",
  "_1",
  "-Ys",
  "0", // zero the -Ys zodiac offset (a bare `_Ys` leaves a `-Ys 1` offset of +1 degree in place) ...
  "_Ys", // ... then switch the invariable-plane option off; measured: Sun 84.229045 after `-Ys 1`
  "_c3", // no progression, no solar chart, no alt. sidereal, 2D houses
  "-x",
  "1", // no harmonic chart
  "-Yz",
  "0",
  "-YzO",
  "0",
  "-YzC",
  "0", // no time or position offsets
  "-YQ",
  "0", // no text scroll limit: with the default 24 lines a settings file without -YQ cuts the output
];

// The full pinned switch list for one call: neutral pins, the zodiac (tropical or a sidereal
// ayanamsa, always passed), the house system, the mean lunar node (`_Yn`; `=Yn` would be the true
// node), and the objects to compute. `-R0` restricts everything first, so only the listed objects
// exist for the run.
export function pinArgs(
  houseSystem: HouseSystem,
  codes: readonly ObjectCode[],
  ephemDir: string,
  ayanamsa: Ayanamsa,
): string[] {
  return [
    ...NEUTRAL_PINS,
    ...zodiacArgs(ayanamsa),
    "-c",
    String(houseNumber(houseSystem)),
    "_Yn",
    "-Yi1", // ephemeris directory, so an astrolog.as cannot point elsewhere or turn files off
    ephemDir,
    "-R0",
    ...codes.map((code) => ASTROLOG_NAME[code]),
  ];
}
