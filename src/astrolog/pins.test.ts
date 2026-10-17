import { describe, expect, it } from "vitest";
import { ASTROLOG_NAME, houseNumber } from "../objects.js";
import { HOUSE_SYSTEMS, OBJECT_CODES, type HouseSystem } from "../types.js";
import { NEUTRAL_PINS, pinArgs } from "./pins.js";

describe("pins", () => {
  it("lists every object code after -R0", () => {
    const args = pinArgs("placidus", OBJECT_CODES, "/opt/astrolog/ephem", "tropical");
    const after = args.slice(args.indexOf("-R0") + 1);
    for (const code of OBJECT_CODES) {
      expect(after).toContain(ASTROLOG_NAME[code]);
    }
    expect(after).toHaveLength(OBJECT_CODES.length);
    expect(OBJECT_CODES).toHaveLength(20);
  });

  it("maps each house name to its -c number", () => {
    const expected: Record<HouseSystem, number> = {
      placidus: 0,
      koch: 1,
      equal: 2,
      campanus: 3,
      regiomontanus: 5,
      porphyry: 6,
      whole_sign: 14,
    };
    for (const name of Object.keys(HOUSE_SYSTEMS) as HouseSystem[]) {
      const args = pinArgs(name, ["Sun"], "/opt/astrolog/ephem", "tropical");
      expect(args[args.indexOf("-c") + 1]).toBe(String(expected[name]));
      expect(houseNumber(name)).toBe(expected[name]);
    }
  });

  it("always carries the neutral pins, tropical zodiac and the mean node", () => {
    const args = pinArgs("koch", ["Sun"], "/opt/astrolog/ephem", "tropical");
    expect(args.slice(0, NEUTRAL_PINS.length)).toEqual([...NEUTRAL_PINS]);
    expect(args).toContain("_s");
    expect(args).toContain("_Yn");
  });

  it("keeps the tropical argv byte for byte: the same switches, in the same order, as before ayanamsa", () => {
    const args = pinArgs("placidus", ["Sun"], "/opt/astrolog/ephem", "tropical");
    expect(args.slice(NEUTRAL_PINS.length)).toEqual(["_s", "-c", "0", "_Yn", "-Yi1", "/opt/astrolog/ephem", "-R0", "Sun"]);
    expect(pinArgs("placidus", ["Sun"], "/opt/astrolog/ephem", "tropical")).toEqual(args);
  });

  it("puts _s then -s and the astrolog name in the zodiac place for a sidereal value", () => {
    const args = pinArgs("placidus", ["Sun"], "/opt/astrolog/ephem", "lahiri");
    expect(args.slice(NEUTRAL_PINS.length)).toEqual(["_s", "-s", "Lahiri", "-c", "0", "_Yn", "-Yi1", "/opt/astrolog/ephem", "-R0", "Sun"]);
  });
});
