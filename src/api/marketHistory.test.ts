import { describe, expect, it } from "vitest";

import { parseMarketHistoryPayload } from "./marketHistory";

describe("market-history API adapter", () => {
  it("normalizes and sorts a ticker's collected closes", () => {
    const result = parseMarketHistoryPayload({
      schemaVersion: 1,
      instrument: {
        ticker: "005930",
        name: "삼성전자",
        country: "KR",
        assetType: "STOCK",
        currency: "KRW",
      },
      prices: [
        { date: "2026-07-24", close: 91_000 },
        { date: "2026-07-23", close: 90_000 },
      ],
    });

    expect(result.prices).toEqual([
      { date: "2026-07-23", close: 90_000 },
      { date: "2026-07-24", close: 91_000 },
    ]);
  });

  it("rejects history without usable prices", () => {
    expect(() =>
      parseMarketHistoryPayload({
        schemaVersion: 1,
        instrument: {
          ticker: "005930",
          name: "삼성전자",
          country: "KR",
          assetType: "STOCK",
          currency: "KRW",
        },
        prices: [],
      }),
    ).toThrow("과거 종가");
  });
});
