import { describe, expect, it } from "vitest";
import { read } from "./repo.mjs";

describe("licence files", () => {
  it("LICENSE is the GNU Affero General Public License version 3", () => {
    const license = read("LICENSE");
    expect(license).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(license).toContain("Version 3, 19 November 2007");
  });

  it("package.json declares AGPL-3.0-only", () => {
    expect(JSON.parse(read("package.json")).license).toBe("AGPL-3.0-only");
  });

  it("NOTICE names the project licence, Astrolog and Swiss Ephemeris with their licences", () => {
    const notice = read("NOTICE");
    expect(notice).toContain("GNU Affero General Public License");
    expect(notice).toMatch(/Astrolog 8\.00[\s\S]*GNU General Public License/);
    expect(notice).toMatch(/Swiss Ephemeris[\s\S]*GNU Affero General Public License/);
    expect(notice).not.toMatch(/MIT/);
  });

  it("NOTICE names the Astrolog credits, the GeoNames data inside atlas.as and the GPL source obligation", () => {
    const notice = read("NOTICE");
    expect(notice).toContain("Walter D. Pullen");
    expect(notice).toContain("Astrodienst AG");
    expect(notice).toContain("Permission is granted to freely use, modify, and distribute these");
    expect(notice).toContain("Atlas composed May 14, 2026 using data from: https://www.geonames.org/");
    expect(notice).toContain("This work is licensed under a Creative Commons Attribution 4.0 License");
    expect(notice).toMatch(/GPL version 2[\s\S]*making the corresponding source code available/);
  });

  it("NOTICE and the licensing guide quote the Swiss Ephemeris clauses in full, including the public-service condition", () => {
    const clause =
      "The choice must be made before the software developer distributes software containing parts of Swiss Ephemeris to others, and before any public service using the developed software is activated.";
    for (const text of [read("NOTICE"), read("docs/licensing.md")]) {
      expect(text).toContain(clause);
      expect(text).toContain("he or she must fulfill the conditions of that license");
      expect(text).toContain("purchase the Swiss Ephemeris Professional Edition from Astrodienst");
    }
  });

  it("NOTICE and the README give the GeoNames export page as the credit link", () => {
    expect(read("NOTICE")).toContain("https://www.geonames.org/export/");
    expect(read("README.md")).toContain("https://www.geonames.org/export/");
  });
});
