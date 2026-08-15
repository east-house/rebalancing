import { describe, expect, it } from "vitest";

import { generatePortfolioCandidates } from "./portfolioGenerator";
import { makeResearchProfile } from "./etfResearchTestUtils";

describe("포트폴리오 생성기", () => {
  it("필터를 통과한 ETF로 설명 가능한 3개 후보를 만든다", () => {
    const profiles = [
      makeResearchProfile("A1", "STOCK", { expenseRatioPercent: 0.1 }),
      makeResearchProfile("A2", "STOCK", { expenseRatioPercent: 0.2, holdings: [{ key: "B", name: "B", weightPercent: 50 }] }),
      makeResearchProfile("B1", "BOND", { assetClass: "BOND", holdings: [{ key: "C", name: "C", weightPercent: 80 }] }),
      makeResearchProfile("B2", "BOND", { assetClass: "BOND", expenseRatioPercent: 0.05, holdings: [{ key: "D", name: "D", weightPercent: 80 }] }),
    ];
    const result = generatePortfolioCandidates(profiles, {
      sleeves: [
        { id: "stock", label: "주식", strategyKey: "STOCK", targetWeightPercent: 60 },
        { id: "bond", label: "채권", strategyKey: "BOND", targetWeightPercent: 40 },
      ],
      investmentAmountKrw: 10_000_000,
      maxEtfs: 4,
      maxEtfWeightPercent: 70,
      maxPairOverlapPercent: 70,
      minimumTradingValue20dKrw: 0,
      maximumExpenseRatioPercent: null,
      hedgePreference: "any",
      fixedStocks: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual([
      "balanced",
      "low-cost",
      "low-overlap",
    ]);
    expect(result.candidates[0].items).toHaveLength(2);
  });

  it("ETF와 직접 보유 주식 비중 합계가 100이 아니면 거부한다", () => {
    const result = generatePortfolioCandidates([makeResearchProfile("A", "S")], {
      sleeves: [{ id: "s", label: "주식", strategyKey: "S", targetWeightPercent: 90 }],
      investmentAmountKrw: 1_000_000,
      maxEtfs: 2,
      maxEtfWeightPercent: 100,
      maxPairOverlapPercent: 100,
      minimumTradingValue20dKrw: 0,
      maximumExpenseRatioPercent: null,
      hedgePreference: "any",
      fixedStocks: [],
    });
    expect(result.errors[0]).toContain("100%");
  });
});
