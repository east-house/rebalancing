import { describe, expect, it } from "vitest";

import type { PortfolioReportPayload } from "../../api/portfolioReport";
import { allocatePortfolio, buildSnapshot, type PortfolioDeviceState } from "./portfolioReportModel";

const payload: PortfolioReportPayload = {
  schema_version: 2,
  generated_at: "2026-08-17T07:30:00+09:00",
  report_date_kst: "2026-08-17",
  report_time_kst: "07:30",
  signal_market_date: "2026-08-14",
  proposed_execution_date: "2026-08-17",
  stale_preview: true,
  default_capital: 2_819,
  default_fractional_shares: true,
  fractional_precision: 3,
  strategy: {
    id: "us_theme_hybrid_v1",
    name: "안정 모멘텀·테마 혼합",
    status: "production_baseline",
    base_weight: 0.85,
    theme_weight: 0.15,
    benchmark: "IVV",
  },
  selection: ["A", "B", "C", "D", "E"].map((ticker, index) => ({
    ticker,
    name: `Company ${ticker}`,
    sector: `Sector ${index}`,
    themes: index === 0 ? "강한 테마" : "미분류",
    weight: 0.2,
    reference_close: 100,
    rank: index + 1,
    score: 0.9 - index * 0.05,
    base_score: 0.9 - index * 0.05,
    theme_strength: index === 0 ? 1 : 0.5,
    trend_200: 0.1,
  })),
  candidates: [],
  quotes: Object.fromEntries(["A", "B", "C", "D", "E"].map((ticker, index) => [ticker, {
    ticker,
    name: `Company ${ticker}`,
    sector: `Sector ${index}`,
    themes: index === 0 ? "강한 테마" : "미분류",
    close: ticker === "A" ? 80 : 100,
    rank: index + 1,
    score: 0.9 - index * 0.05,
    base_score: 0.9 - index * 0.05,
    theme_strength: index === 0 ? 1 : 0.5,
    trend_200: 0.1,
  }])),
  market: { state: "강세", ivv_close: 700, ivv_vs_sma_200: 0.1 },
  policy: { maximum_positions: 5, hold_rank: 10, maximum_names_per_sector: 2, maximum_pairwise_correlation: 0.8, stop_loss: 0.12, trailing_stop: 0.15, drift_threshold: 0.03, review_frequency: "monthly", market_regime_cash_overlay: false, stopped_capital_stays_cash_until_monthly_review: true, automatic_trading: false },
  privacy: { storage: "browser localStorage only", server_user_state: false, cross_device_sync: false, analytics: false },
  data_snapshot: "snapshot.parquet",
};

describe("portfolio report device model", () => {
  it("allocates five equal-weight positions without exceeding capital", () => {
    const plan = allocatePortfolio(payload, 2_819, true);

    expect(plan.positions).toHaveLength(5);
    expect(plan.positions.every((position) => position.weight === 0.2)).toBe(true);
    expect(plan.cash).toBeGreaterThanOrEqual(0);
  });

  it("recommends a full sell after the 12% loss limit", () => {
    const plan = allocatePortfolio(payload, 2_819, true);
    const lowerPayload: PortfolioReportPayload = {
      ...payload,
      quotes: {
        ...payload.quotes,
        A: { ...payload.quotes.A!, close: 60 },
      },
    };
    const state: PortfolioDeviceState = {
      schemaVersion: 2,
      strategyId: payload.strategy.id,
      capital: 2_819,
      fractional: true,
      cash: plan.cash,
      positions: plan.positions,
      initialReport: { reportDate: "2026-07-01", marketDate: "2026-06-30", strategyId: payload.strategy.id },
      lastReviewMonth: "2026-07",
      history: [],
    };

    const snapshot = buildSnapshot(lowerPayload, state);

    expect(snapshot.actions.find((item) => item.ticker === "A")?.action).toBe("SELL");
    expect(snapshot.actions.find((item) => item.ticker === "A")?.reason).toContain("손실 제한선");
  });
});
