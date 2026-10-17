import { describe, expect, it } from "vitest";
import { BODY_NAMES, formatDegreesMinutes, formatLatitude, formatLongitude, formatLongitudeCoordinate } from "./format.js";
import { OBJECT_CODES } from "../types.js";

describe("formatLongitude", () => {
  it("writes sign, degree, minute and text from a longitude", () => {
    // 84.2333 is 24°14′ of Gemini, which starts at 60 degrees.
    expect(formatLongitude(84.2333)).toEqual({
      sign: "Gemini",
      degree: 24,
      minute: 14,
      text: "24°14′ Gemini",
    });
  });

  it("starts each sign at 0 degrees", () => {
    expect(formatLongitude(0).text).toBe("0°00′ Aries");
    expect(formatLongitude(330).text).toBe("0°00′ Pisces");
  });

  it("rounds to the arcminute, so 29°59.7′ reads as 0 degrees of the next sign", () => {
    expect(formatLongitude(29.995).text).toBe("0°00′ Taurus");
  });

  it("wraps a longitude that rounds up to 360 back to Aries", () => {
    expect(formatLongitude(359.999).text).toBe("0°00′ Aries");
  });

  it("keeps the degree and minute inside their ranges for every whole arcminute", () => {
    for (let arcminute = 0; arcminute < 360 * 60; arcminute += 7) {
      const position = formatLongitude(arcminute / 60);
      expect(position.degree).toBeGreaterThanOrEqual(0);
      expect(position.degree).toBeLessThanOrEqual(29);
      expect(position.minute).toBeGreaterThanOrEqual(0);
      expect(position.minute).toBeLessThanOrEqual(59);
    }
  });
});

describe("formatDegreesMinutes", () => {
  it("writes degrees and two-digit minutes", () => {
    expect(formatDegreesMinutes(97.7431)).toBe("97°45′");
    expect(formatDegreesMinutes(1.0833)).toBe("1°05′");
  });
});

describe("coordinate letters", () => {
  it("always writes the hemisphere letter on latitude and longitude", () => {
    expect(formatLatitude({ degrees: 30.2672, hemisphere: "N" })).toBe("30°16′N");
    expect(formatLatitude({ degrees: 33.9, hemisphere: "S" })).toBe("33°54′S");
    expect(formatLongitudeCoordinate({ degrees: 97.7431, hemisphere: "W" })).toBe("97°45′W");
    expect(formatLongitudeCoordinate({ degrees: 0.5, hemisphere: "E" })).toBe("0°30′E");
  });
});

describe("BODY_NAMES", () => {
  it("names every object code", () => {
    for (const code of OBJECT_CODES) {
      expect(BODY_NAMES[code]).toBeTruthy();
    }
  });
});
