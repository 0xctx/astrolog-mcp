import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

// Sends the target verbatim. fetch would normalise URLs, so it cannot send malformed targets.
function rawGet(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("createApp", () => {
  let server: Server;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    server = createApp();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a TCP address");
    }
    port = address.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("answers GET /health with 200 and {ok: true}", async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("matches /health with a query string", async () => {
    const response = await fetch(`${baseUrl}/health?probe=1`);

    expect(response.status).toBe(200);
  });

  // RFC 9112 requires origin servers to accept absolute-form targets.
  it("matches /health sent in absolute form", async () => {
    expect(await rawGet(port, `${baseUrl}/health`)).toBe(200);
  });

  it("answers HEAD /health with 200 and no body", async () => {
    const response = await fetch(`${baseUrl}/health`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("returns 404 for any other path", async () => {
    const response = await fetch(`${baseUrl}/missing`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ ok: false, error: "not found", fix: "Send GET /health, or send POST /mcp." });
  });

  // Each target made the URL parser throw, which crashed the whole process.
  it.each(["//[", "//[::1", "http://[", "//a:99999", "http://a:99999/", "//%zz"])(
    "answers the malformed target %s with 404 and keeps serving /health",
    async (target) => {
      expect(await rawGet(port, target)).toBe(404);

      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);
    },
  );

  it("refuses the request past ratePerMinute on /mcp, with Retry-After", async () => {
    const limited = createApp({ ratePerMinute: 2 });
    await new Promise<void>((resolve) => limited.listen(0, "127.0.0.1", resolve));
    const { port: limitedPort } = limited.address() as AddressInfo;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const response = await fetch(`http://127.0.0.1:${limitedPort}/mcp`);
        statuses.push(response.status);
        if (i === 2) {
          expect(response.headers.get("retry-after")).not.toBeNull();
        }
        await response.text();
      }
      expect(statuses[0]).not.toBe(429);
      expect(statuses[1]).not.toBe(429);
      expect(statuses[2]).toBe(429);
    } finally {
      await new Promise<void>((resolve, reject) => limited.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
