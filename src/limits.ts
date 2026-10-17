import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { LimitFunction } from "p-limit";
import { AstroError } from "./types.js";

// The largest request body the MCP endpoint reads. A chart request is a few hundred bytes.
export const MAX_BODY_BYTES = 64 * 1024;

// Requests per client address per window, across every method on /mcp. /token has its own limiter of the
// same size. RATE_LIMIT_PER_MINUTE sets the count; see parseLimitSettings.
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
export const RATE_WINDOW_MS = 60_000;

// Engine calls allowed in flight at once. Each one can run an astrolog child process. ENGINE_CONCURRENCY
// sets it.
export const DEFAULT_ENGINE_CONCURRENCY = 4;

// Engine calls allowed to wait for a slot. A call past this is refused at once, so a burst cannot
// grow the queue without bound. ENGINE_QUEUE sets it. The smallest value is 3: one daily-transits
// request queues four engine calls, and with one slot three of them must be able to wait.
export const DEFAULT_ENGINE_QUEUE = 16;
export const MIN_ENGINE_QUEUE = 3;

export interface LimitSettings {
  ratePerMinute: number;
  engineConcurrency: number;
  engineQueue: number;
}

export interface EngineLimits {
  engineConcurrency: number;
  engineQueue: number;
}

export const DEFAULT_ENGINE_LIMITS: EngineLimits = {
  engineConcurrency: DEFAULT_ENGINE_CONCURRENCY,
  engineQueue: DEFAULT_ENGINE_QUEUE,
};

// Reads ENGINE_CONCURRENCY and ENGINE_QUEUE, the two settings the engine uses. Unset or empty means
// the default. Any other value must be a whole number in range, or the start-up fails with a fix line.
export function parseEngineLimits(env: Record<string, string | undefined>): EngineLimits {
  return {
    engineConcurrency: parseCount(env.ENGINE_CONCURRENCY, "ENGINE_CONCURRENCY", DEFAULT_ENGINE_CONCURRENCY, 1, 64),
    engineQueue: parseCount(env.ENGINE_QUEUE, "ENGINE_QUEUE", DEFAULT_ENGINE_QUEUE, MIN_ENGINE_QUEUE, 1_000),
  };
}

// Reads RATE_LIMIT_PER_MINUTE, then the engine limits. Unset or empty means the default. Any other
// value must be a whole number in range, or the start-up fails with a fix line.
export function parseLimitSettings(env: Record<string, string | undefined>): LimitSettings {
  return {
    ratePerMinute: parseCount(env.RATE_LIMIT_PER_MINUTE, "RATE_LIMIT_PER_MINUTE", DEFAULT_RATE_LIMIT_PER_MINUTE, 1, 10_000),
    ...parseEngineLimits(env),
  };
}

function parseCount(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const count = Number(value);
  if (!/^\d+$/.test(value) || count < min || count > max) {
    throw new Error(
      `${name} must be a whole number from ${min} to ${max}, got "${value}"\nFix: Set ${name} to a whole number from ${min} to ${max}, or leave it unset for ${fallback}.`,
    );
  }
  return count;
}

// Upper bound for one tool call, including the wait for an engine slot. This is deliberately far
// above the 500 ms round trip that voice assistants expect of a warm call: that is a latency target, not a hard kill. A
// cold astrolog start plus a full queue can pass 500 ms, and a hard kill there would turn correct
// but slow answers into errors.
export const CALL_TIMEOUT_MS = 10_000;

export class BodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`request body must not exceed ${limitBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export class CallTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the call did not finish within ${timeoutMs} ms`);
    this.name = "CallTimeoutError";
  }
}

// Thrown inside the queue for a call that timed out while it waited, so no engine work starts.
export class CallAbandonedError extends Error {
  constructor() {
    super("the call timed out before it reached the engine");
    this.name = "CallAbandonedError";
  }
}

// Reads the whole body or stops at maxBytes. A declared length over the limit is refused before
// any byte is read.
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new BodyTooLargeError(maxBytes);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) {
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RateLimiter {
  check(key: string): RateDecision;
}

// Entries are dropped once their window ends. The map is swept only when it grows past this size,
// so a flood of distinct addresses cannot grow it without bound.
const SWEEP_THRESHOLD = 10_000;

// In memory, one fixed window per key. It lives in one process, so a second instance has its own
// counts.
export function createRateLimiter({ limit, windowMs, now = Date.now }: RateLimitOptions): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    check(key) {
      const time = now();
      if (windows.size > SWEEP_THRESHOLD) {
        for (const [name, window] of windows) {
          if (time - window.start >= windowMs) {
            windows.delete(name);
          }
        }
      }
      let window = windows.get(key);
      if (window === undefined || time - window.start >= windowMs) {
        window = { start: time, count: 0 };
        windows.set(key, window);
      }
      window.count += 1;
      if (window.count <= limit) {
        return { allowed: true };
      }
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + windowMs - time) / 1000)) };
    },
  };
}

// Rejects with CallTimeoutError if work does not settle in time. The work itself keeps running,
// so the caller's concurrency slot is released only when the engine returns.
export function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

// Queues one engine call on the shared limit. A full queue refuses the call with a fix line. A
// call whose signal is already aborted (it timed out while waiting) skips the engine entirely.
export async function queueEngineCall<T>(
  limit: LimitFunction,
  work: () => Promise<T>,
  signal?: AbortSignal,
  maxQueued = DEFAULT_ENGINE_QUEUE,
): Promise<T> {
  if (limit.pendingCount >= maxQueued) {
    throw new AstroError("the server has too many chart calls waiting", "The server is busy, retry shortly.");
  }
  return limit(() => {
    if (signal?.aborted) {
      throw new CallAbandonedError();
    }
    return work();
  });
}

// Reads TRUST_PROXY. Off by default: the socket address is the client, and X-Forwarded-For is
// ignored, because any caller can send that header.
export function parseTrustProxy(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "false") {
    return false;
  }
  if (value === "true") {
    return true;
  }
  throw new Error(`TRUST_PROXY must be true or false, got "${value}"`);
}

// The key the rate limiter counts a caller under. With trustProxy on, the rightmost X-Forwarded-For
// entry is the address the proxy saw, so it is the client; a missing or invalid entry falls back to
// the socket. An IPv6 address is keyed by its /64, because one client can hold a whole /64.
export function clientKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = rightmostForwarded(req.headers["x-forwarded-for"]);
    if (forwarded !== undefined && isIP(forwarded) !== 0) {
      return addressKey(forwarded);
    }
  }
  return addressKey(req.socket.remoteAddress ?? "unknown");
}

function rightmostForwarded(header: string | string[] | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const entries = (Array.isArray(header) ? header.join(",") : header).split(",");
  return entries[entries.length - 1]?.trim() || undefined;
}

// An IPv4 address as written, an IPv4-mapped IPv6 address as its IPv4 address, and any other IPv6
// address as its /64 prefix in full form.
function addressKey(address: string): string {
  const bare = address.split("%")[0] ?? address;
  if (isIP(bare) !== 6) {
    return bare;
  }
  const groups = expandIPv6(bare);
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

// The eight 16-bit groups of a valid IPv6 address, with "::" expanded and an embedded IPv4 tail
// counted as two groups.
function expandIPv6(address: string): number[] {
  let text = address;
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const after = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeros = new Array<string>(8 - head.length - after.length).fill("0");
  return [...head, ...zeros, ...after].map((group) => parseInt(group, 16));
}
