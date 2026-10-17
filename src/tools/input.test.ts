import { describe, expect, it } from "vitest";
import { birthSchema, isKnownZone, isRealDate } from "./input.js";

describe("isRealDate", () => {
  it("accepts a date that exists, including a leap day", () => {
    expect(isRealDate("2000-06-15")).toBe(true);
    expect(isRealDate("2000-02-29")).toBe(true);
    expect(isRealDate("1990-06-15")).toBe(true);
  });

  it("refuses a date that does not exist", () => {
    expect(isRealDate("2001-02-29")).toBe(false);
    expect(isRealDate("2000-02-30")).toBe(false);
    expect(isRealDate("2000-13-01")).toBe(false);
    expect(isRealDate("2000-00-10")).toBe(false);
    expect(isRealDate("1900-02-29")).toBe(false);
    expect(isRealDate("2100-02-29")).toBe(false);
    expect(isRealDate("1990-13-01")).toBe(false);
  });

  it("keeps years before 100 as they are written", () => {
    expect(isRealDate("0050-03-01")).toBe(true);
  });
});

describe("isKnownZone", () => {
  it("accepts an IANA zone name and UTC", () => {
    expect(isKnownZone("America/New_York")).toBe(true);
    expect(isKnownZone("UTC")).toBe(true);
  });

  it("refuses a name that is not a zone", () => {
    expect(isKnownZone("Mars/Olympus")).toBe(false);
    expect(isKnownZone("")).toBe(false);
  });

  it("refuses the names luxon takes but that are not IANA zones: local, system, UTC+5", () => {
    for (const name of ["local", "system", "UTC+5", "utc+05:30", "default"]) {
      expect(isKnownZone(name), name).toBe(false);
    }
  });
});

// birthShape is the birth fields every tool shares, so a refine on birth_date lands on all of them.
// The daily and transit tools already do this for their own date fields; birth_date now does too, and
// no valid input changes, since isRealDate only rejects a date that does not exist.
describe("shared birth_date", () => {
  it.each(["1990-02-30", "1900-02-29", "2100-02-29", "1990-13-01"])(
    "refuses %s with the same 'date that exists' message the daily and transit date fields use",
    (birth_date) => {
      const bad = birthSchema.safeParse({ birth_date, birth_time: "12:00", place: "NYC" });
      expect(bad.success).toBe(false);
      expect(bad.error?.issues.find((i) => i.path.join(".") === "birth_date")?.message).toBe(
        "Give the birth date as a date that exists, such as 1990-06-15.",
      );
    },
  );

  it.each(["2000-02-29", "1990-06-15"])("accepts %s on the shared birth schema", (birth_date) => {
    expect(birthSchema.safeParse({ birth_date, birth_time: "12:00", place: "NYC" }).success).toBe(true);
  });
});
