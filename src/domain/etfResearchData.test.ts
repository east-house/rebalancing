import { describe, expect, it } from "vitest";

import analysisJson from "../../public/data/etf-research-analysis.json";
import manifestJson from "../../public/data/etf-research-manifest.json";
import returnsJson from "../../public/data/etf-research-returns.json";
import { runPortfolioBacktest } from "./etfBacktest";
import { generatePortfolioCandidates, PORTFOLIO_PRESETS } from "./portfolioGenerator";
import type { EtfAnalysisBundle, EtfResearchManifest, EtfReturnsBundle } from "./etfResearchTypes";

const analysis = analysisJson as EtfAnalysisBundle;
const manifest = manifestJson as EtfResearchManifest;
const returns = returnsJson as EtfReturnsBundle;

describe("배포용 ETF 연구 스냅샷", () => {
  it("manifest와 두 번들의 버전 및 종목 집합이 일치한다", () => {
    expect(analysis.dataVersion).toBe(manifest.dataVersion);
    expect(returns.dataVersion).toBe(manifest.dataVersion);
    expect(analysis.profiles).toHaveLength(50);
    expect(returns.series).toHaveLength(50);
    expect(new Set(analysis.profiles.map((profile) => profile.ticker))).toEqual(
      new Set(returns.series.map((series) => series.ticker)),
    );
  });

  it.each(["defensive", "balanced", "growth"] as const)(
    "%s 프리셋에서 세 후보를 만들 수 있다",
    (preset) => {
      const result = generatePortfolioCandidates(analysis.profiles, {
        sleeves: PORTFOLIO_PRESETS[preset].sleeves,
        investmentAmountKrw: 10_000_000,
        maxEtfs: 8,
        maxEtfWeightPercent: 50,
        maxPairOverlapPercent: 70,
        minimumTradingValue20dKrw: 100_000_000,
        maximumExpenseRatioPercent: 0.7,
        hedgePreference: "any",
        fixedStocks: [],
      });
      expect(result.errors).toEqual([]);
      expect(result.candidates).toHaveLength(3);
    },
  );

  it("배포 이력으로 기본 균형 후보를 백테스트할 수 있다", () => {
    const generated = generatePortfolioCandidates(analysis.profiles, {
      sleeves: PORTFOLIO_PRESETS.balanced.sleeves,
      investmentAmountKrw: 10_000_000,
      maxEtfs: 8,
      maxEtfWeightPercent: 50,
      maxPairOverlapPercent: 70,
      minimumTradingValue20dKrw: 100_000_000,
      maximumExpenseRatioPercent: 0.7,
      hedgePreference: "any",
      fixedStocks: [],
    });
    const result = runPortfolioBacktest(generated.candidates[0], returns.series, {
      initialValue: 10_000_000,
      rebalanceFrequency: "annual",
      transactionCostBps: 5,
      riskFreeRatePercent: 2.5,
    });
    expect(result.curve.length).toBeGreaterThan(250);
    expect(result.metrics.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
