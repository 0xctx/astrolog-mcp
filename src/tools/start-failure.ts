import { AstroError } from "../types.js";

// Writes why the server cannot start to stderr, never stdout: stdio's stdout is protocol-only.
export function reportStartFailure(error: unknown): void {
  if (error instanceof AstroError) {
    console.error(error.message);
    console.error(`fix: ${error.fix}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
}
