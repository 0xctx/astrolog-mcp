import { describe, expect, it } from "vitest";
import { AstroError, AYANAMSAS, type Ayanamsa } from "../types.js";
import { SIDEREAL_NAMES, zodiacArgs } from "./zodiac.js";

describe("zodiacArgs", () => {
  it("gives the tropical _s pin for tropical", () => {
    expect(zodiacArgs("tropical")).toEqual(["_s"]);
  });

  it("refuses a value with no astrolog name, with a fix line that lists the values", () => {
    for (const value of [undefined, "vedic", "constructor"]) {
      expect(() => zodiacArgs(value as unknown as Ayanamsa), String(value)).toThrow(AstroError);
    }
    try {
      zodiacArgs("vedic" as Ayanamsa);
    } catch (error) {
      expect((error as AstroError).fix).toBe(`Use one of ${AYANAMSAS.join(", ")}.`);
    }
  });

  it("gives _s, then -s and the astrolog name, for each sidereal value", () => {
    expect(zodiacArgs("lahiri")).toEqual(["_s", "-s", "Lahiri"]);
    expect(zodiacArgs("fagan_bradley")).toEqual(["_s", "-s", "Fagan-Bradley"]);
    expect(zodiacArgs("raman")).toEqual(["_s", "-s", "Raman"]);
    expect(zodiacArgs("krishnamurti")).toEqual(["_s", "-s", "Krishnamurti"]);
  });
});

describe("SIDEREAL_NAMES", () => {
  it("has one name for every sidereal value, and no name for tropical", () => {
    const sidereal = AYANAMSAS.filter((name): name is Exclude<Ayanamsa, "tropical"> => name !== "tropical");
    expect(Object.keys(SIDEREAL_NAMES).sort()).toEqual([...sidereal].sort());
  });

  it("gives names that astrolog's -s can take: a word, not a number or a switch", () => {
    for (const name of Object.values(SIDEREAL_NAMES)) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z-]*$/);
    }
  });
});
