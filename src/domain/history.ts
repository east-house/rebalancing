import { normalizeTicker } from "./portfolio";
import type { Holding, Snapshot } from "./types";

export interface HistoricalClose {
  date: string;
  close: number;
}

export interface HoldingPriceHistory {
  ticker: string;
  country: "KR" | "US";
  prices: readonly HistoricalClose[];
}

function historyKey(country: "KR" | "US", ticker: string): string {
  return `${country}:${normalizeTicker(ticker)}`;
}

/**
 * Reconstructs a price-only asset trend with today's quantities held constant.
 * Cash is also held constant, matching the requested no-rebalancing scenario.
 */
export function calculateFixedHoldingsTrend(
  holdings: readonly Holding[],
  histories: ReadonlyMap<string, HoldingPriceHistory>,
  usdKrwHistory: readonly HistoricalClose[],
  cash: number,
): Snapshot[] {
  const activeHoldings = holdings.filter(
    (holding) => holding.quantity > 0 && normalizeTicker(holding.ticker),
  );
  if (activeHoldings.length === 0) return [];

  const series = activeHoldings.map((holding) => ({
    holding,
    history: histories.get(historyKey(holding.country, holding.ticker)),
  }));
  if (series.some((item) => !item.history?.prices.length)) return [];

  const dates = Array.from(
    new Set(
      series.flatMap((item) => item.history?.prices.map((point) => point.date) ?? []),
    ),
  ).sort((left, right) => left.localeCompare(right));
  const sortedFx = [...usdKrwHistory].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  const latestClose = new Map<string, number>();
  const priceIndexes = new Map<string, number>();
  let fxIndex = 0;
  let latestFx: number | undefined;
  const result: Snapshot[] = [];

  for (const date of dates) {
    for (const { holding, history } of series) {
      const key = historyKey(holding.country, holding.ticker);
      let index = priceIndexes.get(key) ?? 0;
      while (history && index < history.prices.length && history.prices[index].date <= date) {
        latestClose.set(key, history.prices[index].close);
        index += 1;
      }
      priceIndexes.set(key, index);
    }
    while (fxIndex < sortedFx.length && sortedFx[fxIndex].date <= date) {
      latestFx = sortedFx[fxIndex].close;
      fxIndex += 1;
    }

    let totalValue = Math.max(0, cash);
    let complete = true;
    for (const { holding } of series) {
      const close = latestClose.get(historyKey(holding.country, holding.ticker));
      if (!close || (holding.country === "US" && !latestFx)) {
        complete = false;
        break;
      }
      totalValue +=
        holding.quantity * close * (holding.country === "US" ? latestFx ?? 0 : 1);
    }
    if (complete) result.push({ date, totalValue });
  }

  return result;
}

