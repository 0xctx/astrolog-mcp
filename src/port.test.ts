import { describe, expect, it } from "vitest";
import { DEFAULT_PORT, parsePort } from "./port.js";

describe("parsePort", () => {
  it("uses the default port when PORT is unset or empty", () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
    expect(parsePort("")).toBe(DEFAULT_PORT);
  });

  it("accepts an integer from 1 to 65535", () => {
    expect(parsePort("8080")).toBe(8080);
    expect(parsePort("1")).toBe(1);
    expect(parsePort("65535")).toBe(65535);
  });

  it.each(["abc", "80.5", "-1", "0", "65536", " 80", "8080x"])("rejects %j", (value) => {
    expect(() => parsePort(value)).toThrow(/PORT must be an integer from 1 to 65535/);
  });
});
