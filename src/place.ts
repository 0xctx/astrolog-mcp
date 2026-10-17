import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { IANAZone } from "luxon";
import { latitudeFromSigned, longitudeFromSigned } from "./astrolog/coord.js";
import { AstroError, type Place } from "./types.js";
import { PLACE_ALIASES, type PlaceAlias } from "./place-aliases.js";

// The GeoNames files the installer puts in the data directory. The table is never committed.
export const CITIES_FILE = "cities500.txt";
export const ADMIN1_FILE = "admin1CodesASCII.txt";
export const COUNTRY_FILE = "countryInfo.txt";

// A cities row has 19 tab-separated columns, GeoNames readme order.
const CITY_COLUMNS = 19;
const MAX_CANDIDATES = 5;
// The top match wins outright when it has at least this many times the next one's population.
const CLEAR_LEAD = 3;
// A plain decimal: optional sign, digits with an optional point. No exponent, hex, blanks or padding.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const COUNT = /^\d+$/;

export interface PlaceCandidate {
  name: string;
  region?: string;
  regionCode?: string;
  country: string;
  countryCode: string;
  population: number;
}

// Thrown when the name matches several places and no clear best one. Carries up to five candidates.
export class AmbiguousPlaceError extends AstroError {
  constructor(
    message: string,
    fix: string,
    readonly candidates: PlaceCandidate[],
  ) {
    super(message, fix);
    this.name = "AmbiguousPlaceError";
  }
}

interface Row extends PlaceCandidate {
  asciiName: string;
  geonameId: number;
  latitude: number;
  longitude: number;
  timezone: string;
  // Normalised region and country spellings a suffix may use, such as "tx", "texas", "us", "usa".
  regionForms: string[];
  countryForms: string[];
}

export interface PlaceTable {
  byName: Map<string, Row[]>;
  // Every city row, keyed by its GeoNames geonameId, for alias resolution and uniqueness checks.
  byGeonameId: Map<number, Row>;
  // City rows left out because a field failed validation. Callers and tests read this count to see
  // that the file is partly unusable; a skipped row never resolves.
  skipped: number;
}

// Lowercase, accents removed, initialism periods closed, punctuation and spacing collapsed to single
// spaces. The same rule applies to the table and to the user's text, so "St. Louis" and "st louis"
// meet, and "D.C." and "DC" meet.
export function normalizeName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/(?<!\p{L})(\p{L})\.(?=\p{L})/gu, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Parses the three GeoNames files into a lookup table. Pure, so tests pass in text. A city row that
// fails validation is skipped and counted; a file with no usable row at all throws.
export function buildPlaceTable(cities: string, admin1: string, countries: string): PlaceTable {
  const regions = parseAdmin1(admin1);
  const countryNames = parseCountries(countries);
  const zoneValid = zoneChecker();
  const byName = new Map<string, Row[]>();
  const byGeonameId = new Map<number, Row>();
  let usable = 0;
  let skipped = 0;
  for (const line of cityLines(cities)) {
    const row = parseCity(line, regions, countryNames, zoneValid);
    if (row === undefined) {
      skipped++;
      continue;
    }
    usable++;
    byGeonameId.set(row.geonameId, row);
    for (const key of new Set([normalizeName(row.name), normalizeName(row.asciiName)])) {
      if (key === "") {
        continue;
      }
      const rows = byName.get(key) ?? [];
      rows.push(row);
      byName.set(key, rows);
    }
  }
  if (usable === 0) {
    throw new AstroError(
      `${CITIES_FILE} has no usable city rows (${skipped} skipped)`,
      `Run the installer again so ${CITIES_FILE} is the GeoNames file, or set ASTROLOG_MCP_DATA to the directory that holds it.`,
    );
  }
  return { byName, byGeonameId, skipped };
}

// The fixed shorthand table, keyed by normalised alias text. Built once at module load from
// PLACE_ALIASES; normalising the keys here means "LA" and "L.A." and "la" all match the same entry,
// exactly as they would match a city name. Two spellings that normalise alike must name the same
// place, or the table is refused at load: a silent last-entry-wins would hide the conflict. A place is
// the id, name and country code together, so two spellings of one key must agree on all three.
const ALIAS_BY_KEY: Map<string, PlaceAlias> = new Map();
for (const entry of PLACE_ALIASES) {
  const key = normalizeName(entry.alias);
  const existing = ALIAS_BY_KEY.get(key);
  if (
    existing !== undefined &&
    (existing.geonameId !== entry.geonameId ||
      existing.name !== entry.name ||
      existing.countryCode !== entry.countryCode)
  ) {
    throw new Error(`place alias "${entry.alias}" normalises to "${key}", which already names another place`);
  }
  ALIAS_BY_KEY.set(key, entry);
}

// Resolves a place by name with a candidate list on ambiguity. Explicit latitude, longitude and
// timezone override the lookup, and when all three are given the table is not read at all.
export interface PlaceOptions {
  // Signed decimal degrees, north and east positive.
  latitude?: number;
  longitude?: number;
  timezone?: string;
  // Defaults to ASTROLOG_MCP_DATA, then ./data.
  dataDir?: string;
}

export async function resolvePlace(text: string, opts: PlaceOptions = {}): Promise<Place> {
  requireText(text);
  requireOptions(opts);
  const { latitude, longitude, timezone } = opts;
  if (latitude !== undefined && longitude !== undefined && timezone !== undefined) {
    return {
      name: text.trim(),
      latitude: latitudeFromSigned(latitude),
      longitude: longitudeFromSigned(longitude),
      timezone: checkZone(timezone),
    };
  }
  const table = await loadPlaceTable(opts.dataDir ?? defaultDataDir());
  const found = lookupPlace(table, text);
  return {
    name: found.name,
    latitude: latitude === undefined ? found.latitude : latitudeFromSigned(latitude),
    longitude: longitude === undefined ? found.longitude : longitudeFromSigned(longitude),
    timezone: timezone === undefined ? found.timezone : checkZone(timezone),
  };
}

// Pure lookup against a built table. Throws AmbiguousPlaceError or AstroError with a fix line.
export function lookupPlace(table: PlaceTable, text: string): Place {
  requireText(text);
  const normalized = normalizeName(text);
  const { rows: matches, qualified } = findMatches(table, normalized.split(" ").filter(Boolean));
  if (matches.length === 0) {
    // The alias is consulted only when the name search finds no place at all, so it never overrides a
    // name that resolves and never turns an ambiguous name into a resolved one. A missing alias target
    // is reported as any other unknown place.
    const aliased = aliasPlace(table, normalized, text);
    if (aliased !== undefined) {
      return aliased;
    }
    throw new AstroError(
      `no place named "${text.trim()}" is in the built-in list of places`,
      'Write the place as "City, ST" or "City, Country", for example "Austin, TX", or pass latitude, longitude and time zone.',
    );
  }
  const ranked = [...matches].sort(
    (a, b) => b.population - a.population || a.geonameId - b.geonameId,
  );
  const leader = clearLeader(ranked);
  if (leader !== undefined) {
    return {
      name: text.trim(),
      latitude: latitudeFromSigned(leader.latitude),
      longitude: longitudeFromSigned(leader.longitude),
      timezone: leader.timezone,
    };
  }
  const candidates = ranked.slice(0, MAX_CANDIDATES).map(toCandidate);
  const first = candidates[0];
  // A region or country already in the text cannot be the missing piece, so the fix asks for coordinates.
  const fix = qualified
    ? "Pass latitude, longitude and time zone, because the place name alone does not say which of these you mean."
    : `Add a region or country to the place, for example "${first?.name}, ${first?.region ?? first?.country}", or pass latitude, longitude and time zone.`;
  throw new AmbiguousPlaceError(
    `"${text.trim()}" matches ${ranked.length} places: ${candidates.map(describe).join("; ")}${
      ranked.length > candidates.length ? ` (showing ${candidates.length} of ${ranked.length})` : ""
    }`,
    fix,
    candidates,
  );
}

// The place a shorthand names, or undefined when the text is not an alias, its target row is absent,
// or the row the id returns is not the place the alias names (a re-bound GeoNames id). Coordinates and
// zone come from the target row, as they do for any name.
function aliasPlace(table: PlaceTable, normalized: string, text: string): Place | undefined {
  const entry = ALIAS_BY_KEY.get(normalized);
  const row = entry === undefined ? undefined : table.byGeonameId.get(entry.geonameId);
  if (entry === undefined || row === undefined || row.name !== entry.name || row.countryCode !== entry.countryCode) {
    return undefined;
  }
  return {
    name: text.trim(),
    latitude: latitudeFromSigned(row.latitude),
    longitude: longitudeFromSigned(row.longitude),
    timezone: row.timezone,
  };
}

// The most populous match when it is the only one, or when it has at least CLEAR_LEAD times the
// population of the next. A population of zero never leads, so two unknown towns stay ambiguous.
function clearLeader(ranked: Row[]): Row | undefined {
  const [top, next] = ranked;
  if (top === undefined || next === undefined) {
    return top;
  }
  return top.population > 0 && top.population >= CLEAR_LEAD * next.population ? top : undefined;
}

interface Matches {
  rows: Row[];
  // True when the text named a region or country after the place name.
  qualified: boolean;
}

// The longest leading run of tokens that is a name, with the rest read as region or country. Where
// the rest names a region of some row, only those rows count, so "Richmond, CA" is California and
// not Canada. A country code alone is the fallback.
function findMatches(table: PlaceTable, tokens: string[]): Matches {
  for (let split = tokens.length; split >= 1; split--) {
    const rows = table.byName.get(tokens.slice(0, split).join(" ")) ?? [];
    if (split === tokens.length) {
      if (rows.length > 0) {
        return { rows, qualified: false };
      }
      continue;
    }
    const rest = tokens.slice(split).join(" ");
    const inRegion = rows.filter((row) => matchesRegion(row, rest));
    const found =
      inRegion.length > 0 ? inRegion : rows.filter((row) => row.countryForms.includes(rest));
    if (found.length > 0) {
      return { rows: found, qualified: true };
    }
  }
  return { rows: [], qualified: false };
}

function matchesRegion(row: Row, rest: string): boolean {
  return row.regionForms.some(
    (region) =>
      region === rest || row.countryForms.some((country) => `${region} ${country}` === rest),
  );
}

// Cached per data directory. A failed load is forgotten, so a later call can retry after the
// installer has run.
const tables = new Map<string, Promise<PlaceTable>>();
let directoryLogged = false;

// Test hook: lets a test see the once-per-process directory line again.
export function resetDirectoryLogForTests(): void {
  directoryLogged = false;
}

export function loadPlaceTable(dataDir: string): Promise<PlaceTable> {
  let table = tables.get(dataDir);
  if (table === undefined) {
    table = readTable(dataDir);
    tables.set(dataDir, table);
    table.catch(() => {
      tables.delete(dataDir);
    });
  }
  return table;
}

async function readTable(dataDir: string): Promise<PlaceTable> {
  // The client message names a file only; the operator gets the directory once per process, on
  // stderr, though a failed read is retried on each place call.
  const [cities, admin1, countries] = await Promise.all([
    readData(join(dataDir, CITIES_FILE), dataDir),
    readData(join(dataDir, ADMIN1_FILE), dataDir),
    readData(join(dataDir, COUNTRY_FILE), dataDir),
  ]).catch((error: unknown) => {
    if (!directoryLogged) {
      directoryLogged = true;
      console.error(`GeoNames table directory: ${dataDir}`);
    }
    throw error;
  });
  return buildPlaceTable(cities, admin1, countries);
}

async function readData(path: string, dataDir: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new AstroError(
      `the GeoNames file ${basename(path)} cannot be read`,
      `Run the installer so the data directory holds ${CITIES_FILE}, ${ADMIN1_FILE} and ${COUNTRY_FILE}, or set ASTROLOG_MCP_DATA to the directory that does.`,
    );
  }
}

function defaultDataDir(): string {
  return process.env.ASTROLOG_MCP_DATA || "./data";
}

function requireText(text: unknown): asserts text is string {
  if (typeof text !== "string" || text.trim() === "") {
    throw new AstroError(
      `the place must be non-empty text, got ${typeof text === "string" ? JSON.stringify(text) : String(text)}`,
      'Pass the place as text such as "Austin, TX", or pass latitude, longitude and time zone.',
    );
  }
}

function requireOptions(opts: unknown): void {
  if (typeof opts !== "object" || opts === null) {
    throw new AstroError(
      `place options must be an object, got ${String(opts)}`,
      "Pass the options as an object, or leave them out.",
    );
  }
}

function checkZone(timezone: string): string {
  if (typeof timezone !== "string" || !IANAZone.isValidZone(timezone)) {
    throw new AstroError(
      `the time zone ${JSON.stringify(timezone)} is not an IANA zone name`,
      'Use an IANA zone name such as "America/Chicago".',
    );
  }
  return timezone;
}

interface Admin1 {
  name: string;
  asciiName: string;
  code: string;
}

// admin1CodesASCII.txt: "US.TX", name, asciiname, geonameid.
function parseAdmin1(text: string): Map<string, Admin1> {
  const regions = new Map<string, Admin1>();
  for (const line of text.split("\n")) {
    const [key, name, asciiName] = line.split("\t");
    if (key === undefined || name === undefined || asciiName === undefined || key === "") {
      continue;
    }
    const dot = key.indexOf(".");
    regions.set(key, { name, asciiName, code: key.slice(dot + 1) });
  }
  return regions;
}

interface CountryName {
  iso3: string;
  name: string;
  // The FIPS code, kept only when it is unique and is not another country's ISO code.
  fips?: string;
}

// countryInfo.txt: lines starting with # are comments. Column 0 is ISO, 1 ISO3, 3 FIPS, 4 Country.
// FIPS codes are kept only when they cannot be confused with an ISO code: "SZ" is Eswatini's ISO code
// and Switzerland's FIPS code, and a user who writes "SZ" means Eswatini.
function parseCountries(text: string): Map<string, CountryName> {
  const rows: { iso: string; iso3: string; fips: string; name: string }[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const [iso, iso3, , fips = "", name] = line.split("\t");
    if (iso !== undefined && iso !== "" && iso3 !== undefined && name !== undefined) {
      rows.push({ iso, iso3, fips, name });
    }
  }
  const isoCodes = new Set(rows.map((row) => row.iso));
  const fipsUse = new Map<string, number>();
  for (const row of rows) {
    fipsUse.set(row.fips, (fipsUse.get(row.fips) ?? 0) + 1);
  }
  const countries = new Map<string, CountryName>();
  for (const row of rows) {
    const usable =
      row.fips !== "" &&
      row.fips !== row.iso &&
      !isoCodes.has(row.fips) &&
      fipsUse.get(row.fips) === 1;
    countries.set(row.iso, {
      iso3: row.iso3,
      name: row.name,
      ...(usable ? { fips: row.fips } : {}),
    });
  }
  return countries;
}

function cityLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "" && !line.startsWith("#"));
}

// A strict decimal in range, or undefined. The text is not trimmed, so padding fails too.
function parseDegrees(text: string, max: number): number | undefined {
  if (!DECIMAL.test(text)) {
    return undefined;
  }
  const degrees = Number(text);
  return Math.abs(degrees) <= max ? degrees : undefined;
}

// One answer per distinct zone name, so a build asks luxon about each zone once, not once per row.
function zoneChecker(): (zone: string) => boolean {
  const known = new Map<string, boolean>();
  return (zone) => {
    let valid = known.get(zone);
    if (valid === undefined) {
      valid = IANAZone.isValidZone(zone);
      known.set(zone, valid);
    }
    return valid;
  };
}

// Returns undefined for a row that fails validation, so it is skipped rather than resolved.
function parseCity(
  line: string,
  regions: Map<string, Admin1>,
  countries: Map<string, CountryName>,
  zoneValid: (zone: string) => boolean,
): Row | undefined {
  const cols = line.split("\t");
  if (cols.length < CITY_COLUMNS) {
    return undefined;
  }
  const [
    id = "",
    name = "",
    asciiName = "",
    ,
    lat = "",
    lon = "",
    ,
    ,
    countryCode = "",
    ,
    admin1Code = "",
    ,
    ,
    ,
    pop = "",
    ,
    ,
    timezone = "",
  ] = cols;
  const latitude = parseDegrees(lat, 90);
  const longitude = parseDegrees(lon, 180);
  const population = COUNT.test(pop) ? Number(pop) : undefined;
  const geonameId = COUNT.test(id) ? Number(id) : undefined;
  if (
    name === "" ||
    countryCode === "" ||
    latitude === undefined ||
    longitude === undefined ||
    population === undefined ||
    geonameId === undefined ||
    !zoneValid(timezone)
  ) {
    return undefined;
  }
  const region = admin1Code === "" ? undefined : regions.get(`${countryCode}.${admin1Code}`);
  const country = countries.get(countryCode);
  const countryName = country?.name ?? countryCode;
  const row: Row = {
    name,
    asciiName,
    country: countryName,
    countryCode,
    population,
    geonameId,
    latitude,
    longitude,
    timezone,
    regionForms: [],
    countryForms: [countryCode, country?.iso3, country?.fips, countryName]
      .filter((form): form is string => form !== undefined && form !== "")
      .map(normalizeName)
      .filter(Boolean),
  };
  if (region !== undefined) {
    row.region = region.name;
    row.regionCode = region.code;
    row.regionForms = [region.code, region.name, region.asciiName]
      .map(normalizeName)
      .filter(Boolean);
  }
  return row;
}

function toCandidate(row: Row): PlaceCandidate {
  return {
    name: row.name,
    ...(row.region === undefined ? {} : { region: row.region, regionCode: row.regionCode }),
    country: row.country,
    countryCode: row.countryCode,
    population: row.population,
  };
}

// Name, region and country, with a repeated part left out: a city-state reads "Singapore" once.
function describe(candidate: PlaceCandidate): string {
  const parts = [candidate.name, candidate.region, candidate.country].filter(
    (part, index, all): part is string => part !== undefined && all.indexOf(part) === index,
  );
  return `${parts.join(", ")} (population ${candidate.population})`;
}
