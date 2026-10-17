import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "test/installer/**/*.test.mjs",
      "test/packaging/**/*.test.mjs",
    ],
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
  },
});
