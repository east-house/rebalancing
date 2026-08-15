import { describe, expect, it } from "vitest";

import { runPortfolioBacktest } from "./etfBacktest";
import { makeReturnSeries } from "./etfResearchTestUtils";
import type { PortfolioCandidate } from "./etfResearchTypes";

const candidate: PortfolioCandidate = {
  kind: "balanced",
  label: "균형 후보",
  score: 80,
  items: [
    { ticker: "A", name: "A", sleeveId: "a", sleeveLabel: "주식", targetWeightPercent: 60, qualityScore: 80, expectedQuantity: null, expectedAmountKrw: null, reasons: [] },
    { ticker: "B", name: "B", sleeveId: "b", sleeveLabel: "채권", targetWeightPercent: 40, qualityScore: 80, expectedQuantity: null, expectedAmountKrw: null, reasons: [] },
  ],
  weightedExpenseRatioPercent: 0.1,
  weightedOverlapPercent: 0,
  overlapConfidence: "exact",
  dataReliabilityScore: 100,
  remainingCashKrw: null,
  topCompanyExposures: [],
  warnings: [],
};

describe("ETF 백테스트", () => {
  it("공통 거래일의 가격으로 곡선과 위험지표를 계산한다", () => {
    const a = makeReturnSeries("A", Array.from({ length: 40 }, (_, index) => 100 + index));
    const b = makeReturnSeries("B", Array.from({ length: 40 }, (_, index) => 100 + index * 0.2));
    const result = runPortfolioBacktest(candidate, [a, b], {
      initialValue: 10_000_000,
      rebalanceFrequency: "none",
      transactionCostBps: 5,
      riskFreeRatePercent: 2,
    });
    expect(result.curve).toHaveLength(40);
    expect(result.metrics.cumulativeReturnPercent).toBeGreaterThan(0);
    expect(result.distributionIncluded).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("분배금"))).toBe(true);
  });

  it("가격 이력이 없으면 조용히 추정하지 않고 오류를 낸다", () => {
    expect(() =>
      runPortfolioBacktest(candidate, [makeReturnSeries("A", Array(40).fill(100))], {
        initialValue: 1_000_000,
        rebalanceFrequency: "annual",
        transactionCostBps: 5,
        riskFreeRatePercent: 2,
      }),
    ).toThrow("가격 이력");
  });
});
