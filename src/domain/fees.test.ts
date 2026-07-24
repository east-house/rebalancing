import { describe, expect, it } from "vitest";

import { calculateKiwoomTradeFee } from "./fees";

describe("calculateKiwoomTradeFee", () => {
  it("applies Kiwoom online commission and domestic stock sell tax", () => {
    const buy = calculateKiwoomTradeFee({
      country: "KR",
      assetType: "STOCK",
      action: "BUY",
      grossValue: 100_000_000,
    });
    const sell = calculateKiwoomTradeFee({
      country: "KR",
      assetType: "STOCK",
      action: "SELL",
      grossValue: 100_000_000,
    });

    expect(buy.commission).toBeCloseTo(15_000);
    expect(buy.exchangeFee).toBe(0);
    expect(buy.sellLevy).toBe(0);
    expect(buy.total).toBeCloseTo(15_000);
    expect(sell.commission).toBeCloseTo(15_000);
    expect(sell.exchangeFee).toBe(0);
    expect(sell.sellLevy).toBeCloseTo(200_000);
    expect(sell.total).toBeCloseTo(215_000);
  });

  it("does not apply domestic stock transaction tax to ETFs", () => {
    expect(
      calculateKiwoomTradeFee({
        country: "KR",
        assetType: "ETF",
        action: "SELL",
        grossValue: 100_000_000,
      }).total,
    ).toBeCloseTo(15_000);
  });

  it("applies US online commission and the current SEC sell fee", () => {
    expect(
      calculateKiwoomTradeFee({
        country: "US",
        assetType: "STOCK",
        action: "BUY",
        grossValue: 10_000,
        quantity: 20,
      }).total,
    ).toBeCloseTo(25.06);
    expect(
      calculateKiwoomTradeFee({
        country: "US",
        assetType: "STOCK",
        action: "SELL",
        grossValue: 10_000,
        quantity: 20,
      }).total,
    ).toBeCloseTo(25.266);
  });

  it("respects the USD 0.01 SEC fee minimum", () => {
    expect(
      calculateKiwoomTradeFee({
        country: "US",
        assetType: "ETF",
        action: "SELL",
        grossValue: 100,
        quantity: 1,
      }).total,
    ).toBeCloseTo(0.263);
  });
});
