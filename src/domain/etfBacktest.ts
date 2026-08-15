import type {
  BacktestMetrics,
  BacktestOptions,
  BacktestResult,
  EtfReturnSeries,
  PortfolioCandidate,
  RebalanceFrequency,
  ReturnMode,
} from "./etfResearchTypes";

const TRADING_DAYS = 252;

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
  );
}

function periodKey(date: string, frequency: RebalanceFrequency): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (frequency === "quarterly") return `${year}-Q${Math.ceil(month / 3)}`;
  if (frequency === "annual") return String(year);
  return "hold";
}

function maximumDrawdown(values: readonly number[]): number {
  let peak = values[0] ?? 0;
  let result = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) result = Math.min(result, ((value - peak) / peak) * 100);
  }
  return result;
}

function worstMonth(curve: readonly { date: string; totalValue: number }[]): number | null {
  const monthEnds = new Map<string, number>();
  for (const point of curve) monthEnds.set(point.date.slice(0, 7), point.totalValue);
  const values = [...monthEnds.values()];
  if (values.length < 2) return null;
  let worst = Number.POSITIVE_INFINITY;
  for (let index = 1; index < values.length; index += 1) {
    worst = Math.min(worst, ((values[index] / values[index - 1]) - 1) * 100);
  }
  return Number.isFinite(worst) ? worst : null;
}

function commonMode(series: readonly EtfReturnSeries[]): ReturnMode | "mixed" {
  const modes = new Set(series.map((item) => item.returnMode));
  return modes.size === 1 ? series[0].returnMode : "mixed";
}

export function runPortfolioBacktest(
  candidate: PortfolioCandidate,
  allSeries: readonly EtfReturnSeries[],
  options: BacktestOptions,
): BacktestResult {
  const selected = candidate.items.map((item) => {
    const series = allSeries.find((candidateSeries) => candidateSeries.ticker === item.ticker);
    if (!series) throw new Error(`${item.name}(${item.ticker})의 가격 이력이 없습니다.`);
    return { item, series };
  });
  if (selected.length === 0) throw new Error("백테스트할 ETF가 없습니다.");

  const pricesByTicker = new Map(
    selected.map(({ series }) => [series.ticker, new Map(series.points.map((point) => [point.date, point.close]))]),
  );
  const commonDates = selected[0].series.points
    .map((point) => point.date)
    .filter((date) => selected.every(({ series }) => pricesByTicker.get(series.ticker)?.has(date)))
    .sort();
  if (commonDates.length < 30) throw new Error("공통 거래일이 30일 미만이라 백테스트할 수 없습니다.");

  const totalWeight = selected.reduce((sum, entry) => sum + entry.item.targetWeightPercent, 0);
  if (totalWeight <= 0) throw new Error("ETF 목표 비중의 합계가 0입니다.");
  const weights = selected.map(({ item }) => item.targetWeightPercent / totalWeight);
  const firstDate = commonDates[0];
  let portfolioValue = options.initialValue;
  let units = selected.map(({ series }, index) => {
    const price = pricesByTicker.get(series.ticker)?.get(firstDate) ?? 0;
    if (price <= 0) throw new Error(`${series.name}의 시작 가격이 올바르지 않습니다.`);
    return (portfolioValue * weights[index]) / price;
  });
  const curve: Array<{ date: string; totalValue: number }> = [];
  let previousPeriod = periodKey(firstDate, options.rebalanceFrequency);
  let rebalanceCount = 0;
  let totalTurnover = 0;

  for (const date of commonDates) {
    const prices = selected.map(({ series }) => pricesByTicker.get(series.ticker)?.get(date) ?? 0);
    portfolioValue = units.reduce((sum, quantity, index) => sum + quantity * prices[index], 0);
    const currentPeriod = periodKey(date, options.rebalanceFrequency);
    if (
      options.rebalanceFrequency !== "none" &&
      currentPeriod !== previousPeriod &&
      portfolioValue > 0
    ) {
      const currentWeights = units.map((quantity, index) => (quantity * prices[index]) / portfolioValue);
      const turnover =
        currentWeights.reduce((sum, weight, index) => sum + Math.abs(weight - weights[index]), 0) / 2;
      portfolioValue *= 1 - turnover * (options.transactionCostBps / 10_000);
      units = units.map((_, index) => (portfolioValue * weights[index]) / prices[index]);
      totalTurnover += turnover;
      rebalanceCount += 1;
      previousPeriod = currentPeriod;
    }
    curve.push({ date, totalValue: portfolioValue });
  }

  const dailyReturns = curve.slice(1).map((point, index) => point.totalValue / curve[index].totalValue - 1);
  const downside = dailyReturns.map((value) => Math.min(0, value));
  const startValue = curve[0].totalValue;
  const endValue = curve[curve.length - 1].totalValue;
  const elapsedYears = Math.max(1 / 365.25, (Date.parse(commonDates.at(-1)!) - Date.parse(firstDate)) / 31_557_600_000);
  const annualizedReturn = (endValue / startValue) ** (1 / elapsedYears) - 1;
  const annualizedVolatility = sampleDeviation(dailyReturns) * Math.sqrt(TRADING_DAYS);
  const downsideVolatility = Math.sqrt(mean(downside.map((value) => value ** 2))) * Math.sqrt(TRADING_DAYS);
  const excessReturn = annualizedReturn - options.riskFreeRatePercent / 100;
  const metrics: BacktestMetrics = {
    cumulativeReturnPercent: (endValue / startValue - 1) * 100,
    annualizedReturnPercent: annualizedReturn * 100,
    annualizedVolatilityPercent: annualizedVolatility * 100,
    maximumDrawdownPercent: maximumDrawdown(curve.map((point) => point.totalValue)),
    downsideVolatilityPercent: downsideVolatility * 100,
    sharpeRatio: annualizedVolatility > 0 ? excessReturn / annualizedVolatility : null,
    sortinoRatio: downsideVolatility > 0 ? excessReturn / downsideVolatility : null,
    worstMonthPercent: worstMonth(curve),
    startDate: firstDate,
    endDate: commonDates.at(-1)!,
    tradingDays: commonDates.length,
    rebalanceCount,
    totalTurnoverPercent: totalTurnover * 100,
  };
  const usedSeries = selected.map(({ series }) => series);
  const warnings = [
    "과거 성과는 미래 수익을 보장하지 않습니다.",
    "모든 ETF에 가격이 존재하는 공통 거래일만 사용했습니다.",
  ];
  if (usedSeries.some((series) => !series.distributionIncluded)) {
    warnings.push("분배금이 보장되게 반영되지 않은 가격수익률 자료가 포함되어 실제 총수익률과 다를 수 있습니다.");
  }
  return {
    frequency: options.rebalanceFrequency,
    returnMode: commonMode(usedSeries),
    distributionIncluded: usedSeries.every((series) => series.distributionIncluded),
    curve,
    metrics,
    warnings,
  };
}
