import { describe, expect, it } from "vitest";

import {
  calculatePortfolio,
  calculateRebalancePreview,
  validateTargetWeights,
} from "./portfolio";
import type { Portfolio, Quote } from "./types";

const portfolio: Portfolio = {
  totalAssets: 10_000,
  targetCashWeight: 10,
  holdings: [
    {
      ticker: "aaa",
      name: "Alpha",
      assetType: "ETF",
      country: "US",
      quantity: 20,
      averagePrice: 80,
      targetWeight: 50,
    },
    {
      ticker: "BBB",
      name: "Beta",
      assetType: "STOCK",
      country: "US",
      quantity: 30,
      averagePrice: 220,
      targetWeight: 40,
    },
  ],
};

const quotes: Quote[] = [
  { ticker: "AAA", close: 100, asOf: "2026-07-17" },
  { ticker: "bbb", close: 200, asOf: "2026-07-17" },
];

describe("calculatePortfolio", () => {
  it("calculates invested value, cash and weights from closing prices", () => {
    const result = calculatePortfolio(portfolio, quotes);

    expect(result.totalValue).toBe(10_000);
    expect(result.investedValue).toBe(8_000);
    expect(result.cash).toBe(2_000);
    expect(result.cashWeight).toBe(20);
    expect(result.holdings[0]).toMatchObject({
      marketValue: 2_000,
      weight: 20,
    });
    expect(result.holdings[1]).toMatchObject({
      marketValue: 6_000,
      weight: 60,
    });
  });

  it("fails explicitly when a holding has no closing price", () => {
    expect(() => calculatePortfolio(portfolio, quotes.slice(0, 1))).toThrow(
      "Missing quote for ticker: BBB",
    );
  });
});

describe("validateTargetWeights", () => {
  it("accepts holding and cash targets that add up to 100", () => {
    expect(validateTargetWeights(portfolio)).toMatchObject({
      valid: true,
      totalWeight: 100,
      difference: 0,
      errors: [],
    });
  });

  it("rejects totals other than 100 and out-of-range targets", () => {
    const invalid = {
      ...portfolio,
      targetCashWeight: -5,
      holdings: portfolio.holdings.map((holding, index) => ({
        ...holding,
        targetWeight: index === 0 ? 90 : holding.targetWeight,
      })),
    };
    const result = validateTargetWeights(invalid);

    expect(result.valid).toBe(false);
    expect(result.totalWeight).toBe(125);
    expect(result.errors).toHaveLength(2);
  });
});

describe("calculateRebalancePreview", () => {
  it("returns whole-share buy, sell and projected cash values", () => {
    const result = calculateRebalancePreview(portfolio, quotes);

    expect(result.items[0]).toMatchObject({
      ticker: "AAA",
      action: "BUY",
      currentQuantity: 20,
      targetQuantity: 50,
      quantityDelta: 30,
      targetValue: 5_000,
      estimatedTradeValue: 3_000,
      estimatedTradeFee: 7.59,
      projectedWeight: 50,
    });
    expect(result.items[1]).toMatchObject({
      ticker: "BBB",
      action: "SELL",
      currentQuantity: 30,
      targetQuantity: 20,
      quantityDelta: -10,
      targetValue: 4_000,
      estimatedTradeValue: 2_000,
      estimatedTradeFee: 5.0712,
      projectedWeight: 40,
    });
    expect(result.projectedInvestedValue).toBe(9_000);
    expect(result.projectedTransactionFees).toBeCloseTo(12.6612);
    expect(result.projectedCash).toBeCloseTo(987.3388);
    expect(result.projectedCashWeight).toBeCloseTo(9.873388);
  });

  it("rounds target quantities down to whole shares", () => {
    const wholeSharePortfolio: Portfolio = {
      totalAssets: 1_000,
      targetCashWeight: 50,
      holdings: [
        {
          ticker: "AAA",
          name: "Alpha",
          assetType: "ETF",
          country: "US",
          quantity: 3,
          averagePrice: 100,
          targetWeight: 50,
        },
      ],
    };

    const result = calculateRebalancePreview(wholeSharePortfolio, [
      { ticker: "AAA", close: 120, asOf: "2026-07-17" },
    ]);

    expect(result.items[0]).toMatchObject({
      action: "BUY",
      targetQuantity: 4,
      targetValue: 480,
      projectedWeight: 48,
    });
    expect(result.projectedCash).toBeCloseTo(519.697);
  });

  it("refuses to preview an invalid target allocation", () => {
    expect(() =>
      calculateRebalancePreview(
        { ...portfolio, targetCashWeight: 0 },
        quotes,
      ),
    ).toThrow("must add up to 100");
  });
});
