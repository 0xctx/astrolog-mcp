import {
  AstroError,
  DEFAULT_HOUSE_SYSTEM,
  HOUSE_NUMBERS,
  OBJECT_CODES,
  validateChartInput,
  validateCompositeInput,
  validateSkyInput,
  type Ayanamsa,
  type Body,
  type ChartInput,
  type CompositeInput,
  type CompositePositions,
  type CompositeProvenance,
  type Engine,
  type HouseNumber,
  type HouseSystem,
  type ObjectCode,
  type Positions,
  type Provenance,
  type SkyBody,
  type SkyInput,
  type SkyPositions,
  type UtcMoment,
} from "./types.js";

// Fixed placeholder positions for tests and for ENGINE=stub. They are not astrolog output and not an ephemeris: nothing may present them as data.
// The stub ignores the birth moment and the place, returns the same values on every call, and
// honours `bodies`, `houseSystem` (only whole_sign changes the cusps) and the input validators.
// A composite reads only its own houseSystem and bodies; a and b contribute their moments to the
// provenance, and a davison takes the midpoint of those two moments.
const STUB_ASTROLOG_VERSION = "stub (no astrolog run)";

// Longitude in degrees and speed in degrees per day. Placeholder values, not measured motion.
const FIXED_BODIES: Record<ObjectCode, { longitude: number; speed: number }> = {
  Sun: { longitude: 0, speed: 0.99 },
  Moo: { longitude: 18, speed: 13.2 },
  Mer: { longitude: 36, speed: -1.2 },
  Ven: { longitude: 54, speed: 1.2 },
  Mar: { longitude: 72, speed: 0.5 },
  Jup: { longitude: 90, speed: 0.2 },
  Sat: { longitude: 108, speed: 0.1 },
  Ura: { longitude: 126, speed: 0.05 },
  Nep: { longitude: 144, speed: 0.02 },
  Plu: { longitude: 162, speed: -0.01 },
  Chi: { longitude: 180, speed: 0.03 },
  Nor: { longitude: 198, speed: -0.05 },
  Cer: { longitude: 216, speed: 0.2 },
  Pal: { longitude: 234, speed: 0.2 },
  Jun: { longitude: 252, speed: 0.3 },
  Ves: { longitude: 270, speed: 0.2 },
  Eri: { longitude: 288, speed: 0.2 },
  Hau: { longitude: 306, speed: 0.1 },
  Mak: { longitude: 324, speed: 0.05 },
  Sed: { longitude: 342, speed: 0.1 },
};

// Cusps step by 30 degrees from 15. Every system except whole_sign uses these.
const FIXED_HOUSES: Record<HouseNumber, number> = {
  1: 15,
  2: 45,
  3: 75,
  4: 105,
  5: 135,
  6: 165,
  7: 195,
  8: 225,
  9: 255,
  10: 285,
  11: 315,
  12: 345,
};

// whole_sign: each cusp is 0 degrees of a sign, so cusp 1 is 0 and the cusps step by 30.
const WHOLE_SIGN_HOUSES: Record<HouseNumber, number> = {
  1: 0,
  2: 30,
  3: 60,
  4: 90,
  5: 120,
  6: 150,
  7: 180,
  8: 210,
  9: 240,
  10: 270,
  11: 300,
  12: 330,
};

// The ASC and MC are the true angles, so they stay the same under whole_sign.
const FIXED_ANGLES: Positions["angles"] = {
  ASC: 15,
  MC: 285,
  DSC: 195,
  IC: 105,
};

// The house whose cusp interval holds the longitude, wrapping past 360. Fills the stub's
// fixed houses only; the real engine takes ObjHouse from astrolog.
function houseOf(longitude: number, cusps: Record<HouseNumber, number>): HouseNumber {
  const house = HOUSE_NUMBERS.find((n) => {
    const start = cusps[n];
    const end = cusps[((n % 12) + 1) as HouseNumber];
    const wraps = start > end;
    return wraps ? longitude >= start || longitude < end : longitude >= start && longitude < end;
  });
  if (house === undefined) {
    throw new AstroError("no house holds the longitude", "The fixed cusps must cover the circle.");
  }
  return house;
}

// A fresh copy each call, so a caller that edits a result cannot change the stub's table.
function skyBody(code: ObjectCode): SkyBody {
  const { longitude, speed } = FIXED_BODIES[code];
  return { longitude, speed, retrograde: speed < 0 };
}

// The stub is tropical by construction: refuseSidereal has already turned away any other value.
function stubProvenance(utc: UtcMoment): Provenance {
  return { astrologVersion: STUB_ASTROLOG_VERSION, source: "stub", utc, ayanamsa: "tropical" };
}

// The stub has tropical placeholders only. A sidereal request is refused, never answered with
// tropical numbers that look like it.
function refuseSidereal(ayanamsa: Ayanamsa | undefined): void {
  if (ayanamsa !== undefined && ayanamsa !== "tropical") {
    throw new AstroError(
      `The ${ayanamsa} zodiac needs the real Astrolog engine: this server runs placeholder numbers, which are tropical only.`,
      "Use the tropical zodiac, or ask the server's operator to run the real Astrolog engine for sidereal positions.",
    );
  }
}

// The davison moment: the UT midpoint of the two birth moments, rounded to the second with half a
// second rounding up. This is date arithmetic for the stub only; a real engine reports the moment
// astrolog used.
function midpointUtc(a: UtcMoment, b: UtcMoment): UtcMoment {
  const midMs = (Date.parse(a) + Date.parse(b)) / 2;
  return new Date(Math.round(midMs / 1000) * 1000).toISOString().replace(".000Z", "Z") as UtcMoment;
}

export class StubEngine implements Engine {
  async cast(input: ChartInput): Promise<Positions> {
    validateChartInput(input);
    refuseSidereal(input.ayanamsa);
    return {
      ...chart(input.houseSystem ?? DEFAULT_HOUSE_SYSTEM, input.bodies),
      provenance: stubProvenance(input.utc),
    };
  }

  async sky(input: SkyInput): Promise<SkyPositions> {
    validateSkyInput(input);
    refuseSidereal(input.ayanamsa);
    const bodies: SkyPositions["bodies"] = {};
    for (const code of input.bodies ?? OBJECT_CODES) {
      bodies[code] = skyBody(code);
    }
    return { bodies, missing: [], provenance: stubProvenance(input.utc) };
  }

  async composite(input: CompositeInput): Promise<CompositePositions> {
    validateCompositeInput(input);
    refuseSidereal(input.ayanamsa);
    const inputUtc: [UtcMoment, UtcMoment] = [input.a.utc, input.b.utc];
    const provenance: CompositeProvenance =
      input.kind === "davison"
        ? {
            astrologVersion: STUB_ASTROLOG_VERSION,
            source: "stub",
            inputUtc,
            ayanamsa: "tropical",
            kind: "davison",
            utc: midpointUtc(input.a.utc, input.b.utc),
          }
        : { astrologVersion: STUB_ASTROLOG_VERSION, source: "stub", inputUtc, ayanamsa: "tropical", kind: "composite" };
    return { ...chart(input.houseSystem ?? DEFAULT_HOUSE_SYSTEM, input.bodies), provenance };
  }
}

function chart(
  houseSystem: HouseSystem,
  requested: ObjectCode[] | undefined,
): Omit<Positions, "provenance"> {
  const cusps = houseSystem === "whole_sign" ? WHOLE_SIGN_HOUSES : FIXED_HOUSES;
  const bodies: Positions["bodies"] = {};
  for (const code of requested ?? OBJECT_CODES) {
    const body: Body = { ...skyBody(code), house: houseOf(FIXED_BODIES[code].longitude, cusps) };
    bodies[code] = body;
  }
  return {
    bodies,
    houses: { ...cusps },
    angles: { ...FIXED_ANGLES },
    missing: [],
    housesFrom: houseSystem,
  };
}
