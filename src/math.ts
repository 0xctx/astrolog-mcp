// Pure arithmetic over astrolog's positions: harmonics, separations, aspects, classic midpoints and
// transit aspects. Nothing here computes an ephemeris or does I/O. Every longitude comes from a
// Positions or SkyPositions that astrolog produced.
import {
  ANGLE_CODES,
  AstroError,
  HOUSE_NUMBERS,
  OBJECT_CODES,
  type Ayanamsa,
  type Body,
  type HouseNumber,
  type ObjectCode,
  type Positions,
  type SkyBody,
  type SkyPositions,
} from "./types.js";

// A chart takes any positive whole harmonic up to this.
export const MAX_HARMONIC = 10000;

// An aspect is the angle k × 360 ÷ harmonic. The conjunction is harmonic 1, the opposition harmonic 2.
export interface AspectType {
  key: string;
  angle: number;
  harmonic: number;
}

// The angle is rounded to 6 decimals, as the oracle's aspect registry rounds it.
export function aspectType(key: string, k: number, harmonic: number): AspectType {
  return { key, angle: round6((360 * k) / harmonic), harmonic };
}

// The vibrational aspect set from traditions/vibrational/method.toml, with the angles of the
// oracle's aspects_registry.
export const VIBRATIONAL_ASPECTS: readonly AspectType[] = [
  aspectType("conjunction", 0, 1),
  aspectType("opposition", 1, 2),
  aspectType("trine", 1, 3),
  aspectType("square", 1, 4),
  aspectType("quintile", 1, 5),
  aspectType("biquintile", 2, 5),
  aspectType("sextile", 1, 6),
  aspectType("septile", 1, 7),
  aspectType("biseptile", 2, 7),
  aspectType("triseptile", 3, 7),
  aspectType("semisquare", 1, 8),
  aspectType("sesquiquadrate", 3, 8),
  aspectType("novile", 1, 9),
  aspectType("binovile", 2, 9),
  aspectType("quadnovile", 4, 9),
  aspectType("semisextile", 1, 12),
  aspectType("quincunx", 5, 12),
];

// The classic midpoint orb of the vibrational pack ([midpoints] orb in method.toml).
export const VIBRATIONAL_MIDPOINT_ORB = 1.5;

// An explicit configuration of the aspects to read in the classic midpoint method. Aspects of
// harmonic 1 and 2 take `orb`; the others take `orb × 2 ÷ harmonic`.
export interface MidpointConfig {
  aspects: readonly AspectType[];
  orb: number;
}

// An aspect and the orb it is allowed, in degrees. The caller chooses the orb.
export interface AspectLimit {
  type: AspectType;
  orb: number;
}

// One midpoint contact: `focus` sits on, or in aspect to, the midpoint of `a` and `b`. Degrees
// and orbs are in the harmonic chart; `strength` is 1 at exact and 0 at the edge of the limit.
export interface MidpointContact {
  focus: string;
  a: string;
  b: string;
  aspect: string;
  midpoint: number;
  orb: number;
  limit: number;
  strength: number;
}

// The aspect a separation matches: the angle it is measured from, its orb, its limit and strength.
export interface AspectMatch {
  aspect: string;
  angle: number;
  orb: number;
  limit: number;
  strength: number;
}

// A transit: a transiting body's aspect to one natal target. `phase` is read by approachPhase over the look-ahead;
// `applying` is true only when the phase is applying, so an unknown phase is never applying.
export interface TransitHit extends AspectMatch {
  transit: ObjectCode;
  natal: string;
  phase: ApproachPhase;
  applying: boolean;
}

// Throws AstroError for a harmonic that is not a whole number from 1 to MAX_HARMONIC.
export function assertHarmonic(harmonic: number): void {
  if (!Number.isInteger(harmonic) || harmonic < 1 || harmonic > MAX_HARMONIC) {
    throw new AstroError(
      `harmonic must be a whole number from 1 to ${MAX_HARMONIC}, got ${String(harmonic)}`,
      `Use a whole-number harmonic from 1 to ${MAX_HARMONIC}, for example 5.`,
    );
  }
}

// (lon × H) mod 360, unrounded. The oracle's harmonic strengths use the unrounded product, so the bodies of
// midpointContacts use this value. Its angles are rounded to 6 decimals above H 1, as the oracle's harmonic_chart does.
export function harmonicLongitude(lon: number, harmonic: number): number {
  assertHarmonic(harmonic);
  return mod360(lon * harmonic);
}

// A copy of a natal chart in harmonic H: every body longitude, house cusp and angle is (lon × H) mod 360,
// rounded to 6 decimals above H 1, and every body speed is multiplied by H. Retrograde, house numbers,
// missing codes and provenance are copied unchanged. The input is not modified.
export function harmonicPositions(positions: Positions, harmonic: number): Positions {
  assertHarmonic(harmonic);
  const bodies: Positions["bodies"] = {};
  for (const [code, body] of Object.entries(positions.bodies) as Array<[ObjectCode, Body]>) {
    bodies[code] = { ...body, ...harmonicSkyBody(body, harmonic) };
  }
  const houses = { ...positions.houses };
  for (const n of HOUSE_NUMBERS) {
    houses[n] = harmonicValue(positions.houses[n], harmonic);
  }
  const angles = { ...positions.angles };
  for (const code of ANGLE_CODES) {
    angles[code] = harmonicValue(positions.angles[code], harmonic);
  }
  return {
    ...positions,
    bodies,
    houses,
    angles,
    missing: [...positions.missing],
    provenance: { ...positions.provenance },
  };
}

// A copy of a transit sky in harmonic H, with the same rules as harmonicPositions for its bodies. Transits
// to a harmonic natal chart take both sides this way, then call transitAspects.
export function harmonicSky(sky: SkyPositions, harmonic: number): SkyPositions {
  assertHarmonic(harmonic);
  const bodies: SkyPositions["bodies"] = {};
  for (const [code, body] of Object.entries(sky.bodies) as Array<[ObjectCode, SkyBody]>) {
    bodies[code] = { ...body, ...harmonicSkyBody(body, harmonic) };
  }
  return { ...sky, bodies, missing: [...sky.missing], provenance: { ...sky.provenance } };
}

// The longitude and speed of one body in harmonic H. Retrograde is unchanged: speed × H keeps its sign.
function harmonicSkyBody(body: SkyBody, harmonic: number): SkyBody {
  return {
    longitude: harmonicValue(body.longitude, harmonic),
    speed: body.speed * harmonic,
    retrograde: body.retrograde,
  };
}

// The angular distance between two longitudes, 0 to 180.
export function separation(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

// The midpoint on the shorter arc between two longitudes.
export function midpoint(a: number, b: number): number {
  const diff = mod360(b - a + 180) - 180;
  return mod360(a + diff / 2);
}

// 1 at exact and 0 at the edge of the orb. Above 0 only when the orb is inside the limit.
export function strength(orb: number, limit: number): number {
  return 1 - orb / limit;
}

// The vibrational orb in the harmonic chart: an aspect of harmonic H has 16 ÷ H degrees in the natal chart.
export const VIBRATIONAL_ORB_BASE = 16;

// The natal orb of a vibrational aspect of harmonic H, in degrees: 16 ÷ H (method.toml [orbs], rule harmonic).
export function vibrationalNatalLimit(harmonic: number): number {
  assertHarmonic(harmonic);
  return VIBRATIONAL_ORB_BASE / harmonic;
}

// The transit orb of an aspect, as the oracle's transit_orb: the natal orb, capped at 2 degrees for
// harmonics 1 to 4 and at 1 degree above. `harmonic` is the aspect's harmonic, not the chart's.
export function transitLimit(natalOrb: number, harmonic: number): number {
  assertHarmonic(harmonic);
  assertOrb(natalOrb, "the natal orb");
  return Math.min(natalOrb, harmonic <= 4 ? 2 : 1);
}

// The transit orb of a vibrational aspect: its natal orb 16 ÷ H, capped as transitLimit caps it. The transit tool and the
// point-set rule both take their orb from here.
export function vibrationalTransitLimit(aspect: AspectType): number {
  return transitLimit(vibrationalNatalLimit(aspect.harmonic), aspect.harmonic);
}

// The aspect a separation matches best: the largest strength, then the tightest orb, then the first
// listed. Undefined when no aspect is within its limit.
export function matchAspect(sep: number, limits: readonly AspectLimit[]): AspectMatch | undefined {
  assertAspectLimits(limits);
  const candidates = limits.map(({ type, orb: limit }): AspectMatch => {
    const orb = Math.abs(sep - type.angle);
    return { aspect: type.key, angle: type.angle, orb, limit, strength: strength(orb, limit) };
  });
  return bestOf(candidates.filter((c) => c.orb <= c.limit));
}

// The classic midpoint limit for an aspect: the axis orb for harmonic 1 and 2, else in proportion.
export function midpointLimit(aspect: AspectType, orb: number): number {
  return aspect.harmonic <= 2 ? orb : (orb * 2) / aspect.harmonic;
}

// Every classic (old-method) midpoint contact in one harmonic chart. Each body or angle is tested
// against the midpoint of every pair of the others. Harmonics 1 and 2 read the axis: the far end
// of the midpoint counts like the near one, and the side decides conjunction or opposition.
export function midpointContacts(
  positions: Positions,
  harmonic: number,
  config: MidpointConfig,
): MidpointContact[] {
  assertMidpointConfig(config);
  const lons = participants(
    positions,
    (lon) => harmonicLongitude(lon, harmonic),
    (lon) => harmonicValue(lon, harmonic),
  );
  const out: MidpointContact[] = [];
  for (const [focus, focusLon] of lons) {
    const others = lons.filter(([code]) => code !== focus);
    const found: MidpointContact[] = [];
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        const [a, aLon] = others[i]!;
        const [b, bLon] = others[j]!;
        const mid = midpoint(aLon, bLon);
        const best = matchMidpointAspect(separation(focusLon, mid), config.aspects, config.orb);
        if (best) {
          found.push({ focus, a, b, aspect: best.aspect, midpoint: mid, orb: best.orb, limit: best.limit, strength: best.strength });
        }
      }
    }
    found.sort((x, y) => y.strength - x.strength || x.orb - y.orb);
    out.push(...found);
  }
  return out;
}

// The classic reading of one separation from a midpoint, shared by midpointContacts and readPointSets. Harmonics 1 and 2
// read the axis on the midpoint's side: the aspect at 0 degrees when the separation is under 90, else the one at 180. A
// set without that axis aspect reports nothing on that side, and an aspect not in the set is never reported. Other
// aspects take their own angle. Every limit is midpointLimit(aspect, orb). Undefined when none is within its limit.
function matchMidpointAspect(sep: number, aspects: readonly AspectType[], orb: number): AspectMatch | undefined {
  const axisAngle = sep < 90 ? 0 : 180;
  const candidates: AspectMatch[] = [];
  for (const type of aspects) {
    if (type.harmonic <= 2 && type.angle !== axisAngle) {
      continue;
    }
    const limit = midpointLimit(type, orb);
    const off = Math.abs(sep - type.angle);
    if (off <= limit) {
      candidates.push({ aspect: type.key, angle: type.angle, orb: off, limit, strength: strength(off, limit) });
    }
  }
  return bestOf(candidates);
}

// The look-ahead of transit applying: a moving body is moved this many days along its speed to read whether its orb shrinks.
export const TRANSIT_LOOK_AHEAD_DAYS = 0.01;

// Throws AstroError when two results are in different zodiacs. A sidereal chart read against a
// tropical sky is off by the ayanamsa everywhere, with no other sign, so a reader refuses the pair.
export function assertSameZodiac(
  first: { provenance: { ayanamsa: Ayanamsa } },
  second: { provenance: { ayanamsa: Ayanamsa } },
): void {
  if (first.provenance.ayanamsa !== second.provenance.ayanamsa) {
    throw new AstroError(
      `the two results are in different zodiacs: ${first.provenance.ayanamsa} and ${second.provenance.ayanamsa}`,
      "Cast both with the same ayanamsa, or read both in tropical.",
    );
  }
}

// The transit aspects of a sky moment against a natal chart. Each transiting body reads every natal
// body and ASC and MC, and keeps its best aspect per target. Sorted by strength, largest first.
// The natal chart and the sky must be in the same zodiac (assertSameZodiac).
export function transitAspects(
  natal: Positions,
  sky: SkyPositions,
  limits: readonly AspectLimit[],
): TransitHit[] {
  assertSameZodiac(natal, sky);
  assertAspectLimits(limits);
  const targets = participants(natal, (lon) => lon);
  const hits: TransitHit[] = [];
  for (const code of OBJECT_CODES) {
    const body = sky.bodies[code];
    if (!body) {
      continue;
    }
    for (const [name, lon] of targets) {
      const best = matchAspect(separation(body.longitude, lon), limits);
      if (!best) {
        continue;
      }
      const phase = approachPhase(body.longitude, body.speed, lon, best);
      hits.push({ ...best, transit: code, natal: name, phase, applying: phase === "applying" });
    }
  }
  return hits.sort((x, y) => y.strength - x.strength);
}

// Every aspect of the set between each pair of points, strongest first. A pair that sits inside the orb of
// two aspects lists both; ties keep the input order, so the result is deterministic.
export interface PairAspect<P extends string = string> extends AspectMatch {
  a: P;
  b: P;
}

export function pairAspects<P extends string>(
  points: ReadonlyArray<readonly [P, number]>,
  limits: readonly AspectLimit[],
): PairAspect<P>[] {
  assertAspectLimits(limits);
  const found: PairAspect<P>[] = [];
  points.forEach(([a, aLon], i) => {
    points.slice(i + 1).forEach(([b, bLon]) => {
      const sep = separation(aLon, bLon);
      for (const { type, orb: limit } of limits) {
        const orb = Math.abs(sep - type.angle);
        if (orb <= limit) {
          found.push({ a, b, aspect: type.key, angle: type.angle, orb, limit, strength: strength(orb, limit) });
        }
      }
    });
  });
  return found.sort((x, y) => y.strength - x.strength);
}

// The 17 vibrational aspects, each with its natal orb of 16 ÷ its harmonic. The orb follows the aspect's
// harmonic, not the chart's, so a harmonic 5 chart reads the same aspects with the same orbs.
export function vibrationalAspectLimits(): AspectLimit[] {
  return VIBRATIONAL_ASPECTS.map((type) => ({ type, orb: vibrationalNatalLimit(type.harmonic) }));
}

function assertMidpointConfig(config: MidpointConfig): void {
  if (config.aspects.length === 0) {
    throw new AstroError("the midpoint config lists no aspects", "Pass the aspect set, for example VIBRATIONAL_ASPECTS.");
  }
  assertAspects(config.aspects);
  assertOrb(config.orb, "the midpoint orb");
}

// Every aspect's harmonic must be a whole number in range, and its angle a number from 0 up to 360, so the reading of its
// angle is never silently skipped. Build each aspect with aspectType, which rounds its angle.
function assertAspects(aspects: readonly AspectType[]): void {
  for (const aspect of aspects) {
    assertHarmonic(aspect.harmonic);
    if (!Number.isFinite(aspect.angle) || aspect.angle < 0 || aspect.angle >= 360) {
      throw new AstroError(
        `the angle of ${aspect.key} must be a number from 0 up to 360, got ${String(aspect.angle)}`,
        "Build each aspect with aspectType(key, k, harmonic), as VIBRATIONAL_ASPECTS does.",
      );
    }
    // Harmonic 1 is the conjunction at 0 and harmonic 2 the opposition at 180. The midpoint reader takes its axis from these
    // angles, so any other angle at those harmonics would be skipped without a sound.
    const axis = AXIS_ANGLES.get(aspect.harmonic);
    if (axis !== undefined && aspect.angle !== axis) {
      throw new AstroError(
        `the angle of ${aspect.key} must be ${axis} for harmonic ${aspect.harmonic}, got ${String(aspect.angle)}`,
        "Build each aspect with aspectType(key, k, harmonic), as VIBRATIONAL_ASPECTS does.",
      );
    }
  }
}

// The only angle an aspect of harmonic 1 or 2 can have: 0 for the conjunction, 180 for the opposition.
const AXIS_ANGLES = new Map<number, number>([
  [1, 0],
  [2, 180],
]);

// Strength divides by the limit, so every limit must be a finite number above 0; otherwise it is NaN or infinite.
function assertAspectLimits(limits: readonly AspectLimit[]): void {
  for (const { type, orb } of limits) {
    assertOrb(orb, `the orb of ${type.key}`);
  }
}

function assertOrb(orb: number, what: string): void {
  if (!Number.isFinite(orb) || orb <= 0) {
    throw new AstroError(`${what} must be a positive number of degrees, got ${String(orb)}`, "Use an orb such as 2 degrees.");
  }
}

// Each body in OBJECT_CODES order, then ASC and MC: the canonical order for every pair and target, and for chartPoints.
// Midpoints and transits take ASC and MC from the angles only; DSC and IC are not targets, as in the oracle. Each entry is
// name, longitude and speed; an angle has no speed, so its speed is undefined.
function participants(
  positions: Positions,
  map: (lon: number) => number,
  mapAngle: (lon: number) => number = map,
): Array<[string, number, number | undefined]> {
  const out: Array<[string, number, number | undefined]> = [];
  for (const code of OBJECT_CODES) {
    const body = positions.bodies[code];
    if (body) {
      out.push([code, map(body.longitude), body.speed]);
    }
  }
  out.push(["ASC", mapAngle(positions.angles.ASC), undefined], ["MC", mapAngle(positions.angles.MC), undefined]);
  return out;
}

// A harmonic chart's angle or cusp, rounded to 6 decimals above H 1 as the oracle's harmonic_chart rounds its
// angles. H 1 is the natal chart, so its value stays exact. Rounding can reach 360, which is 0 on the circle.
function harmonicValue(lon: number, harmonic: number): number {
  const value = harmonicLongitude(lon, harmonic);
  if (harmonic === 1) {
    return value;
  }
  const rounded = round6(value);
  return rounded === 360 ? 0 : rounded;
}

// The best candidate: largest strength, then tightest orb, then the first. Undefined for none.
function bestOf<T extends { strength: number; orb: number }>(candidates: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const c of candidates) {
    if (!best || c.strength > best.strength || (c.strength === best.strength && c.orb < best.orb)) {
      best = c;
    }
  }
  return best;
}

// Wraps into [0, 360). An in-range value comes back unchanged, so H 1 keeps every longitude exact.
function mod360(x: number): number {
  const r = x % 360;
  const wrapped = r < 0 ? r + 360 : r;
  return wrapped === 360 ? 0 : wrapped;
}

// Rounds to 6 decimals from the exact binary value, as Python's round does except on exact ties.
function round6(x: number): number {
  return Number(x.toFixed(6));
}

// ---- Point sets: midpoint sets, and readings of one point set against another. ----
// Pure: no I/O, no engine. The longitudes and speeds are astrolog's, carried in by skyPoints or chartPoints.

// A body or an angle. `speed` is in degrees per day and is undefined when it is not known; an angle has none. `zodiac`
// is the zodiac of the result it came from, so readPointSets can refuse a natal point read against a sky point of another.
export interface PointEntry {
  name: string;
  kind: "point";
  longitude: number;
  speed?: number;
  zodiac: Ayanamsa;
}

// A point's name, longitude and speed, as a midpoint keeps them of each of its two points.
export interface Motion {
  name: string;
  longitude: number;
  speed?: number;
}

// The midpoint of two points, from midpointSet. Its speed is undefined when either point's speed is not known. `from` keeps
// the two points, so a reading can see the midpoint's own 180 degree flip, when its two points sit opposite each other.
export interface MidpointEntry {
  name: string;
  kind: "midpoint";
  longitude: number;
  speed?: number;
  zodiac: Ayanamsa;
  from: readonly [Motion, Motion];
}

// A point in a set. `longitude` is in degrees, 0 up to but not including 360.
export type SetPoint = PointEntry | MidpointEntry;

// What midpointSet takes: a body or an angle, with `kind` optional. A midpoint has kind "midpoint" and is refused by the
// type, so a midpoint of midpoints does not compile.
export interface PlacedPoint {
  name: string;
  kind?: "point";
  longitude: number;
  speed?: number;
  zodiac: Ayanamsa;
}

// The orb of each aspect in a point set reading. `point` is the limit of an aspect between two points that are not
// midpoints (vibrationalTransitLimit, for a transit). `midpoint` is the base orb of the classic midpoint rule: any pair with a
// midpoint takes midpointLimit(aspect, midpoint).
export interface PointOrbRule {
  point: (aspect: AspectType) => number;
  midpoint: number;
}

export interface PointSetOptions {
  aspects: readonly AspectType[];
  orb: PointOrbRule;
  // A hit is kept when its strength is at least this: 0 keeps every hit within its orb, 1 keeps exact hits only.
  minStrength: number;
}

// Whether a moving point's orb is shrinking over the look-ahead. "unknown" when its speed is not known, or when a fold is crossed
// inside the look-ahead (approachPhase); it is never guessed.
// Compare with ===. A string is truthy whichever value it holds, so `if (hit.phase)` would count separating and unknown too.
export type ApproachPhase = "applying" | "separating" | "unknown";

// One aspect between a moving point and a still point, with its best aspect only. The still point is held still. The codes
// are the object codes each point is made of: one for a body or an angle, the two of a midpoint, so no caller parses a name.
export interface PointSetHit extends AspectMatch {
  moving: string;
  movingKind: SetPoint["kind"];
  movingCodes: readonly string[];
  still: string;
  stillKind: SetPoint["kind"];
  stillCodes: readonly string[];
  phase: ApproachPhase;
}

// The vibrational orb rule: a point aspect takes the transit orb of its harmonic, as vibrationalTransitLimit gives it; a
// midpoint aspect takes the classic midpoint orb of VIBRATIONAL_MIDPOINT_ORB.
export const VIBRATIONAL_ORB_RULE: PointOrbRule = {
  point: vibrationalTransitLimit,
  midpoint: VIBRATIONAL_MIDPOINT_ORB,
};

// The points of a transit sky: every body in OBJECT_CODES order, each with its speed and the sky's zodiac.
export function skyPoints(sky: SkyPositions): PointEntry[] {
  const out: PointEntry[] = [];
  for (const code of OBJECT_CODES) {
    const body = sky.bodies[code];
    if (body) {
      out.push({ name: code, kind: "point", longitude: body.longitude, speed: body.speed, zodiac: sky.provenance.ayanamsa });
    }
  }
  return out;
}

// The points of a natal chart: every body in OBJECT_CODES order, then ASC and MC, in the order participants reads them.
// DSC and IC are left out, as in the oracle. The angles carry no speed.
export function chartPoints(positions: Positions): PointEntry[] {
  return participants(positions, (lon) => lon).map(
    ([name, longitude, speed]): PointEntry => ({
      name,
      kind: "point",
      longitude,
      speed,
      zodiac: positions.provenance.ayanamsa,
    }),
  );
}

// The midpoint set of plain points: the shorter-arc midpoint of every pair, in input order with i before j.
// The speed of a midpoint is the mean of its two speeds. That is the rate of the shorter-arc midpoint while the shorter arc
// does not change, which holds except when the two points are exactly 180 degrees apart. It is known whenever both are.
// The points must share one zodiac, which the midpoints keep.
export function midpointSet(points: readonly PlacedPoint[]): MidpointEntry[] {
  assertPoints(points);
  assertPlainPoints(points);
  assertOneZodiac(points);
  const out: MidpointEntry[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!;
      const b = points[j]!;
      const speed = a.speed === undefined || b.speed === undefined ? undefined : (a.speed + b.speed) / 2;
      out.push({
        name: `${a.name}/${b.name}`,
        kind: "midpoint",
        longitude: midpoint(a.longitude, b.longitude),
        speed,
        zodiac: a.zodiac,
        from: [
          { name: a.name, longitude: a.longitude, speed: a.speed },
          { name: b.name, longitude: b.longitude, speed: b.speed },
        ],
      });
    }
  }
  return out;
}

// Reads a moving point set against a still one. Each ordered pair keeps its best aspect, as matchAspect picks it. A hit is
// kept when its strength is at least minStrength, and the hits are sorted by strength, largest first. Equal strengths
// keep the order of the moving set, then of the still set, because the sort is stable and the pairs are built in that
// order. The still set is held still, as natal positions are in transitAspects. A point paired with itself, the same object
// on both sides, is skipped, so one set passed on both sides gives no self-pairs; copies of a point are not recognised.
// Every point of both sets must share one zodiac: a natal point read against a sky point of another zodiac is refused.
export function readPointSets(
  moving: readonly SetPoint[],
  still: readonly SetPoint[],
  options: PointSetOptions,
): PointSetHit[] {
  assertPointSetOptions(options);
  assertPoints(moving);
  assertPoints(still);
  assertOneZodiac([...moving, ...still]);
  const limits: AspectLimit[] = options.aspects.map((type) => ({ type, orb: options.orb.point(type) }));
  assertAspectLimits(limits);
  const hits: PointSetHit[] = [];
  for (const m of moving) {
    for (const s of still) {
      if (m === s) {
        continue;
      }
      const hit = readPair(m, s, limits, options.orb.midpoint);
      if (hit && hit.strength >= options.minStrength) {
        hits.push(hit);
      }
    }
  }
  return hits.sort((x, y) => y.strength - x.strength);
}

// Whether a hit's moving point is applying. Unknown and separating are both false here: read the phase to tell them apart.
export function isApplying(hit: PointSetHit): boolean {
  return hit.phase === "applying";
}

// The four pairings of a transit point set against a natal point set, in the order they are read and merged. T is a transiting
// point and Tm the midpoint of two transiting points; N is a natal point (a body, ASC or MC) and Nm the midpoint of two natal
// points. Every reading takes the same options.
export const PAIRING_LABELS = ["T to N", "T to Nm", "Tm to N", "Tm to Nm"] as const;

export type PairingLabel = (typeof PAIRING_LABELS)[number];

// The four pairings of a sky against a natal chart. Takes the two results, not bare points, so the zodiac is checked
// (assertSameZodiac) before any point is built.
export function readPairings(
  sky: SkyPositions,
  natal: Positions,
  options: PointSetOptions,
): Record<PairingLabel, PointSetHit[]> {
  assertSameZodiac(natal, sky);
  const transit = skyPoints(sky);
  const natalPoints = chartPoints(natal);
  const transitMidpoints = midpointSet(transit);
  const natalMidpoints = midpointSet(natalPoints);
  return {
    "T to N": readPointSets(transit, natalPoints, options),
    "T to Nm": readPointSets(transit, natalMidpoints, options),
    "Tm to N": readPointSets(transitMidpoints, natalPoints, options),
    "Tm to Nm": readPointSets(transitMidpoints, natalMidpoints, options),
  };
}

// Throws AstroError when the points come from more than one zodiac. Each point names the zodiac of its result.
function assertOneZodiac(points: readonly { zodiac: Ayanamsa }[]): void {
  const [first] = points;
  if (!first) {
    return;
  }
  const other = points.find((point) => point.zodiac !== first.zodiac);
  if (other) {
    throw new AstroError(
      `the points are in different zodiacs: ${first.zodiac} and ${other.zodiac}`,
      "Read points cast with the same ayanamsa, or read both in tropical.",
    );
  }
}

// The best aspect of one moving point to one still point, or undefined when none is within its limit. A pair with a midpoint
// takes the classic reading (matchMidpointAspect) with the midpoint orb. A pair of points takes the point limit of each aspect.
function readPair(m: SetPoint, s: SetPoint, limits: readonly AspectLimit[], midpointOrb: number): PointSetHit | undefined {
  const sep = separation(m.longitude, s.longitude);
  const classic = m.kind === "midpoint" || s.kind === "midpoint";
  const best = classic
    ? matchMidpointAspect(sep, limits.map((limit) => limit.type), midpointOrb)
    : matchAspect(sep, limits);
  if (!best) {
    return undefined;
  }
  return {
    moving: m.name,
    movingKind: m.kind,
    movingCodes: codesOf(m),
    still: s.name,
    stillKind: s.kind,
    stillCodes: codesOf(s),
    ...best,
    phase: approach(m, s.longitude, best),
  };
}

// The object codes a point is made of: its own code for a body or an angle, the two codes of a midpoint.
function codesOf(point: SetPoint): string[] {
  return point.kind === "midpoint" ? point.from.map((part) => part.name) : [point.name];
}

// The phase of one moving point's orb to one aspect of a still point. A midpoint whose two points are unknown is unknown; the
// rest is approachPhase on the midpoint's own longitude and speed.
function approach(m: SetPoint, stillLongitude: number, best: AspectMatch): ApproachPhase {
  if (m.kind === "midpoint" && midpointFlips(m.from)) {
    return "unknown";
  }
  if (m.speed === undefined) {
    return "unknown";
  }
  return approachPhase(m.longitude, m.speed, stillLongitude, best);
}

// The signed offsets where separation folds: a body on the same longitude as the point, or opposite it.
const FOLD_ANGLES = [-180, 0, 180] as const;

// The phase of a moving body's orb to one aspect over the look-ahead: applying when the orb shrinks, separating when it grows,
// and unknown when a fold is crossed inside the look-ahead. The folds are the separation's kinks, 0 and 180, and the aspect's own
// exact points, at its angle and its mirror image: the orb passes through zero there, and a straight step across one reads a
// contact passed inside the look-ahead as separating. Between folds the orb is monotone, so comparing its two ends is exact.
export function approachPhase(longitude: number, speed: number, stillLongitude: number, best: AspectMatch): ApproachPhase {
  const step = speed * TRANSIT_LOOK_AHEAD_DAYS;
  const now = mod360(longitude - stillLongitude + 180) - 180;
  const later = now + step;
  const lo = Math.min(now, later);
  const hi = Math.max(now, later);
  const exact = [best.angle, -best.angle];
  if ([...FOLD_ANGLES, ...exact].some((fold) => lo < fold && fold < hi)) {
    return "unknown";
  }
  const ahead = separation(longitude + step, stillLongitude);
  return Math.abs(ahead - best.angle) < best.orb ? "applying" : "separating";
}

// A midpoint's shorter arc flips when its two points are 180 degrees apart: the midpoint then jumps to the other side of the
// circle. A look-ahead that crosses that gap is unknown, and so is one whose points have no known speed.
function midpointFlips(from: readonly [Motion, Motion]): boolean {
  const [a, b] = from;
  if (a.speed === undefined || b.speed === undefined) {
    return true;
  }
  const now = mod360(a.longitude - b.longitude + 180) - 180;
  const later = now + (a.speed - b.speed) * TRANSIT_LOOK_AHEAD_DAYS;
  const lo = Math.min(now, later);
  const hi = Math.max(now, later);
  // Inclusive: opposite points now are already ambiguous, so the endpoints count as a flip.
  return (lo <= 180 && 180 <= hi) || (lo <= -180 && -180 <= hi);
}


function assertPointSetOptions(options: PointSetOptions): void {
  if (options.aspects.length === 0) {
    throw new AstroError("the point set reading lists no aspects", "Pass the aspect set, for example VIBRATIONAL_ASPECTS.");
  }
  assertAspects(options.aspects);
  assertOrb(options.orb.midpoint, "the midpoint orb");
  if (!Number.isFinite(options.minStrength) || options.minStrength < 0 || options.minStrength > 1) {
    throw new AstroError(
      `minStrength must be a number from 0 to 1, got ${String(options.minStrength)}`,
      "Use 0 to keep every hit within its orb, or 1 to keep exact hits only.",
    );
  }
}

// A midpoint set takes plain points. A midpoint is refused at run time too, for a caller that does not check types.
function assertPlainPoints(points: readonly PlacedPoint[]): void {
  for (const p of points) {
    if ((p as SetPoint).kind === "midpoint") {
      throw new AstroError(
        `point ${p.name} is a midpoint, and a midpoint set takes plain points`,
        "Pass the points themselves; midpointSet builds the midpoints of every pair.",
      );
    }
  }
}

// Longitudes and speeds are astrolog's numbers, so a non-finite one is a caller bug and is refused.
function assertPoints(points: readonly Pick<SetPoint, "name" | "longitude" | "speed">[]): void {
  for (const p of points) {
    if (!Number.isFinite(p.longitude) || (p.speed !== undefined && !Number.isFinite(p.speed))) {
      throw new AstroError(
        `point ${p.name} has a longitude or speed that is not a finite number`,
        "Pass longitudes in degrees, and speeds in degrees per day or left out when they are not known.",
      );
    }
  }
}

// ---- Daily reading: the sky at three moments of one local day. ----
// Pure: no I/O, no engine. The natal chart and the three sky samples are astrolog's, already in one harmonic and one zodiac
// (the caller applies harmonicPositions and harmonicSky). A day runs from local midnight, fraction 0, to the next local
// midnight, fraction 1. Between samples each longitude is the quadratic through its three values, so an exact moment is a
// root of that quadratic and an orb is the closest approach of one. A classic midpoint is the midpoint of two bodies by the
// shorter arc. It jumps by 180 degrees when the two are exactly opposite, so its path is cut at those moments.

const DAY_START = 0;
const DAY_END = 1;
const EPSILON = 1e-12;

// The Moon's object code, which the daily reading names on its own and in midpoints.
export const MOON_CODE: ObjectCode = "Moo";

// The transiting bodies that count as outer: Jupiter and beyond. A hit by one of them weighs more (see dailyScore).
export const OUTER_CODES: readonly ObjectCode[] = ["Jup", "Sat", "Ura", "Nep", "Plu"];

// The natal points whose hits weigh more: the Sun, the Moon, the Ascendant and the Midheaven.
export const KEY_POINT_NAMES = ["Sun", MOON_CODE, "ASC", "MC"] as const;

export function isKeyPoint(name: string): boolean {
  return KEY_POINT_NAMES.some((key) => key === name);
}

// The weights of a hit's score: a transiting outer body adds OUTER_BONUS to the weight of 1, a key natal point adds KEY_BONUS.
// The largest weight, MAX_WEIGHT, is the divisor, so a score stays between 0 and 1.
export const OUTER_BONUS = 0.25;
export const KEY_BONUS = 0.25;
export const MAX_WEIGHT = 1 + OUTER_BONUS + KEY_BONUS;

// The score of a hit, from 0 to 1: orb tightness times weight. Tightness is 1 at exact and 0 at the edge of the orb.
export function dailyScore(orb: number, limit: number, outer: boolean, key: boolean): number {
  const weight = 1 + (outer ? OUTER_BONUS : 0) + (key ? KEY_BONUS : 0);
  return ((1 - orb / limit) * weight) / MAX_WEIGHT;
}

// The fastest motion a day's reading allows, in degrees a day, for one body or for the difference of two bodies. The Moon moves
// about 15.5 degrees a day at most and the fastest other body about 2, so 20 leaves a margin.
export const MAX_DAILY_MOTION = 20;

// The shortest local day, in hours. Clocks move by 2 hours in a few zones (Antarctica/Troll gives 22 and 26), so 22 is the
// shortest day any zone has, and it allows the largest harmonic.
export const SHORTEST_DAY_HOURS = 22;

// The largest harmonic a day of `hours` hours is read in. The two samples of a day are half a day apart, so between them a body
// moves MAX_DAILY_MOTION × (hours ÷ 2) ÷ 24 degrees, and the harmonic multiplies that. The step must stay under 180 degrees, or the
// reading cannot tell a forward move from a backward one: 432 ÷ hours, rounded down. That is 18 on a 24-hour day and 17 on 25.
export function maxDayHarmonic(hours: number): number {
  return Math.floor(180 / ((MAX_DAILY_MOTION * (hours / 2)) / 24));
}

// The largest harmonic any day accepts: the shortest day's, since a shorter day allows a larger harmonic. A day's own cap is
// maxDayHarmonic of its hours, and it is lower on a longer day.
export const MAX_DAY_HARMONIC = maxDayHarmonic(SHORTEST_DAY_HOURS);

// The score as the result shows it: two places. The cut for min_strength and the order use this value, so a hit is never kept
// below its cut because of digits the result does not show.
export function shownScore(score: number): number {
  return Math.round(score * 100) / 100;
}

// The phase of a day's hit: the point-set ApproachPhase without "unknown", since a day's path is known in full. See
// closestApproach for where it changes.
export type DayPhase = Exclude<ApproachPhase, "unknown">;

// A quadratic y(x) = c + b·x + a·x², with x a fraction of the day.
export interface Quadratic {
  a: number;
  b: number;
  c: number;
}

// Three values at the three sample fractions, in order.
type Nodes = readonly [number, number, number];

// The quadratic through three samples at fractions xs, by Newton's divided differences.
function quadraticThrough(xs: Nodes, ys: Nodes): Quadratic {
  const [x0, x1, x2] = xs;
  const [y0, y1, y2] = ys;
  const slope01 = (y1 - y0) / (x1 - x0);
  const slope12 = (y2 - y1) / (x2 - x1);
  const a = (slope12 - slope01) / (x2 - x0);
  const b = slope01 - a * (x0 + x1);
  return { a, b, c: y0 - b * x0 - a * x0 * x0 };
}

function evalQuadratic(q: Quadratic, x: number): number {
  return q.c + x * (q.b + q.a * x);
}

function slopeAt(q: Quadratic, x: number): number {
  return q.b + 2 * q.a * x;
}

// The roots of q in [lo, hi], ascending. A quadratic that is zero throughout has the root lo, so it is exact from lo on.
export function quadraticRoots(q: Quadratic, lo: number, hi: number): number[] {
  const { a, b, c } = q;
  let roots: number[];
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) < EPSILON) {
      return Math.abs(c) < EPSILON ? [lo] : [];
    }
    roots = [-c / b];
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) {
      return [];
    }
    // The stable form: the root that adds like signs is computed first, so a small a does not cancel the other root.
    const root = Math.sqrt(disc);
    const q = -0.5 * (b + (b < 0 ? -root : root));
    roots = q === 0 ? [0] : [q / a, c / q];
  }
  return roots.filter((x) => x >= lo && x <= hi).sort((x, y) => x - y);
}

// Wraps into (-180, 180].
function wrap180(x: number): number {
  const r = ((x % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

// Each value moved by whole turns so that it lies within half a turn of the one before. The first value is kept.
function unwrapped(values: Nodes): Nodes {
  const second = values[0] + wrap180(values[1] - values[0]);
  return [values[0], second, second + wrap180(values[2] - values[1])];
}

// A moving point's path over the day: its classic longitude as a quadratic on each segment, cut where it jumps.
interface PathSegment {
  lo: number;
  hi: number;
  q: Quadratic;
}

// A body's path: one segment, the unwrapped longitude through its samples.
function bodyPath(longitudes: Nodes, xs: Nodes): PathSegment[] {
  return [{ lo: DAY_START, hi: DAY_END, q: quadraticThrough(xs, unwrapped(longitudes)) }];
}

// A classic midpoint's path. The midpoint is first + gap / 2, where gap is the unwrapped signed difference: that sum is
// continuous. The classic midpoint is the sum plus 180 degrees while |gap| is over 180, so the path is cut where gap
// crosses 180 or -180, and each segment is one continuous quadratic.
function midpointPath(first: Nodes, second: Nodes, xs: Nodes): PathSegment[] {
  const starts = unwrapped(first);
  const gap = unwrapped([wrap180(second[0] - first[0]), second[1] - first[1], second[2] - first[2]]);
  const sums = nodes((k) => starts[k]! + gap[k]! / 2);
  const delta = quadraticThrough(xs, gap);
  const sum = quadraticThrough(xs, sums);
  const cuts = [...quadraticRoots(shifted(delta, -180), DAY_START, DAY_END), ...quadraticRoots(shifted(delta, 180), DAY_START, DAY_END)]
    .filter((x) => x > DAY_START && x < DAY_END)
    .sort((x, y) => x - y);
  const edges = [DAY_START, ...cuts, DAY_END];
  return edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1]!;
    const jump = Math.abs(evalQuadratic(delta, (lo + hi) / 2)) > 180 ? 180 : 0;
    return { lo, hi, q: { ...sum, c: sum.c + jump } };
  });
}

function shifted(q: Quadratic, by: number): Quadratic {
  return { ...q, c: q.c + by };
}

function nodes(value: (k: number) => number): Nodes {
  return [value(0), value(1), value(2)];
}

// What one segment of a path says about an aspect: the least orb over the segment, where it falls, whether the orb is
// applying there, and the exact moment the path reaches the angle inside the day (before the next midnight).
interface OrbReading {
  orb: number;
  at: number;
  applying: boolean;
  exact?: number;
}

// Reads one segment against an angle that q is measured from: q is the path minus the angle, so 0 is exact. The least orb
// is at the start of the segment, at its end, or at the turn of the quadratic inside it, and the orb at a turn is the least
// orb of the segment, since the path does not cross the angle. The phase is applying when the least orb comes after the
// start, so the orb shrinks into it. The start reads separating, as the orb grows from there: that holds for the day's start
// and for a cut start, where a midpoint jumps by 180 degrees, so a jump into orb is separating from that moment. An exact hit
// reads applying.
function closestApproach(q: Quadratic, lo: number, hi: number): OrbReading {
  const exact = quadraticRoots(q, lo, hi).find((x) => x < DAY_END);
  if (exact !== undefined) {
    return { orb: 0, at: exact, applying: true, exact };
  }
  const candidates = [lo, hi];
  if (Math.abs(q.a) >= EPSILON) {
    const vertex = -q.b / (2 * q.a);
    if (vertex > lo && vertex < hi) {
      candidates.push(vertex);
    }
  }
  let best: OrbReading | undefined;
  for (const x of candidates) {
    const value = evalQuadratic(q, x);
    if (best === undefined || Math.abs(value) < best.orb) {
      best = { orb: Math.abs(value), at: x, applying: x > lo };
    }
  }
  return best as OrbReading;
}

// Reads a whole path against one target longitude. An exact moment in any segment wins, the first one in the day; otherwise
// the least orb does.
function scanPath(path: readonly PathSegment[], target: number): OrbReading {
  let best: OrbReading | undefined;
  for (const { lo, hi, q } of path) {
    // Whole turns put the segment's middle within half a turn of the target, so the quadratic reads the nearest orb.
    const turns = Math.round((evalQuadratic(q, (lo + hi) / 2) - target) / 360);
    const reading = closestApproach({ ...q, c: q.c - target - 360 * turns }, lo, hi);
    if (best === undefined || isBetterReading(reading, best)) {
      best = reading;
    }
  }
  return best as OrbReading;
}

// An exact reading beats one that is not, and the earlier exact moment beats a later one. Otherwise the lesser orb wins.
function isBetterReading(reading: OrbReading, best: OrbReading): boolean {
  if (reading.exact === undefined) {
    return best.exact === undefined && reading.orb < best.orb;
  }
  return best.exact === undefined || reading.exact < best.exact;
}

// A moving point of the day: a body or a transit midpoint, its path, and its samples for the cheap first test.
interface MovingPoint {
  name: string;
  codes: readonly string[];
  kind: "point" | "midpoint";
  outer: boolean;
  samples: Nodes;
  path: PathSegment[];
}

// A fixed point: a natal body, ASC or MC, or a natal midpoint.
interface StillPoint {
  name: string;
  codes: readonly string[];
  kind: "point" | "midpoint";
  longitude: number;
  key: boolean;
}

// One aspect of one moving point to one fixed point over the day: its strongest side within the orb, as DayHit states it.
type DayAspect = Pick<DayHit, "aspect" | "orb" | "limit" | "score" | "phase" | "exact">;

// The least distance from the offset over the three signed samples.
function nearestOrb(signed: Nodes, offset: number): number {
  return Math.min(Math.abs(fold(signed[0] - offset)), Math.abs(fold(signed[1] - offset)), Math.abs(fold(signed[2] - offset)));
}

// A signed distance differenced with another, folded into (-180, 180]. Both inputs are already in (-180, 180], so the
// difference lies in [-360, 360] and one step of 360 is enough; this avoids the modulo in the hot loop.
function fold(x: number): number {
  return x > 180 ? x - 360 : x < -180 ? x + 360 : x;
}

// One aspect of a day's reading, with the orb it allows a point pair and a midpoint pair, and the angles it is met at.
interface AspectTest {
  key: string;
  pointLimit: number;
  midpointLimit: number;
  offsets: readonly number[];
}

// The aspect tests of the set. An aspect at 0 or 180 is one angle; any other is met on either side, so it has two offsets.
function aspectTests(aspects: readonly AspectType[]): AspectTest[] {
  return aspects.map((aspect) => ({
    key: aspect.key,
    pointLimit: vibrationalTransitLimit(aspect),
    midpointLimit: midpointLimit(aspect, VIBRATIONAL_MIDPOINT_ORB),
    offsets: aspect.angle === 0 || aspect.angle === 180 ? [aspect.angle] : [aspect.angle, -aspect.angle],
  }));
}

// Whether `next` is a stronger reading of one aspect than `best`: the higher score, then the smaller orb, then the earlier exact
// moment. An aspect with two sides (at +angle and at -angle) reports the stronger side, so a tie takes the side that is exact first.
function isStrongerAspect(next: DayAspect, best: DayAspect): boolean {
  if (next.score !== best.score) {
    return next.score > best.score;
  }
  if (next.orb !== best.orb) {
    return next.orb < best.orb;
  }
  return next.exact !== undefined && (best.exact === undefined || next.exact < best.exact);
}

// Every aspect of one moving point to one fixed point that comes within its orb during the day, one entry per aspect, in the order
// of the aspect tests. A pair with a midpoint takes the classic midpoint orb. The three samples make a cheap first test: a path can
// come within an orb only when a sample is near it, so a pair the samples place far from every aspect is skipped without a full read.
function aspectsOf(moving: MovingPoint, still: StillPoint, tests: readonly AspectTest[]): DayAspect[] {
  const classic = moving.kind === "midpoint" || still.kind === "midpoint";
  const signed = nodes((k) => wrap180(moving.samples[k]! - still.longitude));
  // The largest change in the signed distance between neighbouring samples. Within a quarter day of a sample the distance moves
  // by about half of it, so this slack, the change plus half a degree, keeps every aspect that comes within its orb between
  // the samples.
  const slack = Math.max(Math.abs(fold(signed[1] - signed[0])), Math.abs(fold(signed[2] - signed[1]))) + 0.5;
  const found: DayAspect[] = [];
  for (const test of tests) {
    const limit = classic ? test.midpointLimit : test.pointLimit;
    let best: DayAspect | undefined;
    for (const offset of test.offsets) {
      if (nearestOrb(signed, offset) > limit + slack) {
        continue;
      }
      const reading = scanPath(moving.path, still.longitude + offset);
      if (reading.orb > limit) {
        continue;
      }
      const candidate: DayAspect = {
        aspect: test.key,
        orb: reading.orb,
        limit,
        score: dailyScore(reading.orb, limit, moving.outer, still.key),
        phase: reading.applying ? "applying" : "separating",
        exact: reading.exact,
      };
      if (best === undefined || isStrongerAspect(candidate, best)) {
        best = candidate;
      }
    }
    if (best !== undefined) {
      found.push(best);
    }
  }
  return found;
}

// One aspect hit of the day, between a moving point and a fixed point. A pair keeps each of its aspects that comes within orb, once
// each. `exact` is the fraction of the day when the aspect is exact, or undefined when it does not perfect within the day. `orb` is
// the least orb over the day, in degrees, and `score` is dailyScore at that orb. `movingCodes` and `stillCodes` are the object
// codes each point is made of: one for a body or an angle, two for a midpoint.
export interface DayHit {
  pairing: PairingLabel;
  moving: string;
  movingCodes: readonly string[];
  still: string;
  stillCodes: readonly string[];
  aspect: string;
  orb: number;
  limit: number;
  score: number;
  phase: DayPhase;
  exact?: number;
}

// A body that changes sign, or moves into another natal house, at the fraction `at` of the day. The union is told apart by
// `change`: a sign change gives sign indexes from Aries (0), and a house change gives natal house numbers from 1 to 12.
interface DayIngressBase {
  body: ObjectCode;
  at: number;
}

export interface DaySignChange extends DayIngressBase {
  change: "sign";
  from: number;
  to: number;
}

export interface DayHouseChange extends DayIngressBase {
  change: "house";
  from: HouseNumber;
  to: HouseNumber;
}

export type DayIngress = DaySignChange | DayHouseChange;

// A body whose retrograde flag changes at the fraction `at` of the day.
export interface DayStation {
  body: ObjectCode;
  to: "retrograde" | "direct";
  at: number;
}

export interface DayReadingInput {
  natal: Positions;
  // Local midnight, the middle of the day, and the next local midnight, in order. Each is harmonic if the natal chart is.
  sky: readonly [SkyPositions, SkyPositions, SkyPositions];
  // The fraction of the day at the middle sample, strictly between 0 and 1.
  middle: number;
  aspects: readonly AspectType[];
  // A hit is kept when its score, to two places as the result shows it, is at least this: 0 keeps every hit within its orb.
  minScore: number;
}

// The day's facts. Hits are sorted by score, largest first, then by the smaller orb; ingresses and stations by time. `missing`
// names every body that an engine call did not compute.
export interface DayReading {
  hits: DayHit[];
  ingresses: DayIngress[];
  stations: DayStation[];
  missing: ObjectCode[];
}

// Reads a day against a natal chart: the four pairings of the transiting bodies and their midpoints against the natal points
// and natal midpoints, the sign and natal house changes of every body, and its retrograde changes. Every body must be in all
// three samples; a body that is not is left out and named in `missing`.
export function readDay(input: DayReadingInput): DayReading {
  const { natal, sky, aspects, minScore } = input;
  for (const s of sky) {
    assertSameZodiac(natal, s);
  }
  const xs: Nodes = [DAY_START, input.middle, DAY_END];
  const tests = aspectTests(aspects);
  const present = OBJECT_CODES.filter((code) => sky.every((s) => s.bodies[code] !== undefined));
  const longitudesOf = (code: ObjectCode): Nodes => nodes((k) => sky[k]!.bodies[code]!.longitude);
  const speedsOf = (code: ObjectCode): Nodes => nodes((k) => sky[k]!.bodies[code]!.speed);

  const bodies: MovingPoint[] = present.map((code) => ({
    name: code,
    codes: [code],
    kind: "point",
    outer: OUTER_CODES.includes(code),
    samples: longitudesOf(code),
    path: bodyPath(longitudesOf(code), xs),
  }));
  const midpoints: MovingPoint[] = [];
  present.forEach((a, i) => {
    present.slice(i + 1).forEach((b) => {
      const first = longitudesOf(a);
      const second = longitudesOf(b);
      midpoints.push({
        name: `${a}/${b}`,
        codes: [a, b],
        kind: "midpoint",
        outer: false,
        samples: nodes((k) => midpoint(first[k]!, second[k]!)),
        path: midpointPath(first, second, xs),
      });
    });
  });

  const chart = chartPoints(natal);
  const stills: StillPoint[] = [
    ...chart.map((p): StillPoint => ({ name: p.name, codes: codesOf(p), kind: "point", longitude: p.longitude, key: isKeyPoint(p.name) })),
    ...midpointSet(chart).map(
      (m): StillPoint => ({ name: m.name, codes: codesOf(m), kind: "midpoint", longitude: m.longitude, key: false }),
    ),
  ];

  const hits: DayHit[] = [];
  for (const moving of [...bodies, ...midpoints]) {
    for (const still of stills) {
      const pairing = `${moving.kind === "midpoint" ? "Tm" : "T"} to ${still.kind === "midpoint" ? "Nm" : "N"}` as PairingLabel;
      for (const aspect of aspectsOf(moving, still, tests)) {
        if (shownScore(aspect.score) >= input.minScore) {
          hits.push({
            pairing,
            moving: moving.name,
            movingCodes: moving.codes,
            still: still.name,
            stillCodes: still.codes,
            ...aspect,
          });
        }
      }
    }
  }
  // The order is the one the result shows: the higher score first, then the tighter orb, then the order they were read in.
  hits.sort((x, y) => shownScore(y.score) - shownScore(x.score) || x.orb - y.orb);

  const ingresses = bodies.flatMap((body) => {
    const q = body.path[0]!.q;
    return [...signChanges(body.name as ObjectCode, q), ...houseChanges(body.name as ObjectCode, q, natal.houses)];
  });
  ingresses.sort((x, y) => x.at - y.at);

  const stations = present.flatMap((code) => stationsOf(code, speedsOf(code), xs));
  stations.sort((x, y) => x.at - y.at);

  const missing = OBJECT_CODES.filter((code) => natal.missing.includes(code) || sky.some((s) => s.missing.includes(code)));
  return { hits, ingresses, stations, missing };
}

// The range of a quadratic over the day: its least and greatest value.
function rangeOver(q: Quadratic): [number, number] {
  const values = [evalQuadratic(q, DAY_START), evalQuadratic(q, DAY_END)];
  if (Math.abs(q.a) >= EPSILON) {
    const vertex = -q.b / (2 * q.a);
    if (vertex > DAY_START && vertex < DAY_END) {
      values.push(evalQuadratic(q, vertex));
    }
  }
  return [Math.min(...values), Math.max(...values)];
}

// The times in the day, before the next midnight, when a body's longitude passes the value. A passage with no slope is not a
// crossing: a body that does not move never crosses anything.
function passages(q: Quadratic, value: number): { at: number; rising: boolean }[] {
  return quadraticRoots(shifted(q, -value), DAY_START, DAY_END)
    .filter((x) => x < DAY_END && Math.abs(slopeAt(q, x)) > EPSILON)
    .map((at) => ({ at, rising: slopeAt(q, at) > 0 }));
}

function mod12(k: number): number {
  return ((k % 12) + 12) % 12;
}

// The sign changes of one body: every multiple of 30 degrees it passes. A rising body enters the sign that starts there.
function signChanges(body: ObjectCode, q: Quadratic): DaySignChange[] {
  const [low, high] = rangeOver(q);
  const out: DaySignChange[] = [];
  for (let k = Math.ceil(low / 30); 30 * k <= high; k++) {
    for (const { at, rising } of passages(q, 30 * k)) {
      const [before, after] = [mod12(k - 1), mod12(k)];
      out.push({ body, change: "sign", from: rising ? before : after, to: rising ? after : before, at });
    }
  }
  return out;
}

// The natal house changes of one body: every cusp it passes, the cusps repeating every turn. A rising body enters the house
// that starts at the cusp.
function houseChanges(body: ObjectCode, q: Quadratic, cusps: Positions["houses"]): DayHouseChange[] {
  const [low, high] = rangeOver(q);
  const out: DayHouseChange[] = [];
  for (const n of HOUSE_NUMBERS) {
    const cusp = cusps[n];
    const previous = (n === 1 ? 12 : n - 1) as HouseNumber;
    for (let t = Math.ceil((low - cusp) / 360); cusp + 360 * t <= high; t++) {
      for (const { at, rising } of passages(q, cusp + 360 * t)) {
        out.push({ body, change: "house", from: rising ? previous : n, to: rising ? n : previous, at });
      }
    }
  }
  return out;
}

// The retrograde changes of one body between two samples: the speed quadratic is zero where the flag changes, found by
// halving between the samples.
function stationsOf(code: ObjectCode, speeds: Nodes, xs: Nodes): DayStation[] {
  const speed = quadraticThrough(xs, speeds);
  const out: DayStation[] = [];
  for (let k = 0; k < 2; k++) {
    const before = speeds[k]! < 0;
    if (before === (speeds[k + 1]! < 0)) {
      continue;
    }
    const at = halve(speed, xs[k]!, xs[k + 1]!, before);
    if (at < DAY_END) {
      out.push({ body: code, to: before ? "direct" : "retrograde", at });
    }
  }
  return out;
}

// The point between lo and hi where the speed turns sign, found by halving the interval. `below` says whether the speed is
// negative at lo, so the half that keeps that sign is the one to keep.
function halve(speed: Quadratic, lo: number, hi: number, below: boolean): number {
  let start = lo;
  let end = hi;
  for (let i = 0; i < 60; i++) {
    const middle = (start + end) / 2;
    if ((evalQuadratic(speed, middle) < 0) === below) {
      start = middle;
    } else {
      end = middle;
    }
  }
  return (start + end) / 2;
}
