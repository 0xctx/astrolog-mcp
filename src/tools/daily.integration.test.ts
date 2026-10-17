import pLimit from "p-limit";
import { beforeAll, describe, expect, it } from "vitest";
import { depsFromEngine, type ToolDeps } from "./deps.js";
import { dailyInputSchema, getDailyTransits, type DailyOutput } from "./daily.js";
import { midpoint, VIBRATIONAL_ASPECTS } from "../math.js";
import { resolveBirth } from "./input.js";
import type { ObjectCode, UtcMoment } from "../types.js";

// The daily reading against the real binary. Skipped unless ASTROLOG_BIN is set.
const bin = process.env.ASTROLOG_BIN;
const suite = bin ? describe : describe.skip;
const NATAL = { birth_date: "1990-06-15", birth_time: "14:30", latitude: 40.7, longitude: -73.9, timezone: "UTC" };

// 14 October 2026 in UT: the Moon leaves Scorpio for Sagittarius at 00:59 UT, a little after local midnight.
const MOON_DAY = "2026-10-14";

// 16 February 2026 in UT: Jupiter conjoins the natal Jupiter at 13:55 UT, an exact slow-body hit.
const SLOW_DAY = "2026-02-16";

// 18 March 2026 in UT: the midpoint of the Moon and Jupiter conjoins the natal MC at 17:58 UT, an exact transit-midpoint hit.
const MIDPOINT_DAY = "2026-03-18";

// The fine sampling that checks the tool's exact times: one engine sky every ten minutes across the day.
const FINE_STEP_MS = 600_000;
const DAY_START_MS = Date.parse("2026-10-14T00:00:00Z");
const FINE_COUNT = 24 * 6 + 1;

function shifted(utc: string, ms: number): UtcMoment {
  return new Date(Date.parse(utc) + ms).toISOString().replace(".000Z", "Z") as UtcMoment;
}

function utcOf(ms: number): UtcMoment {
  return new Date(ms).toISOString().replace(".000Z", "Z") as UtcMoment;
}

// The signed distance from target to a longitude, in (-180, 180].
function signedDistance(longitude: number, target: number): number {
  const r = ((((longitude - target) % 360) + 360) % 360);
  return r > 180 ? r - 360 : r;
}

// Every moment in the fine samples when a longitude passes a target. Between two samples ten minutes apart a body moves a
// fraction of a degree, so the crossing is the linear interpolation of the two sides, and a jump of 90 degrees or more
// is a wrap, not a crossing.
function crossings(samples: readonly { at: number; longitude: number }[], target: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < samples.length; i++) {
    const before = signedDistance(samples[i]!.longitude, target);
    const after = signedDistance(samples[i + 1]!.longitude, target);
    if ((before < 0) !== (after < 0) && Math.abs(after - before) < 90) {
      out.push(samples[i]!.at + (-before / (after - before)) * FINE_STEP_MS);
    }
  }
  return out;
}

suite("get_daily_transits on the real engine", () => {
  let deps: ToolDeps;
  let output: DailyOutput;

  beforeAll(async () => {
    deps = await depsFromEngine("astrolog", { ...process.env, ASTROLOG_BIN: bin });
    output = await getDailyTransits(dailyInputSchema.parse({ ...NATAL, date: MOON_DAY }), deps, pLimit(4));
  }, 120_000);

  it("reports the Moon's entry into Sagittarius with a time the engine's own sky confirms", async () => {
    const [change] = output.moon.sign_changes.items;
    expect(change).toMatchObject({ body: "Moo", change: "sign", from: "Scorpio", to: "Sagittarius" });

    // Two minutes either side of the reported time, the engine's Moon is on either side of 240 degrees, the start of Sagittarius.
    const at = change!.at_utc as UtcMoment;
    const before = await deps.engine.sky({ utc: shifted(at, -120_000), ayanamsa: "tropical" });
    const after = await deps.engine.sky({ utc: shifted(at, 120_000), ayanamsa: "tropical" });
    expect(before.bodies.Moo!.longitude).toBeLessThan(240);
    expect(after.bodies.Moo!.longitude).toBeGreaterThanOrEqual(240);
    expect(change!.at_local).toBe("00:59");
  });

  it("ranks the hits, caps the list at the limit with the total, and keeps every exact time inside the day", async () => {
    expect(output.day).toMatchObject({ timezone: "UTC", hours: 24, start_utc: "2026-10-14T00:00:00Z", end_utc: "2026-10-15T00:00:00Z" });
    expect(output.hits.total).toBeGreaterThan(output.hits.items.length);
    expect(output.hits.items).toHaveLength(10);
    expect(output.hits.truncated).toBe(true);
    // The default set ranks the five major aspects only, so no minor aspect reaches the top of the day.
    expect(output.meta.aspects).toBe("major");
    expect(output.hits.items.every((hit) => ["conjunction", "opposition", "trine", "square", "sextile"].includes(hit.aspect))).toBe(true);
    for (let i = 1; i < output.hits.items.length; i++) {
      expect(output.hits.items[i - 1]!.score).toBeGreaterThanOrEqual(output.hits.items[i]!.score);
    }
    for (const hit of output.hits.items) {
      if (hit.exact_utc !== null) {
        expect(hit.exact_utc >= "2026-10-14T00:00:00Z" && hit.exact_utc < "2026-10-15T00:00:00Z").toBe(true);
      }
    }
    expect(output.meta.provenance.source).toBe("astrolog");
    expect(output.missing).toEqual([]);
  });
});

// The chart's natal points, and a day's tool output read with a long list, so its hits can be checked one by one.
interface Checked {
  natal: Awaited<ReturnType<ToolDeps["engine"]["cast"]>>;
  daily: DailyOutput;
  fine: Partial<Record<ObjectCode, { at: number; longitude: number }[]>>;
}

// The fine samples of a moving point: a body's longitudes, or a transit midpoint's, the midpoint of its two bodies at each sample.
function seriesOf(fine: Checked["fine"], moving: string): { at: number; longitude: number }[] {
  const [first, second] = moving.split("/") as [ObjectCode, ObjectCode | undefined];
  if (second === undefined) {
    return fine[first]!;
  }
  return fine[first]!.map((sample, k) => ({ at: sample.at, longitude: midpoint(sample.longitude, fine[second]![k]!.longitude) }));
}

// The fine crossings of one hit's aspect, and the least gap between the tool's exact time and any of them, in minutes.
function gapMinutes(checked: Checked, hit: { moving: string; still: string; aspect: string; exact_utc: string | null }): number {
  expect(hit.exact_utc).not.toBeNull();
  const samples = seriesOf(checked.fine, hit.moving);
  const angle = VIBRATIONAL_ASPECTS.find((type) => type.key === hit.aspect)!.angle;
  const point = checked.natal.bodies[hit.still as ObjectCode]?.longitude ?? checked.natal.angles[hit.still as "ASC" | "MC"]!;
  const targets = angle === 0 || angle === 180 ? [point + angle] : [point + angle, point - angle];
  const exact = Date.parse(hit.exact_utc!);
  const found = targets.flatMap((target) => crossings(samples, target));
  expect(found.length).toBeGreaterThan(0);
  return Math.min(...found.map((at) => Math.abs(at - exact))) / 60_000;
}

suite("get_daily_transits exact times against fine sampling of the engine", () => {
  let deps: ToolDeps;
  let natal: Awaited<ReturnType<ToolDeps["engine"]["cast"]>>;

  // The engine's Moon, Jupiter and Saturn every ten minutes across one UT day, read through the same engine as the tool. The count
  // is the day's ten-minute steps plus one, so a 25-hour day has 151 samples and its last one is its end.
  async function fineSky(dayStart: number, count: number): Promise<Checked["fine"]> {
    const limit = pLimit(4);
    const skies = await Promise.all(
      Array.from({ length: count }, (_, k) =>
        limit(() => deps.engine.sky({ utc: utcOf(dayStart + k * FINE_STEP_MS), ayanamsa: "tropical" })),
      ),
    );
    const fine: Checked["fine"] = {};
    for (const code of ["Moo", "Jup", "Sat"] as ObjectCode[]) {
      fine[code] = skies.map((sky, k) => ({ at: dayStart + k * FINE_STEP_MS, longitude: sky.bodies[code]!.longitude }));
    }
    return fine;
  }

  beforeAll(async () => {
    deps = await depsFromEngine("astrolog", { ...process.env, ASTROLOG_BIN: bin });
    const { place, utc } = await resolveBirth(dailyInputSchema.parse({ ...NATAL, date: MOON_DAY }), deps);
    natal = await deps.engine.cast({ utc, latitude: place.latitude, longitude: place.longitude, houseSystem: "placidus", ayanamsa: "tropical" });
  }, 120_000);

  it("places every exact single-body Moon aspect in the first 50 within 2 minutes of the fine-sampled crossing", async () => {
    const daily = await getDailyTransits(dailyInputSchema.parse({ ...NATAL, date: MOON_DAY, limit: 50 }), deps, pLimit(4));
    const fine = await fineSky(DAY_START_MS, FINE_COUNT);
    // Single bodies only: the fine samples hold the Moon, Jupiter and Saturn, not the midpoints that hold the Moon.
    const hits = daily.moon.aspects.items.filter((item) => item.exact_utc !== null && !item.moving.includes("/") && !item.still.includes("/"));
    expect(hits.length).toBeGreaterThan(0);
    const gaps = hits.map((hit) => gapMinutes({ natal, daily, fine }, hit));
    console.info(`fast-body exact hits ${hits.length}, largest gap ${Math.max(...gaps).toFixed(3)} minutes`);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2);
  });

  it("places every exact Jupiter or Saturn aspect of the day within 2 minutes of the fine-sampled crossing", async () => {
    const daily = await getDailyTransits(dailyInputSchema.parse({ ...NATAL, date: SLOW_DAY, limit: 50 }), deps, pLimit(4));
    const fine = await fineSky(Date.parse(`${SLOW_DAY}T00:00:00Z`), FINE_COUNT);
    const hits = daily.hits.items.filter((item) => item.exact_utc !== null && (item.moving === "Jup" || item.moving === "Sat") && !item.still.includes("/"));
    expect(hits.some((hit) => hit.moving === "Jup" && hit.still === "Jup")).toBe(true);
    const gaps = hits.map((hit) => gapMinutes({ natal, daily, fine }, hit));
    console.info(`slow-body exact hits ${hits.length}, largest gap ${Math.max(...gaps).toFixed(3)} minutes`);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2);
  });

  it("places an exact transit-midpoint aspect within 2 minutes of the fine-sampled crossing of the midpoint of its two bodies", async () => {
    // 18 March 2026 in UT: the midpoint of the Moon and Jupiter conjoins the natal MC at 17:58 UT.
    const daily = await getDailyTransits(dailyInputSchema.parse({ ...NATAL, date: MIDPOINT_DAY, limit: 50 }), deps, pLimit(4));
    const fine = await fineSky(Date.parse(`${MIDPOINT_DAY}T00:00:00Z`), FINE_COUNT);
    // The transit midpoints of two bodies with fine samples, against a natal point. Each exact one is checked against the midpoint
    // of the two fine-sampled bodies, Moon and Jupiter or Moon and Saturn.
    const hits = daily.hits.items.filter(
      (item) => item.exact_utc !== null && item.pairing === "Tm to N" && item.moving.split("/").every((code) => code in fine),
    );
    expect(hits.some((hit) => hit.moving === "Moo/Jup" && hit.still === "MC")).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    const gaps = hits.map((hit) => gapMinutes({ natal, daily, fine }, hit));
    console.info(`transit-midpoint exact hits ${hits.length}, largest gap ${Math.max(...gaps).toFixed(3)} minutes`);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2);
  });

  it("places an exact single-body aspect of the 25-hour New York day within 2 minutes of the fine-sampled crossing", async () => {
    // 1 November 2026 in New York runs from 04:00 UT to 05:00 UT the next day: 25 hours, so 151 ten-minute samples.
    const daily = await getDailyTransits(
      dailyInputSchema.parse({ ...NATAL, date: "2026-11-01", day_timezone: "America/New_York", limit: 50 }),
      deps,
      pLimit(4),
    );
    expect(daily.day.hours).toBe(25);
    const fine = await fineSky(Date.parse(daily.day.start_utc), 25 * 6 + 1);
    const hits = daily.hits.items.filter(
      (item) => item.exact_utc !== null && !item.moving.includes("/") && !item.still.includes("/") && item.moving in fine,
    );
    expect(hits.length).toBeGreaterThan(0);
    const gaps = hits.map((hit) => gapMinutes({ natal, daily, fine }, hit));
    console.info(`25-hour day exact hits ${hits.length}, largest gap ${Math.max(...gaps).toFixed(3)} minutes`);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2);
  });
});

suite("get_daily_transits day length on the real engine", () => {
  let deps: ToolDeps;

  beforeAll(async () => {
    deps = await depsFromEngine("astrolog", { ...process.env, ASTROLOG_BIN: bin });
  }, 120_000);

  // The latency budget: a warm call, after one call has started the engine, answers under 500 ms. All five timings are logged,
  // and the slowest must still be under the budget.
  it("answers a warm call in under 500 ms, the slowest of five", async () => {
    const args = dailyInputSchema.parse({ ...NATAL, date: MOON_DAY });
    await getDailyTransits(args, deps, pLimit(4));
    const timings: number[] = [];
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      await getDailyTransits(args, deps, pLimit(4));
      timings.push(performance.now() - started);
    }
    console.info(`warm daily calls ms: ${timings.map((ms) => ms.toFixed(1)).join(", ")}`);
    expect(Math.max(...timings)).toBeLessThan(500);
  });

  // New York's clocks move forward at 02:00 on 8 March 2026 and back on 1 November: the days are 23 and 25 hours long.
  it.each([
    ["2026-03-08", 23, "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z"],
    ["2026-11-01", 25, "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z"],
  ])("reads %s as a %i hour day, with every exact time inside it", async (date, hours, start, end) => {
    const daily = await getDailyTransits(dailyInputSchema.parse({ ...NATAL, date, day_timezone: "America/New_York", limit: 50 }), deps, pLimit(4));

    expect(daily.day).toMatchObject({ hours, start_utc: start, end_utc: end });
    for (const hit of daily.hits.items) {
      if (hit.exact_utc !== null) {
        expect(hit.exact_utc >= start && hit.exact_utc < end).toBe(true);
      }
    }
  });
});
