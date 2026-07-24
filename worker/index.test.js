import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

import { handleHistory, handleLatestQuotes } from "./index.js";

function request() {
  return new Request("https://portfolio.example/api/market-data/latest");
}

describe("latest quotes Worker API", () => {
  it("decodes the compressed R2 object for browser JSON parsing", async () => {
    const cache = {
      match: vi.fn().mockResolvedValue(undefined),
      put: vi.fn().mockResolvedValue(undefined),
    };
    const context = { waitUntil: vi.fn() };
    const payload = { schemaVersion: 1, quoteCount: 4067 };
    const env = {
      MARKET_DATA: {
        get: vi.fn().mockResolvedValue({
          body: gzipSync(JSON.stringify(payload)),
          httpEtag: '"quote-etag"',
          uploaded: new Date("2026-07-20T07:31:00Z"),
        }),
      },
    };

    const response = await handleLatestQuotes(request(), env, context, cache);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("etag")).toBe('"quote-etag"');
    await expect(response.json()).resolves.toEqual(payload);
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

describe("closing-price history Worker API", () => {
  it("returns a decoded one-year ticker history", async () => {
    const payload = {
      schemaVersion: 1,
      instrument: { ticker: "005930", country: "KR" },
      prices: [{ date: "2026-07-24", close: 91_000 }],
    };
    const env = {
      MARKET_DATA: {
        get: vi.fn().mockResolvedValue({
          body: gzipSync(JSON.stringify(payload)),
        }),
      },
    };

    const response = await handleHistory(
      new Request(
        "https://portfolio.example/api/market-data/history/KR/005930",
      ),
      env,
      { waitUntil: vi.fn() },
      "KR",
      "005930",
      { match: vi.fn(), put: vi.fn() },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(payload);
    expect(env.MARKET_DATA.get).toHaveBeenCalledWith(
      "market-data/history/KR/005930.json.gz",
    );
  });

  it("rejects path traversal before reading R2", async () => {
    const get = vi.fn();
    const response = await handleHistory(
      new Request("https://portfolio.example/api/market-data/history/KR/bad"),
      { MARKET_DATA: { get } },
      { waitUntil: vi.fn() },
      "KR",
      "../BAD",
      { match: vi.fn(), put: vi.fn() },
    );

    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });
});
