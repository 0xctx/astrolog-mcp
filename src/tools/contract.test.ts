import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PLACE_ALIASES } from "../place-aliases.js";
import { AYANAMSAS, OBJECT_CODES } from "../types.js";
import { ASPECT_NAME_GUIDE, ASPECT_SYNONYMS } from "./aspect-list.js";
import { FIELD_WORDS, invalidInputResult } from "./call.js";
import { chartInputSchema } from "./chart.js";
import { compositeInputSchema } from "./composite.js";
import { dailyInputSchema } from "./daily.js";
import { harmonicInputSchema } from "./harmonic.js";
import {
  AYANAMSA_SYNONYMS,
  HOUSE_SYSTEM_NAMES,
  HOUSE_SYSTEM_SYNONYMS,
  namesPeopleUse,
  OBJECT_CODE_LIST,
  objectCodesField,
} from "./input.js";
import { ALL_ASPECT_NAMES } from "./output.js";
import { transitInputSchema } from "./transit.js";

// The five tools' input schemas, by the name the audit table uses.
const SCHEMAS: Record<string, z.ZodType> = {
  chart: chartInputSchema,
  transit: transitInputSchema,
  composite: compositeInputSchema,
  harmonic: harmonicInputSchema,
  daily: dailyInputSchema,
};

interface JsonNode {
  type?: string;
  description?: string;
  enum?: unknown[];
  pattern?: string;
  maxLength?: number;
  maxItems?: number;
  items?: JsonNode;
  properties?: Record<string, JsonNode>;
}

function inputJson(schema: z.ZodType): JsonNode {
  return z.toJSONSchema(schema, { io: "input" }) as JsonNode;
}

// Every string in a schema, with its path, nested objects and array items included.
function strings(node: JsonNode, path: string): [string, JsonNode][] {
  const own: [string, JsonNode][] = node.type === "string" ? [[path, node]] : [];
  const items = node.items ? strings(node.items, `${path}[]`) : [];
  const fields = Object.entries(node.properties ?? {}).flatMap(([key, child]) => strings(child, path ? `${path}.${key}` : key));
  return [...own, ...items, ...fields];
}

describe("input bounds", () => {
  it.each(Object.entries(SCHEMAS))("bounds every text field of %s by a maximum length, an anchored pattern or a value list", (_, schema) => {
    const found = strings(inputJson(schema), "");
    expect(found.length).toBeGreaterThan(0);
    for (const [path, node] of found) {
      const anchored = node.pattern !== undefined && node.pattern.startsWith("^") && node.pattern.endsWith("$");
      expect({ path, bounded: node.maxLength !== undefined || anchored || node.enum !== undefined }).toEqual({
        path,
        bounded: true,
      });
    }
  });

  it("caps the bodies list at the number of object codes, with its own message", () => {
    const field = objectCodesField("Bodies.");
    expect((z.toJSONSchema(field, { io: "input" }) as JsonNode).maxItems).toBe(OBJECT_CODES.length);
    const tooMany = field.safeParse([...OBJECT_CODES, "Sun"]);
    expect(tooMany.error?.issues.map((issue) => issue.message)).toContain(`List at most ${OBJECT_CODES.length} object codes.`);
  });
});

describe("description lists", () => {
  it("lists exactly the object codes, in order, each with its name", () => {
    expect(OBJECT_CODE_LIST.map((entry) => entry.split(" ")[0])).toEqual([...OBJECT_CODES]);
    expect(OBJECT_CODE_LIST).toContain("Moo (Moon)");
    expect(OBJECT_CODE_LIST).toContain("Nor (Mean North Node, North Node)");
    const description = inputJson(chartInputSchema).properties?.bodies?.description;
    expect(description).toContain(`Codes: ${OBJECT_CODE_LIST.join(", ")}.`);
  });

  it("gives other names for exactly the accepted house systems and zodiacs, and no other value's name", () => {
    expect(Object.keys(HOUSE_SYSTEM_SYNONYMS).sort()).toEqual([...HOUSE_SYSTEM_NAMES].sort());
    expect(Object.keys(AYANAMSA_SYNONYMS).sort()).toEqual([...AYANAMSAS].sort());
    for (const synonyms of [HOUSE_SYSTEM_SYNONYMS, AYANAMSA_SYNONYMS] as Record<string, string>[]) {
      for (const [value, names] of Object.entries(synonyms)) {
        for (const other of Object.keys(synonyms).filter((key) => key !== value)) {
          expect({ value, names, mentions: new RegExp(`\\b${other.replace("_", "[ _-]")}\\b`, "i").test(names) }).toEqual({
            value,
            names,
            mentions: false,
          });
        }
      }
    }
    const properties = inputJson(chartInputSchema).properties;
    expect(properties?.house_system?.description).toContain(namesPeopleUse(HOUSE_SYSTEM_SYNONYMS));
    expect(properties?.ayanamsa?.description).toContain(namesPeopleUse(AYANAMSA_SYNONYMS));
  });

  it("names every aspect of the sets once, with its other names, in every tool that reads an aspect set", () => {
    expect(Object.keys(ASPECT_SYNONYMS).sort()).toEqual([...ALL_ASPECT_NAMES].sort());
    for (const name of ALL_ASPECT_NAMES) {
      expect(ASPECT_NAME_GUIDE.match(new RegExp(`(^|[:,;] |has |adds )${name} \\(`, "g"))).toHaveLength(1);
    }
    expect(ASPECT_NAME_GUIDE).toContain("square (sqr, quartile, 90°)");
    expect(ASPECT_NAME_GUIDE).toContain("septile (sep, 51°26′)");
    for (const name of ["chart", "transit", "composite", "daily"]) {
      expect(inputJson(SCHEMAS[name] as z.ZodType).properties?.aspects?.description).toContain(ASPECT_NAME_GUIDE);
    }
  });

  it("names time zones by IANA name only, and names the place shorthand it supports", () => {
    const properties = inputJson(chartInputSchema).properties;
    expect(properties?.timezone?.description).not.toMatch(/\b(EST|EDT|CST|CDT|PST|PDT|BST|GMT)\b/);
    expect(properties?.place?.description).toMatch(/\b(NYC|LA|SF|DC)\b/);
  });

  it("documents every place shorthand in docs/tools.md", () => {
    const doc = readFileSync(new URL("../../docs/tools.md", import.meta.url), "utf8");
    for (const { alias } of PLACE_ALIASES) {
      expect(doc, alias).toContain(`\`${alias}\``);
    }
  });

  // The check the other way: the table promises only spellings the alias table resolves. Both sets are
  // compared whole, so removing a row fails here too, and so does a spelling the table does not resolve.
  it("lists in the docs shorthand table exactly the spellings in PLACE_ALIASES", () => {
    const doc = readFileSync(new URL("../../docs/tools.md", import.meta.url), "utf8");
    expect(docShorthands(doc).sort()).toEqual(PLACE_ALIASES.map(({ alias }) => alias).sort());
  });
});

// The backticked spellings in the first cell of the shorthand table in docs/tools.md, one row each.
function docShorthands(doc: string): string[] {
  const lines = doc.split("\n");
  const header = lines.indexOf("| Shorthand | Resolves to | Alias target |");
  expect(header, "the shorthand table header").toBeGreaterThan(-1);
  const spellings: string[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) {
      break;
    }
    const firstCell = line.split("|")[1] ?? "";
    spellings.push(...[...firstCell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!));
  }
  return spellings;
}

// The enum values a fix line lists so the caller can pick one. They are values, not identifiers in the text.
const VALUE_NAMES = /\b(whole_sign|fagan_bradley|to_natal_midpoints|transit_midpoints|midpoint_to_midpoint)\b/g;

// The fix line of the refusal a tool returns for one issue. The header above it names the argument key
// the caller sent, on purpose; the fix line is the part that must be in plain words.
function fixLine(issue: z.core.$ZodIssue, schema: z.ZodType): string {
  const result = invalidInputResult(new z.ZodError([issue]), schema);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  return text.split("\nFix: ")[1] ?? "";
}

// Wrong values for any field: an unknown key inside it, and a value of each other JSON type.
const WRONG_VALUES: unknown[] = [{ wrong: true }, "x", 5, true, [], null];

// The verbs a fix line starts with, so it tells the caller what to change.
const FIX_START = /^(Give|Write|List|Remove|Use|Leave|Name|Pick) /;

describe("error texts", () => {
  it.each(Object.entries(SCHEMAS))("has plain words for every field of %s", (_, schema) => {
    const fields = Object.keys(inputJson(schema).properties ?? {});
    expect(fields.filter((field) => FIELD_WORDS[field] === undefined)).toEqual([]);
  });

  it.each(Object.entries(SCHEMAS))(
    "words every refusal fix of %s without a parameter identifier, and says what to change",
    (_, schema) => {
      const inputs: unknown[] = ["x", { wrong: true }, { person_a: { wrong: true } }];
      for (const field of Object.keys(inputJson(schema).properties ?? {})) {
        inputs.push(...WRONG_VALUES.map((value) => ({ [field]: value })));
        inputs.push(...WRONG_VALUES.map((value) => ({ person_a: { [field]: value } })));
      }
      const codes = new Set<string>();
      for (const input of inputs) {
        for (const issue of schema.safeParse(input).error?.issues ?? []) {
          codes.add(issue.code);
          const fix = fixLine(issue, schema);
          const text = fix.replace(VALUE_NAMES, "");
          expect({ fix, identifier: /\b[a-z]+_[a-z_]+\b|\btimezone\b/.test(text), says: FIX_START.test(fix) }).toEqual({
            fix,
            identifier: false,
            says: true,
          });
        }
      }
      expect([...codes]).toEqual(expect.arrayContaining(["unrecognized_keys", "invalid_type"]));
    },
  );

  it("turns a wrong-type value into a fix line that names the field and what to give", () => {
    const issue = (path: string[], value: unknown) => chartInputSchema.safeParse({ [path[0] as string]: value }).error?.issues.find((i) => i.path.join(".") === path.join("."));
    const latitude = issue(["latitude"], "30.2");
    expect(latitude?.code).toBe("invalid_type");
    expect(fixLine(latitude as z.core.$ZodIssue, chartInputSchema)).toBe("Give the latitude as a number, for example 30.2672.");
    const person = compositeInputSchema.safeParse({ person_a: { longitude: "east" } }).error?.issues.find((i) => i.path.join(".") === "person_a.longitude");
    expect(fixLine(person as z.core.$ZodIssue, compositeInputSchema)).toBe("Give the first person's longitude as a number, for example -97.7431.");
    const root = chartInputSchema.safeParse("Austin").error?.issues[0];
    expect(fixLine(root as z.core.$ZodIssue, chartInputSchema)).toBe("Give the arguments as an object with named fields, such as the birth date.");
  });
});

describe("round 3 wording", () => {
  const DAILY_FIX = "Give the harmonic as a whole number from 1 to the day's maximum, which is 18 on a 24-hour day and 17 on a 25-hour day.";

  it("gives daily harmonic refusals daily's own range, never 1 to 10000", () => {
    for (const value of ["x", 2.5, 0, null, -1, 20]) {
      const issue = dailyInputSchema.safeParse({ place: "Austin, TX", birth_date: "1990-01-01", birth_time: "12:00", date: "2026-10-14", harmonic: value }).error?.issues.find((i) => i.path[0] === "harmonic");
      expect({ value, message: issue?.message }).toEqual({ value, message: DAILY_FIX });
    }
  });

  it("has no bracket followed by a quote in any description or fix text", () => {
    const texts: string[] = [];
    for (const schema of Object.values(SCHEMAS)) {
      const walk = (node: JsonNode): void => {
        if (node.description) texts.push(node.description);
        if (node.items) walk(node.items);
        Object.values(node.properties ?? {}).forEach(walk);
      };
      walk(inputJson(schema));
      const inputs: unknown[] = ["x", { wrong: true }, { person_a: { wrong: true } }];
      for (const field of Object.keys(inputJson(schema).properties ?? {})) {
        inputs.push(...WRONG_VALUES.map((value) => ({ [field]: value })));
        inputs.push({ [field]: ["Sun", "Sun"] }, { [field]: [] });
      }
      for (const input of inputs) {
        for (const issue of schema.safeParse(input).error?.issues ?? []) texts.push(fixLine(issue, schema), issue.message);
      }
    }
    expect(texts.filter((text) => /\[\s*["']/.test(text))).toEqual([]);
  });

  it("never falls back to the generic wording for a wrong-type value of any field", () => {
    for (const schema of Object.values(SCHEMAS)) {
      for (const field of Object.keys(inputJson(schema).properties ?? {})) {
        for (const wrap of [(v: unknown) => ({ [field]: v }), (v: unknown) => ({ person_a: { [field]: v } })]) {
          for (const value of WRONG_VALUES) {
            for (const issue of schema.safeParse(wrap(value)).error?.issues ?? []) {
              if (issue.code === "invalid_type") expect(fixLine(issue, schema)).not.toContain("in the form its description gives");
            }
          }
        }
      }
    }
  });

  it("names the person in a composite rule refusal", () => {
    const place = { place: "Austin, TX", birth_date: "1990-01-01", birth_time: "12:00" };
    for (const [key, who] of [["person_a", "the first person"], ["person_b", "the second person"]] as const) {
      const input = { person_a: place, person_b: place, [key]: { ...place, latitude: 1 } };
      const issue = compositeInputSchema.safeParse(input).error?.issues[0] as z.core.$ZodIssue;
      expect(fixLine(issue, compositeInputSchema)).toBe(`For ${who}: give a place, or latitude, longitude and time zone, not both.`);
    }
  });
});

// birth_date comes from the shared birthShape, so an impossible date is refused at parse time on
// every tool, with the isRealDate message, not later with a different fix line.
describe("birth_date isRealDate on every tool", () => {
  it.each(["1990-02-30", "1900-02-29", "2100-02-29", "1990-13-01"])(
    "refuses %s on each schema with the 'date that exists' message",
    (birth_date) => {
      const bases: Record<string, unknown> = {
        chart: { birth_date, birth_time: "19:30", place: "Austin, TX" },
        transit: { birth_date, birth_time: "19:30", place: "Austin, TX" },
        harmonic: { birth_date, birth_time: "19:30", place: "Austin, TX", harmonic: 5 },
        daily: { birth_date, birth_time: "19:30", place: "Austin, TX", date: "2026-10-14" },
        composite: {
          person_a: { birth_date, birth_time: "19:30", place: "Austin, TX" },
          person_b: { birth_date: "1990-06-15", birth_time: "08:00", place: "Austin, TX" },
          kind: "composite",
        },
      };
      for (const [name, input] of Object.entries(bases)) {
        const schema = SCHEMAS[name as keyof typeof SCHEMAS]!;
        const result = schema.safeParse(input);
        expect(result.success, name).toBe(false);
        const birthIssue = result.error?.issues.find((i) => i.path.some((segment) => segment === "birth_date"));
        expect(birthIssue?.message, name).toBe("Give the birth date as a date that exists, such as 1990-06-15.");
      }
    },
  );

  it.each(["2000-02-29", "1990-06-15"])("accepts %s on each schema", (birth_date) => {
    const bases: Record<string, unknown> = {
      chart: { birth_date, birth_time: "19:30", place: "Austin, TX" },
      transit: { birth_date, birth_time: "19:30", place: "Austin, TX" },
      harmonic: { birth_date, birth_time: "19:30", place: "Austin, TX", harmonic: 5 },
      daily: { birth_date, birth_time: "19:30", place: "Austin, TX", date: "2026-10-14" },
      composite: {
        person_a: { birth_date, birth_time: "19:30", place: "Austin, TX" },
        person_b: { birth_date: "1990-06-15", birth_time: "08:00", place: "Austin, TX" },
        kind: "composite",
      },
    };
    for (const [name, input] of Object.entries(bases)) {
      const schema = SCHEMAS[name as keyof typeof SCHEMAS]!;
      const result = schema.safeParse(input);
      expect(result.success, name).toBe(true);
    }
  });
});
