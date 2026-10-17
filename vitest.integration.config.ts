import { defineConfig } from "vitest/config";

// Tests that run the real astrolog binary. They skip themselves when ASTROLOG_BIN is unset.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    // The first call after a cold start reads the GeoNames table; a build runs tsc.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
