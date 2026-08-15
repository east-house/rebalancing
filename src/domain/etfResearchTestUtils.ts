import type { EtfResearchProfile, EtfReturnSeries } from "./etfResearchTypes";

export function makeResearchProfile(
  ticker: string,
  strategyKey: string,
  overrides: Partial<EtfResearchProfile> = {},
): EtfResearchProfile {
  return {
    ticker,
    name: `ETF ${ticker}`,
    issuer: "테스트운용",
    assetClass: "GLOBAL_EQUITY",
    assetClassLabel: "글로벌 주식",
    strategyKey,
    strategyLabel: strategyKey,
    benchmarkName: strategyKey,
    structure: "physical",
    hedgeType: "unhedged",
    expenseRatioPercent: 0.1,
    listingDate: "2020-01-01",
    priceAsOf: "2026-07-24",
    holdingsAsOf: "2026-07-23",
    holdingsCoveragePercent: 100,
    holdings: [{ key: "A", name: "A", weightPercent: 50 }],
    metrics: {
      latestPrice: 10_000,
      nav: 10_010,
      navDeviationPercent: -0.1,
      marketCapKrw: 1_000_000_000_000,
      averageTradingValue20dKrw: 10_000_000_000,
      return1yPercent: 10,
      volatility1yPercent: 15,
      downsideVolatility1yPercent: 10,
      maxDrawdown3yPercent: -20,
      priceHistoryDays: 1_000,
    },
    dataGrade: "A",
    usage: "GENERATOR_ELIGIBLE",
    exclusionReasons: [],
    sources: [],
    ...overrides,
  };
}

export function makeReturnSeries(
  ticker: string,
  closes: readonly number[],
): EtfReturnSeries {
  return {
    ticker,
    name: ticker,
    returnMode: "price",
    distributionIncluded: false,
    source: "test",
    points: closes.map((close, index) => ({
      date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
      close,
    })),
  };
}
