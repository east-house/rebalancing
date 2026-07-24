import { describe, expect, it } from "vitest";

import { calculateFixedHoldingsTrend } from "./history";
import type { Holding } from "./types";

const holdings: Holding[] = [
  {
    ticker: "005930",
    name: "삼성전자",
    country: "KR",
    assetType: "STOCK",
    quantity: 10,
    averagePrice: 80_000,
    targetWeight: 100,
  },
];

describe("calculateFixedHoldingsTrend", () => {
  it("values prior closes with current quantities and constant cash", () => {
    const result = calculateFixedHoldingsTrend(
      holdings,
      new Map([
        [
          "KR:005930",
          {
            ticker: "005930",
            country: "KR" as const,
            prices: [
              { date: "2026-07-23", close: 90_000 },
              { date: "2026-07-24", close: 91_000 },
            ],
          },
        ],
      ]),
      [],
      100_000,
    );

    expect(result).toEqual([
      { date: "2026-07-23", totalValue: 1_000_000 },
      { date: "2026-07-24", totalValue: 1_010_000 },
    ]);
  });

  it("uses the latest known FX close for US histories", () => {
    const result = calculateFixedHoldingsTrend(
      [{ ...holdings[0], ticker: "VOO", country: "US", quantity: 2 }],
      new Map([
        [
          "US:VOO",
          {
            ticker: "VOO",
            country: "US" as const,
            prices: [{ date: "2026-07-24", close: 500 }],
          },
        ],
      ]),
      [{ date: "2026-07-23", close: 1_390 }],
      0,
    );

    expect(result).toEqual([
      { date: "2026-07-24", totalValue: 1_390_000 },
    ]);
  });
});

