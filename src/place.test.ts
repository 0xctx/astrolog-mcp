import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IANAZone } from "luxon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AstroError, type Place } from "./types.js";
import {
  resetDirectoryLogForTests,
  ADMIN1_FILE,
  AmbiguousPlaceError,
  CITIES_FILE,
  COUNTRY_FILE,
  buildPlaceTable,
  lookupPlace,
  normalizeName,
  resolvePlace,
  type PlaceTable,
} from "./place.js";
import { PLACE_ALIASES } from "./place-aliases.js";

// The committed sample rows. The region and country names are inline, so the fixture stays one file.
const cities = readFileSync(new URL("../data/fixtures/cities-small.txt", import.meta.url), "utf8");

const admin1 = [
  ["US.TX", "Texas"],
  ["US.MN", "Minnesota"],
  ["US.IL", "Illinois"],
  ["US.MO", "Missouri"],
  ["US.MA", "Massachusetts"],
  ["US.OH", "Ohio"],
  ["US.NY", "New York"],
  ["US.OR", "Oregon"],
  ["US.ME", "Maine"],
  ["US.CO", "Colorado"],
  ["US.HI", "Hawaii"],
  ["US.CA", "California"],
  ["US.PA", "Pennsylvania"],
  ["US.NV", "Nevada"],
  ["US.DC", "District of Columbia"],
  ["CA.02", "British Columbia"],
  ["IN.29", "West Bengal"],
  ["IN.16", "Maharashtra"],
  ["IN.25", "Tamil Nadu"],
  ["AU.SA", "South Australia"],
  ["GB.ENG", "England"],
  ["CN.22", "Beijing"],
  ["VN.79", "Ho Chi Minh City"],
]
  .map(([key, name]) => `${key}\t${name}\t${name}\t0`)
  .join("\n");

const countries = [
  "# ISO\tISO3\tISO-Numeric\tfips\tCountry",
  "US\tUSA\t840\tUS\tUnited States",
  "IN\tIND\t356\tIN\tIndia",
  "AU\tAUS\t036\tAS\tAustralia",
  "GB\tGBR\t826\tUK\tUnited Kingdom",
  "CA\tCAN\t124\tCA\tCanada",
  "SG\tSGP\t702\tSN\tSingapore",
  "SZ\tSWZ\t748\tWZ\tEswatini",
  "CH\tCHE\t756\tSZ\tSwitzerland",
  "CN\tCHN\t156\t\tChina",
  "VN\tVNM\t704\t\tVietnam",
].join("\n");

const table: PlaceTable = buildPlaceTable(cities, admin1, countries);

// The committed rows without the one whose geonameId is given, for tests that drop or replace a row.
function withoutRow(id: string): string {
  return cities
    .split("\n")
    .filter((line) => line.split("\t")[0] !== id)
    .join("\n");
}

// The real GeoNames files, when ASTROLOG_MCP_DATA names a directory the installer filled. Without
// them the data-driven tests below skip, so `npm test` stays green and offline. The table is built
// once at import; a missing or unreadable directory leaves realTable undefined and skips instead.
const realDataDir = process.env.ASTROLOG_MCP_DATA;
let realTable: PlaceTable | undefined;
if (realDataDir !== undefined) {
  try {
    realTable = buildPlaceTable(
      readFileSync(join(realDataDir, CITIES_FILE), "utf8"),
      readFileSync(join(realDataDir, ADMIN1_FILE), "utf8"),
      readFileSync(join(realDataDir, COUNTRY_FILE), "utf8"),
    );
  } catch {
    // The data directory is set but the files are missing or unreadable: skip the data-driven tests.
  }
}
const withRealData = realTable ? it : it.skip.bind(it);

// Writes the three GeoNames files into a fresh directory and returns its path.
async function dataDirWith(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(dir, name), text);
  }
}

const allFiles = { [CITIES_FILE]: cities, [ADMIN1_FILE]: admin1, [COUNTRY_FILE]: countries };

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "s3-place-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function thrownBy(run: () => unknown): AstroError {
  try {
    run();
  } catch (error) {
    if (error instanceof AstroError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the lookup to throw");
}

async function rejectedWith(promise: Promise<unknown>): Promise<AstroError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AstroError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the promise to reject");
}

describe("lookupPlace on the fixture table", () => {
  it('resolves "Austin, TX" to a Texas zone with lettered-ready coordinates', () => {
    const place = lookupPlace(table, "Austin, TX");
    expect(place).toEqual({
      name: "Austin, TX",
      latitude: { degrees: 30.26715, hemisphere: "N" },
      longitude: { degrees: 97.74306, hemisphere: "W" },
      timezone: "America/Chicago",
    });
  });

  it.each(["austin tx US", "Austin, Texas", "AUSTIN, tx", "Austin Texas USA"])(
    'reads "%s" as Austin, Texas',
    (text) => {
      expect(lookupPlace(table, text).timezone).toBe("America/Chicago");
      expect(lookupPlace(table, text).latitude.degrees).toBe(30.26715);
    },
  );

  it('takes the more populous Austin for a bare "Austin" (Texas is over three times Minnesota)', () => {
    expect(lookupPlace(table, "Austin").latitude.degrees).toBe(30.26715);
  });

  it("uses the region to pick Austin, Minnesota", () => {
    expect(lookupPlace(table, "Austin, MN").latitude).toEqual({
      degrees: 43.66663,
      hemisphere: "N",
    });
  });

  it('resolves "Springfield, IL" and "Springfield, Missouri" by region', () => {
    expect(lookupPlace(table, "Springfield, IL").latitude.degrees).toBe(39.80172);
    expect(lookupPlace(table, "Springfield, Missouri").latitude.degrees).toBe(37.21533);
  });

  it('returns up to five candidates for an ambiguous "Springfield", with a fix line', () => {
    const error = thrownBy(() => lookupPlace(table, "Springfield"));
    expect(error).toBeInstanceOf(AmbiguousPlaceError);
    if (!(error instanceof AmbiguousPlaceError)) {
      throw new Error("unreachable");
    }
    expect(error.candidates.length).toBeGreaterThan(1);
    expect(error.candidates.length).toBeLessThanOrEqual(5);
    expect(error.candidates[0]).toEqual({
      name: "Springfield",
      region: "Missouri",
      regionCode: "MO",
      country: "United States",
      countryCode: "US",
      population: 169176,
    });
    expect(error.candidates.map((c) => c.region)).toEqual([
      "Missouri",
      "Massachusetts",
      "Illinois",
      "Ohio",
    ]);
    expect(error.message).toContain('"Springfield" matches 4 places');
    expect(error.fix).toBe(
      'Add a region or country to the place, for example "Springfield, Missouri", or pass latitude, longitude and time zone.',
    );
    expect(error.fix).not.toContain('"Springfield"');
  });

  it("makes the fix line's example resolve to the first candidate", () => {
    const error = thrownBy(() => lookupPlace(table, "Springfield"));
    const example = /for example "([^"]+)"/.exec(error.fix)?.[1];
    expect(example).toBe("Springfield, Missouri");
    expect(lookupPlace(table, example ?? "").latitude.degrees).toBe(37.21533);
  });

  it("asks for coordinates, not another region, when the text already names a country", () => {
    const error = thrownBy(() => lookupPlace(table, "Springfield, US"));
    expect(error).toBeInstanceOf(AmbiguousPlaceError);
    expect(error.fix).toBe(
      "Pass latitude, longitude and time zone, because the place name alone does not say which of these you mean.",
    );
    expect(error.fix).not.toContain("Springfield");
  });

  it('resolves "Portland" to Oregon, because Portland is over three times Portland, Maine', () => {
    expect(lookupPlace(table, "Portland").timezone).toBe("America/Los_Angeles");
    expect(lookupPlace(table, "Portland, ME").timezone).toBe("America/New_York");
  });

  it("gives a Mountain zone for El Paso, Texas, so a Texas place is not always Central", () => {
    expect(lookupPlace(table, "El Paso, TX").timezone).toBe("America/Denver");
  });

  it("resolves New York City, NY", () => {
    expect(lookupPlace(table, "New York City, NY").timezone).toBe("America/New_York");
  });

  it("resolves a half-hour zone city by name, country code or country name", () => {
    expect(lookupPlace(table, "Kolkata, India").timezone).toBe("Asia/Kolkata");
    expect(lookupPlace(table, "Kolkata, IN").timezone).toBe("Asia/Kolkata");
    expect(lookupPlace(table, "Adelaide, AU").timezone).toBe("Australia/Adelaide");
  });

  it("resolves a city in a country with a multi-word name", () => {
    expect(lookupPlace(table, "London, United Kingdom").timezone).toBe("Europe/London");
  });

  it('resolves "London, UK" through the FIPS code, as "London, GB" does', () => {
    expect(lookupPlace(table, "London, UK").timezone).toBe("Europe/London");
    expect(lookupPlace(table, "London, GB").timezone).toBe("Europe/London");
  });

  it('reads "SZ" as Eswatini, the ISO code, not Switzerland, whose FIPS code it is', () => {
    expect(lookupPlace(table, "Mbabane, SZ").timezone).toBe("Africa/Mbabane");
    expect(() => lookupPlace(table, "Zurich, SZ")).toThrow(AstroError);
    expect(lookupPlace(table, "Zurich, Switzerland").timezone).toBe("Europe/Zurich");
  });

  it('prefers the region match: "Richmond, CA" is California, and Canada needs its name', () => {
    expect(lookupPlace(table, "Richmond, CA").timezone).toBe("America/Los_Angeles");
    expect(lookupPlace(table, "Richmond, Canada").timezone).toBe("America/Vancouver");
    expect(lookupPlace(table, "Richmond, British Columbia").timezone).toBe("America/Vancouver");
  });

  it("gives an ambiguous Richmond a fix line whose example resolves to the first candidate", () => {
    const error = thrownBy(() => lookupPlace(table, "Richmond"));
    expect(error).toBeInstanceOf(AmbiguousPlaceError);
    expect(error.fix).toContain('"Richmond, British Columbia"');
    expect(lookupPlace(table, "Richmond, British Columbia").timezone).toBe("America/Vancouver");
  });

  it('reads dotted initials: "Washington, D.C." and "New York City, N.Y."', () => {
    expect(lookupPlace(table, "Washington, D.C.").timezone).toBe("America/New_York");
    expect(lookupPlace(table, "Washington, DC").latitude.degrees).toBe(38.89511);
    expect(lookupPlace(table, "New York City, N.Y.").timezone).toBe("America/New_York");
  });

  it("resolves a city-state that has no region", () => {
    expect(lookupPlace(table, "Singapore").timezone).toBe("Asia/Singapore");
  });

  it("refuses a name that is not in the table, with a fix line", () => {
    const error = thrownBy(() => lookupPlace(table, "Zzyzx"));
    expect(error).not.toBeInstanceOf(AmbiguousPlaceError);
    expect(error.message).toContain('no place named "Zzyzx"');
    expect(error.fix).toContain('"City, ST"');
  });

  it("refuses a known city with a region that does not match it", () => {
    expect(() => lookupPlace(table, "Austin, CA")).toThrow(AstroError);
  });

  it("keeps the name the user gave, trimmed", () => {
    expect(lookupPlace(table, "  Denver, CO ").name).toBe("Denver, CO");
  });
});

// A shorthand resolves to one GeoNames place, by geonameId, when the name search finds nothing. The
// coordinates and time zone come from that place's row, so an alias never supplies numbers of its
// own. The values below are the real GeoNames coordinates and zones of each target.
const ALIAS_EXPECTED: Record<string, { latitude: number; longitude: number; timezone: string }> = {
  NYC: { latitude: 40.71427, longitude: -74.00597, timezone: "America/New_York" },
  "New York": { latitude: 40.71427, longitude: -74.00597, timezone: "America/New_York" },
  LA: { latitude: 34.05223, longitude: -118.24368, timezone: "America/Los_Angeles" },
  "L.A.": { latitude: 34.05223, longitude: -118.24368, timezone: "America/Los_Angeles" },
  SF: { latitude: 37.77493, longitude: -122.41942, timezone: "America/Los_Angeles" },
  "San Fran": { latitude: 37.77493, longitude: -122.41942, timezone: "America/Los_Angeles" },
  DC: { latitude: 38.89511, longitude: -77.03637, timezone: "America/New_York" },
  Philly: { latitude: 39.95238, longitude: -75.16362, timezone: "America/New_York" },
  Vegas: { latitude: 36.17497, longitude: -115.13722, timezone: "America/Los_Angeles" },
  Peking: { latitude: 39.9075, longitude: 116.39723, timezone: "Asia/Shanghai" },
  Saigon: { latitude: 10.82302, longitude: 106.62965, timezone: "Asia/Ho_Chi_Minh" },
};

// One test per alias, on the committed fixture, proving each shorthand resolves to its place.
describe("place shorthand on the fixture table", () => {
  it.each(PLACE_ALIASES)("resolves the '$alias' shorthand to its GeoNames place", ({ alias, geonameId }) => {
    expect(table.byGeonameId.get(geonameId), `${alias} needs its target in the fixture`).toBeDefined();
    const expected = ALIAS_EXPECTED[alias]!;
    expect(expected, `no expected value recorded for ${alias}`).toBeDefined();
    expect(lookupPlace(table, alias)).toEqual({
      name: alias,
      latitude: { degrees: Math.abs(expected.latitude), hemisphere: expected.latitude < 0 ? "S" : "N" },
      longitude: { degrees: Math.abs(expected.longitude), hemisphere: expected.longitude < 0 ? "W" : "E" },
      timezone: expected.timezone,
    });
  });

  // Each alias names the row its id returns: the same primary name and country code, so an id that now
  // names another place cannot pass for the place the alias names.
  it("names, for every alias, the same name and country code as its fixture row", () => {
    for (const { alias, geonameId, name, countryCode } of PLACE_ALIASES) {
      const row = table.byGeonameId.get(geonameId);
      expect(row, `${alias} needs its row in the fixture`).toBeDefined();
      expect({ alias, name: row!.name, countryCode: row!.countryCode }).toEqual({ alias, name, countryCode });
    }
  });

  // A GeoNames release that moves an alias's id to another city refuses the alias with the no-place error,
  // rather than sending it to that city. Here the Los Angeles row is replaced by an Anaheim row under its id.
  it("refuses an alias whose id now names another place, with the no-place error", () => {
    const rebound = buildPlaceTable(
      [
        withoutRow("5368361"),
        cityRow({ id: "5368361", name: "Anaheim", lat: "33.83529", lon: "-117.91439", country: "US", admin1: "CA", pop: "345012", zone: "America/Los_Angeles" }),
      ].join("\n"),
      admin1,
      countries,
    );
    for (const alias of ["LA", "L.A."]) {
      expect(thrownBy(() => lookupPlace(rebound, alias)).message, alias).toContain(`no place named "${alias}"`);
    }
  });

  // The alias is a fallback for a name that finds nothing. A real row named like an alias key keeps its own
  // place: a Vegas row in Singapore must win over the Las Vegas alias.
  it("never overrides a name that resolves: a Vegas row keeps its own place", () => {
    const named = buildPlaceTable(
      `${cities}\n${cityRow({ id: "9000002", name: "Vegas", lat: "1.28967", lon: "103.85007", country: "SG", admin1: "", pop: "740", zone: "Asia/Singapore" })}`,
      admin1,
      countries,
    );
    expect(lookupPlace(named, "Vegas")).toEqual({
      name: "Vegas",
      latitude: { degrees: 1.28967, hemisphere: "N" },
      longitude: { degrees: 103.85007, hemisphere: "E" },
      timezone: "Asia/Singapore",
    });
    expect(lookupPlace(named, "Las Vegas").timezone).toBe("America/Los_Angeles");
  });

  // A name that matches several places stays ambiguous: the alias table is consulted only when the name
  // search finds no place, so the Peking alias cannot resolve two rows that share the name. The fixture
  // keeps its Beijing row, so an alias consulted first would resolve here and fail the test.
  it("keeps a shorthand spelling that matches several places ambiguous", () => {
    const shared = buildPlaceTable(
      [
        cities,
        cityRow({ id: "9000003", name: "Peking", country: "BZ", admin1: "", pop: "1000" }),
        cityRow({ id: "9000004", name: "Peking", country: "SR", admin1: "", pop: "1000" }),
      ].join("\n"),
      admin1,
      countries,
    );
    const error = thrownBy(() => lookupPlace(shared, "Peking"));
    expect(error).toBeInstanceOf(AmbiguousPlaceError);
    expect((error as AmbiguousPlaceError).candidates.length).toBe(2);
  });

  // A shorthand stands alone: it is matched on the whole text, so a region or country after it is unknown.
  it("refuses a shorthand with a region or country after it", () => {
    for (const text of ["LA, CA", "Philly, PA", "NYC, US"]) {
      expect(thrownBy(() => lookupPlace(table, text)).message, text).toContain(`no place named "${text}"`);
    }
  });

  // An alias whose target row is absent from the table is reported as any unknown place.
  it("reports Philly as an unknown place when its row is absent", () => {
    const without = buildPlaceTable(withoutRow("4560349"), admin1, countries);
    expect(thrownBy(() => lookupPlace(without, "Philly")).message).toContain('no place named "Philly"');
  });

  // Spellings are keys after the same normalisation as a place name, so case never changes the place.
  it("resolves every case variant of a shorthand to the same place", () => {
    for (const { alias } of PLACE_ALIASES) {
      const place = lookupPlace(table, alias);
      for (const variant of [alias.toUpperCase(), alias.toLowerCase()]) {
        expect(lookupPlace(table, variant), variant).toMatchObject({
          latitude: place.latitude,
          longitude: place.longitude,
          timezone: place.timezone,
        });
      }
    }
  });

  // The fixture row is named "New York City" in both columns, as in cities500, so no name search finds
  // "New York": it reaches the alias, and "New York, NY" is refused as it is on the real file.
  it("resolves New York to the same place as NYC, through the alias", () => {
    expect(table.byName.get(normalizeName("New York")), "a name row would bypass the alias").toBeUndefined();
    expect(lookupPlace(table, "New York")).toEqual({ ...lookupPlace(table, "NYC"), name: "New York" });
  });

  it('refuses "New York, NY" on the fixture, as the real file does', () => {
    expect(thrownBy(() => lookupPlace(table, "New York, NY")).message).toContain('no place named "New York, NY"');
  });

  // An alias names a row by id, name and country code. A row that keeps the id and name but moves to
  // another country must refuse, so the country check in aliasPlace is tested on its own.
  it("refuses an alias whose id keeps the name but now names another country", () => {
    const moved = buildPlaceTable(
      [
        withoutRow("5368361"),
        cityRow({ id: "5368361", name: "Los Angeles", lat: "19.43261", lon: "-99.13321", country: "MX", admin1: "", pop: "9209944", zone: "America/Mexico_City" }),
      ].join("\n"),
      admin1,
      countries,
    );
    // The row is there with the right name and the wrong country, so only the country check can refuse it.
    expect(moved.byGeonameId.get(5368361)).toMatchObject({ name: "Los Angeles", countryCode: "MX" });
    for (const alias of ["LA", "L.A."]) {
      expect(thrownBy(() => lookupPlace(moved, alias)).message, alias).toContain(`no place named "${alias}"`);
    }
  });

  // Two spellings that normalise to one key must name one place. The table is checked when the module
  // loads, so a conflict stops the load rather than silently resolving to the last entry.
  it("refuses to load a table whose spellings share a key but name different places", async () => {
    vi.resetModules();
    vi.doMock("./place-aliases.js", () => ({
      PLACE_ALIASES: [
        { alias: "Vegas", geonameId: 5506956, name: "Las Vegas", countryCode: "US" },
        { alias: "VEGAS", geonameId: 1, name: "Vegas", countryCode: "SG" },
      ],
    }));
    try {
      await expect(import("./place.js")).rejects.toThrow('"VEGAS" normalises to "vegas"');
    } finally {
      vi.doUnmock("./place-aliases.js");
      vi.resetModules();
    }
  });

  // The same key and the same geonameId are not enough: a second row that gives the id another name or
  // another country names another place, so the table is refused too. The last case is the control: the
  // same place spelt twice loads.
  it.each([
    ["name", { alias: "VEGAS", geonameId: 5506956, name: "Vegas", countryCode: "US" }],
    ["country code", { alias: "VEGAS", geonameId: 5506956, name: "Las Vegas", countryCode: "MX" }],
  ])("refuses a table whose duplicate spellings differ in the %s", async (_field, second) => {
    vi.resetModules();
    vi.doMock("./place-aliases.js", () => ({
      PLACE_ALIASES: [
        { alias: "Vegas", geonameId: 5506956, name: "Las Vegas", countryCode: "US" },
        second,
      ],
    }));
    try {
      await expect(import("./place.js")).rejects.toThrow('"VEGAS" normalises to "vegas"');
    } finally {
      vi.doUnmock("./place-aliases.js");
      vi.resetModules();
    }
  });

  it("loads a table whose duplicate spellings name the same place", async () => {
    vi.resetModules();
    vi.doMock("./place-aliases.js", () => ({
      PLACE_ALIASES: [
        { alias: "Vegas", geonameId: 5506956, name: "Las Vegas", countryCode: "US" },
        { alias: "VEGAS", geonameId: 5506956, name: "Las Vegas", countryCode: "US" },
      ],
    }));
    try {
      await expect(import("./place.js")).resolves.toBeDefined();
    } finally {
      vi.doUnmock("./place-aliases.js");
      vi.resetModules();
    }
  });
});

describe("place shorthand against the real GeoNames files", () => {
  // Skipped without the data files, like the other real-data tests.
  withRealData("every alias target exists and is unique in cities500", () => {
    const countIds = (cities: string) => {
      const counts = new Map<string, number>();
      for (const line of cities.split("\n")) {
        const id = line.split("\t", 1)[0];
        if (id !== undefined && id !== "") {
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
      return counts;
    };
    // Re-read the file so the count reflects the real source rows, not the parsed table.
    const cities = readFileSync(join(realDataDir!, CITIES_FILE), "utf8");
    const counts = countIds(cities);
    for (const { alias, geonameId, name, countryCode } of PLACE_ALIASES) {
      // One row per geonameId means an alias can never be hijacked by a different city.
      expect(counts.get(String(geonameId)), `${alias} geonameId ${geonameId} must occur once`).toBe(1);
      const row = realTable!.byGeonameId.get(geonameId);
      expect(row, `${alias} target missing from real table`).toBeDefined();
      // The alias names the row its id returns: the same primary name and country code.
      expect({ alias, name: row!.name, countryCode: row!.countryCode }).toEqual({ alias, name, countryCode });
    }
  });

  // An alias key that is also a real place name would be found by the name search first, so the alias
  // would never apply. Each spelling must be free of a real name.
  withRealData("no alias spelling is also a real place name, so each alias applies", () => {
    for (const { alias } of PLACE_ALIASES) {
      expect(realTable!.byName.get(normalizeName(alias)), `${alias} is a real place name`).toBeUndefined();
    }
  });

  // An alias is used only when the name search finds nothing. Each old name below matches a real
  // place by name in cities500, so it resolves to that place, and the alias table does not apply.
  withRealData("keeps the old names that already match a place, and names the Indian cities instead", () => {
    expect(lookupPlace(realTable!, "Bombay")).toMatchObject({
      latitude: { degrees: 37.16667, hemisphere: "S" },
      longitude: { degrees: 174.98333, hemisphere: "E" },
      timezone: "Pacific/Auckland",
    });
    expect(lookupPlace(realTable!, "Madras")).toMatchObject({
      latitude: { degrees: 44.63345, hemisphere: "N" },
      longitude: { degrees: 121.12949, hemisphere: "W" },
      timezone: "America/Los_Angeles",
    });
    // Four cities500 rows are named Calcutta; the South African one is over three times the next, so it leads.
    expect(lookupPlace(realTable!, "Calcutta")).toMatchObject({
      latitude: { degrees: 24.98317, hemisphere: "S" },
      longitude: { degrees: 31.23485, hemisphere: "E" },
      timezone: "Africa/Johannesburg",
    });
    expect(lookupPlace(realTable!, "Mumbai").timezone).toBe("Asia/Kolkata");
    expect(lookupPlace(realTable!, "Kolkata").latitude.degrees).toBe(22.56263);
    expect(lookupPlace(realTable!, "Chennai").latitude.degrees).toBe(13.08784);
  });

  withRealData("resolves each alias to its place, as the acceptance requires", () => {
    for (const { alias } of PLACE_ALIASES) {
      const expected = ALIAS_EXPECTED[alias];
      expect(expected, `no expected value recorded for ${alias}`).toBeDefined();
      const { latitude, longitude, timezone } = expected!;
      expect(lookupPlace(realTable!, alias)).toEqual({
        name: alias,
        latitude: { degrees: Math.abs(latitude), hemisphere: latitude < 0 ? "S" : "N" },
        longitude: { degrees: Math.abs(longitude), hemisphere: longitude < 0 ? "W" : "E" },
        timezone,
      });
    }
  });
});

describe("a table that cannot be read", () => {
  it("names the file only, never the directory", async () => {
    const dir = join(scratch, "no-such-table-dir");
    const err = await resolvePlace("Austin, TX", { dataDir: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AstroError);
    expect((err as AstroError).message).toMatch(/GeoNames file \S+ cannot be read/);
    expect((err as AstroError).message).not.toContain("/");
    expect((err as AstroError).fix).not.toContain(dir);
  });
});

describe("resolvePlace with explicit values", () => {
  it("returns the explicit place without reading any table", async () => {
    const place = await resolvePlace("Anywhere", {
      latitude: 40.7,
      longitude: -73.9,
      timezone: "America/New_York",
      dataDir: join(scratch, "does-not-exist"),
    });
    expect(place).toEqual({
      name: "Anywhere",
      latitude: { degrees: 40.7, hemisphere: "N" },
      longitude: { degrees: 73.9, hemisphere: "W" },
      timezone: "America/New_York",
    });
  });

  it("lets an explicit zone override the table's zone", async () => {
    const dir = join(scratch, "override-zone");
    await mkdir(dir, { recursive: true });
    await dataDirWith(dir, allFiles);
    const place = await resolvePlace("Austin, TX", { dataDir: dir, timezone: "Europe/Paris" });
    expect(place.timezone).toBe("Europe/Paris");
    expect(place.latitude.degrees).toBe(30.26715);
  });

  it("lets explicit coordinates override the table's coordinates", async () => {
    const dir = join(scratch, "override-coords");
    await mkdir(dir, { recursive: true });
    await dataDirWith(dir, allFiles);
    const place: Place = await resolvePlace("Austin, TX", {
      dataDir: dir,
      latitude: 10,
      longitude: -20,
    });
    expect(place.latitude).toEqual({ degrees: 10, hemisphere: "N" });
    expect(place.longitude).toEqual({ degrees: 20, hemisphere: "W" });
    expect(place.timezone).toBe("America/Chicago");
  });

  it("needs the table when a field is missing, and says how to supply it", async () => {
    const error = await rejectedWith(
      resolvePlace("Anywhere", {
        latitude: 40.7,
        longitude: -73.9,
        dataDir: join(scratch, "absent"),
      }),
    );
    // The three reads run in parallel, so the first file named can be any of them.
    expect([CITIES_FILE, ADMIN1_FILE, COUNTRY_FILE].some((name) => error.message.includes(name))).toBe(
      true,
    );
    expect(error.fix).toContain("ASTROLOG_MCP_DATA");
  });

  it("refuses an explicit zone that is not an IANA name", async () => {
    const error = await rejectedWith(
      resolvePlace("Anywhere", { latitude: 1, longitude: 1, timezone: "Mars/Olympus" }),
    );
    expect(error.message).toContain("not an IANA zone name");
  });

  it("refuses an explicit latitude beyond 90 degrees", async () => {
    const error = await rejectedWith(
      resolvePlace("Anywhere", { latitude: 91, longitude: 1, timezone: "UTC" }),
    );
    expect(error.message).toContain("latitude must be a number from -90 to 90");
  });
});

describe("resolvePlace from a data directory", () => {
  it("reads the table once and keeps it, then retries a load that failed", async () => {
    const dir = join(scratch, "cached");
    await mkdir(dir, { recursive: true });
    await dataDirWith(dir, allFiles);
    const first = await resolvePlace("Austin, TX", { dataDir: dir });
    expect(first.timezone).toBe("America/Chicago");

    // The table is cached, so removing the file does not break the next lookup.
    await unlink(join(dir, CITIES_FILE));
    const second = await resolvePlace("Austin, TX", { dataDir: dir });
    expect(second).toEqual(first);

    // A directory that cannot be read is not cached: the same call works once it holds the files.
    const later = join(scratch, "later");
    await mkdir(later, { recursive: true });
    const failure = await rejectedWith(resolvePlace("Austin, TX", { dataDir: later }));
    expect(failure.fix).toContain("ASTROLOG_MCP_DATA");
    await dataDirWith(later, allFiles);
    expect((await resolvePlace("Austin, TX", { dataDir: later })).timezone).toBe("America/Chicago");
  });

  it("reads the directory named by ASTROLOG_MCP_DATA when no dataDir is given", async () => {
    const dir = join(scratch, "from-env");
    const empty = join(scratch, "env-empty");
    await mkdir(dir, { recursive: true });
    await mkdir(empty, { recursive: true });
    await dataDirWith(dir, allFiles);
    const before = process.env.ASTROLOG_MCP_DATA;
    try {
      process.env.ASTROLOG_MCP_DATA = dir;
      expect((await resolvePlace("Austin, TX")).timezone).toBe("America/Chicago");

      // An empty directory named by the variable is the one that is reported, not ./data.
      process.env.ASTROLOG_MCP_DATA = empty;
      resetDirectoryLogForTests();
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const failure = await rejectedWith(resolvePlace("Austin, TX"));
      expect(failure.message).not.toContain(empty);
      expect(logged).toHaveBeenCalledWith(`GeoNames table directory: ${empty}`);
      // The directory is logged once per process; a second failed read is retried but not logged again.
      await rejectedWith(resolvePlace("Austin, TX"));
      expect(logged).toHaveBeenCalledTimes(1);
      logged.mockRestore();
    } finally {
      if (before === undefined) {
        delete process.env.ASTROLOG_MCP_DATA;
      } else {
        process.env.ASTROLOG_MCP_DATA = before;
      }
    }
  });

  it("rejects an ambiguous name with the candidate list", async () => {
    const dir = join(scratch, "ambiguous");
    await mkdir(dir, { recursive: true });
    await dataDirWith(dir, allFiles);
    const error = await rejectedWith(resolvePlace("Springfield", { dataDir: dir }));
    expect(error).toBeInstanceOf(AmbiguousPlaceError);
    expect((error as AmbiguousPlaceError).candidates.length).toBe(4);
  });
});

// One GeoNames-layout city row, with the fields a test varies. The defaults make a valid row.
function cityRow(
  fields: Partial<{
    id: string;
    name: string;
    lat: string;
    lon: string;
    country: string;
    admin1: string;
    pop: string;
    zone: string;
  }> = {},
): string {
  const f = {
    id: "9000001",
    name: "Twin",
    lat: "30",
    lon: "-90",
    country: "US",
    admin1: "TX",
    pop: "100",
    zone: "America/Chicago",
    ...fields,
  };
  return [
    f.id,
    f.name,
    f.name,
    "",
    f.lat,
    f.lon,
    "P",
    "PPL",
    f.country,
    "",
    f.admin1,
    "",
    "",
    "",
    f.pop,
    "",
    "",
    f.zone,
    "2023-01-01",
  ].join("\t");
}

describe("ranking rule", () => {
  // Two towns with the same name in the same place, and the populations to rank them by.
  function twoTowns(
    first: number,
    second: number,
    place: Partial<{ country: string; admin1: string }> = {},
  ): PlaceTable {
    return buildPlaceTable(
      [
        cityRow({ id: "1", lat: "30", pop: String(first), ...place }),
        cityRow({ id: "2", lat: "31", pop: String(second), ...place }),
      ].join("\n"),
      admin1,
      countries,
    );
  }

  it("takes the top town when it has at least three times the next one's population", () => {
    expect(lookupPlace(twoTowns(300, 100), "Twin, TX").latitude.degrees).toBe(30);
  });

  it("calls it ambiguous just under three times", () => {
    expect(() => lookupPlace(twoTowns(299, 100), "Twin, TX")).toThrow(AmbiguousPlaceError);
  });

  it("never picks a town when both have no population", () => {
    expect(() => lookupPlace(twoTowns(0, 0), "Twin, TX")).toThrow(AmbiguousPlaceError);
  });

  it("asks for a region when the text has none, and suggests the region name", () => {
    const error = thrownBy(() => lookupPlace(twoTowns(299, 100), "Twin"));
    expect(error.fix).toBe(
      'Add a region or country to the place, for example "Twin, Texas", or pass latitude, longitude and time zone.',
    );
    // Both towns are in Texas, so the suggested region does not separate them: the retry asks for coordinates.
    expect(() => lookupPlace(twoTowns(299, 100), "Twin, Texas")).toThrow(AmbiguousPlaceError);
  });

  it("asks for coordinates when the text already has a region", () => {
    const error = thrownBy(() => lookupPlace(twoTowns(299, 100), "Twin, TX"));
    expect(error.fix).toBe(
      "Pass latitude, longitude and time zone, because the place name alone does not say which of these you mean.",
    );
  });

  it("describes a region-less candidate without repeating its country", () => {
    const error = thrownBy(() =>
      lookupPlace(twoTowns(0, 0, { country: "SG", admin1: "" }), "Twin"),
    );
    expect(error.message).toContain("Twin, Singapore (population 0)");
    expect(error.message).not.toContain("Singapore, Singapore");
  });
});

describe("buildPlaceTable", () => {
  it("skips and counts city rows whose coordinates or zone fail validation", () => {
    const bad = [
      cityRow({ name: "Blank", lat: "" }),
      cityRow({ name: "Hex", lat: "0x1E" }),
      cityRow({ name: "Padded", lat: " 30" }),
      cityRow({ name: "Exponent", lon: "1e2" }),
      cityRow({ name: "Far", lat: "91" }),
      cityRow({ name: "Olympus", zone: "Mars/Olympus" }),
      cityRow({ name: "Blankzone", zone: "" }),
    ];
    const table = buildPlaceTable(`${cities}\n${bad.join("\n")}`, admin1, countries);
    expect(table.skipped).toBe(bad.length);
    for (const name of ["Blank", "Hex", "Padded", "Exponent", "Far", "Olympus", "Blankzone"]) {
      const error = thrownBy(() => lookupPlace(table, name));
      expect(error).not.toBeInstanceOf(AmbiguousPlaceError);
      expect(error.message).toContain(`no place named "${name}"`);
    }
    expect(lookupPlace(table, "Austin, TX").timezone).toBe("America/Chicago");
  });

  it("counts no skipped rows in the committed fixture", () => {
    expect(table.skipped).toBe(0);
  });

  // The bound is generous: a loaded full run can slow a build well past its own cost, and the budget is for a real slowdown.
  it("builds a 20k-row table in under 2 seconds", () => {
    // The fixture's rows repeated, so the build sees the row count of a large GeoNames file.
    const rows = cities.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    const big = Array.from({ length: 20_000 }, (_, i) => rows[i % rows.length]).join("\n");
    // The fastest of three builds: a single build can lose its time to load from other tests in the same run.
    let fastest = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      const built = buildPlaceTable(big, admin1, countries);
      fastest = Math.min(fastest, performance.now() - started);
      expect(built.skipped).toBe(0);
    }
    expect(fastest).toBeLessThan(2000);
  });

  it("checks each distinct zone once per build, not once per row", () => {
    const rows = cities.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
    const zones = new Set(rows.map((line) => line.split("\t")[17]));
    const big = Array.from({ length: 20_000 }, (_, i) => rows[i % rows.length]).join("\n");
    const spy = vi.spyOn(IANAZone, "isValidZone");
    try {
      buildPlaceTable(big, admin1, countries);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(zones.size);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a file with no usable row, with the count and a fix line", () => {
    const error = thrownBy(() => buildPlaceTable(cityRow({ lat: "" }), admin1, countries));
    expect(error.message).toBe(`${CITIES_FILE} has no usable city rows (1 skipped)`);
    expect(error.fix).toContain("installer");
  });

  it("normalises case, accents and punctuation the same way on both sides", () => {
    expect(normalizeName("St. Louis")).toBe("st louis");
    expect(normalizeName("Málaga")).toBe("malaga");
    expect(normalizeName("Winston-Salem, NC")).toBe("winston salem nc");
  });

  it('closes initialisms, so "D.C." and "N.Y." meet "DC" and "NY"', () => {
    expect(normalizeName("Washington, D.C.")).toBe("washington dc");
    expect(normalizeName("N.Y.")).toBe("ny");
    expect(normalizeName("U.S.A.")).toBe("usa");
    expect(normalizeName("St. Louis")).toBe("st louis");
  });
});

describe("text and options that are not valid", () => {
  it.each([undefined, null, 42, ""])(
    "resolvePlace refuses %s with an AstroError",
    async (value) => {
      const error = await rejectedWith(resolvePlace(value as unknown as string));
      expect(error.message).toContain("the place must be non-empty text");
      expect(error.fix).toContain('"Austin, TX"');
    },
  );

  it("lookupPlace refuses a value that is not text", () => {
    const error = thrownBy(() => lookupPlace(table, 7 as unknown as string));
    expect(error.message).toContain("the place must be non-empty text, got 7");
  });

  it("resolvePlace refuses options that are not an object", async () => {
    const error = await rejectedWith(resolvePlace("Austin, TX", null as unknown as object));
    expect(error.message).toContain("place options must be an object");
  });
});

describe("attribution", () => {
  it("credits GeoNames under CC BY 4.0 in README and NOTICE", () => {
    for (const file of ["../README.md", "../NOTICE"]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text).toContain("GeoNames");
      expect(text).toContain("CC BY 4.0");
      expect(text).toContain("https://www.geonames.org/");
    }
  });
});
