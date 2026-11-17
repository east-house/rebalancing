import { describe, expect, it } from "vitest";
import type { PortfolioStrategyInputs } from "../../api/portfolioReport";
import { advanceAccount, createAccount, withCoreQuote } from "./portfolioReportModel";
import { MissingStrategyInputs, i2Weights, s1Names } from "./portfolioStrategies";
import { chain, fixture } from "./accountTestData";

function inputs(day: string, market: string, returns: Record<string, number[]> = {}): PortfolioStrategyInputs {
  return {
    schema_version: 1, report_date_kst: day, signal_market_date: market, returns,
    tickers: { A: { mom_12_1: 0.1, gics_sector: "Information Technology" }, B: { mom_12_1: 0.9, gics_sector: "Information Technology" },
      C: { mom_12_1: 0.5, gics_sector: "Energy" }, D: { mom_12_1: 0.3, gics_sector: "Health Care" }, Z: { mom_12_1: 0.8, gics_sector: "Energy" } },
    i2: { ivv_weight: 0.2, stock_cap_each_full_kelly: 0.4, stock_budget_full_kelly: 0.8, kelly_fraction: 0.5, lookback: 252, min_observations: 126, fee_daily: (2 * 0.0025 + 0.0000206) / 21 },
    s1: { ivv_weight: 0.2, stock_budget: 0.8, positions: 3, pool_size: 20, hold_order_rank: 5, max_names_per_gics_sector: 1, pool_price_weight: 0.2, price_margin: 0.9, ordering: "mom_12_1", ordering_source: "test" },
  };
}
const series = (seed: number, drift: number) => Array.from({ length: 252 }, (_, t) => drift + 0.01 * Math.sin(seed * 7 + t * 1.3));

describe("I2 half-Kelly sizing", () => {
  it("keeps IVV at 20%, each stock at most 20% and stocks at most 40%", () => {
    const input = inputs("d", "m", { IVV: series(1, 0.0004), A: series(2, 0.003), B: series(3, 0.002), C: series(4, -0.001) });
    const { weights, fallback } = i2Weights(input, ["A", "B", "C"]);
    expect(fallback).toBe(false);
    expect(weights.IVV).toBe(0.2);
    const stocks = ["A", "B", "C"].map(t => weights[t]);
    stocks.forEach(w => { expect(w).toBeGreaterThanOrEqual(0); expect(w).toBeLessThanOrEqual(0.2 + 1e-9); });
    expect(stocks.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(weights.C).toBeLessThan(weights.A);
  });
  it("falls back to equal 40% when history is short", () => {
    const input = inputs("d", "m", { IVV: [0.01, 0.0], A: [0.02, 0.01], B: [0.0, 0.01] });
    const { weights, fallback } = i2Weights(input, ["A", "B"]);
    expect(fallback).toBe(true); expect(weights.A).toBeCloseTo(0.2); expect(weights.B).toBeCloseTo(0.2);
  });
});

describe("S1 selection", () => {
  it("orders the leader pool by momentum and keeps one stock per GICS sector", () => {
    const report = fixture();
    const { names } = s1Names(report, inputs("2026-08-31", "2026-08-28"), [], 10000);
    // B (IT, 0.9) -> Z (Energy, 0.8) -> C (Energy, skipped) -> D (Health Care, 0.3) ; A (IT) skipped.
    expect(names.map(item => item.ticker)).toEqual(["IVV", "B", "Z", "D"]);
    expect(names[0].weight).toBe(0.2); expect(names[1].weight).toBeCloseTo(0.8 / 3);
  });
  it("skips names whose one share is unaffordable for the account", () => {
    const report = fixture(); report.candidates.find(item => item.ticker === "B")!.close = 5000; report.quotes.B.close = 5000;
    const { names } = s1Names(report, inputs("2026-08-31", "2026-08-28"), [], 10000);
    expect(names.map(item => item.ticker)).not.toContain("B");
  });
});

describe("weighted accounts", () => {
  it("requires published inputs before an I2/S1 decision and leaves planned cash for I2", () => {
    const reports = chain();
    expect(() => advanceAccount(createAccount("2026-08-31", 10000, "i2"), reports)).toThrow(MissingStrategyInputs);
    const data = Object.fromEntries(reports.map(r => [r.report_date_kst, inputs(r.report_date_kst, r.signal_market_date,
      { IVV: series(1, 0.0004), A: series(2, 0.003), B: series(3, 0.002), C: series(4, 0.001), D: series(5, 0.0015) })]));
    const i2 = advanceAccount(createAccount("2026-08-31", 10000, "i2"), reports, data);
    const day = i2.days.at(-1)!;
    expect(day.holdings.some(item => item.ticker === "IVV")).toBe(false);
    const ivv = day.holdings.find(item => item.ticker === "SPYM")!;
    expect(ivv.value / day.equity).toBeGreaterThan(0.17); expect(ivv.value / day.equity).toBeLessThan(0.21);
    expect(day.cash / day.equity).toBeGreaterThan(0.35);
    const s1 = advanceAccount(createAccount("2026-08-31", 10000, "s1"), reports, data);
    expect(s1.days.at(-1)!.holdings.map(item => item.ticker).sort()).toEqual(["B", "D", "SPYM", "Z"]);
    expect(s1.days.at(-1)!.cash / s1.days.at(-1)!.equity).toBeLessThan(0.05);
  });
});

describe("S&P 500 core ETF substitution", () => {
  it("buys SPYM for the 20% core when one IVV share is larger than the slice", () => {
    const reports = chain().map(report => {
      const quotes: Record<string, typeof report.quotes.IVV> = { ...report.quotes, IVV: { ...report.quotes.IVV, close: 770 } };
      delete quotes.SPYM;
      return withCoreQuote({ ...report, quotes }, { schema_version: 1, report_date_kst: report.report_date_kst,
        signal_market_date: report.signal_market_date, ticker: "SPYM", name: "SPDR Portfolio S&P 500 ETF", proxy_for: "IVV", close: 88 });
    });
    for (const strategy of ["i1", "i2", "s1"] as const) {
      const data = Object.fromEntries(reports.map(r => [r.report_date_kst, inputs(r.report_date_kst, r.signal_market_date,
        { IVV: series(1, 0.0004), A: series(2, 0.003), B: series(3, 0.002), C: series(4, 0.001), D: series(5, 0.0015) })]));
      const day = advanceAccount(createAccount("2026-08-31", 2819, strategy), reports, data).days.at(-1)!;
      const core = day.holdings.find(item => item.ticker === "SPYM");
      expect(core, strategy).toBeTruthy();
      expect(core!.value / day.equity).toBeGreaterThan(0.15);
      expect(core!.value / day.equity).toBeLessThan(0.21);
      expect(day.holdings.some(item => item.ticker === "IVV")).toBe(false);
    }
  });
  it("rejects a SPYM close from a different US session", () => {
    const report = fixture();
    expect(() => withCoreQuote(report, { schema_version: 1, report_date_kst: report.report_date_kst, signal_market_date: "2026-08-27",
      ticker: "SPYM", name: "x", proxy_for: "IVV", close: 88 })).toThrow("미국장 기준일");
  });
});

describe("chosen cash reserve", () => {
  const data = (reports: ReturnType<typeof chain>) => Object.fromEntries(reports.map(r => [r.report_date_kst, inputs(r.report_date_kst, r.signal_market_date,
    { IVV: series(1, 0.0004), A: series(2, 0.003), B: series(3, 0.002), C: series(4, 0.001), D: series(5, 0.0015) })]));
  it("I1/S1: keeps the chosen share in cash by scaling every target weight (default 0%)", () => {
    const reports = chain();
    for (const strategy of ["i1", "s1"] as const) {
      expect(createAccount("2026-08-31", 10000, strategy).cashReserve, strategy).toBeUndefined();
      const reserved = advanceAccount(createAccount("2026-08-31", 10000, strategy, 0.3), reports, data(reports));
      const day = reserved.days.at(-1)!;
      expect(reserved.cashReserve).toBe(0.3);
      expect(day.cash / day.equity, strategy).toBeGreaterThan(0.29);
      const total = Object.values(day.targetWeights ?? {}).reduce((sum, value) => sum + value, 0);
      expect(total, strategy).toBeCloseTo(0.7, 9);
      expect(day.targetWeights!.SPYM, strategy).toBeCloseTo(0.14, 9);
      expect(day.holdings.some(item => item.ticker === "SPYM"), strategy).toBe(true);
    }
  });
  it("I2: the chosen cash share replaces the 40% planned cash and rescales the half-Kelly stock weights", () => {
    const reports = chain();
    const run = (reserve?: number) => advanceAccount(createAccount("2026-08-31", 10000, "i2", reserve), reports, data(reports));
    const design = run(), thirty = run(0.3), none = run(0);
    expect(createAccount("2026-08-31", 10000, "i2").cashReserve).toBe(0.4);
    const weights = (account: ReturnType<typeof run>) => account.days.at(-1)!.targetWeights!;
    const stocks = (w: Record<string, number>) => Object.entries(w).filter(([ticker]) => ticker !== "SPYM");
    expect(weights(design).SPYM).toBe(0.2); expect(weights(thirty).SPYM).toBe(0.2); expect(weights(none).SPYM).toBe(0.2);
    const base = Object.fromEntries(stocks(weights(design)));
    expect(Object.values(base).some(value => value > 0)).toBe(true);
    for (const [ticker, value] of stocks(weights(thirty))) expect(value, ticker).toBeCloseTo(base[ticker] * 1.25, 9);
    for (const [ticker, value] of stocks(weights(none))) expect(value, ticker).toBeCloseTo(base[ticker] * 2, 9);
    const sum = (w: Record<string, number>) => stocks(w).reduce((total, [, value]) => total + value, 0);
    expect(sum(weights(design))).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(sum(weights(thirty))).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(stocks(weights(thirty)).every(([, value]) => value <= 0.25 + 1e-9)).toBe(true);
    // Legacy I2 accounts without a stored cash share keep the original 40% design.
    const legacy = createAccount("2026-08-31", 10000, "i2"); delete legacy.cashReserve;
    expect(advanceAccount(legacy, reports, data(reports)).days.at(-1)!.targetWeights).toEqual(weights(design));
    expect(thirty.days.at(-1)!.selectionDetails!.find(item => item.ticker !== "SPYM" && (item.weight ?? 0) > 0)!.reason).toContain("현금 비중 30% → 개별 종목 한도 50%");
  });
  it("rejects cash shares outside the allowed range", () => {
    expect(() => createAccount("2026-08-31", 10000, "i1", 0.95)).toThrow("현금 비중");
    expect(() => createAccount("2026-08-31", 10000, "i1", -0.1)).toThrow("현금 비중");
    expect(() => createAccount("2026-08-31", 10000, "i2", 0.85)).toThrow("0%에서 80%");
  });
});
