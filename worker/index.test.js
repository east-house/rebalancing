import { describe, expect, it, vi } from "vitest";

import { handleLatestQuotes } from "./index.js";

function request() {
  return new Request("https://portfolio.example/api/market-data/latest");
}

describe("latest quotes Worker API", () => {
  it("passes the compressed R2 object through with cache headers", async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const context = { waitUntil: vi.fn() };
    const env = {
      MARKET_DATA: {
        get: vi.fn().mockResolvedValue({
          body: new Uint8Array([31, 139, 8, 0]),
          httpEtag: '"quote-etag"',
          uploaded: new Date("2026-07-20T07:31:00Z"),
        }),
      },
    };

    const response = await handleLatestQuotes(request(), env, context, cache);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("etag")).toBe('"quote-etag"');
    expect(env.MARKET_DATA.get).toHaveBeenCalledWith(
      "market-data/latest/quotes/all.json.gz",
    );
    expect(context.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("returns a clear service-unavailable response before the first run", async () => {
    const response = await handleLatestQuotes(
      request(),
      { MARKET_DATA: { get: vi.fn().mockResolvedValue(null) } },
      { waitUntil: vi.fn() },
      { match: vi.fn(), put: vi.fn() },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Run the collection workflow"),
    });
  });
});
