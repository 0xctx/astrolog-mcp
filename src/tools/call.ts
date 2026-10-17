import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CALL_TIMEOUT_MS, CallTimeoutError, withTimeout } from "../limits.js";
import { AstroError, type Provenance } from "../types.js";
import type { ToolDeps } from "./deps.js";

// The marker a stub result starts with, so a model cannot take placeholder positions for astrolog's.
export const STUB_MARKER = "PLACEHOLDER numbers (ENGINE=stub), not astrolog output.";

// What a tool's run returns: the structured output, and the source of the engine that made it.
export interface EngineResult<O> {
  output: O;
  source: Provenance["source"];
}

// The words a tool's failures use. `subject` opens the messages, such as "The chart".
export interface FailureWording {
  subject: string;
  timeoutFix: string;
}

// A failure the caller can act on: what went wrong, then one line that says how to fix it.
export function errorResult(message: string, fix: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: `${message}\nFix: ${fix}` }] };
}

export function failureOf(error: unknown, name: string, wording: FailureWording): CallToolResult {
  if (error instanceof AstroError) {
    return errorResult(error.message, error.fix);
  }
  if (error instanceof CallTimeoutError) {
    return errorResult(
      `${wording.subject} did not finish within ${error.timeoutMs / 1000} seconds.`,
      wording.timeoutFix,
    );
  }
  // Only the class name is logged, never the input, which holds a birth moment.
  console.error(`${name} failed:`, error instanceof Error ? error.name : "unknown");
  return errorResult(
    `${wording.subject} could not be calculated.`,
    "Retry the call; if it fails again, report it with the time it happened.",
  );
}

// The text a host shows the model: the headline, then the whole result as JSON, so a host that
// forwards only text still gets the numbers. A stub result leads with the placeholder marker, keyed
// on the result's own provenance source.
export function resultText(output: { headline: string }, source: Provenance["source"]): string {
  const lines = [output.headline, JSON.stringify(output)];
  return (source === "stub" ? [STUB_MARKER, ...lines] : lines).join("\n");
}

// Each argument of the five tools in plain words, so a fix line names a field the way a person would.
// The contract test checks that every field of every tool has an entry.
export const FIELD_WORDS: Readonly<Record<string, string>> = {
  birth_date: "the birth date",
  birth_time: "the birth time",
  place: "the birth place",
  latitude: "the latitude",
  longitude: "the longitude",
  timezone: "the time zone",
  house_system: "the house system",
  ayanamsa: "the zodiac",
  harmonic: "the harmonic",
  bodies: "the bodies",
  aspects: "the aspect set",
  aspect_limit: "the aspect limit",
  transit_date: "the transit date",
  transit_time: "the transit time",
  transit_timezone: "the transit time zone",
  include: "the pairings",
  min_strength: "the minimum strength",
  person_a: "the first person",
  person_b: "the second person",
  kind: "the chart kind",
  date: "the date",
  day_timezone: "the day's time zone",
  limit: "the number to list",
};

// What to give for a field whose value has the wrong type, with an example of the right one.
const FIELD_EXAMPLES: Readonly<Record<string, string>> = {
  place: 'as text, for example "Austin, TX"',
  latitude: "as a number, for example 30.2672",
  longitude: "as a number, for example -97.7431",
  timezone: "as text, an IANA time zone name such as America/Chicago",
  transit_timezone: "as text, an IANA time zone name such as America/Chicago",
  day_timezone: "as text, an IANA time zone name such as America/Chicago",
  bodies: "as a list of object codes, such as Sun and Moo",
  person_a: "as an object with the birth date, birth time and place",
  person_b: "as an object with the birth date, birth time and place",
};

// The way to give a value of each JSON type, for a field with no example above.
const TYPE_WORDS: Readonly<Record<string, string>> = {
  string: "as text",
  number: "as a number",
  boolean: "as true or false",
  array: "as a list",
  object: "as an object",
};

// A field path in words: person_a then latitude reads "the first person's latitude".
function fieldWords(path: readonly PropertyKey[]): string {
  const words = path.map((key) => FIELD_WORDS[String(key)] ?? `the ${String(key)}`);
  return words.reduce((owner, field) => `${owner}'s ${field.replace(/^the /, "")}`);
}

// The fields of the object at a path in the schema, in words, so a fix line can list the valid ones.
function fieldsAt(schema: unknown, path: readonly PropertyKey[]): string[] {
  let node = schema as { shape?: Record<PropertyKey, unknown> } | undefined;
  for (const key of path) {
    node = node?.shape?.[key] as { shape?: Record<PropertyKey, unknown> } | undefined;
  }
  return Object.keys(node?.shape ?? {}).map((key) => FIELD_WORDS[key] ?? key);
}

// "a, b and c".
function andList(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items.join("");
}

// A rejected argument. The SDK checks arguments against the schema itself and answers with its own
// error text, which has no fix line, so the handler does the check. The header names the argument key
// the caller sent; the fix line says in plain words what to change. An unknown key names the object it
// sits in, and the fix lists that object's fields. A value of the wrong type, which zod words as
// "expected number, received string", gets a fix line that says what to give instead.
export function invalidInputResult(error: z.ZodError, schema: z.ZodType): CallToolResult {
  const [issue] = error.issues;
  if (issue?.code === "unrecognized_keys") {
    const keys = issue.keys.join(", ");
    const where = issue.path.length ? ` in ${issue.path.join(".")}` : "";
    const owner = issue.path.length ? `${fieldWords(issue.path)} takes` : "this tool takes";
    const fix = `Remove ${issue.keys.length > 1 ? "those fields" : "that field"}; ${owner} ${andList(fieldsAt(schema, issue.path))}.`;
    return errorResult(`Invalid input: unknown field ${keys}${where}`, fix);
  }
  const field = issue?.path.length ? issue.path.join(".") : "input";
  if (issue?.code === "invalid_type" && issue.message.startsWith("Invalid input: expected")) {
    if (!issue.path.length) {
      return errorResult(`Invalid input: ${field}`, "Give the arguments as an object with named fields, such as the birth date.");
    }
    const key = String(issue.path[issue.path.length - 1]);
    const how = FIELD_EXAMPLES[key] ?? TYPE_WORDS[issue.expected] ?? "in the form its description gives";
    return errorResult(`Invalid input: ${field}`, `Give ${fieldWords(issue.path)} ${how}.`);
  }
  // A rule inside one person of a composite names that person, as the two share one wording.
  const person = issue?.path[0];
  if (issue?.code === "custom" && (person === "person_a" || person === "person_b")) {
    return errorResult(`Invalid input: ${field}`, `For ${FIELD_WORDS[person]}: ${issue.message[0]?.toLowerCase()}${issue.message.slice(1)}`);
  }
  return errorResult(`Invalid input: ${field}`, issue?.message ?? "Check the arguments against the tool's description.");
}

// The schema the tool advertises. It has the same JSON Schema as the real one, but its validate
// accepts everything, so the handler's own check (invalidInputResult) is the one that runs.
function advertisedSchema(schema: z.ZodType) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "astrolog-mcp",
      validate: (value: unknown) => ({ value }),
      jsonSchema: schema["~standard"].jsonSchema,
    },
  };
}

export interface EngineToolSpec<I, O extends { headline: string }> {
  name: string;
  title: string;
  description: string;
  failure: FailureWording;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  // Runs one call. The signal is aborted when the call has timed out or returned, so an engine call
  // still waiting for a slot does not start.
  run(input: I, signal: AbortSignal): Promise<EngineResult<O>>;
}

// Registers one tool that runs through the engine: checks the arguments, runs the call under the
// timeout, and returns the text and structured content, or isError with a fix line.
export function registerEngineTool<I, O extends { headline: string }>(
  server: McpServer,
  deps: ToolDeps,
  spec: EngineToolSpec<I, O>,
): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: advertisedSchema(spec.inputSchema),
      outputSchema: spec.outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (raw): Promise<CallToolResult> => {
      const parsed = spec.inputSchema.safeParse(raw);
      if (!parsed.success) {
        return invalidInputResult(parsed.error, spec.inputSchema);
      }
      // Aborted once the call ends, so a call that timed out leaves no engine work queued.
      const abandon = new AbortController();
      try {
        const { output, source } = await withTimeout(
          spec.run(parsed.data, abandon.signal),
          deps.timeoutMs ?? CALL_TIMEOUT_MS,
        );
        return { content: [{ type: "text", text: resultText(output, source) }], structuredContent: output };
      } catch (error) {
        return failureOf(error, spec.name, spec.failure);
      } finally {
        abandon.abort();
      }
    },
  );
}
