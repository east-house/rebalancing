import { describe, expect, it } from "vitest";

import {
  latestQuoteDate,
  parseMarketDataPayload,
  quotesForPolicy,
} from "./marketData";

const payload = parseMarketDataPayload({
  schemaVersion: 1,
  generatedAt: "2026-07-20T07:30:00Z",
  expectedShardCount: 8,
  availableShards: [0, 1, 2, 3, 4, 5, 6, 7],
  complete: true,
  quoteCount: 2,
  fx: {
    usdKrw: {
      closes: [
        { date: "2026-07-17", close: 1380 },
        { date: "2026-07-20", close: 1390 },
      ],
    },
  },
  quotes: [
    {
      ticker: "005930",
      name: "삼성전자",
      country: "KR",
      assetType: "STOCK",
      currency: "KRW",
      closes: [
        { date: "2026-07-17", close: 90000 },
        { date: "2026-07-20", close: 91000 },
      ],
    },
    {
      ticker: "AAPL",
      name: "Apple Inc.",
      country: "US",
      assetType: "STOCK",
      currency: "USD",
      closes: [
        { date: "2026-07-17", close: 325 },
        { date: "2026-07-20", close: 330 },
      ],
    },
  ],
});

describe("market-data API adapter", () => {
  it("uses the prior native close and matching FX close", () => {
    const quotes = quotesForPolicy(payload, "previous");
    const apple = quotes.find((quote) => quote.ticker === "AAPL");

    expect(apple).toMatchObject({
      close: 448500,
      nativeClose: 325,
      nativeCurrency: "USD",
      fxRate: 1380,
      asOf: "2026-07-17",
    });
  });

  it("uses the latest close and reports the latest date", () => {
    const quotes = quotesForPolicy(payload, "today");

    expect(quotes.find((quote) => quote.ticker === "005930")?.close).toBe(91000);
    expect(latestQuoteDate(quotes)).toBe("2026-07-20");
  });

  it("automatically uses today's close when present", () => {
    const quotes = quotesForPolicy(payload, "auto");

    expect(quotes.find((quote) => quote.ticker === "005930")).toMatchObject({
      close: 91_000,
      asOf: "2026-07-20",
    });
  });

  it("automatically falls back to the most recent prior close", () => {
    const withoutToday = {
      ...payload,
      quotes: [
        {
          ...payload.quotes[0],
          closes: [{ date: "2026-07-17", close: 90_000 }],
        },
      ],
    };

    expect(quotesForPolicy(withoutToday, "auto")[0]).toMatchObject({
      close: 90_000,
      asOf: "2026-07-17",
    });
  });

  it("keeps full FX history for historical won valuations", () => {
    const parsed = parseMarketDataPayload({
      ...payload,
      fx: {
        usdKrw: {
          closes: [
            { date: "2026-07-16", close: 1370 },
            { date: "2026-07-17", close: 1380 },
            { date: "2026-07-20", close: 1390 },
          ],
        },
      },
    });

    expect(parsed.fx.usdKrw.closes).toHaveLength(3);
  });

  it("does not apply an FX close later than the stock close", () => {
    const stockClosedBeforeLatestFx = {
      ...payload,
      quotes: [
        {
          ...payload.quotes[1],
          closes: [
            { date: "2026-07-17", close: 325 },
            { date: "2026-07-18", close: 326 },
          ],
        },
      ],
    };

    expect(
      quotesForPolicy(stockClosedBeforeLatestFx, "today")[0]?.fxRate,
    ).toBe(1380);
  });

  it("rejects payloads without usable FX data", () => {
    expect(() =>
      parseMarketDataPayload({ schemaVersion: 1, quotes: payload.quotes }),
    ).toThrow("환율");
  });
});
