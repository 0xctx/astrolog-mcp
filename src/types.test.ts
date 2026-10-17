import { describe, expect, it } from "vitest";
import {
  ANGLE_CODES,
  AYANAMSAS,
  AstroError,
  COMPOSITE_KINDS,
  DEFAULT_HOUSE_SYSTEM,
  HOUSE_NUMBERS,
  HOUSE_SYSTEMS,
  OBJECT_CODES,
  validateChartInput,
  validateCompositeInput,
  validateSkyInput,
  type Ayanamsa,
  type Birth,
  type ChartInput,
  type CompositeInput,
  type CompositeKind,
  type CompositeProvenance,
  type HouseSystem,
  type ObjectCode,
  type SkyInput,
  type UtcMoment,
} from "./types.js";

const chart: ChartInput = {
  utc: "1990-06-15T19:30:00Z",
  latitude: { degrees: 40.7, hemisphere: "N" },
  longitude: { degrees: 73.9, hemisphere: "W" },
};

const birth: Birth = {
  utc: "1990-06-15T19:30:00Z",
  latitude: { degrees: 40.7, hemisphere: "N" },
  longitude: { degrees: 73.9, hemisphere: "W" },
};

const other: Birth = {
  utc: "1992-06-15T19:30:00Z",
  latitude: { degrees: 51.5, hemisphere: "N" },
  longitude: { degrees: 0.1, hemisphere: "W" },
};

// The AstroError a validator throws, so a test can check its fix line as well as its message.
function thrownBy(run: () => void): AstroError {
  try {
    run();
  } catch (error) {
    if (error instanceof AstroError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the validator to throw");
}

describe("HOUSE_SYSTEMS", () => {
  it("maps the seven house systems to their astrolog -c numbers", () => {
    expect(HOUSE_SYSTEMS).toEqual({
      placidus: 0,
      koch: 1,
      equal: 2,
      campanus: 3,
      regiomontanus: 5,
      porphyry: 6,
      whole_sign: 14,
    });
  });

  it("defaults to placidus, which is one of the systems", () => {
    const systems: HouseSystem[] = Object.keys(HOUSE_SYSTEMS) as HouseSystem[];

    expect(DEFAULT_HOUSE_SYSTEM).toBe("placidus");
    expect(systems).toContain(DEFAULT_HOUSE_SYSTEM);
  });
});

describe("OBJECT_CODES", () => {
  it("lists the twenty astrolog object codes once each", () => {
    expect(OBJECT_CODES).toEqual([
      "Sun",
      "Moo",
      "Mer",
      "Ven",
      "Mar",
      "Jup",
      "Sat",
      "Ura",
      "Nep",
      "Plu",
      "Chi",
      "Nor",
      "Cer",
      "Pal",
      "Jun",
      "Ves",
      "Eri",
      "Hau",
      "Mak",
      "Sed",
    ]);
    expect(new Set(OBJECT_CODES).size).toBe(20);
  });
});

describe("HOUSE_NUMBERS and ANGLE_CODES", () => {
  it("lists house numbers 1 to 12 and the four angles", () => {
    expect(HOUSE_NUMBERS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(ANGLE_CODES).toEqual(["ASC", "MC", "DSC", "IC"]);
  });
});

describe("COMPOSITE_KINDS", () => {
  it("lists the two composite kinds", () => {
    expect(COMPOSITE_KINDS).toEqual(["composite", "davison"]);
  });
});

describe("AstroError", () => {
  it("is an Error named AstroError that carries the fix line", () => {
    const error = new AstroError("latitude is wrong", "Give a latitude from 0 to 90.");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AstroError");
    expect(error.message).toBe("latitude is wrong");
    expect(error.fix).toBe("Give a latitude from 0 to 90.");
  });
});

describe("UtcMoment", () => {
  // The compile-time check: tsc fails this file if a local time with no Z typechecks.
  it("does not typecheck a local time with no trailing Z", () => {
    // @ts-expect-error a local time with no Z is not a UtcMoment
    const local: UtcMoment = "1990-06-15T19:30:00";

    expect(local).toBe("1990-06-15T19:30:00");
  });
});

describe("the composite input types", () => {
  // The compile-time checks: tsc fails this file if a per-person input carries a composite field.
  it("does not typecheck a houseSystem or bodies on a per-person Birth", () => {
    // @ts-expect-error a per-person input carries birth data only
    const withHouseSystem: Birth = { ...birth, houseSystem: "koch" };
    // @ts-expect-error a per-person input carries birth data only
    const withBodies: Birth = { ...birth, bodies: ["Sun"] };

    expect(withHouseSystem.utc).toBe(birth.utc);
    expect(withBodies.utc).toBe(birth.utc);
  });

  it("does not typecheck an unknown composite kind", () => {
    // @ts-expect-error the kind is composite or davison
    const kind: CompositeKind = "cusp";

    expect(kind).toBe("cusp");
  });

  it("does not typecheck a composite provenance with a utc unless it is a davison", () => {
    // @ts-expect-error a composite has no moment of its own
    const provenance: CompositeProvenance = {
      astrologVersion: "stub (no astrolog run)",
      source: "stub",
      inputUtc: [birth.utc, other.utc],
      kind: "composite",
      utc: birth.utc,
    };

    expect(provenance.kind).toBe("composite");
  });
});

describe("validateChartInput", () => {
  it("accepts a complete chart, with or without the optional fields", () => {
    expect(() => validateChartInput(chart)).not.toThrow();
    expect(() =>
      validateChartInput({
        ...chart,
        houseSystem: "whole_sign",
        bodies: ["Sun", "Moo"],
        latitude: { degrees: 0, hemisphere: "S" },
        longitude: { degrees: 180, hemisphere: "E" },
      }),
    ).not.toThrow();
  });

  it.each([
    ["a latitude below 0", { latitude: { degrees: -0.1, hemisphere: "N" as const } }],
    ["a latitude above 90", { latitude: { degrees: 90.5, hemisphere: "N" as const } }],
    ["a NaN latitude", { latitude: { degrees: Number.NaN, hemisphere: "N" as const } }],
    ["an infinite latitude", { latitude: { degrees: Number.POSITIVE_INFINITY, hemisphere: "S" as const } }],
    ["a longitude above 180", { longitude: { degrees: 180.1, hemisphere: "E" as const } }],
    ["a NaN longitude", { longitude: { degrees: Number.NaN, hemisphere: "W" as const } }],
  ])("rejects %s with a fix line", (_label, change) => {
    expect(() => validateChartInput({ ...chart, ...change })).toThrow(AstroError);
    expect(() => validateChartInput({ ...chart, ...change })).toThrow(/from 0 to/);
  });

  it("rejects a hemisphere letter that does not match the axis", () => {
    const wrongLatitude = { ...chart, latitude: { degrees: 40, hemisphere: "E" } } as unknown as ChartInput;
    const wrongLongitude = { ...chart, longitude: { degrees: 40, hemisphere: "N" } } as unknown as ChartInput;

    expect(() => validateChartInput(wrongLatitude)).toThrow(/latitude.hemisphere must be N or S/);
    expect(() => validateChartInput(wrongLongitude)).toThrow(/longitude.hemisphere must be E or W/);
  });

  it.each([
    "1990-06-15 19:30:00Z",
    "1990-06-15T19:30:00",
    "1990-06-15T19:30:00+02:00Z",
    "1990-6-15T19:30:00Z",
    "1990-02-30T00:00:00Z",
    "1990-06-15T24:00:00Z",
    "1990-06-15T19:60:00Z",
    "",
  ])("rejects the utc %j", (utc) => {
    expect(() => validateChartInput({ ...chart, utc: utc as ChartInput["utc"] })).toThrow(AstroError);
    expect(() => validateChartInput({ ...chart, utc: utc as ChartInput["utc"] })).toThrow(/UT moment/);
  });

  it("accepts a leap day in a leap year", () => {
    expect(() => validateChartInput({ ...chart, utc: "2000-02-29T00:00:00Z" })).not.toThrow();
  });

  it("rejects an unknown house system", () => {
    expect(() => validateChartInput({ ...chart, houseSystem: "geocentric" as HouseSystem })).toThrow(
      /houseSystem must be one of/,
    );
  });

  it("rejects an empty bodies list", () => {
    expect(() => validateChartInput({ ...chart, bodies: [] })).toThrow(AstroError);
    expect(() => validateChartInput({ ...chart, bodies: [] })).toThrow(/at least one object code/);
  });

  it("rejects a repeated object code", () => {
    expect(() => validateChartInput({ ...chart, bodies: ["Sun", "Moo", "Sun"] })).toThrow(AstroError);
    expect(() => validateChartInput({ ...chart, bodies: ["Sun", "Moo", "Sun"] })).toThrow(/more than once/);
  });

  it("rejects an unknown object code and names the valid ones in the fix", () => {
    const input = { ...chart, bodies: ["Pluto" as ObjectCode] };

    expect(() => validateChartInput(input)).toThrow(AstroError);
    expect(() => validateChartInput(input)).toThrow(/unknown object code "Pluto"/);
  });
});

describe("the ayanamsa on the inputs", () => {
  it("accepts every named zodiac on a chart, a sky and a composite, and none at all", () => {
    for (const ayanamsa of AYANAMSAS) {
      expect(() => validateChartInput({ ...chart, ayanamsa })).not.toThrow();
      expect(() => validateSkyInput({ utc: chart.utc, ayanamsa })).not.toThrow();
      expect(() => validateCompositeInput({ a: birth, b: other, kind: "composite", ayanamsa })).not.toThrow();
    }
    expect(() => validateChartInput(chart)).not.toThrow();
  });

  it("rejects an unknown zodiac with a fix line that lists the names", () => {
    const error = thrownBy(() => validateChartInput({ ...chart, ayanamsa: "vedic" as Ayanamsa }));
    expect(error.message).toBe('input.ayanamsa must be one of tropical, lahiri, fagan_bradley, raman, krishnamurti, got "vedic"');
    expect(error.fix).toBe("Use one of tropical, lahiri, fagan_bradley, raman, krishnamurti, or omit input.ayanamsa for tropical.");
    expect(() => validateSkyInput({ utc: chart.utc, ayanamsa: 23.85 as unknown as Ayanamsa })).toThrow(/ayanamsa must be one of/);
  });

  it("refuses an ayanamsa on a person, because only the composite takes one", () => {
    const onA = { a: { ...birth, ayanamsa: "lahiri" } as Birth, b: other, kind: "composite" as const };
    expect(() => validateCompositeInput(onA)).toThrow(/a sets ayanamsa, which only the composite takes/);
    expect(thrownBy(() => validateCompositeInput(onA)).fix).toMatch(/composite input/);
  });
});

describe("validateSkyInput", () => {
  const sky: SkyInput = { utc: "1990-06-15T19:30:00Z" };

  it("accepts a moment with or without bodies", () => {
    expect(() => validateSkyInput(sky)).not.toThrow();
    expect(() => validateSkyInput({ ...sky, bodies: ["Mer"] })).not.toThrow();
  });

  it("rejects a utc with no Z", () => {
    expect(() => validateSkyInput({ utc: "1990-06-15T19:30:00" as SkyInput["utc"] })).toThrow(AstroError);
  });

  it("rejects an empty or repeated bodies list and an unknown code", () => {
    expect(() => validateSkyInput({ ...sky, bodies: [] })).toThrow(/at least one object code/);
    expect(() => validateSkyInput({ ...sky, bodies: ["Mer", "Mer"] })).toThrow(/more than once/);
    expect(() => validateSkyInput({ ...sky, bodies: ["Xyz" as ObjectCode] })).toThrow(/unknown object code/);
  });
});

describe("validateCompositeInput", () => {
  const valid: CompositeInput = { a: birth, b: other, kind: "composite" };

  it("accepts a composite and a davison, with or without the composite's own fields", () => {
    expect(() => validateCompositeInput(valid)).not.toThrow();
    expect(() =>
      validateCompositeInput({ ...valid, kind: "davison", houseSystem: "whole_sign", bodies: ["Sun"] }),
    ).not.toThrow();
  });

  it("rejects an unknown kind with an AstroError and a fix line", () => {
    const error = thrownBy(() => validateCompositeInput({ ...valid, kind: "cusp" as CompositeKind }));

    expect(error.message).toBe('kind must be "composite" or "davison", got "cusp"');
    expect(error.fix).toMatch(/-rc.*-rm/);
  });

  it("rejects a houseSystem or bodies on a person, and names the composite as the place for them", () => {
    const onA = { ...valid, a: { ...birth, houseSystem: "koch" } as Birth };
    const onB = { ...valid, b: { ...other, bodies: ["Sun"] } as Birth };

    expect(() => validateCompositeInput(onA)).toThrow(/a sets houseSystem or bodies/);
    expect(() => validateCompositeInput(onB)).toThrow(/b sets houseSystem or bodies/);
    expect(thrownBy(() => validateCompositeInput(onA)).fix).toMatch(/composite input/);
  });

  it("validates a and b as birth data, with the name in each message", () => {
    const badB = { ...valid, b: { ...other, latitude: { degrees: 91, hemisphere: "N" as const } } };

    expect(() => validateCompositeInput(badB)).toThrow(/b.latitude.degrees must be a number from 0 to 90/);
  });

  it("validates the composite's own houseSystem and bodies", () => {
    expect(() => validateCompositeInput({ ...valid, houseSystem: "geocentric" as HouseSystem })).toThrow(
      /input.houseSystem must be one of/,
    );
    expect(() => validateCompositeInput({ ...valid, bodies: [] })).toThrow(/input.bodies must name at least one/);
  });
});

describe("validators on a missing or non-object field", () => {
  // A real engine calls these first, so a missing field is an AstroError and never a TypeError.
  it.each([
    [
      "the whole chart input",
      () => validateChartInput(undefined as unknown as ChartInput),
      /input must be an object, got undefined/,
    ],
    [
      "a missing latitude",
      () => validateChartInput({ ...chart, latitude: undefined } as unknown as ChartInput),
      /input.latitude must be an object, got undefined/,
    ],
    [
      "a null longitude",
      () => validateChartInput({ ...chart, longitude: null } as unknown as ChartInput),
      /input.longitude must be an object, got null/,
    ],
    [
      "a missing sky utc",
      () => validateSkyInput({} as unknown as SkyInput),
      /input.utc must be a real UT moment/,
    ],
    [
      "a bodies that is a string, not a list",
      () => validateSkyInput({ ...chart, bodies: "Sun" } as unknown as SkyInput),
      /input.bodies must be a list of object codes, got "Sun"/,
    ],
    [
      "a missing composite a",
      () => validateCompositeInput({ b: other, kind: "composite" } as unknown as CompositeInput),
      /a must be an object, got undefined/,
    ],
    [
      "a missing composite kind",
      () => validateCompositeInput({ a: birth, b: other } as unknown as CompositeInput),
      /kind must be "composite" or "davison", got undefined/,
    ],
  ])("throws AstroError, not TypeError, for %s", (_label, run, message) => {
    expect(run).toThrow(AstroError);
    expect(run).toThrow(message);
  });
});
