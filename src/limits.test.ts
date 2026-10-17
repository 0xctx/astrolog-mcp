import { afterEach, describe, expect, it } from "vitest";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pLimit from "p-limit";
import {
  BodyTooLargeError,
  CallAbandonedError,
  CallTimeoutError,
  clientKey,
  createRateLimiter,
  DEFAULT_ENGINE_QUEUE,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  MIN_ENGINE_QUEUE,
  parseEngineLimits,
  parseLimitSettings,
  parseTrustProxy,
  queueEngineCall,
  readBody,
  withTimeout,
} from "./limits.js";

// A request as clientKey sees it: a socket address and the headers that were sent.
function requestFrom(remoteAddress: string | undefined, headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

describe("createRateLimiter", () => {
  it("allows the limit within one window and refuses the next request", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });

    expect([1, 2, 3].map(() => limiter.check("a").allowed)).toEqual([true, true, true]);
    expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it("counts each address on its own", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("opens a new window once the old one has ended", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => now });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    now = 60_000;
    expect(limiter.check("a").allowed).toBe(true);
  });

  it("reports at least one second to wait", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => now });
    limiter.check("a");
    now = 999;

    expect(limiter.check("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});

describe("readBody", () => {
  let server: Server;
  let port: number;

  // Reads the body with the cap and answers 200 with the byte count, or 413 when it is refused.
  async function serve(maxBytes: number): Promise<void> {
    server = createServer(async (req: IncomingMessage, res) => {
      try {
        const body = await readBody(req, maxBytes);
        res.end(String(body.length));
      } catch (error) {
        res.writeHead(error instanceof BodyTooLargeError ? 413 : 500);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  }

  function send(body: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "POST", path: "/", agent: false }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("reads a body at the limit", async () => {
    await serve(10);
    expect(await send("0123456789")).toEqual({ status: 200, text: "10" });
  });

  it("refuses a body one byte over the limit", async () => {
    await serve(10);
    expect((await send("01234567890")).status).toBe(413);
  });
});

describe("withTimeout", () => {
  it("resolves with the work when it finishes in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 1_000)).resolves.toBe(7);
  });

  it("rejects with CallTimeoutError when the work is too slow", async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toBeInstanceOf(CallTimeoutError);
  });

  it("passes the work's own error through", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom");
  });
});

describe("clientKey", () => {
  it("keys an IPv4 socket by its address", () => {
    expect(clientKey(requestFrom("203.0.113.9"), false)).toBe("203.0.113.9");
  });

  it("keys an IPv6 socket by its /64, so one client cannot rotate inside it", () => {
    expect(clientKey(requestFrom("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), false)).toBe("2001:db8:1:2::/64");
    expect(clientKey(requestFrom("2001:db8:1:2::1"), false)).toBe("2001:db8:1:2::/64");
    expect(clientKey(requestFrom("2001:db8:1:3::1"), false)).toBe("2001:db8:1:3::/64");
  });

  it("keys an IPv4-mapped IPv6 socket by its IPv4 address", () => {
    expect(clientKey(requestFrom("::ffff:192.0.2.7"), false)).toBe("192.0.2.7");
  });

  it("ignores X-Forwarded-For when trustProxy is off", () => {
    expect(clientKey(requestFrom("203.0.113.9", { "x-forwarded-for": "198.51.100.1" }), false)).toBe("203.0.113.9");
  });

  it("keys on the rightmost X-Forwarded-For entry when trustProxy is on", () => {
    const req = requestFrom("10.0.0.1", { "x-forwarded-for": "6.6.6.6, 198.51.100.1" });
    expect(clientKey(req, true)).toBe("198.51.100.1");
  });

  it("reads the rightmost entry when the header arrives as several lines", () => {
    const req = requestFrom("10.0.0.1", { "x-forwarded-for": ["6.6.6.6", "198.51.100.2"] });
    expect(clientKey(req, true)).toBe("198.51.100.2");
  });

  it("keys an IPv6 X-Forwarded-For entry by its /64", () => {
    const req = requestFrom("10.0.0.1", { "x-forwarded-for": "2001:db8:1:2:ffff::9" });
    expect(clientKey(req, true)).toBe("2001:db8:1:2::/64");
  });

  it("falls back to the socket when trustProxy is on and the entry is not an address", () => {
    expect(clientKey(requestFrom("203.0.113.9", { "x-forwarded-for": "not-an-address" }), true)).toBe("203.0.113.9");
    expect(clientKey(requestFrom("203.0.113.9", { "x-forwarded-for": " " }), true)).toBe("203.0.113.9");
  });

  it("falls back to the socket when trustProxy is on and no header is sent", () => {
    expect(clientKey(requestFrom("203.0.113.9"), true)).toBe("203.0.113.9");
  });
});

describe("parseTrustProxy", () => {
  it("is off when unset or empty", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("is on only for true", () => {
    expect(parseTrustProxy("true")).toBe(true);
  });

  it("refuses any other value, naming it", () => {
    expect(() => parseTrustProxy("yes")).toThrow('TRUST_PROXY must be true or false, got "yes"');
  });
});

describe("parseLimitSettings", () => {
  it("uses 60 per minute, 4 engine calls at once and 16 waiting when nothing is set", () => {
    expect(parseLimitSettings({})).toEqual({ ratePerMinute: 60, engineConcurrency: 4, engineQueue: 16 });
    expect(parseLimitSettings({ RATE_LIMIT_PER_MINUTE: "", ENGINE_CONCURRENCY: "", ENGINE_QUEUE: "" })).toEqual({
      ratePerMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
      engineConcurrency: 4,
      engineQueue: DEFAULT_ENGINE_QUEUE,
    });
  });

  it("reads each whole number in range", () => {
    expect(parseLimitSettings({ RATE_LIMIT_PER_MINUTE: "600", ENGINE_CONCURRENCY: "8", ENGINE_QUEUE: "3" })).toEqual({
      ratePerMinute: 600,
      engineConcurrency: 8,
      engineQueue: 3,
    });
  });

  it("accepts the smallest queue, 3, and refuses 2", () => {
    expect(parseLimitSettings({ ENGINE_QUEUE: String(MIN_ENGINE_QUEUE) }).engineQueue).toBe(3);
    expect(() => parseLimitSettings({ ENGINE_QUEUE: "2" })).toThrow("ENGINE_QUEUE must be a whole number from 3 to 1000");
  });

  it("reads only the two engine settings in parseEngineLimits, so a bad rate does not stop it", () => {
    expect(parseEngineLimits({ RATE_LIMIT_PER_MINUTE: "abc", ENGINE_CONCURRENCY: "2", ENGINE_QUEUE: "5" })).toEqual({
      engineConcurrency: 2,
      engineQueue: 5,
    });
    expect(() => parseEngineLimits({ RATE_LIMIT_PER_MINUTE: "abc" })).not.toThrow();
  });

  it.each([
    ["RATE_LIMIT_PER_MINUTE", "0", 1, 10_000],
    ["RATE_LIMIT_PER_MINUTE", "10001", 1, 10_000],
    ["ENGINE_CONCURRENCY", "0", 1, 64],
    ["ENGINE_CONCURRENCY", "65", 1, 64],
    ["ENGINE_QUEUE", "0", 3, 1_000],
    ["ENGINE_QUEUE", "2", 3, 1_000],
    ["ENGINE_QUEUE", "1001", 3, 1_000],
    ["RATE_LIMIT_PER_MINUTE", "sixty", 1, 10_000],
    ["ENGINE_CONCURRENCY", "4.5", 1, 64],
    ["ENGINE_QUEUE", "-1", 3, 1_000],
    ["ENGINE_QUEUE", " 16", 3, 1_000],
  ])("refuses %s=%j, naming it and giving a fix line", (name, value, min, max) => {
    expect(() => parseLimitSettings({ [name]: value })).toThrow(
      `${name} must be a whole number from ${min} to ${max}, got "${value}"\nFix: Set ${name} to a whole number from ${min} to ${max}`,
    );
  });
});

describe("queueEngineCall", () => {
  it("refuses a call once DEFAULT_ENGINE_QUEUE calls are waiting, with a fix line", async () => {
    const limit = pLimit(1);
    const never = () => new Promise<never>(() => {});
    void limit(never);
    // Let p-limit move the first call into its slot, so the queue holds only the waiting calls.
    await Promise.resolve();
    for (let i = 0; i < DEFAULT_ENGINE_QUEUE; i += 1) {
      void queueEngineCall(limit, never);
    }
    await expect(queueEngineCall(limit, never)).rejects.toMatchObject({
      message: "the server has too many chart calls waiting",
      fix: "The server is busy, retry shortly.",
    });
    expect(limit.pendingCount).toBe(DEFAULT_ENGINE_QUEUE);
  });

  it("refuses at the cap it is given, not at the default", async () => {
    const limit = pLimit(1);
    const never = () => new Promise<never>(() => {});
    void limit(never);
    await Promise.resolve();
    void queueEngineCall(limit, never, undefined, 2);
    void queueEngineCall(limit, never, undefined, 2);
    await expect(queueEngineCall(limit, never, undefined, 2)).rejects.toMatchObject({
      message: "the server has too many chart calls waiting",
    });
    expect(limit.pendingCount).toBe(2);
  });

  it("skips the work of a call that was aborted while it waited", async () => {
    const limit = pLimit(1);
    let started = 0;
    const hold = new Promise<void>((resolve) => setTimeout(resolve, 20));
    void limit(() => hold);
    const abandon = new AbortController();
    const waiting = queueEngineCall(
      limit,
      () => {
        started += 1;
        return Promise.resolve(1);
      },
      abandon.signal,
    );
    abandon.abort();

    await expect(waiting).rejects.toBeInstanceOf(CallAbandonedError);
    expect(started).toBe(0);
  });

  it("runs the work of a call that is not aborted", async () => {
    await expect(queueEngineCall(pLimit(1), () => Promise.resolve(5))).resolves.toBe(5);
  });
});
