import { describe, expect, it } from "vitest";
import { AstroError, validateSkyInput, type LocalMoment } from "./types.js";
import { toUtc } from "./time.js";

function local(date: string, time: string, timezone: string): LocalMoment {
  return { date, time, timezone };
}

function thrownBy(run: () => unknown): AstroError {
  try {
    run();
  } catch (error) {
    if (error instanceof AstroError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected toUtc to throw");
}

describe("toUtc", () => {
  it("converts a summer date in New York with daylight time (UTC-4)", () => {
    expect(toUtc(local("2024-07-04", "12:00", "America/New_York"))).toBe("2024-07-04T16:00:00Z");
  });

  it("converts a winter date in New York with standard time (UTC-5)", () => {
    expect(toUtc(local("2024-01-15", "12:00", "America/New_York"))).toBe("2024-01-15T17:00:00Z");
  });

  it("keeps seconds when the time has them", () => {
    expect(toUtc(local("2024-07-04", "12:00:30", "America/New_York"))).toBe("2024-07-04T16:00:30Z");
  });

  it("uses the offset before and after the autumn change", () => {
    expect(toUtc(local("2024-11-03", "00:30", "America/New_York"))).toBe("2024-11-03T04:30:00Z");
    expect(toUtc(local("2024-11-03", "02:30", "America/New_York"))).toBe("2024-11-03T07:30:00Z");
  });

  it("converts a half-hour zone (India, UTC+5:30)", () => {
    expect(toUtc(local("1990-06-15", "00:00", "Asia/Kolkata"))).toBe("1990-06-14T18:30:00Z");
  });

  it("converts a half-hour zone with daylight time (Adelaide, +10:30 then +9:30)", () => {
    expect(toUtc(local("2024-01-15", "12:00", "Australia/Adelaide"))).toBe("2024-01-15T01:30:00Z");
    expect(toUtc(local("2024-07-15", "12:00", "Australia/Adelaide"))).toBe("2024-07-15T02:30:00Z");
  });

  it("uses the historical local mean time with seconds before 1883", () => {
    // New York was on local mean time (UTC-4:56:02) in June 1880.
    expect(toUtc(local("1880-06-15", "12:00", "America/New_York"))).toBe("1880-06-15T16:56:02Z");
  });

  it("accepts UTC as a zone", () => {
    expect(toUtc(local("1990-06-15", "19:30", "UTC"))).toBe("1990-06-15T19:30:00Z");
  });

  it("returns a moment the contract accepts", () => {
    const utc = toUtc(local("1990-06-15", "14:30", "America/Chicago"));
    expect(utc).toBe("1990-06-15T19:30:00Z");
    expect(() => validateSkyInput({ utc })).not.toThrow();
  });

  it("refuses a clock time that the spring change skips", () => {
    const error = thrownBy(() => toUtc(local("2024-03-10", "02:30", "America/New_York")));
    expect(error.message).toContain("does not exist in America/New_York");
    expect(error.fix).toContain("skipped hour");
  });

  it("refuses a clock time that the autumn change repeats, and says what the caller can do", () => {
    const error = thrownBy(() => toUtc(local("2024-11-03", "01:30", "America/New_York")));
    expect(error.message).toContain("occurs twice in America/New_York");
    expect(error.fix).toBe("Use a clock time outside the repeated hour.");
  });

  it("refuses a local moment that is not an object", () => {
    const error = thrownBy(() => toUtc(undefined as unknown as LocalMoment));
    expect(error.message).toContain("local moment must be an object");
    expect(error.fix).toContain('"America/Chicago"');
    expect(thrownBy(() => toUtc(null as unknown as LocalMoment))).toBeInstanceOf(AstroError);
  });

  it("converts a zone with a 45-minute offset, Nepal (UTC+5:45)", () => {
    expect(toUtc(local("2024-07-15", "12:00", "Asia/Kathmandu"))).toBe("2024-07-15T06:15:00Z");
  });

  it("converts Chatham Islands, +12:45 in July and +13:45 in January, across the date line", () => {
    expect(toUtc(local("2024-07-15", "12:00", "Pacific/Chatham"))).toBe("2024-07-14T23:15:00Z");
    expect(toUtc(local("2024-01-15", "12:00", "Pacific/Chatham"))).toBe("2024-01-14T22:15:00Z");
  });

  it("converts Eucla, a zone at +8:45 with no daylight time", () => {
    expect(toUtc(local("2024-07-15", "12:00", "Australia/Eucla"))).toBe("2024-07-15T03:15:00Z");
  });

  it("refuses the Lord Howe clock time its spring-forward skips, and converts the next one", () => {
    // Lord Howe moves from +10:30 to +11:00 at 02:00 standard time on 2024-10-06, so 02:00 to 02:30 is gone.
    const error = thrownBy(() => toUtc(local("2024-10-06", "02:15", "Australia/Lord_Howe")));
    expect(error.message).toContain("does not exist in Australia/Lord_Howe");
    expect(toUtc(local("2024-10-06", "02:45", "Australia/Lord_Howe"))).toBe("2024-10-05T15:45:00Z");
  });

  it("refuses a date that does not exist", () => {
    const error = thrownBy(() => toUtc(local("2023-02-29", "12:00", "America/Chicago")));
    expect(error.message).toContain("not a real date and time");
    expect(error.fix).toContain("leap year");
  });

  it("refuses an hour of 24 rather than rolling it into the next day", () => {
    const error = thrownBy(() => toUtc(local("2024-07-04", "24:00", "America/Chicago")));
    expect(error.message).toContain("not a real date and time");
  });

  it("refuses a date that is not YYYY-MM-DD", () => {
    const error = thrownBy(() => toUtc(local("7/4/2024", "12:00", "America/Chicago")));
    expect(error.message).toContain("date must be YYYY-MM-DD");
  });

  it("refuses a time that is not HH:MM or HH:MM:SS", () => {
    const error = thrownBy(() => toUtc(local("2024-07-04", "9:30", "America/Chicago")));
    expect(error.message).toContain("time must be HH:MM or HH:MM:SS");
  });

  it("refuses a zone that is not an IANA name", () => {
    const error = thrownBy(() => toUtc(local("2024-07-04", "12:00", "Mars/Olympus")));
    expect(error.message).toContain("not an IANA zone name");
    expect(error.fix).toContain("America/Chicago");
  });
});
