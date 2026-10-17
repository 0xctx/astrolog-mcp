import { describe, expect, it } from "vitest";
import {
  VIBRATIONAL_ASPECTS,
  VIBRATIONAL_MIDPOINT_ORB,
  VIBRATIONAL_ORB_RULE,
  aspectType,
  chartPoints,
  isApplying,
  midpointContacts,
  midpointSet,
  readPairings,
  readPointSets,
  skyPoints,
  type AspectType,
  type PointEntry,
  type PointSetOptions,
} from "./math.js";
import {
  AstroError,
  HOUSE_NUMBERS,
  type Ayanamsa,
  type ObjectCode,
  type Positions,
  type Provenance,
  type SkyBody,
  type SkyPositions,
} from "./types.js";

// Hand-built sky and natal charts. Only the longitudes and speeds matter to these functions; the rest is inert, and
// `source: "stub"` says so: nothing here is astrolog output.
function provenanceIn(ayanamsa: Ayanamsa = "tropical"): Provenance {
  return { astrologVersion: "hand-computed test fixture", source: "stub", utc: "1990-06-15T19:30:00Z", ayanamsa };
}

function skyOf(bodies: Partial<Record<ObjectCode, SkyBody>>, ayanamsa: Ayanamsa = "tropical"): SkyPositions {
  return { bodies, missing: [], provenance: provenanceIn(ayanamsa) };
}

function natalOf(bodies: Partial<Record<ObjectCode, SkyBody>>, asc: number, mc: number, ayanamsa: Ayanamsa = "tropical"): Positions {
  const out: Positions["bodies"] = {};
  for (const [code, body] of Object.entries(bodies) as Array<[ObjectCode, SkyBody]>) {
    out[code] = { ...body, house: 1 };
  }
  return {
    bodies: out,
    houses: Object.fromEntries(HOUSE_NUMBERS.map((n) => [n, (n - 1) * 30])) as Positions["houses"],
    angles: { ASC: asc, MC: mc, DSC: (asc + 180) % 360, IC: (mc + 180) % 360 },
    missing: [],
    housesFrom: "placidus",
    provenance: provenanceIn(ayanamsa),
  };
}

function pt(name: string, longitude: number, speed?: number, zodiac: Ayanamsa = "tropical"): PointEntry {
  return { name, kind: "point", longitude, speed, zodiac };
}

// The reading used by the pairing tests: conjunction, opposition and square, a point orb of 2 degrees, and the classic
// midpoint orb of the vibrational pack.
const options: PointSetOptions = {
  aspects: [aspectType("conjunction", 0, 1), aspectType("opposition", 1, 2), aspectType("square", 1, 4)],
  orb: { point: () => 2, midpoint: VIBRATIONAL_MIDPOINT_ORB },
  minStrength: 0,
};

describe("midpoint set", () => {
  it("takes the shorter-arc midpoint of every pair, in input order, across 0", () => {
    const set = midpointSet([
      { name: "Sun", longitude: 350, speed: 1, zodiac: "tropical" },
      { name: "Moo", longitude: 10, speed: 13, zodiac: "tropical" },
    ]);
    expect(set).toEqual([{
        name: "Sun/Moo",
        kind: "midpoint",
        longitude: 0,
        speed: 7,
        zodiac: "tropical",
        from: [
          { name: "Sun", longitude: 350, speed: 1 },
          { name: "Moo", longitude: 10, speed: 13 },
        ],
      }]);
  });

  it("lists the pairs with the first point before the second, A/B then A/C then B/C", () => {
    const set = midpointSet([pt("A", 0), pt("B", 20), pt("C", 40)]);
    expect(set.map((p) => p.name)).toEqual(["A/B", "A/C", "B/C"]);
    expect(set.map((p) => p.longitude)).toEqual([10, 20, 30]);
  });

  it("has no speed when either point's speed is not known, and is never a guess", () => {
    const set = midpointSet([pt("ASC", 0), pt("Sun", 20, 1)]);
    expect(set).toEqual([{
        name: "ASC/Sun",
        kind: "midpoint",
        longitude: 10,
        speed: undefined,
        zodiac: "tropical",
        from: [
          { name: "ASC", longitude: 0, speed: undefined },
          { name: "Sun", longitude: 20, speed: 1 },
        ],
      }]);
    expect(set[0]?.speed).toBeUndefined();
  });

  it("rejects a longitude or speed that is not a finite number", () => {
    expect(() => midpointSet([pt("Sun", Number.NaN, 1)])).toThrow(AstroError);
    expect(() => midpointSet([pt("Sun", 10, Number.POSITIVE_INFINITY)])).toThrow(AstroError);
  });
});

describe("point set reading: the four pairings", () => {
  it("T to N: a transit body within the square's orb of a natal point is a hit, and one outside is a miss", () => {
    const sky = skyOf({ Mar: { longitude: 91, speed: -0.5, retrograde: true } });
    const natal = natalOf({ Sun: { longitude: 0, speed: 1, retrograde: false } }, 200, 300);
    // Mars at 91 is 91 degrees from the Sun: the square (90) with orb 1, limit 2, strength 0.5. Its speed is
    // negative, so over 0.01 days it moves to 90.995, nearer the square: applying.
    expect(readPointSets(skyPoints(sky), chartPoints(natal), options)).toEqual([
      {
        moving: "Mar",
        movingCodes: ["Mar"],
        movingKind: "point",
        still: "Sun",
        stillCodes: ["Sun"],
        stillKind: "point",
        aspect: "square",
        angle: 90,
        orb: 1,
        limit: 2,
        strength: 0.5,
        phase: "applying",
      },
    ]);
    // Venus at 45 is 45 degrees from the Sun, 155 from the ASC and 105 from the MC: no aspect within 2 degrees.
    const miss = skyOf({ Ven: { longitude: 45, speed: 1.2, retrograde: false } });
    expect(readPointSets(skyPoints(miss), chartPoints(natal), options)).toEqual([]);
  });

  it("T to Nm: a transit body on a natal midpoint's axis is a hit, and one off it is a miss", () => {
    const natal = natalOf(
      {
        Sun: { longitude: 0, speed: 1, retrograde: false },
        Moo: { longitude: 120, speed: 13, retrograde: false },
      },
      200,
      300,
    );
    const still = midpointSet(chartPoints(natal).slice(0, 2));
    // The natal midpoint Sun/Moo is 60. Venus at 59.25 is 0.75 degrees from it: the conjunction with orb 0.75, limit
    // 1.5 (the axis orb), strength 0.5. Over 0.01 days Venus moves to 59.262, nearer 60: applying.
    const hit = skyOf({ Ven: { longitude: 59.25, speed: 1.2, retrograde: false } });
    expect(readPointSets(skyPoints(hit), still, options)).toEqual([
      {
        moving: "Ven",
        movingCodes: ["Ven"],
        movingKind: "point",
        still: "Sun/Moo",
        stillCodes: ["Sun", "Moo"],
        stillKind: "midpoint",
        aspect: "conjunction",
        angle: 0,
        orb: 0.75,
        limit: 1.5,
        strength: 0.5,
        phase: "applying",
      },
    ]);
    // Mars at 70 is 10 degrees from 60: no axis aspect within 1.5 degrees.
    const miss = skyOf({ Mar: { longitude: 70, speed: -0.5, retrograde: true } });
    expect(readPointSets(skyPoints(miss), still, options)).toEqual([]);
  });

  it("T to Nm reads the opposition of the midpoint's axis, where the point is 180 degrees away", () => {
    const still = midpointSet([pt("Sun", 0, 1), pt("Moo", 120, 13)]);
    // Venus at 240 is 180 degrees from the midpoint at 60: the opposition with orb 0, strength 1, and not applying
    // (Venus is at its exact opposition and moves away over the look-ahead).
    const sky = skyOf({ Ven: { longitude: 240, speed: 1.2, retrograde: false } });
    expect(readPointSets(skyPoints(sky), still, options)).toEqual([
      {
        moving: "Ven",
        movingCodes: ["Ven"],
        movingKind: "point",
        still: "Sun/Moo",
        stillCodes: ["Sun", "Moo"],
        stillKind: "midpoint",
        aspect: "opposition",
        angle: 180,
        orb: 0,
        limit: 1.5,
        strength: 1,
        phase: "separating",
      },
    ]);
  });

  it("Tm to N: a transit midpoint near a natal body is a hit, and one far from every natal point is a miss", () => {
    // The transit midpoint of Mars (0, speed 1) and Jupiter (20, speed 0.5) is 10, with speed 0.75.
    const moving = midpointSet(skyPoints(skyOf({
      Mar: { longitude: 0, speed: 1, retrograde: false },
      Jup: { longitude: 20, speed: 0.5, retrograde: false },
    })));
    const natal = natalOf({ Sun: { longitude: 10.5, speed: 1, retrograde: false } }, 200, 300);
    // The Sun at 10.5 is 0.5 degrees from the midpoint: the conjunction with orb 0.5, limit 1.5, strength 2/3. Over 0.01
    // days the midpoint moves to 10.0075, nearer the Sun: applying.
    const hits = readPointSets(moving, chartPoints(natal), options);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      moving: "Mar/Jup",
      movingKind: "midpoint",
      still: "Sun",
      stillKind: "point",
      aspect: "conjunction",
      angle: 0,
      orb: 0.5,
      limit: 1.5,
      phase: "applying",
    });
    expect(hits[0]!.strength).toBeCloseTo(2 / 3, 12);
    // Moon at 40 is 30 degrees from 10; the angles at 200 and 300 are 170 and 70 away. Nothing is within its limit.
    const far = natalOf({ Moo: { longitude: 40, speed: 13, retrograde: false } }, 200, 300);
    expect(readPointSets(moving, chartPoints(far), options)).toEqual([]);
  });

  it("Tm to Nm: a transit midpoint on a natal midpoint is a hit, and one 50 degrees away is a miss", () => {
    const moving = midpointSet(skyPoints(skyOf({
      Mar: { longitude: 0, speed: 1, retrograde: false },
      Jup: { longitude: 20, speed: 0.5, retrograde: false },
    })));
    // The natal midpoint Sun/Moo is 10.5, speed 7. The transit midpoint at 10 is 0.5 degrees from it: the conjunction
    // with strength 2/3, applying as in the Tm to N case.
    const still = midpointSet([pt("Sun", 2, 1), pt("Moo", 19, 13)]);
    const hits = readPointSets(moving, still, options);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      moving: "Mar/Jup",
      movingKind: "midpoint",
      still: "Sun/Moo",
      stillKind: "midpoint",
      aspect: "conjunction",
      angle: 0,
      orb: 0.5,
      limit: 1.5,
      phase: "applying",
    });
    expect(hits[0]!.strength).toBeCloseTo(2 / 3, 12);
    // The natal midpoint Sun/Moo at 60 is 50 degrees from 10: no axis or square aspect within the classic limit.
    expect(readPointSets(moving, midpointSet([pt("Sun", 0, 1), pt("Moo", 120, 13)]), options)).toEqual([]);
  });
});

describe("point set reading: the orb rules", () => {
  it("applies the classic midpoint limit in proportion above harmonic 2: a quintile's limit is 0.6 degrees", () => {
    const still = midpointSet([pt("Sun", 0, 1), pt("Moo", 0, 1)]);
    const quintile = [aspectType("quintile", 1, 5)];
    const rule = { aspects: quintile, orb: { point: () => 2, midpoint: VIBRATIONAL_MIDPOINT_ORB }, minStrength: 0 };
    // A point at 72.5 is 0.5 degrees from the quintile (72), inside 0.6: strength 1 - 0.5/0.6.
    const hit = readPointSets([pt("Ven", 72.5)], still, rule);
    expect(hit).toHaveLength(1);
    expect(hit[0]!.limit).toBeCloseTo(0.6, 12);
    expect(hit[0]!.strength).toBeCloseTo(1 - 0.5 / 0.6, 12);
    // At 72.7 it is 0.7 degrees away, outside 0.6.
    expect(readPointSets([pt("Ven", 72.7)], still, rule)).toEqual([]);
  });

  it("gives a point-to-point aspect the transit orb of its harmonic, so a quintile is limited to 1 degree", () => {
    const quintile = [aspectType("quintile", 1, 5)];
    const rule = { aspects: quintile, orb: VIBRATIONAL_ORB_RULE, minStrength: 0 };
    expect(readPointSets([pt("Mar", 73.5)], [pt("Sun", 0)], rule)).toEqual([]);
    const hits = readPointSets([pt("Mar", 72.5)], [pt("Sun", 0)], rule);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ limit: 1, orb: 0.5, strength: 0.5 });
  });
});

describe("point set reading: applying", () => {
  it("is unknown when the moving point's speed is not known, and says so", () => {
    const hits = readPointSets([pt("Mar", 91)], [pt("Sun", 0, 1)], options);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.phase).toBe("unknown");
  });

  it("is unknown for a midpoint with a component of unknown speed, such as an angle", () => {
    const moving = midpointSet([pt("ASC", 0), pt("Sun", 20, 1)]);
    const hits = readPointSets(moving, [pt("Moo", 10.5)], options);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.phase).toBe("unknown");
  });

  it("is unknown when the pair crosses 180 degrees inside the look-ahead, and never reads it as separating", () => {
    // Mars at 179.995 moves 0.01 degrees over the look-ahead, past the opposition of the Sun at 0. Separation folds at 180, so
    // the straight step would say separating. The pair is 0.005 from exact, so it is a hit whose phase is not known.
    const hits = readPointSets([pt("Mar", 179.995, 1)], [pt("Sun", 0, 1)], options);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ aspect: "opposition", phase: "unknown" });
    expect(hits[0]?.orb).toBeCloseTo(0.005, 9);
  });

  it("is unknown when the pair crosses 0 degrees inside the look-ahead", () => {
    const hits = readPointSets([pt("Mar", 359.995, 1)], [pt("Sun", 0, 1)], options);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ aspect: "conjunction", phase: "unknown" });
    expect(hits[0]?.orb).toBeCloseTo(0.005, 9);
  });

  it("reads the same opposition as applying or separating when the look-ahead does not cross a fold", () => {
    // Away from the fold the straight step is exact: 179.5 moves to 179.51, closer to the opposition, so it is applying.
    expect(readPointSets([pt("Mar", 179.5, 1)], [pt("Sun", 0, 1)], options)[0]?.phase).toBe("applying");
    // Moving backward from 179.995 leaves the opposition, so the orb grows: separating, not unknown.
    expect(readPointSets([pt("Mar", 179.995, -1)], [pt("Sun", 0, 1)], options)[0]?.phase).toBe("separating");
  });

  it("ignores the still point's speed: the still point is held still", () => {
    const sky = skyOf({ Mar: { longitude: 91, speed: -0.5, retrograde: true } });
    const fast = natalOf({ Sun: { longitude: 0, speed: 1000, retrograde: false } }, 200, 300);
    const hits = readPointSets(skyPoints(sky), chartPoints(fast), options);
    expect(hits.find((h) => h.still === "Sun")?.phase).toBe("applying");
  });
});

describe("point set reading: ordering and filters", () => {
  it("sorts the hits by strength, largest first", () => {
    const hits = readPointSets([pt("A", 91), pt("B", 0.5)], [pt("Sun", 0)], options);
    expect(hits.map((h) => [h.moving, h.strength])).toEqual([
      ["B", 0.75],
      ["A", 0.5],
    ]);
  });

  it("keeps equal strengths in the order of the moving set", () => {
    // X at 91 and Y at 271 are both 1 degree from the square of the Sun at 0: strength 0.5 each.
    const hits = readPointSets([pt("X", 91), pt("Y", 271)], [pt("Sun", 0)], options);
    expect(hits.map((h) => h.moving)).toEqual(["X", "Y"]);
  });

  it("keeps equal strengths in the order of the still set, after the moving set", () => {
    // Sun at 0 and Moo at 182 are both 91 degrees from X at 91: strength 0.5 each.
    const hits = readPointSets([pt("X", 91)], [pt("S1", 0), pt("S2", 182)], options);
    expect(hits.map((h) => h.still)).toEqual(["S1", "S2"]);
  });

  it("keeps only the hits whose strength is at least minStrength", () => {
    const moving = [pt("B", 0.5), pt("A", 91)];
    expect(readPointSets(moving, [pt("Sun", 0)], { ...options, minStrength: 0.6 }).map((h) => h.moving)).toEqual(["B"]);
    expect(readPointSets(moving, [pt("Sun", 0)], { ...options, minStrength: 1 })).toEqual([]);
  });

  it("is deterministic and pure: the same inputs give the same hits, and the inputs are not changed", () => {
    const moving = midpointSet(skyPoints(skyOf({
      Mar: { longitude: 0, speed: 1, retrograde: false },
      Jup: { longitude: 20, speed: 0.5, retrograde: false },
    })));
    const still = chartPoints(natalOf({ Sun: { longitude: 10.5, speed: 1, retrograde: false } }, 200, 300));
    const before = structuredClone({ moving, still });
    const first = readPointSets(moving, still, options);
    expect(readPointSets(moving, still, options)).toEqual(first);
    expect({ moving, still }).toEqual(before);
  });

  it("has no field or value that says strong, significant or stands out", () => {
    const hits = readPointSets([pt("A", 91, -0.5)], [pt("Sun", 0)], options);
    expect(JSON.stringify(hits)).not.toMatch(/strong|significant|stands out/i);
  });
});

describe("point set reading: validation", () => {
  it("rejects an empty aspect set, a non-positive orb and a minStrength outside 0 to 1, each with a fix line", () => {
    const err = (call: () => unknown) => {
      try {
        call();
      } catch (error) {
        return error instanceof AstroError ? error : undefined;
      }
      return undefined;
    };
    const empty = err(() => readPointSets([pt("A", 1)], [pt("B", 2)], { ...options, aspects: [] }));
    expect(empty?.fix).toMatch(/VIBRATIONAL_ASPECTS/);
    expect(() => readPointSets([pt("A", 1)], [pt("B", 2)], { ...options, orb: { point: () => 2, midpoint: 0 } })).toThrow(AstroError);
    expect(() => readPointSets([pt("A", 1)], [pt("B", 2)], { ...options, minStrength: 1.5 })).toThrow(AstroError);
    expect(() => readPointSets([pt("A", 1)], [pt("B", 2)], { ...options, minStrength: Number.NaN })).toThrow(AstroError);
  });

  it("rejects a point orb that is not a positive number", () => {
    expect(() => readPointSets([pt("A", 1)], [pt("B", 2)], { ...options, orb: { point: () => 0, midpoint: 1.5 } })).toThrow(AstroError);
  });
});

describe("point set reading: speed budget", () => {
  // Fourteen points with longitudes and speeds spread around the circle, so the reading does real work.
  const fourteen = (prefix: string): PointEntry[] =>
    Array.from({ length: 14 }, (_, i) => pt(`${prefix}${i}`, (i * 25.7) % 360, 0.5 + i * 0.1));

  // The fastest of several runs. A single run can lose its time to load from other tests; the fastest run is the reading's own cost.
  const fastestMs = (run: () => void): number => {
    run();
    return Math.min(...Array.from({ length: 5 }, () => {
      const start = performance.now();
      run();
      return performance.now() - start;
    }));
  };

  // The bound is generous: a loaded full run can slow a fast reading several times over, and the budget is for a real slowdown.
  it("reads a 14-point set against a 14-point set with all 17 vibrational aspects in under 150 ms", () => {
    const moving = fourteen("T");
    const still = fourteen("N");
    const all = { aspects: VIBRATIONAL_ASPECTS, orb: VIBRATIONAL_ORB_RULE, minStrength: 0 };
    expect(fastestMs(() => readPointSets(moving, still, all))).toBeLessThan(150);
  });

  it("reads the midpoint sets of the same points within the same budget", () => {
    const moving = midpointSet(fourteen("T"));
    const still = midpointSet(fourteen("N"));
    const all = { aspects: VIBRATIONAL_ASPECTS, orb: VIBRATIONAL_ORB_RULE, minStrength: 0 };
    expect(fastestMs(() => readPointSets(moving, still, all))).toBeLessThan(150);
  });
});

describe("point set reading: phase", () => {
  it("never counts an unknown hit as applying, and counts a known applying one", () => {
    const unknown = readPointSets([pt("Mar", 91), pt("Ven", 91, 0.5)], [pt("Sun", 0, 1)], options);
    expect(unknown.map((h) => h.phase)).toEqual(["unknown", "separating"]);
    expect(unknown.filter(isApplying)).toEqual([]);
    const known = readPointSets([pt("Ven", 91, -0.5)], [pt("Sun", 0, 1)], options);
    expect(known.filter(isApplying)).toHaveLength(1);
  });

  it("reads a separating midpoint: its orb grows over the look-ahead", () => {
    // The midpoint of Mars (0, speed 1) and Jupiter (20, speed 0.5) is 10, speed 0.75. Sun at 9.5 is 0.5 degrees behind it.
    // Over 0.01 days the midpoint moves to 10.0075, 0.5075 from the Sun, so the orb grows: separating, not applying.
    const hits = readPointSets(midpointSet(skyPoints(skyOf({
      Mar: { longitude: 0, speed: 1, retrograde: false },
      Jup: { longitude: 20, speed: 0.5, retrograde: false },
    }))), [pt("Sun", 9.5, 1)], options);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ moving: "Mar/Jup", aspect: "conjunction", orb: 0.5, phase: "separating" });
    expect(isApplying(hits[0]!)).toBe(false);
  });
});

describe("classic midpoint reading: a set without an axis aspect", () => {
  // Sun 10 and Moon 30 have the midpoint 20. Mercury at 21 is 1 degree from it, on the conjunction side. Jupiter at 200 is
  // 180 degrees from it, on the opposition side.
  const chart = natalOf(
    {
      Sun: { longitude: 10, speed: 1, retrograde: false },
      Moo: { longitude: 30, speed: 13, retrograde: false },
      Mer: { longitude: 21, speed: 1.5, retrograde: false },
      Jup: { longitude: 200, speed: 0.2, retrograde: false },
    },
    200,
    300,
  );
  const midSunMoo = midpointSet([pt("Sun", 10, 1), pt("Moo", 30, 13)]);
  const onSunMoo = (focus: string) => (contact: { focus: string; a: string; b: string }) =>
    contact.focus === focus && contact.a === "Sun" && contact.b === "Moo";

  it("reports nothing on the side whose axis aspect the set lacks, in both readers", () => {
    const opposition = [aspectType("opposition", 1, 2)];
    const contacts = midpointContacts(chart, 1, { aspects: opposition, orb: VIBRATIONAL_MIDPOINT_ORB });
    expect(contacts.filter(onSunMoo("Mer"))).toEqual([]);
    expect(contacts.filter(onSunMoo("Jup"))).toEqual([expect.objectContaining({ aspect: "opposition", orb: 0 })]);
    expect(readPointSets([pt("Mer", 21)], midSunMoo, { ...options, aspects: opposition })).toEqual([]);
    expect(readPointSets([pt("Jup", 200)], midSunMoo, { ...options, aspects: opposition }).map((h) => h.aspect)).toEqual([
      "opposition",
    ]);
  });

  it("reports nothing on the opposition side when the set has only the conjunction, in both readers", () => {
    const conjunction = [aspectType("conjunction", 0, 1)];
    const contacts = midpointContacts(chart, 1, { aspects: conjunction, orb: VIBRATIONAL_MIDPOINT_ORB });
    expect(contacts.filter(onSunMoo("Jup"))).toEqual([]);
    expect(contacts.filter(onSunMoo("Mer"))).toEqual([expect.objectContaining({ aspect: "conjunction", orb: 1 })]);
    expect(readPointSets([pt("Jup", 200)], midSunMoo, { ...options, aspects: conjunction })).toEqual([]);
    expect(readPointSets([pt("Mer", 21)], midSunMoo, { ...options, aspects: conjunction }).map((h) => h.aspect)).toEqual([
      "conjunction",
    ]);
  });

  it("identifies the axis aspect by its angle, not its key", () => {
    const byAngle = [aspectType("contact", 0, 1)];
    expect(readPointSets([pt("Mer", 21)], midSunMoo, { ...options, aspects: byAngle }).map((h) => h.aspect)).toEqual([
      "contact",
    ]);
  });

  it("refuses a midpoint config whose aspect has an invalid angle or harmonic, rather than skipping it", () => {
    const config = (aspect: AspectType) => () => midpointContacts(chart, 1, { aspects: [aspect], orb: VIBRATIONAL_MIDPOINT_ORB });
    expect(config({ key: "odd", angle: 360, harmonic: 1 })).toThrow(AstroError);
    expect(config({ key: "odd", angle: 90, harmonic: 0 })).toThrow(AstroError);
    expect(config({ key: "odd", angle: Number.NaN, harmonic: 2 })).toThrow(AstroError);
  });
});

describe("point set reading: pairings in one call", () => {
  it("returns the four labelled lists, with the hits and misses of each pairing", () => {
    // Transit Mars at 91 (speed -0.5) and Venus at 59.25 (speed 1.2). Natal Sun 0, Moon 120 and Mercury 75.5, and the
    // angles at 200 and 20, which no pairing reaches within its orb (the midpoints with an angle included).
    const sky = skyOf({ Mar: { longitude: 91, speed: -0.5, retrograde: true }, Ven: { longitude: 59.25, speed: 1.2, retrograde: false } });
    const natal = natalOf(
      {
        Sun: { longitude: 0, speed: 1, retrograde: false },
        Moo: { longitude: 120, speed: 13, retrograde: false },
        Mer: { longitude: 75.5, speed: 1.5, retrograde: false },
      },
      200,
      20,
    );
    const readings = readPairings(sky, natal, options);
    expect(Object.keys(readings)).toEqual(["T to N", "T to Nm", "Tm to N", "Tm to Nm"]);
    const shape = (hits: ReturnType<typeof readPointSets>) => hits.map((h) => [h.moving, h.still, h.aspect]);
    // Mars 91 square the Sun; Venus 59.25 conjunct the natal midpoint Sun/Moon at 60.
    expect(shape(readings["T to N"])).toEqual([["Mar", "Sun", "square"]]);
    expect(shape(readings["T to Nm"])).toEqual([["Ven", "Sun/Moo", "conjunction"]]);
    // The transit midpoint Ven/Mar (Venus first, as the sky lists bodies) is 75.125, 0.375 from Mercury at 75.5.
    // No transit midpoint is near the natal midpoints.
    expect(shape(readings["Tm to N"])).toEqual([["Ven/Mar", "Mer", "conjunction"]]);
    expect(readings["Tm to Nm"]).toEqual([]);
  });

  it("refuses a midpoint as an input to midpointSet, at compile time and at run time", () => {
    const mids = midpointSet([pt("A", 0), pt("B", 20)]);
    // @ts-expect-error a midpoint is not a plain point, so midpointSet refuses it at compile time
    expect(() => midpointSet(mids)).toThrow(AstroError);
    // A caller that skips the type check gets the same refusal from the run-time check.
    expect(() => midpointSet(mids as unknown as PointEntry[])).toThrow(AstroError);
  });
});

describe("point set reading: aspects and self-pairs", () => {
  it("refuses an aspect whose angle or harmonic is not valid, before any reading", () => {
    const withAspect = (aspect: AspectType) => () => readPointSets([pt("A", 1)], [pt("B", 2)], { ...options, aspects: [aspect] });
    expect(withAspect({ key: "odd", angle: 400, harmonic: 1 })).toThrow(AstroError);
    expect(withAspect({ key: "odd", angle: Number.NaN, harmonic: 4 })).toThrow(AstroError);
    expect(withAspect({ key: "odd", angle: 90, harmonic: 0 })).toThrow(AstroError);
  });

  it("skips a point paired with itself when one set is passed on both sides", () => {
    // Each point is 0 degrees from itself, a conjunction. Without the skip, Sun/Sun and Moo/Moo would be hits.
    const set = [pt("Sun", 0, 1), pt("Moo", 120, 13)];
    expect(readPointSets(set, set, options)).toEqual([]);
  });
});

describe("point set reading: one zodiac", () => {
  // A sky with Mars at 91 and a natal Sun at 0: a square, which the readings must find in one zodiac and refuse across two.
  const sky = (ayanamsa: Ayanamsa) => skyOf({ Mar: { longitude: 91, speed: -0.5, retrograde: true } }, ayanamsa);
  const natal = (ayanamsa: Ayanamsa) => natalOf({ Sun: { longitude: 0, speed: 1, retrograde: false } }, 200, 300, ayanamsa);

  function thrown(call: () => unknown): AstroError {
    try {
      call();
    } catch (error) {
      if (error instanceof AstroError) {
        return error;
      }
      throw error;
    }
    throw new Error("expected an AstroError");
  }

  it("refuses a sidereal sky read against a tropical natal chart, in readPairings, with a fix line", () => {
    const error = thrown(() => readPairings(sky("lahiri"), natal("tropical"), options));
    // The natal result is the first argument of assertSameZodiac, so its zodiac is named first.
    expect(error.message).toBe("the two results are in different zodiacs: tropical and lahiri");
    expect(error.fix).toMatch(/ayanamsa/);
  });

  it("refuses a natal point read against a sky point of another zodiac, in readPointSets, with a fix line", () => {
    // The guard that readPairings' own check protects: no caller can reach a mixed pairing through the point reader.
    const error = thrown(() => readPointSets(skyPoints(sky("lahiri")), chartPoints(natal("tropical")), options));
    expect(error.message).toBe("the points are in different zodiacs: lahiri and tropical");
    expect(error.fix).toMatch(/ayanamsa/);
  });

  it("refuses a midpoint set that mixes two zodiacs", () => {
    const mixed = [pt("Sun", 0, 1), pt("Moo", 120, 13, "lahiri")];
    expect(() => midpointSet(mixed)).toThrow(AstroError);
  });

  it("reads a sidereal sky against a sidereal natal chart, as it reads tropical ones", () => {
    const hits = readPairings(sky("lahiri"), natal("lahiri"), options);
    expect(hits["T to N"].map((h) => [h.moving, h.still, h.aspect])).toEqual([["Mar", "Sun", "square"]]);
  });
});

describe("chart points", () => {
  it("lists the bodies in OBJECT_CODES order, then ASC and MC, and gives the angles no speed", () => {
    const points = chartPoints(natalOf({ Sun: { longitude: 10, speed: 1, retrograde: false }, Moo: { longitude: 30, speed: 13, retrograde: false } }, 200, 300));
    expect(points.map((p) => p.name)).toEqual(["Sun", "Moo", "ASC", "MC"]);
    expect(points.map((p) => p.speed)).toEqual([1, 13, undefined, undefined]);
  });
});

describe("point set reading: the aspect's own exact point", () => {
  // The look-ahead is TRANSIT_LOOK_AHEAD_DAYS; a body at the given speed moves speed × that many degrees. A trine's exact points
  // are at +120 and -120 from the natal point. The orb passes through zero there, so a step across one is unknown, never a guess.
  const trine = [aspectType("trine", 1, 3)];
  const square = [aspectType("square", 1, 4)];
  const sextile = [aspectType("sextile", 1, 6)];
  const only = (aspects: AspectType[]): PointSetOptions => ({ ...options, aspects });
  const phase = (longitude: number, speed: number, aspects: AspectType[]) =>
    readPointSets([pt("Mar", longitude, speed)], [pt("Sun", 0)], only(aspects))[0]?.phase;

  it("reads a trine passed inside the look-ahead as unknown, not separating", () => {
    // 119.99 moving 3 a day: the trine's exact point at 120 is crossed inside the step, so the orb falls to 0 and rises again.
    expect(phase(119.99, 3, trine)).toBe("unknown");
    expect(phase(120.01, -3, trine)).toBe("unknown");
  });

  it("reads a square and a sextile passed inside the look-ahead as unknown", () => {
    expect(phase(89.99, 3, square)).toBe("unknown");
    expect(phase(90.01, -3, square)).toBe("unknown");
    expect(phase(59.99, 3, sextile)).toBe("unknown");
    expect(phase(60.01, -3, sextile)).toBe("unknown");
  });

  it("reads the mirror exact point, 120 behind the natal point, the same way", () => {
    expect(phase(239.99, 3, trine)).toBe("unknown");
  });

  it("still reads applying and separating when the exact point is not crossed", () => {
    expect(phase(119.5, 0.5, trine)).toBe("applying");
    expect(phase(120.5, 0.5, trine)).toBe("separating");
    expect(phase(120.5, -0.5, trine)).toBe("applying");
    expect(phase(89.5, 0.5, square)).toBe("applying");
    expect(phase(90.5, 0.5, square)).toBe("separating");
    expect(phase(59.5, 0.5, sextile)).toBe("applying");
  });

  it("is never applying when unknown", () => {
    const hit = readPointSets([pt("Mar", 119.99, 3)], [pt("Sun", 0)], only(trine))[0];
    expect(hit?.phase).toBe("unknown");
    expect(hit && isApplying(hit)).toBe(false);
  });
});

describe("point set reading: a midpoint's own flip", () => {
  it("reads a midpoint whose two points pass 180 degrees apart inside the look-ahead as unknown", () => {
    // Sun at 0 and Moon at 179.9 gaining 13 a day: the shorter arc flips to the other side while the look-ahead runs.
    const flipping = midpointSet([pt("Sun", 0, 0), pt("Moo", 179.9, 13)]);
    const hit = readPointSets(flipping, [pt("Ven", 90.5)], { ...options, aspects: [aspectType("conjunction", 0, 1)] })[0];
    expect(hit?.phase).toBe("unknown");
  });

  it("reads a midpoint whose points are well away from 180 degrees by its own speed", () => {
    const steady = midpointSet([pt("Sun", 0, 1), pt("Moo", 100, 13)]);
    const hit = readPointSets(steady, [pt("Ven", 49)], { ...options, aspects: [aspectType("conjunction", 0, 1)] })[0];
    expect(hit?.phase).toBe("separating");
  });
});

describe("point set reading: codes", () => {
  it("gives each hit the object codes of both points, two for a midpoint", () => {
    const hits = readPointSets(midpointSet([pt("Sun", 0, 1), pt("Moo", 120, 13)]), [pt("MC", 60)], {
      ...options,
      aspects: [aspectType("conjunction", 0, 1)],
    });
    expect(hits[0]).toMatchObject({ movingCodes: ["Sun", "Moo"], movingKind: "midpoint", stillCodes: ["MC"] });
  });
});

describe("aspect axis angles", () => {
  it("refuses a harmonic 1 or 2 aspect whose angle is not 0 or 180", () => {
    const withAspect = (key: string, angle: number, harmonic: number) => () =>
      readPointSets([pt("A", 1)], [pt("B", 2)], { ...options, aspects: [{ key, angle, harmonic }] });
    expect(withAspect("odd", 90, 1)).toThrow(AstroError);
    expect(withAspect("odd", 90, 2)).toThrow(AstroError);
    expect(withAspect("odd", 0, 2)).toThrow(AstroError);
    expect(withAspect("odd", 180, 1)).toThrow(AstroError);
    expect(withAspect("conjunction", 0, 1)).not.toThrow();
  });
});
