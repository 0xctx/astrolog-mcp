import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { DateTime } from "luxon";
import pLimit from "p-limit";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  KEY_BONUS,
  MAX_DAILY_MOTION,
  MAX_DAY_HARMONIC,
  MAX_WEIGHT,
  maxDayHarmonic,
  OUTER_BONUS,
  VIBRATIONAL_MIDPOINT_ORB,
} from "../math.js";
import { toUtc } from "../time.js";
import {
  DAILY_DEFAULT_LIMIT,
  DAILY_MAX_LIMIT,
  DAILY_TOOL_NAME,
  dailyInputSchema,
  dailyInputShape,
  dailyOutputSchema,
  dayBounds,
  getDailyTransits,
  registerDailyTool,
  type DailyArgs,
} from "./daily.js";
import { createStubDeps, type ToolDeps } from "./deps.js";
import {
  AstroError,
  HOUSE_NUMBERS,
  type Ayanamsa,
  type ChartInput,
  type ObjectCode,
  type Positions,
  type SkyBody,
  type SkyInput,
  type SkyPositions,
} from "../types.js";

// Fake engine: the natal chart and each sky moment are given. The zodiac follows the request, as the real engine's does, so a
// result always matches the ayanamsa it was asked for. Every call is recorded.
interface Call {
  kind: "cast" | "sky";
  utc: string;
  ayanamsa?: Ayanamsa;
  houseSystem?: string;
}

function skyBodies(bodies: Partial<Record<ObjectCode, [number, number]>>): Partial<Record<ObjectCode, SkyBody>> {
  const out: Partial<Record<ObjectCode, SkyBody>> = {};
  for (const [code, [longitude, speed]] of Object.entries(bodies) as Array<[ObjectCode, [number, number]]>) {
    out[code] = { longitude, speed, retrograde: speed < 0 };
  }
  return out;
}

function fakeDeps(
  natalBodies: Partial<Record<ObjectCode, number>>,
  skyAt: Record<string, Partial<Record<ObjectCode, [number, number]>>>,
  calls: Call[],
): ToolDeps {
  const bodies: Positions["bodies"] = {};
  for (const [code, longitude] of Object.entries(natalBodies) as Array<[ObjectCode, number]>) {
    bodies[code] = { longitude, speed: 1, retrograde: false, house: 1 };
  }
  const houses = Object.fromEntries(HOUSE_NUMBERS.map((n) => [n, (n - 1) * 30])) as Positions["houses"];
  return {
    engine: {
      async cast(input: ChartInput): Promise<Positions> {
        calls.push({ kind: "cast", utc: input.utc, ayanamsa: input.ayanamsa, houseSystem: input.houseSystem });
        return {
          bodies,
          houses,
          angles: { ASC: 15, MC: 285, DSC: 195, IC: 105 },
          missing: [],
          housesFrom: input.houseSystem ?? "placidus",
          provenance: { astrologVersion: "fake", source: "astrolog", utc: input.utc, ayanamsa: input.ayanamsa ?? "tropical" },
        };
      },
      async sky(input: SkyInput): Promise<SkyPositions> {
        calls.push({ kind: "sky", utc: input.utc, ayanamsa: input.ayanamsa });
        // A moment the test does not name has an empty sky.
        return {
          bodies: skyBodies(skyAt[input.utc] ?? {}),
          missing: [],
          provenance: { astrologVersion: "fake", source: "astrolog", utc: input.utc, ayanamsa: input.ayanamsa ?? "tropical" },
        };
      },
      async composite() {
        throw new Error("the daily tool never asks for a composite");
      },
    },
    resolvePlace: () => {
      throw new Error("these tests give coordinates, not a place name");
    },
    toUtc,
    timeoutMs: 5000,
  };
}

const UTC_PLACE = { birth_date: "1990-06-15", birth_time: "14:30", latitude: 40.7, longitude: -73.9, timezone: "UTC" };
const CHICAGO_PLACE = { birth_date: "1990-06-15", birth_time: "19:30", latitude: 30.2672, longitude: -97.7431, timezone: "America/Chicago" };

// The day of 14 October 2026 in UTC: local midnight, the middle sample, and the next midnight.
const UTC_DAY = ["2026-10-14T00:00:00Z", "2026-10-14T12:00:00Z", "2026-10-15T00:00:00Z"] as const;

// The Moon moves from 29 to 42 degrees across the day: it enters Taurus, and natal house 2, at 1/13 of the day.
const MOON_DAY: Record<string, Partial<Record<ObjectCode, [number, number]>>> = {
  [UTC_DAY[0]]: { Moo: [29, 13] },
  [UTC_DAY[1]]: { Moo: [35.5, 13] },
  [UTC_DAY[2]]: { Moo: [42, 13] },
};

function args(extra: Record<string, unknown>): DailyArgs {
  return dailyInputSchema.parse({ ...UTC_PLACE, date: "2026-10-14", ...extra });
}

describe("get_daily_transits: the Moon's sign change", () => {
  it("reports the Moon's entry into Taurus with its time, in the day's zone and in UT", async () => {
    const calls: Call[] = [];
    const output = await getDailyTransits(args({}), fakeDeps({ Sun: 0 }, MOON_DAY, calls), pLimit(4));

    // The Moon crosses 30 degrees at 01:50:46 UT, which rounds to the minute.
    expect(output.moon.sign_changes).toEqual({
      items: [
        expect.objectContaining({
          body: "Moo",
          change: "sign",
          from: "Aries",
          to: "Taurus",
          at_utc: "2026-10-14T01:51:00Z",
          at_local: "01:51",
          text: "Moon enters Taurus at 01:51 UTC, from Aries",
        }),
      ],
      total: 1,
      truncated: false,
    });
    expect(output.ingresses.items).toContainEqual(expect.objectContaining({ body: "Moo", change: "house", from: 1, to: 2, at_local: "01:51" }));
    expect(output.headline).toContain("Moon: enters Taurus at 01:51 UTC");
  });

  it("caps the Moon's sign changes at limit, with the total, since a harmonic can give several in a day", async () => {
    // At harmonic 3 the Moon runs from 15 to 75 degrees in the harmonic chart: it enters Taurus, then Gemini.
    const raw = {
      [UTC_DAY[0]]: { Moo: [5, 10] as [number, number] },
      [UTC_DAY[1]]: { Moo: [15, 10] as [number, number] },
      [UTC_DAY[2]]: { Moo: [25, 10] as [number, number] },
    };
    const output = await getDailyTransits(args({ harmonic: 3, limit: 1 }), fakeDeps({ Sun: 0 }, raw, []), pLimit(4));

    expect(output.moon.sign_changes).toMatchObject({ total: 2, truncated: true });
    expect(output.moon.sign_changes.items.map((change) => change.to)).toEqual(["Taurus"]);
    expect(output.headline.startsWith("Harmonic 3: ")).toBe(true);
    expect(output.headline).toContain("2 sign changes, the first enters Taurus");
  });
});

describe("get_daily_transits: the list, the zodiac, the harmonic and the zone", () => {
  it("caps each list at limit and states the total and the cut", async () => {
    const sky = {
      [UTC_DAY[0]]: { Sun: [99.5, 1] as [number, number], Moo: [101.5, 0] as [number, number] },
      [UTC_DAY[1]]: { Sun: [100, 1] as [number, number], Moo: [101.5, 0] as [number, number] },
      [UTC_DAY[2]]: { Sun: [100.5, 1] as [number, number], Moo: [101.5, 0] as [number, number] },
    };
    const output = await getDailyTransits(args({ limit: 1 }), fakeDeps({ Sun: 100 }, sky, []), pLimit(4));

    expect(output.hits.items).toHaveLength(1);
    expect(output.hits.total).toBeGreaterThan(1);
    expect(output.hits.truncated).toBe(true);
    expect(output.hits.items[0]).toMatchObject({ moving: "Sun", still: "Sun", aspect: "conjunction", exact_local: "12:00" });
  });

  it("passes one ayanamsa to the natal cast and to all three sky samples", async () => {
    const calls: Call[] = [];
    const output = await getDailyTransits(args({ ayanamsa: "lahiri" }), fakeDeps({ Sun: 0 }, MOON_DAY, calls), pLimit(4));

    expect(calls.map((call) => [call.kind, call.ayanamsa])).toEqual([
      ["cast", "lahiri"],
      ["sky", "lahiri"],
      ["sky", "lahiri"],
      ["sky", "lahiri"],
    ]);
    expect(output.meta.ayanamsa).toBe("lahiri");
  });

  it("applies the harmonic to the natal chart and to every sample, so a harmonic 2 read doubles the Moon", async () => {
    // The raw Moon runs from 14.5 to 21 degrees; doubled, it runs from 29 to 42, and enters Taurus at the same moment.
    const raw = {
      [UTC_DAY[0]]: { Moo: [14.5, 6.5] as [number, number] },
      [UTC_DAY[1]]: { Moo: [17.75, 6.5] as [number, number] },
      [UTC_DAY[2]]: { Moo: [21, 6.5] as [number, number] },
    };
    const output = await getDailyTransits(args({ harmonic: 2 }), fakeDeps({ Sun: 0 }, raw, []), pLimit(4));

    expect(output.meta.harmonic).toBe(2);
    expect(output.moon.sign_changes.items[0]).toMatchObject({ to: "Taurus", at_local: "01:51" });
  });

  it("reads the day in the natal timezone, and in day_timezone when it is given", async () => {
    const sky = { [UTC_DAY[0]]: {}, [UTC_DAY[1]]: {}, [UTC_DAY[2]]: {} };
    const natal = await getDailyTransits(args({ ...CHICAGO_PLACE, date: "2026-10-14" }), fakeDeps({ Sun: 0 }, sky, []), pLimit(4));
    expect(natal.day).toMatchObject({ timezone: "America/Chicago", start_utc: "2026-10-14T05:00:00Z", hours: 24 });

    const override = await getDailyTransits(
      args({ ...CHICAGO_PLACE, date: "2026-10-14", day_timezone: "UTC" }),
      fakeDeps({ Sun: 0 }, sky, []),
      pLimit(4),
    );
    expect(override.day).toMatchObject({ timezone: "UTC", start_utc: "2026-10-14T00:00:00Z" });
  });

  it("makes a daylight-saving day 25 hours long", () => {
    // Midnight to midnight: 04:00 UT to 05:00 UT the next day, so the middle sits 12.5 hours after the start.
    expect(dayBounds("2026-11-01", "America/New_York")).toEqual({
      start: Date.parse("2026-11-01T04:00:00Z"),
      middle: Date.parse("2026-11-01T16:30:00Z"),
      end: Date.parse("2026-11-02T05:00:00Z"),
    });
  });

  it("starts a day at the first instant after a midnight that a zone skips", () => {
    // Find a day in Santiago whose clocks jump over midnight, rather than rely on the date: luxon reads that midnight as 01:00.
    const skipped = Array.from({ length: 6 * 366 }, (_, i) => new Date(Date.UTC(2018, 0, 1) + i * 86_400_000).toISOString().slice(0, 10)).find(
      (date) => DateTime.fromISO(`${date}T00:00`, { zone: "America/Santiago" }).hour !== 0,
    );
    expect(skipped).toBeDefined();
    const first = DateTime.fromISO(`${skipped}T01:00`, { zone: "America/Santiago" });
    expect(dayBounds(skipped!, "America/Santiago").start).toBe(first.toMillis());
  });

  it("makes a half-hour change day 23.5 hours long", () => {
    // Lord Howe moves its clocks by 30 minutes on 2026-10-04: midnight is at +10:30 and the next midnight at +11.
    const day = dayBounds("2026-10-04", "Australia/Lord_Howe");
    expect((day.end - day.start) / 3_600_000).toBe(23.5);
  });

  it("refuses a date the zone skips entirely, before any engine call, and reads the next day the zone has", async () => {
    // Samoa's clocks went from 2011-12-29 straight to 2011-12-31, so 2011-12-30 has no midnight and no day.
    expect(() => dayBounds("2011-12-30", "Pacific/Apia")).toThrow(AstroError);
    expect(() => dayBounds("2011-12-30", "Pacific/Apia")).toThrow("the zone has no 2011-12-30: its clocks skip that day");
    expect(() => dayBounds("1993-08-21", "Pacific/Kwajalein")).toThrow("the zone has no 1993-08-21: its clocks skip that day");

    const calls: Call[] = [];
    await expect(
      getDailyTransits(args({ day_timezone: "Pacific/Apia", date: "2011-12-30" }), fakeDeps({ Sun: 0 }, {}, calls), pLimit(4)),
    ).rejects.toMatchObject({ fix: "Pick another date, or a time zone for the day that has it." });
    expect(calls).toEqual([]);

    const next = await getDailyTransits(
      args({ day_timezone: "Pacific/Apia", date: "2011-12-31" }),
      fakeDeps({ Sun: 0 }, {}, []),
      pLimit(4),
    );
    expect(next.day).toMatchObject({ date: "2011-12-31", hours: 24 });
  });
});

// The same sky at all three moments of the day, so every longitude stands still.
function steadySky(bodies: Partial<Record<ObjectCode, [number, number]>>): Record<string, Partial<Record<ObjectCode, [number, number]>>> {
  return Object.fromEntries(UTC_DAY.map((utc) => [utc, bodies]));
}

describe("get_daily_transits: the aspect set, the score and the text", () => {
  it("ranks the five major aspects by default, and the minor ones only with aspects all", async () => {
    // The Moon stands 72 degrees from the natal Sun all day: an exact quintile, which the major set does not rank.
    const sky = steadySky({ Moo: [72, 0], Mer: [0, 1], Ven: [120, 1] });
    const major = await getDailyTransits(args({}), fakeDeps({ Sun: 0 }, sky, []), pLimit(4));
    const all = await getDailyTransits(args({ aspects: "all" }), fakeDeps({ Sun: 0 }, sky, []), pLimit(4));

    expect(major.meta.aspects).toBe("major");
    expect(major.hits.items.every((hit) => ["conjunction", "opposition", "trine", "square", "sextile"].includes(hit.aspect))).toBe(true);
    expect(major.hits.items.map((hit) => `${hit.moving} ${hit.aspect}`)).toContain("Ven trine");
    expect(all.meta.aspects).toBe("all");
    expect(all.hits.items).toContainEqual(expect.objectContaining({ moving: "Moo", still: "Sun", aspect: "quintile", exact_utc: "2026-10-14T00:00:00Z" }));
  });

  it("states an orb to the arcminute in both the number and the text", async () => {
    // The transit Sun is 0°13′ past the natal Sun: 0.2167 degrees, which the number gives as 0.2167 and the text as 0°13′.
    const output = await getDailyTransits(args({}), fakeDeps({ Sun: 100 }, steadySky({ Sun: [100.2167, 0] }), []), pLimit(4));
    const hit = output.hits.items.find((item) => item.moving === "Sun" && item.still === "Sun" && item.aspect === "conjunction");

    expect(hit).toMatchObject({ orb: 0.2167, exact_utc: null, exact_local: null });
    // The orb never shrinks, so its least moment is the start of the day and the hit reads separating.
    expect(hit?.text).toBe("Transiting Sun conjunction natal Sun, orb 0°13′, separating, not exact today");
  });

  it("starts the headline and every text with the harmonic above 1, and not at 1", async () => {
    const harmonic = await getDailyTransits(args({ harmonic: 2 }), fakeDeps({ Sun: 0 }, MOON_DAY, []), pLimit(4));
    const plain = await getDailyTransits(args({}), fakeDeps({ Sun: 0 }, MOON_DAY, []), pLimit(4));

    expect(harmonic.headline.startsWith("Harmonic 2: Daily transits")).toBe(true);
    expect(harmonic.moon.sign_changes.items[0]!.text.startsWith("Harmonic 2: Moon enters")).toBe(true);
    expect(plain.headline.startsWith("Daily transits")).toBe(true);
    expect(plain.moon.sign_changes.items[0]!.text.startsWith("Moon enters")).toBe(true);
  });

  it("lists the Moon's aspects as the ones whose transiting point holds the Moon, midpoints included", async () => {
    // The Sun and the Moon stand together at 100: their midpoint is at 100 too, and conjoins the natal Sun.
    const output = await getDailyTransits(args({}), fakeDeps({ Sun: 100 }, steadySky({ Sun: [100, 1], Moo: [100, 13] }), []), pLimit(4));
    const movers = output.moon.aspects.items.map((hit) => hit.moving);

    expect(movers).toContain("Sun/Moo");
    expect(movers.every((moving) => moving.split("/").includes("Moo"))).toBe(true);
  });

  it("refuses a harmonic above the schema's ceiling, and states the day's rule in the fix", () => {
    const refused = dailyInputSchema.safeParse({ ...UTC_PLACE, date: "2026-10-14", harmonic: MAX_DAY_HARMONIC + 1 });

    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe(
      "Give the harmonic as a whole number from 1 to the day's maximum, which is 18 on a 24-hour day and 17 on a 25-hour day.",
    );
    expect(dailyInputSchema.safeParse({ ...UTC_PLACE, date: "2026-10-14", harmonic: MAX_DAY_HARMONIC }).success).toBe(true);
    expect(dailyInputSchema.safeParse({ ...UTC_PLACE, date: "2026-10-14", aspects: "minor" }).success).toBe(false);
  });

  it("refuses a harmonic over the day's own maximum, and names that day's maximum in the fix", async () => {
    // New York's 25-hour day allows 17, so 18 is refused there; the same harmonic on a 24-hour UTC day is read, since that day allows 18.
    const deps = fakeDeps({ Sun: 0 }, {}, []);
    await expect(
      getDailyTransits(args({ day_timezone: "America/New_York", date: "2026-11-01", harmonic: 18 }), deps, pLimit(4)),
    ).rejects.toMatchObject({ fix: expect.stringContaining("from 1 to 17") });
    const utc = await getDailyTransits(args({ harmonic: 18 }), deps, pLimit(4));
    expect(utc.meta.harmonic).toBe(18);
  });

  it("caps the harmonic by the day's own length: a 26-hour day allows 16 and a 22-hour day allows 19", async () => {
    // Antarctica/Troll changes its clocks by 2 hours: 2026-10-25 is 26 hours long and 2026-03-29 is 22.
    const deps = fakeDeps({ Sun: 0 }, {}, []);
    const long = await getDailyTransits(args({ day_timezone: "Antarctica/Troll", date: "2026-10-25", harmonic: 16 }), deps, pLimit(4));
    expect(long.day.hours).toBe(26);
    await expect(
      getDailyTransits(args({ day_timezone: "Antarctica/Troll", date: "2026-10-25", harmonic: 17 }), deps, pLimit(4)),
    ).rejects.toMatchObject({ fix: expect.stringContaining("from 1 to 16 for 2026-10-25") });

    const short = await getDailyTransits(args({ day_timezone: "Antarctica/Troll", date: "2026-03-29", harmonic: 19 }), deps, pLimit(4));
    expect(short.day.hours).toBe(22);
    expect(short.meta.harmonic).toBe(19);
  });

  it("refuses a direct call that skips the schema with the same bounds, and gives the fix", async () => {
    const deps = fakeDeps({ Sun: 0 }, {}, []);

    await expect(getDailyTransits({ ...args({}), limit: 0 }, deps, pLimit(4))).rejects.toMatchObject({
      fix: expect.stringContaining("from 1 to 50"),
    });
    await expect(getDailyTransits({ ...args({}), harmonic: 20 }, deps, pLimit(4))).rejects.toThrow(AstroError);
    await expect(getDailyTransits({ ...args({}), min_strength: 1.5 }, deps, pLimit(4))).rejects.toThrow(AstroError);
  });
});

describe("get_daily_transits: exact times and the counts in the headline", () => {
  it("keeps an exact time that rounds past the day's end inside the day's last minute", async () => {
    // The Sun crosses the natal Sun 0.86 seconds before the next midnight. The moment rounds to midnight, so it reads 23:59 UT.
    const x0 = 1 - 1e-5;
    const sky = {
      [UTC_DAY[0]]: { Sun: [100 - x0, 1] as [number, number] },
      [UTC_DAY[1]]: { Sun: [100.5 - x0, 1] as [number, number] },
      [UTC_DAY[2]]: { Sun: [100 + (1 - x0), 1] as [number, number] },
    };
    const output = await getDailyTransits(args({ limit: 50 }), fakeDeps({ Sun: 100 }, sky, []), pLimit(4));
    const hit = output.hits.items.find((item) => item.moving === "Sun" && item.still === "Sun" && item.aspect === "conjunction");

    expect(hit).toMatchObject({ exact_utc: "2026-10-14T23:59:00Z", exact_local: "23:59" });
  });

  it("states the counts in the headline in the plural that agrees with each", async () => {
    // The Moon's entry into Taurus is both a sign change and a house change: two ingresses. Venus turns retrograde once: one station.
    const moon = await getDailyTransits(args({}), fakeDeps({ Sun: 0 }, MOON_DAY, []), pLimit(4));
    expect(moon.ingresses.total).toBe(2);
    expect(moon.headline).toContain(", 2 ingresses, 0 stations.");

    const retro = {
      [UTC_DAY[0]]: { Ven: [50, 1] as [number, number] },
      [UTC_DAY[1]]: { Ven: [50, -1] as [number, number] },
      [UTC_DAY[2]]: { Ven: [50, -1] as [number, number] },
    };
    const station = await getDailyTransits(args({}), fakeDeps({ Sun: 0 }, retro, []), pLimit(4));
    expect(station.stations.total).toBe(1);
    expect(station.headline).toContain(", 0 ingresses, 1 station. Moon:");
  });

  it("reports the first exact moment of a path that perfects twice in the day, and lists that hit once", async () => {
    // The Moon runs 99, 101, then 99.5 degrees: it passes the natal Sun at 100 going up, and again coming down. The two exact
    // moments are about 03:45 and 21:58 UT; the hit gives the first.
    const sky = {
      [UTC_DAY[0]]: { Moo: [99, 1] as [number, number] },
      [UTC_DAY[1]]: { Moo: [101, 1] as [number, number] },
      [UTC_DAY[2]]: { Moo: [99.5, 1] as [number, number] },
    };
    const output = await getDailyTransits(args({ limit: 50 }), fakeDeps({ Sun: 100 }, sky, []), pLimit(4));
    const hits = output.hits.items.filter((hit) => hit.moving === "Moo" && hit.still === "Sun" && hit.aspect === "conjunction");

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ orb: 0, phase: "applying", exact_utc: "2026-10-14T03:45:00Z", exact_local: "03:45" });
  });

  it("applies min_strength to the score as shown, so a hit below the cut at two places is not listed", async () => {
    // Mercury 0.5168 degrees past natal Venus scores 0.4944, which the result shows as 0.49: a cut of 0.494 drops it.
    const sky = steadySky({ Mer: [100.5168, 0] });
    const kept = await getDailyTransits(args({ min_strength: 0.49 }), fakeDeps({ Ven: 100 }, sky, []), pLimit(4));
    const dropped = await getDailyTransits(args({ min_strength: 0.494 }), fakeDeps({ Ven: 100 }, sky, []), pLimit(4));

    expect(kept.hits.items.find((hit) => hit.moving === "Mer" && hit.still === "Ven")).toMatchObject({
      score: 0.49,
      aspect: "conjunction",
    });
    expect(dropped.hits.items.some((hit) => hit.moving === "Mer" && hit.still === "Ven")).toBe(false);
  });
});

describe("get_daily_transits: the stub and the output", () => {
  it("answers on the stub engine and says the numbers are placeholders", async () => {
    const output = await getDailyTransits(args({}), createStubDeps(), pLimit(4));

    expect(output.meta.provenance.source).toBe("stub");
    expect(output.headline.startsWith("Daily transits for 2026-10-14 in UTC")).toBe(true);
    expect(() => dailyOutputSchema.parse(output)).not.toThrow();
  });

  it("returns an output that matches its schema, with the real engine's fake moon", async () => {
    const output = await getDailyTransits(args({}), fakeDeps({ Sun: 0 }, MOON_DAY, []), pLimit(4));

    expect(() => dailyOutputSchema.parse(output)).not.toThrow();
    expect(output.missing).toEqual([]);
  });
});

describe("get_daily_transits: the inputs", () => {
  it("refuses a date that does not exist, a limit outside its range, a strength outside 0 to 1 and an unknown zone", () => {
    expect(dailyInputSchema.safeParse({ ...UTC_PLACE, date: "2026-02-30" }).success).toBe(false);
    expect(dailyInputSchema.safeParse({ ...UTC_PLACE, date: "2026-10-14", limit: 0 }).success).toBe(false);
    expect(dailyInputSchema.safeParse({ ...UTC_PLACE, date: "2026-10-14", limit: DAILY_MAX_LIMIT + 1 }).success).toBe(false);
    expect(dailyInputSchema.safeParse({ ...UTC_PLACE, date: "2026-10-14", min_strength: 1.5 }).success).toBe(false);
    expect(dailyInputSchema.safeParse({ ...UTC_PLACE, date: "2026-10-14", day_timezone: "Mars/Olympus" }).success).toBe(false);
  });

  it("takes the defaults: limit 10, min_strength 0, harmonic 1, the tropical zodiac and placidus", () => {
    const parsed = args({});

    expect(parsed).toMatchObject({
      limit: DAILY_DEFAULT_LIMIT,
      min_strength: 0,
      harmonic: 1,
      ayanamsa: "tropical",
      house_system: "placidus",
    });
  });

  it("refuses an input the tool does not honor, such as bodies", () => {
    expect(dailyInputSchema.safeParse({ ...UTC_PLACE, date: "2026-10-14", bodies: ["Sun"] }).success).toBe(false);
  });
});

// docs/tools.md copies the limits and the formula's constants. A change to a constant has to change the doc too.
describe("get_daily_transits: the documented constants", () => {
  const doc = readFileSync(new URL("../../docs/tools.md", import.meta.url), "utf8");

  it("states the limits, the harmonic caps by day length, the motion bound, the weights and the midpoint orb the code uses", () => {
    expect(doc).toContain(`from 1 to ${DAILY_MAX_LIMIT}, default ${DAILY_DEFAULT_LIMIT}`);
    expect(doc).toContain(`From 1 to the day's maximum, default 1`);
    expect(doc).toContain(`${maxDayHarmonic(24)} on a 24-hour day and ${maxDayHarmonic(25)} on a 25-hour day`);
    expect(doc).toContain(
      `${maxDayHarmonic(22)} on a 22-hour day, ${maxDayHarmonic(24)} on a 24-hour day, ${maxDayHarmonic(25)} on a 25-hour day and ${maxDayHarmonic(26)} on a 26-hour day`,
    );
    expect(doc).toContain(`allows ${MAX_DAILY_MOTION}° a day`);
    expect(doc).toContain("half the day");
    expect(doc).toContain(`weight    = 1 + ${OUTER_BONUS} (outer) + ${KEY_BONUS} (key)`);
    expect(doc).toContain(`÷ ${MAX_WEIGHT}`);
    expect(doc).toContain(`${VIBRATIONAL_MIDPOINT_ORB}° for harmonics 1 and 2`);
  });
});

describe("get_daily_transits: the advertised contract", () => {
  it("names every input in its description and advertises exactly the fields it honors", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerDailyTool(server, createStubDeps(), pLimit(4));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "daily-test", version: "0.0.0" });
    await client.connect(clientSide);

    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === DAILY_TOOL_NAME);
    const description = tool?.description ?? "";
    const properties = (tool?.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    const advertised = Object.keys(properties).sort();

    expect(advertised).toEqual(Object.keys(dailyInputShape).sort());
    // Each name must appear as a whole name: "date" is not found inside "birth_date" or "update".
    for (const field of advertised) {
      expect(description, field).toMatch(new RegExp(`(?<![A-Za-z_])${field}(?![A-Za-z_])`));
    }
    expect(description).not.toContain("bodies");
    expect(description).not.toMatch(/astrolog/i);
    // min_strength names the score, not the tightness the transit tool's field compares.
    expect(properties.min_strength?.description).toContain("score, not its tightness");
    // The score formula is stated once, in the tool description (see R7).
    expect(description).toContain(`orb tightness times weight, divided by ${MAX_WEIGHT}`);
    await client.close();
  });
});
