import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("scripts/smoke.mjs", () => {
  it.skipIf(!existsSync(join(root, "dist", "index.js")))(
    "fails fast with the server's stderr when ASTROLOG_BIN does not exist",
    () => {
      const started = Date.now();
      const run = spawnSync(process.execPath, ["scripts/smoke.mjs"], {
        cwd: root,
        env: { PATH: process.env.PATH, ASTROLOG_BIN: "/nonexistent/astrolog" },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(run.status).toBe(1);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(`${run.stdout}${run.stderr}`).toMatch(/astrolog/i);
      expect(run.stderr).toMatch(/fix:|cannot|not found|ENOENT|start/i);
    },
  );
});
