export const DEFAULT_PORT = 3000;

// Reads the PORT environment value. Unset or empty means DEFAULT_PORT.
export function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${value}"`);
  }
  return port;
}
