import { describe, expect, it } from "vitest";
import { AstroError, type Latitude, type Longitude } from "../types.js";
import { astrologCoord, latitudeFromSigned, longitudeFromSigned } from "./coord.js";

function thrownBy(run: () => unknown): AstroError {
  try {
    run();
  } catch (error) {
    if (error instanceof AstroError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to throw");
}

describe("astrologCoord", () => {
  it("writes New York with letters and seconds", () => {
    const latitude: Latitude = { degrees: 40.7, hemisphere: "N" };
    const longitude: Longitude = { degrees: 73.9, hemisphere: "W" };
    expect(astrologCoord(latitude, longitude)).toEqual({
      latitude: "40:42:00N",
      longitude: "73:54:00W",
    });
  });

  it("writes the southern and eastern letters", () => {
    expect(
      astrologCoord({ degrees: 33.86, hemisphere: "S" }, { degrees: 151.2, hemisphere: "E" }),
    ).toEqual({ latitude: "33:51:36S", longitude: "151:12:00E" });
  });

  it("carries a value that rounds up to a whole degree", () => {
    // 9.99999 degrees is 35999.96 seconds, which rounds to 10:00:00, never 9:60:00.
    expect(
      astrologCoord({ degrees: 9.99999, hemisphere: "N" }, { degrees: 0, hemisphere: "E" }),
    ).toEqual({
      latitude: "10:00:00N",
      longitude: "0:00:00E",
    });
  });

  it("refuses a longitude letter on the latitude", () => {
    const wrong = { degrees: 40.7, hemisphere: "E" } as unknown as Latitude;
    const error = thrownBy(() => astrologCoord(wrong, { degrees: 73.9, hemisphere: "W" }));
    expect(error.message).toContain("latitude letter must be N or S");
    expect(error.fix).toContain("N or S");
  });

  it("refuses a longitude beyond 180 degrees", () => {
    const error = thrownBy(() =>
      astrologCoord({ degrees: 40, hemisphere: "N" }, { degrees: 181, hemisphere: "E" }),
    );
    expect(error.message).toContain("longitude must be unsigned degrees from 0 to 180");
  });
});

describe("signed decimal input", () => {
  it("reads the sign as the letter", () => {
    expect(latitudeFromSigned(40.7)).toEqual({ degrees: 40.7, hemisphere: "N" });
    expect(latitudeFromSigned(-33.9)).toEqual({ degrees: 33.9, hemisphere: "S" });
    expect(longitudeFromSigned(-73.9)).toEqual({ degrees: 73.9, hemisphere: "W" });
    expect(longitudeFromSigned(151.2)).toEqual({ degrees: 151.2, hemisphere: "E" });
  });

  it("takes a stated letter that agrees with the sign", () => {
    expect(longitudeFromSigned(-73.9, "W")).toEqual({ degrees: 73.9, hemisphere: "W" });
  });

  it("gives zero the stated letter, or N and E", () => {
    expect(latitudeFromSigned(0)).toEqual({ degrees: 0, hemisphere: "N" });
    expect(latitudeFromSigned(0, "S")).toEqual({ degrees: 0, hemisphere: "S" });
  });

  it("fails a W sign with an E letter, and names the value in lettered form", () => {
    const error = thrownBy(() => longitudeFromSigned(-73.9, "E"));
    expect(error.message).toBe("longitude -73.9 is 73:54:00W, but E was given");
    expect(error.fix).toContain("drop the E letter");
  });

  it("refuses a latitude beyond 90 degrees and a longitude that is not a number", () => {
    expect(() => latitudeFromSigned(91)).toThrow(AstroError);
    expect(() => longitudeFromSigned(Number.NaN)).toThrow(AstroError);
  });
});
