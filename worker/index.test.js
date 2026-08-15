import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

import { handleEtfResearch, handleHistory, handleLatestQuotes } from "./index.js";

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

describe("ETF research Worker API", () => {
  it("serves and decodes an immutable version bundle from R2", async () => {
    const payload = { schemaVersion: 1, dataVersion: "20260724.test", profiles: [] };
    const env = {
      MARKET_DATA: {
        get: vi.fn().mockResolvedValue({ body: gzipSync(JSON.stringify(payload)) }),
      },
      ASSETS: { fetch: vi.fn() },
    };
    const response = await handleEtfResearch(
      new Request("https://portfolio.example/api/etf-research/versions/20260724.test/analysis"),
      env,
      { waitUntil: vi.fn() },
      "etf-research/versions/20260724.test/analysis.json.gz",
      "/data/etf-research-analysis.json",
      true,
      true,
      { match: vi.fn(), put: vi.fn() },
    );
    await expect(response.json()).resolves.toEqual(payload);
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("falls back to the bundled static snapshot when R2 is empty", async () => {
    const fallback = new Response(JSON.stringify({ dataVersion: "static" }));
    const env = {
      MARKET_DATA: { get: vi.fn().mockResolvedValue(null) },
      ASSETS: { fetch: vi.fn().mockResolvedValue(fallback) },
    };
    const response = await handleEtfResearch(
      new Request("https://portfolio.example/api/etf-research/manifest"),
      env,
      {},
      "etf-research/latest/manifest.json",
      "/data/etf-research-manifest.json",
      false,
      false,
      { match: vi.fn(), put: vi.fn() },
    );
    await expect(response.json()).resolves.toEqual({ dataVersion: "static" });
    expect(env.ASSETS.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("market report Worker API", () => {
  it("serves the dated market report from R2", async () => {
    const payload = {
      schemaVersion: 1,
      displayDate: "2026-08-17",
      marketDate: "2026-08-14",
    };
    const env = {
      MARKET_DATA: {
        get: vi.fn().mockResolvedValue({ body: JSON.stringify(payload) }),
      },
      ASSETS: { fetch: vi.fn() },
    };
    const worker = (await import("./index.js")).default;
    const response = await worker.fetch(
      new Request("https://portfolio.example/api/market-reports/2026-08-17"),
      env,
      { waitUntil: vi.fn() },
    );

    await expect(response.json()).resolves.toEqual(payload);
    expect(env.MARKET_DATA.get).toHaveBeenCalledWith(
      "market-reports/2026-08-17.json",
    );
  });

  it("rejects an invalid report date before reading R2", async () => {
    const get = vi.fn();
    const worker = (await import("./index.js")).default;
    const response = await worker.fetch(
      new Request("https://portfolio.example/api/market-reports/not-a-date"),
      { MARKET_DATA: { get } },
      {},
    );

    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it("serves the market dashboard image from R2", async () => {
    const image = new Uint8Array([137, 80, 78, 71]);
    const env = {
      MARKET_DATA: {
        get: vi.fn().mockResolvedValue({ body: image }),
      },
      ASSETS: { fetch: vi.fn() },
    };
    const worker = (await import("./index.js")).default;
    const response = await worker.fetch(
      new Request("https://portfolio.example/api/market-reports/2026-08-17/dashboard"),
      env,
      {},
    );

    expect(response.headers.get("content-type")).toBe("image/png");
    expect(env.MARKET_DATA.get).toHaveBeenCalledWith("market-reports/2026-08-17.png");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(Array.from(image));
  });
});
