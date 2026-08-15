import type {
  EtfQualityScore,
  EtfResearchProfile,
  EtfReturnPoint,
} from "./etfResearchTypes";

const TRADING_DAYS = 252;

export interface HoldingOverlapResult {
  overlapPercent: number | null;
  commonHoldingCount: number;
  coveragePercent: number;
  confidence: "exact" | "partial" | "unavailable";
  commonHoldings: Array<{ name: string; weightPercent: number }>;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizedKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function calculateHoldingOverlap(
  left: Pick<EtfResearchProfile, "holdings" | "holdingsCoveragePercent">,
  right: Pick<EtfResearchProfile, "holdings" | "holdingsCoveragePercent">,
): HoldingOverlapResult {
  if (left.holdings.length === 0 || right.holdings.length === 0) {
    return {
      overlapPercent: null,
      commonHoldingCount: 0,
      coveragePercent: 0,
      confidence: "unavailable",
      commonHoldings: [],
    };
  }

  const rightByKey = new Map(
    right.holdings.map((holding) => [normalizedKey(holding.key || holding.name), holding]),
  );
  const commonHoldings = left.holdings.flatMap((holding) => {
    const match = rightByKey.get(normalizedKey(holding.key || holding.name));
    if (!match) return [];
    return [
      {
        name: holding.name || match.name,
        weightPercent: Math.min(holding.weightPercent, match.weightPercent),
      },
    ];
  });
  const coveragePercent = Math.min(
    left.holdingsCoveragePercent,
    right.holdingsCoveragePercent,
  );
  return {
    overlapPercent: commonHoldings.reduce((sum, item) => sum + item.weightPercent, 0),
    commonHoldingCount: commonHoldings.length,
    coveragePercent,
    confidence: coveragePercent >= 90 ? "exact" : "partial",
    commonHoldings: commonHoldings
      .sort((a, b) => b.weightPercent - a.weightPercent)
      .slice(0, 10),
  };
}

export function calculateReturnCorrelation(
  left: readonly EtfReturnPoint[],
  right: readonly EtfReturnPoint[],
): number | null {
  const rightPrices = new Map(right.map((point) => [point.date, point.close]));
  const aligned = left
    .filter((point) => rightPrices.has(point.date))
    .map((point) => ({ date: point.date, left: point.close, right: rightPrices.get(point.date)! }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (aligned.length < 3) return null;

  const leftReturns: number[] = [];
  const rightReturns: number[] = [];
  for (let index = 1; index < aligned.length; index += 1) {
    const previous = aligned[index - 1];
    const current = aligned[index];
    if (previous.left <= 0 || previous.right <= 0) continue;
    leftReturns.push(current.left / previous.left - 1);
    rightReturns.push(current.right / previous.right - 1);
  }
  if (leftReturns.length < 2) return null;
  const leftMean = leftReturns.reduce((sum, value) => sum + value, 0) / leftReturns.length;
  const rightMean = rightReturns.reduce((sum, value) => sum + value, 0) / rightReturns.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < leftReturns.length; index += 1) {
    const leftDelta = leftReturns[index] - leftMean;
    const rightDelta = rightReturns[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? covariance / denominator : null;
}

export function calculatePriceRisk(points: readonly EtfReturnPoint[]) {
  const sorted = [...points]
    .filter((point) => point.close > 0 && /^\d{4}-\d{2}-\d{2}$/.test(point.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  const returns = sorted.slice(1).map((point, index) => point.close / sorted[index].close - 1);
  if (returns.length === 0) {
    return {
      annualizedVolatilityPercent: null,
      downsideVolatilityPercent: null,
      maximumDrawdownPercent: null,
    };
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    Math.max(returns.length - 1, 1);
  const downside = returns.filter((value) => value < 0);
  const downsideVariance =
    downside.length > 0
      ? downside.reduce((sum, value) => sum + value ** 2, 0) / downside.length
      : 0;
  let peak = sorted[0]?.close ?? 0;
  let maximumDrawdown = 0;
  for (const point of sorted) {
    peak = Math.max(peak, point.close);
    if (peak > 0) maximumDrawdown = Math.min(maximumDrawdown, point.close / peak - 1);
  }
  return {
    annualizedVolatilityPercent: Math.sqrt(variance * TRADING_DAYS) * 100,
    downsideVolatilityPercent: Math.sqrt(downsideVariance * TRADING_DAYS) * 100,
    maximumDrawdownPercent: maximumDrawdown * 100,
  };
}

function percentile(values: number[], value: number, higherIsBetter = true): number {
  if (values.length <= 1) return 100;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = sorted.findIndex((candidate) => candidate >= value);
  const raw = (Math.max(rank, 0) / (sorted.length - 1)) * 100;
  return higherIsBetter ? raw : 100 - raw;
}

function profileAgeScore(profile: EtfResearchProfile, peers: readonly EtfResearchProfile[]) {
  const values = peers
    .map((item) => item.metrics.priceHistoryDays)
    .filter((value) => value > 0);
  return percentile(values, profile.metrics.priceHistoryDays);
}

export function scoreEtfQuality(
  profiles: readonly EtfResearchProfile[],
): Map<string, EtfQualityScore> {
  const byStrategy = new Map<string, EtfResearchProfile[]>();
  for (const profile of profiles) {
    const group = byStrategy.get(profile.strategyKey) ?? [];
    group.push(profile);
    byStrategy.set(profile.strategyKey, group);
  }

  const scores = new Map<string, EtfQualityScore>();
  for (const profile of profiles) {
    const peers = byStrategy.get(profile.strategyKey) ?? [profile];
    const liquidityValues = peers
      .map((item) => item.metrics.averageTradingValue20dKrw)
      .filter(finite)
      .map((value) => Math.log10(Math.max(value, 1)));
    const expenseValues = peers.map((item) => item.expenseRatioPercent).filter(finite);
    const navValues = peers
      .map((item) => item.metrics.navDeviationPercent)
      .filter(finite)
      .map(Math.abs);
    const scaleValues = peers
      .map((item) => item.metrics.marketCapKrw)
      .filter(finite)
      .map((value) => Math.log10(Math.max(value, 1)));

    const liquidity = finite(profile.metrics.averageTradingValue20dKrw)
      ? percentile(
          liquidityValues,
          Math.log10(Math.max(profile.metrics.averageTradingValue20dKrw, 1)),
        )
      : null;
    const cost = finite(profile.expenseRatioPercent)
      ? percentile(expenseValues, profile.expenseRatioPercent, false)
      : null;
    const navStability = finite(profile.metrics.navDeviationPercent)
      ? percentile(navValues, Math.abs(profile.metrics.navDeviationPercent), false)
      : null;
    const scale = finite(profile.metrics.marketCapKrw)
      ? percentile(scaleValues, Math.log10(Math.max(profile.metrics.marketCapKrw, 1)))
      : null;
    const scaleAndAge = scale === null ? profileAgeScore(profile, peers) : (scale + profileAgeScore(profile, peers)) / 2;
    const dataQuality = profile.dataGrade === "A" ? 100 : profile.dataGrade === "B" ? 70 : 35;
    const weightedParts: Array<[number | null, number]> = [
      [liquidity, 0.3],
      [cost, 0.25],
      [navStability, 0.2],
      [scaleAndAge, 0.15],
      [dataQuality, 0.1],
    ];
    const availableWeight = weightedParts.reduce(
      (sum, [value, weight]) => sum + (value === null ? 0 : weight),
      0,
    );
    const total =
      availableWeight > 0
        ? weightedParts.reduce(
            (sum, [value, weight]) => sum + (value === null ? 0 : value * weight),
            0,
          ) / availableWeight
        : 0;
    scores.set(profile.ticker, {
      ticker: profile.ticker,
      total,
      dataCompleteness: availableWeight * 100,
      parts: { liquidity, cost, navStability, scaleAndAge, dataQuality },
    });
  }
  return scores;
}

export function calculateLookthroughExposure(
  profiles: ReadonlyArray<{ profile: EtfResearchProfile; weightPercent: number }>,
  fixedStocks: ReadonlyArray<{ name: string; weightPercent: number }> = [],
): Array<{ name: string; weightPercent: number }> {
  const exposure = new Map<string, { name: string; weightPercent: number }>();
  for (const { profile, weightPercent } of profiles) {
    for (const holding of profile.holdings) {
      const key = normalizedKey(holding.name || holding.key);
      const current = exposure.get(key) ?? { name: holding.name, weightPercent: 0 };
      current.weightPercent += (weightPercent * holding.weightPercent) / 100;
      exposure.set(key, current);
    }
  }
  for (const stock of fixedStocks) {
    const key = normalizedKey(stock.name);
    const current = exposure.get(key) ?? { name: stock.name, weightPercent: 0 };
    current.weightPercent += stock.weightPercent;
    exposure.set(key, current);
  }
  return [...exposure.values()]
    .sort((a, b) => b.weightPercent - a.weightPercent)
    .slice(0, 10);
}
