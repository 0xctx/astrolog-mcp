import { describe, expect, it } from "vitest";
import {
  chartPoints,
  harmonicPositions,
  harmonicSky,
  MAX_DAY_HARMONIC,
  midpoint,
  midpointLimit,
  midpointSet,
  VIBRATIONAL_ASPECTS,
  VIBRATIONAL_MIDPOINT_ORB,
  VIBRATIONAL_ORB_RULE,
  dailyScore,
  maxDayHarmonic,
  quadraticRoots,
  readDay,
  readPairings,
  shownScore,
  vibrationalTransitLimit,
  type DayReadingInput,
} from "./math.js";
import { HOUSE_NUMBERS, type ObjectCode, type Positions, type SkyBody, type SkyPositions } from "./types.js";

// Hand-built charts and samples. Only the longitudes, speeds and cusps matter to readDay; `source: "stub"` says that nothing
// here is astrolog output.
const PROVENANCE = { astrologVersion: "hand-computed test fixture", source: "stub" as const, utc: "2026-10-14T00:00:00Z" as const, ayanamsa: "tropical" as const };

// Cusps 30 degrees apart from 0, so house n starts at 30(n-1) degrees.
const CUSPS = Object.fromEntries(HOUSE_NUMBERS.map((n) => [n, (n - 1) * 30])) as Positions["houses"];

function natal(longitudes: Partial<Record<ObjectCode, number>>): Positions {
  const bodies: Positions["bodies"] = {};
  for (const [code, longitude] of Object.entries(longitudes) as Array<[ObjectCode, number]>) {
    bodies[code] = { longitude, speed: 1, retrograde: false, house: 1 };
  }
  return {
    bodies,
    houses: CUSPS,
    angles: { ASC: 15, MC: 285, DSC: 195, IC: 105 },
    missing: [],
    housesFrom: "placidus",
    provenance: PROVENANCE,
  };
}

// A sky moment: each body's longitude and speed. A speed is given as a pair, so the retrograde flag can be set too.
function skyOf(bodies: Partial<Record<ObjectCode, [number, number]>>): SkyPositions {
  const out: Partial<Record<ObjectCode, SkyBody>> = {};
  for (const [code, [longitude, speed]] of Object.entries(bodies) as Array<[ObjectCode, [number, number]]>) {
    out[code] = { longitude, speed, retrograde: speed < 0 };
  }
  return { bodies: out, missing: [], provenance: PROVENANCE };
}

// The input for one day: three samples at local midnight, the middle and the next midnight, with the middle at half the day.
function day(natalChart: Positions, samples: [SkyPositions, SkyPositions, SkyPositions], minScore = 0): DayReadingInput {
  return { natal: natalChart, sky: samples, middle: 0.5, aspects: VIBRATIONAL_ASPECTS, minScore };
}

describe("quadraticRoots", () => {
  it("finds the roots of a quadratic inside the interval, ascending", () => {
    // (x - 0.25)(x - 0.75) = x² - x + 0.1875
    expect(quadraticRoots({ a: 1, b: -1, c: 0.1875 }, 0, 1)).toEqual([0.25, 0.75].map((x) => expect.closeTo(x, 9)));
  });

  it("drops roots outside the interval and reports none when the discriminant is negative", () => {
    expect(quadraticRoots({ a: 1, b: 0, c: 4 }, 0, 1)).toEqual([]);
    expect(quadraticRoots({ a: 1, b: -3, c: 2 }, 0, 1.5)).toEqual([expect.closeTo(1, 9)]);
  });

  it("reports the start for a quadratic that is zero throughout, so an identically exact aspect is exact from the start", () => {
    expect(quadraticRoots({ a: 0, b: 0, c: 0 }, 0, 1)).toEqual([0]);
    expect(quadraticRoots({ a: 0, b: 0, c: 3 }, 0, 1)).toEqual([]);
  });
});

describe("dailyScore", () => {
  it("is 1 at exact for an outer body hitting a key point, and falls with the orb", () => {
    expect(dailyScore(0, 2, true, true)).toBe(1);
    expect(dailyScore(0, 2, false, false)).toBeCloseTo(2 / 3, 12);
    expect(dailyScore(0, 2, true, false)).toBeCloseTo(1.25 / 1.5, 12);
    expect(dailyScore(1, 2, false, false)).toBeCloseTo(1 / 3, 12);
  });
});

describe("readDay: aspect hits", () => {
  it("times an exact aspect by interpolation between the samples", () => {
    // The Sun moves one degree a day and crosses the natal Sun at 100 halfway through the day.
    const reading = readDay(
      day(natal({ Sun: 100 }), [skyOf({ Sun: [99.5, 1] }), skyOf({ Sun: [100, 1] }), skyOf({ Sun: [100.5, 1] })]),
    );
    const hit = reading.hits.find((h) => h.pairing === "T to N" && h.moving === "Sun" && h.still === "Sun" && h.aspect === "conjunction");

    expect(hit).toMatchObject({ orb: 0, phase: "applying" });
    expect(hit?.exact).toBeCloseTo(0.5, 9);
  });

  it("reports no exact time when the aspect is only within its orb at the end of the day", () => {
    // The transit Sun is 1.5 degrees short of the natal Sun at the next midnight: inside the 2 degree orb, not exact today.
    const reading = readDay(
      day(natal({ Sun: 100 }), [skyOf({ Sun: [97.5, 1] }), skyOf({ Sun: [98, 1] }), skyOf({ Sun: [98.5, 1] })]),
    );
    const hit = reading.hits.find((h) => h.pairing === "T to N" && h.moving === "Sun" && h.still === "Sun" && h.aspect === "conjunction");

    expect(hit).toMatchObject({ phase: "applying", exact: undefined });
    expect(hit?.orb).toBeCloseTo(1.5, 9);
    expect(hit?.score).toBeCloseTo(((1 - 1.5 / 2) * 1.25) / 1.5, 9);
  });

  it("keeps a midpoint's classic path through the 180 degree jump, so it is exact on each side of the jump", () => {
    // The Sun stands still at 0. The Moon runs from 170 to 210, so the midpoint of the two swings from 85 to 285: it jumps
    // at the moment the two are exactly opposite. The midpoint is 88 at x = 0.15 and 280 at x = 0.75.
    const reading = readDay(
      day(natal({ Sun: 280, Mer: 88 }), [
        skyOf({ Sun: [0, 1], Moo: [170, 13] }),
        skyOf({ Sun: [0, 1], Moo: [190, 13] }),
        skyOf({ Sun: [0, 1], Moo: [210, 13] }),
      ]),
    );
    const exactAt = (still: string) =>
      reading.hits.find((h) => h.pairing === "Tm to N" && h.moving === "Sun/Moo" && h.still === still && h.aspect === "conjunction")?.exact;

    expect(exactAt("Mer")).toBeCloseTo(0.15, 9);
    expect(exactAt("Sun")).toBeCloseTo(0.75, 9);
  });

  it("ranks hits by score and keeps only those at or above min_score", () => {
    // The Sun is exact to the natal Sun; the Moon stands 1.5 degrees off it, a loose hit of score about 0.21.
    const samples: [SkyPositions, SkyPositions, SkyPositions] = [
      skyOf({ Sun: [99.5, 1], Moo: [101.5, 0] }),
      skyOf({ Sun: [100, 1], Moo: [101.5, 0] }),
      skyOf({ Sun: [100.5, 1], Moo: [101.5, 0] }),
    ];
    const all = readDay(day(natal({ Sun: 100 }), samples));
    const strong = readDay(day(natal({ Sun: 100 }), samples, 0.5));

    expect(all.hits.length).toBeGreaterThan(strong.hits.length);
    expect(strong.hits.every((h) => h.score >= 0.5)).toBe(true);
    for (let i = 1; i < all.hits.length; i++) {
      expect(all.hits[i - 1]!.score).toBeGreaterThanOrEqual(all.hits[i]!.score);
    }
  });

  it("names the phase of a hit by where its least orb falls: applying at a turn inside the day, separating from the start", () => {
    // The Sun turns at 100.5 halfway through the day: its least orb to the natal Sun is 0.5 there, so it applies into it.
    const turning = readDay(
      day(natal({ Sun: 100 }), [skyOf({ Sun: [101, 1] }), skyOf({ Sun: [100.5, 1] }), skyOf({ Sun: [101, 1] })]),
    );
    expect(turning.hits.find((h) => h.moving === "Sun" && h.still === "Sun" && h.aspect === "conjunction")).toMatchObject({
      orb: 0.5,
      phase: "applying",
    });

    // The Sun leaves the natal Sun from its start: the least orb is at the start, so the orb grows and the hit separates.
    const leaving = readDay(day(natal({ Sun: 100 }), [skyOf({ Sun: [100.5, 1] }), skyOf({ Sun: [101, 1] }), skyOf({ Sun: [101.5, 1] })]));
    expect(leaving.hits.find((h) => h.moving === "Sun" && h.still === "Sun" && h.aspect === "conjunction")).toMatchObject({
      orb: 0.5,
      phase: "separating",
    });
  });

  it("lists stations in time order, not by body", () => {
    // Venus turns retrograde at 0.19 of the day; Mercury turns direct at 0.81. Mercury comes first in the object-code order.
    const reading = readDay(
      day(natal({ Sun: 0 }), [skyOf({ Mer: [50, -1], Ven: [50, 1] }), skyOf({ Mer: [50, -1], Ven: [50, -1] }), skyOf({ Mer: [50, 1], Ven: [50, -1] })]),
    );

    expect(reading.stations.map((s) => [s.body, s.to])).toEqual([
      ["Ven", "retrograde"],
      ["Mer", "direct"],
    ]);
    expect(reading.stations[0]!.at).toBeLessThan(reading.stations[1]!.at);
  });
});

describe("readDay at the harmonic limit", () => {
  // Raw longitudes move 10.5 degrees between samples half a day apart, which is 21 degrees a day. A midpoint of two bodies that
  // part by that much gains 10.5 per half day. At harmonic 17 the step is 178.5 degrees, under half a turn; at harmonic 18 it
  // is 189, which reads as a backward step.
  const step = 10.5;
  const raw: SkyPositions[] = [0, 1, 2].map((k) => skyOf({ Mer: [k * step, 21] }));
  // The conjunction of Mercury to a natal Sun at harmonic longitude 100, read in the given harmonic. The natal Sun is given raw,
  // as 100 ÷ harmonic, so the harmonic chart puts it at 100.
  const conjunctionAt = (harmonic: number): number | undefined => {
    const samples = raw.map((s) => harmonicSky(s, harmonic)) as [SkyPositions, SkyPositions, SkyPositions];
    const reading = readDay({
      natal: harmonicPositions(natal({ Sun: 100 / harmonic }), harmonic),
      sky: samples,
      middle: 0.5,
      aspects: VIBRATIONAL_ASPECTS,
      minScore: 0,
    });
    return reading.hits.find((h) => h.moving === "Mer" && h.still === "Sun" && h.aspect === "conjunction")?.exact;
  };

  it("reads the same step correctly at the largest harmonic of a 25-hour day and misreads it one harmonic above", () => {
    // The Mercury conjunction to harmonic 100 comes at 100 ÷ (21 × H) of the day: 0.2801 at 17. At 18 the step is over half a
    // turn, so the reading takes Mercury for a body moving backwards, and its exact time is 0.7602, not 0.2646.
    expect(maxDayHarmonic(25)).toBe(17);
    expect(conjunctionAt(17)).toBeCloseTo(100 / (21 * 17), 6);
    expect(conjunctionAt(18)).toBeCloseTo(0.7602, 3);
  });

  it("gives each day's cap as 432 divided by its hours, rounded down, and the largest of any day as 19", () => {
    // Two samples half a day apart, 20 degrees a day: 22 hours allows 19, 24 allows 18, 25 allows 17 and 26 allows 16.
    expect([22, 24, 25, 26].map((hours) => maxDayHarmonic(hours))).toEqual([19, 18, 17, 16]);
    expect(MAX_DAY_HARMONIC).toBe(19);
  });
});

// A deterministic pseudo-random number from 0 up to 1, so a failing case can be rerun.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe("readDay against a minute-by-minute reading", () => {
  it.each([1, 2, 3, 4, 5])("finds the same pairs as readPairings read at every minute of the same interpolated day (seed %i)", (seed) => {
    const next = random(seed);
    const codes: ObjectCode[] = ["Sun", "Moo", "Mer", "Jup"];
    const natalBodies: Partial<Record<ObjectCode, number>> = { Sun: next() * 360, Moo: next() * 360, Ven: next() * 360 };
    const chart = natal(natalBodies);
    // Each body: three sample longitudes that move by a few degrees, as a real day does, and its speed.
    const track = Object.fromEntries(
      codes.map((code) => {
        const start = next() * 360;
        const rate = code === "Moo" ? 13 : 0.2 + next() * 2;
        return [code, [start, start + rate / 2 + next() * 3, start + rate + next() * 6]];
      }),
    ) as Record<ObjectCode, number[]>;
    const samples = [0, 1, 2].map((k) =>
      skyOf(Object.fromEntries(codes.map((code) => [code, [track[code]![k]! % 360, 1]]))),
    ) as [SkyPositions, SkyPositions, SkyPositions];
    const middle = 0.5;
    const daily = readDay(day(chart, samples));
    const dailyPairs = new Set(daily.hits.map((h) => `${h.pairing}|${h.moving}|${h.still}`));

    // The same model at every minute: each body's quadratic through its three samples, read by readPairings.
    const truth = new Set<string>();
    for (let minute = 0; minute <= 1440; minute++) {
      const x = minute / 1440;
      const sky = skyOf(
        Object.fromEntries(
          codes.map((code) => {
            const values = track[code]!;
            const unwrapped = [values[0]!, values[0]! + wrapped(values[1]! - values[0]!), values[0]! + wrapped(values[1]! - values[0]!) + wrapped(values[2]! - values[1]!)];
            const q = quadratic3(unwrapped, [0, middle, 1]);
            return [code, [((q.c + x * (q.b + q.a * x)) % 360 + 360) % 360, 1]];
          }),
        ),
      );
      for (const [label, hits] of Object.entries(readPairings(sky, chart, { aspects: VIBRATIONAL_ASPECTS, orb: VIBRATIONAL_ORB_RULE, minStrength: 0 }))) {
        for (const hit of hits) {
          truth.add(`${label}|${hit.moving}|${hit.still}`);
        }
      }
    }

    expect(truth.size).toBeGreaterThan(20);
    expect([...dailyPairs].sort()).toEqual([...truth].sort());
  });
});

// Local helpers for the brute-force reading: an unwrapped step, and the quadratic through three values.
function wrapped(x: number): number {
  const r = ((x % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

function quadratic3(ys: number[], xs: number[]): { a: number; b: number; c: number } {
  const [x0, x1, x2] = xs as [number, number, number];
  const [y0, y1, y2] = ys as [number, number, number];
  const s01 = (y1 - y0) / (x1 - x0);
  const s12 = (y2 - y1) / (x2 - x1);
  const a = (s12 - s01) / (x2 - x0);
  const b = s01 - a * (x0 + x1);
  return { a, b, c: y0 - b * x0 - a * x0 * x0 };
}

describe("readDay: ingresses and stations", () => {
  it("times the Moon's sign change and its house change at the same moment", () => {
    // The Moon moves from 29 to 42 degrees: it crosses 30, the start of Taurus and of natal house 2, at x = 1/13.
    const reading = readDay(
      day(natal({ Sun: 0 }), [skyOf({ Moo: [29, 13] }), skyOf({ Moo: [35.5, 13] }), skyOf({ Moo: [42, 13] })]),
    );

    expect(reading.ingresses).toContainEqual({ body: "Moo", change: "sign", from: 0, to: 1, at: expect.closeTo(1 / 13, 9) });
    expect(reading.ingresses).toContainEqual({ body: "Moo", change: "house", from: 1, to: 2, at: expect.closeTo(1 / 13, 9) });
  });

  it("reports a retrograde change at the moment the speed crosses zero", () => {
    // Speeds of +1, -1, -1 degrees a day: the speed is zero at x = (6 - sqrt(20)) / 8, about 0.19.
    const reading = readDay(
      day(natal({ Sun: 0 }), [skyOf({ Mer: [50, 1] }), skyOf({ Mer: [50, -1] }), skyOf({ Mer: [50, -1] })]),
    );

    expect(reading.stations).toEqual([{ body: "Mer", to: "retrograde", at: expect.closeTo((6 - Math.sqrt(20)) / 8, 6) }]);
  });

  it("reports a body that crosses a sign boundary once, and no sign change for a body that stands still", () => {
    const reading = readDay(
      day(natal({ Sun: 0 }), [skyOf({ Sun: [5, 1], Moo: [170, 13] }), skyOf({ Sun: [5, 1], Moo: [190, 13] }), skyOf({ Sun: [5, 1], Moo: [210, 13] })]),
    );

    expect(reading.ingresses.filter((i) => i.change === "sign")).toEqual([
      { body: "Moo", change: "sign", from: 5, to: 6, at: expect.closeTo(0.25, 9) },
    ]);
  });

  it("names every body the engine did not compute in any call", () => {
    const withMissing = { ...skyOf({ Sun: [0, 1] }), missing: ["Cer" as ObjectCode] };
    const reading = readDay(day({ ...natal({ Sun: 0 }), missing: ["Eri" as ObjectCode] }, [withMissing, withMissing, withMissing]));

    expect(reading.missing).toEqual(["Cer", "Eri"]);
  });
});

describe("readDay: every aspect of a pair, once each", () => {
  it("reports both aspects a Moon-like path crosses against one natal point, each with its own exact time", () => {
    // The Moon runs from 290 to 430 degrees over the day, past the natal Sun at 0. It is exact to the conjunction at half the day
    // (360), and to the sextile at 300 (1/14 of the day) and again at 420 (13/14). The sextile reports its earlier moment.
    const reading = readDay(
      day(natal({ Sun: 0 }), [skyOf({ Moo: [290, 140] }), skyOf({ Moo: [360, 140] }), skyOf({ Moo: [430, 140] })]),
    );
    const sunHits = reading.hits.filter((h) => h.pairing === "T to N" && h.moving === "Moo" && h.still === "Sun");
    const aspects = sunHits.map((h) => h.aspect);

    expect(new Set(aspects).size).toBe(aspects.length);
    expect(sunHits.find((h) => h.aspect === "conjunction")).toMatchObject({ orb: 0, phase: "applying" });
    expect(sunHits.find((h) => h.aspect === "conjunction")?.exact).toBeCloseTo(0.5, 9);
    expect(sunHits.find((h) => h.aspect === "sextile")?.exact).toBeCloseTo(1 / 14, 9);
    expect(sunHits.find((h) => h.aspect === "semisquare")?.exact).toBeCloseTo(25 / 140, 9);
  });

  it("reports both the square and the trine a harmonic 3 path crosses in one day, each at its own exact time", () => {
    // At harmonic 3 the Moon runs from 80 to 130 degrees in the harmonic chart: it crosses the square at 90 (1/5 of the day) and the
    // trine at 120 (4/5). The raw longitudes are the harmonic ones divided by 3, so harmonicSky multiplies them back.
    const raw = [80, 105, 130].map((longitude) => skyOf({ Moo: [longitude / 3, 0] }));
    const reading = readDay({
      natal: harmonicPositions(natal({ Sun: 0 }), 3),
      sky: raw.map((s) => harmonicSky(s, 3)) as [SkyPositions, SkyPositions, SkyPositions],
      middle: 0.5,
      aspects: VIBRATIONAL_ASPECTS,
      minScore: 0,
    });
    const sunHits = reading.hits.filter((h) => h.pairing === "T to N" && h.moving === "Moo" && h.still === "Sun");

    expect(sunHits.find((h) => h.aspect === "square")?.exact).toBeCloseTo(0.2, 9);
    expect(sunHits.find((h) => h.aspect === "trine")?.exact).toBeCloseTo(0.8, 9);
  });

  it("gives each hit the object codes of both its points, one for a body and two for a midpoint", () => {
    const reading = readDay(
      day(natal({ Mer: 268.6 }), [
        skyOf({ Sun: [0, 0], Moo: [170, 13] }),
        skyOf({ Sun: [0, 0], Moo: [190, 13] }),
        skyOf({ Sun: [0, 0], Moo: [210, 13] }),
      ]),
    );
    const midpointHit = reading.hits.find((h) => h.pairing === "Tm to N" && h.moving === "Sun/Moo" && h.still === "Mer");
    const bodyHit = reading.hits.find((h) => h.pairing === "T to N" && h.moving === "Moo" && h.still === "Mer");

    expect(midpointHit?.movingCodes).toEqual(["Sun", "Moo"]);
    expect(midpointHit?.stillCodes).toEqual(["Mer"]);
    expect(bodyHit?.movingCodes).toEqual(["Moo"]);
  });
});

describe("readDay: the phase at a midpoint's cut", () => {
  it("reads a midpoint that jumps into orb at its cut as separating from the cut", () => {
    // The Sun stands at 0 and the Moon runs from 170 to 210: the midpoint is 85 + 20x until the two are opposite, at x = 1/4, where it
    // jumps by 180 to 265 + 20x. A natal point at 268.6 is 1.4 degrees from the midpoint at the cut, and the orb grows after it.
    const reading = readDay(
      day(natal({ Mer: 268.6 }), [
        skyOf({ Sun: [0, 0], Moo: [170, 13] }),
        skyOf({ Sun: [0, 0], Moo: [190, 13] }),
        skyOf({ Sun: [0, 0], Moo: [210, 13] }),
      ]),
    );

    expect(
      reading.hits.find((h) => h.pairing === "Tm to N" && h.moving === "Sun/Moo" && h.still === "Mer" && h.aspect === "conjunction"),
    ).toMatchObject({ phase: "separating", exact: undefined });
    expect(reading.hits.find((h) => h.moving === "Sun/Moo" && h.still === "Mer" && h.aspect === "conjunction")?.orb).toBeCloseTo(1.4, 6);
  });
});

describe("readDay: the cut for min_strength is the score as shown", () => {
  it("drops a hit whose score rounds to a value under the cut, and keeps one whose shown score meets it", () => {
    // Mercury stands 0.5168 degrees past natal Venus, a conjunction of limit 2 that neither outer nor key: the score is
    // (1 − 0.5168 ÷ 2) ÷ 1.5 = 0.4944, which the result shows as 0.49.
    const samples = [0, 1, 2].map(() => skyOf({ Mer: [100.5168, 0] })) as [SkyPositions, SkyPositions, SkyPositions];
    const kept = readDay(day(natal({ Ven: 100 }), samples, 0.49));
    const dropped = readDay(day(natal({ Ven: 100 }), samples, 0.494));
    const hit = kept.hits.find((h) => h.moving === "Mer" && h.still === "Ven" && h.aspect === "conjunction");

    expect(hit?.score).toBeCloseTo(0.4944, 4);
    expect(shownScore(hit!.score)).toBe(0.49);
    expect(dropped.hits.some((h) => h.moving === "Mer" && h.still === "Ven" && h.aspect === "conjunction")).toBe(false);
  });
});

// A minute search at harmonic 3: every pair and aspect is read each minute of the day, against the reading's own model, which is
// each body's quadratic through its three harmonic samples. The search gives each aspect's least orb, and the minutes where its
// distance changes sign while it is within a degree, which are its exact moments.
describe("readDay against a minute search at harmonic 3", () => {
  it("gives each aspect's orb and exact time that the minute search finds, to a hundredth of a degree and two minutes", () => {
    const next = random(7);
    const codes: ObjectCode[] = ["Sun", "Moo", "Mer", "Jup"];
    const chart = natal({ Sun: next() * 360, Moo: next() * 360, Ven: next() * 360 });
    const track = Object.fromEntries(
      codes.map((code) => {
        const start = next() * 360;
        const rate = code === "Moo" ? 13 : 0.2 + next() * 2;
        return [code, [start, start + rate / 2 + next() * 3, start + rate + next() * 6]];
      }),
    ) as Record<ObjectCode, number[]>;
    const samples = [0, 1, 2].map((k) =>
      harmonicSky(skyOf(Object.fromEntries(codes.map((code) => [code, [track[code]![k]! % 360, 1]]))), 3),
    ) as [SkyPositions, SkyPositions, SkyPositions];
    const natalHarmonic = harmonicPositions(chart, 3);
    const daily = readDay({ natal: natalHarmonic, sky: samples, middle: 0.5, aspects: VIBRATIONAL_ASPECTS, minScore: 0 });

    // The model: each body's unwrapped harmonic samples through a quadratic, read at any fraction of the day.
    const model = codes.map((code) => {
      const longitudes = samples.map((s) => s.bodies[code]!.longitude);
      const second = longitudes[0]! + wrapped(longitudes[1]! - longitudes[0]!);
      return quadratic3([longitudes[0]!, second, second + wrapped(longitudes[2]! - longitudes[1]!)], [0, 0.5, 1]);
    });
    const lonAt = (index: number, x: number) => {
      const q = model[index]!;
      return (((q.c + x * (q.b + q.a * x)) % 360) + 360) % 360;
    };
    const movers = [
      ...codes.map((code, i) => ({ name: code, pairing: "T", parts: [i] })),
      ...codes.flatMap((a, i) => codes.slice(i + 1).map((b, j) => ({ name: `${a}/${b}`, pairing: "Tm", parts: [i, i + 1 + j] }))),
    ];
    const stills = [
      ...chartPoints(natalHarmonic).map((p) => ({ name: p.name, pairing: "N", longitude: p.longitude })),
      ...midpointSet(chartPoints(natalHarmonic)).map((m) => ({ name: m.name, pairing: "Nm", longitude: m.longitude })),
    ];

    // One probe per mover, still point, aspect and side: the offset the aspect is measured from. Probes of one aspect share an entry.
    type Entry = { orb: number; limit: number; crossings: number[] };
    const found = new Map<string, Entry>();
    const probes: { mover: number; offset: number; still: number; entry: Entry }[] = [];
    movers.forEach((mover, mi) =>
      stills.forEach((still, si) =>
        VIBRATIONAL_ASPECTS.forEach((aspect) => {
          const classic = mover.parts.length === 2 || still.pairing === "Nm";
          const limit = classic ? midpointLimit(aspect, VIBRATIONAL_MIDPOINT_ORB) : vibrationalTransitLimit(aspect);
          const key = `${mover.pairing} to ${still.pairing} ${mover.name} ${still.name} ${aspect.key}`;
          const entry = found.get(key) ?? { orb: Infinity, limit, crossings: [] };
          found.set(key, entry);
          const offsets = aspect.angle === 0 || aspect.angle === 180 ? [aspect.angle] : [aspect.angle, -aspect.angle];
          for (const offset of offsets) {
            probes.push({ mover: mi, offset, still: si, entry });
          }
        }),
      ),
    );
    const previous: (number | undefined)[] = new Array(probes.length);
    for (let minute = 0; minute <= 1440; minute++) {
      const x = minute / 1440;
      const moverLongitudes = movers.map((mover) =>
        mover.parts.length === 1 ? lonAt(mover.parts[0]!, x) : midpoint(lonAt(mover.parts[0]!, x), lonAt(mover.parts[1]!, x)),
      );
      probes.forEach((probe, i) => {
        const f = wrapped(moverLongitudes[probe.mover]! - stills[probe.still]!.longitude - probe.offset);
        probe.entry.orb = Math.min(probe.entry.orb, Math.abs(f));
        const before = previous[i];
        if (before !== undefined && (before < 0) !== (f < 0) && Math.abs(before) < 1 && Math.abs(f) < 1) {
          // The crossing lies between the minute before and this one, so it is at minute - 0.5, in minutes from the day's start.
          probe.entry.crossings.push(minute - 0.5);
        }
        previous[i] = f;
      });
    }

    const dailyByKey = new Map(daily.hits.map((h) => [`${h.pairing} ${h.moving} ${h.still} ${h.aspect}`, h]));
    // Each pair and aspect is one hit, so the map loses no hit to a repeated key.
    expect(daily.hits.length).toBe(dailyByKey.size);
    expect(dailyByKey.size).toBeGreaterThan(5);
    for (const [key, hit] of dailyByKey) {
      const seen = found.get(key);
      expect(seen, key).toBeDefined();
      expect(Math.abs(hit.orb - seen!.orb), key).toBeLessThan(0.03);
      if (hit.exact !== undefined) {
        expect(seen!.crossings.length, key).toBeGreaterThan(0);
        expect(Math.abs(hit.exact * 1440 - Math.min(...seen!.crossings)), key).toBeLessThanOrEqual(2);
        // The reading reports the earliest exact moment, so it is the first crossing the search sees.
      }
    }
    for (const [key, seen] of found) {
      if (seen.orb <= seen.limit - 0.03) {
        expect(dailyByKey.has(key), key).toBe(true);
      }
      if (seen.crossings.length > 0) {
        expect(dailyByKey.get(key)?.exact, key).toBeDefined();
      }
    }
  });
});
