import type { PortfolioReportPayload as Report, PortfolioStrategyInputs as Inputs } from "../../api/portfolioReport";

export type StrategyId = "i1" | "i2" | "s1";
export interface StrategyInfo { id: StrategyId; label: string; title: string; summary: string; }

export const STRATEGIES: StrategyInfo[] = [
  { id: "i1", label: "I1 (기존)", title: "I1 코어·위성",
    summary: "S&P 500 ETF(SPYM, IVV 대체) 포함 최대 5종목 동일비중(각 20%). 현금을 거의 두지 않습니다." },
  { id: "i2", label: "I2", title: "I2 · I1 종목 + 하프 켈리 비중",
    summary: "I1과 같은 종목에 S&P 500 ETF(SPYM) 20% 고정, 개별 종목은 하프 켈리 비율로 합계 한도(80% − 현금 비중) 안에서 배분. 기본 현금 비중 40%(개별 종목 한도 40%)." },
  { id: "s1", label: "S1", title: "S1 · 주도주 3종목 + 섹터 분산",
    summary: "I1 점수 상위 20개 주도주를 12-1 모멘텀 순으로 정렬해 GICS 섹터당 1종목씩 3종목(각 26.7%) + S&P 500 ETF(SPYM) 20%. 현금 없음." },
];

/**
 * Default cash share per strategy. For I2 the chosen cash share replaces the original
 * planned cash (40%): the individual-stock ceiling becomes 1 - 20% core - cash.
 * For I1 and S1 the chosen share scales every target weight down.
 */
export const DEFAULT_CASH: Record<StrategyId, number> = { i1: 0, i2: 0.4, s1: 0 };
export const MAX_CASH: Record<StrategyId, number> = { i1: 0.9, i2: 0.8, s1: 0.9 };

export class MissingStrategyInputs extends Error {
  constructor(public day: string) { super(`${day}: I2·S1 계산 자료가 아직 게시되지 않았습니다.`); }
}

export interface WeightedName { ticker: string; name: string; weight: number; note?: string; }

/** Euclidean projection onto {0 <= w <= cap, sum(w) <= budget}. */
function project(v: number[], cap: number, budget: number): number[] {
  const clip = (lambda: number) => v.map(x => Math.min(cap, Math.max(0, x - lambda)));
  let w = clip(0);
  if (w.reduce((a, b) => a + b, 0) <= budget) return w;
  let lo = 0, hi = Math.max(...v);
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (clip(mid).reduce((a, b) => a + b, 0) > budget) lo = mid; else hi = mid;
  }
  w = clip(hi);
  return w;
}

/**
 * Same problem as research src/us_i2_strategy.py optimal_stock_weights:
 * maximize mean log(1 + 0.2*IVV + stocks.w) on 252 joint returns with half the
 * sample mean removed and a daily fee subtracted from stocks; 0<=w<=0.4, sum<=0.8.
 * Solved by projected gradient ascent (SLSQP in research). Deployed weight = 0.5 x w.
 */
export function i2Weights(inputs: Inputs, stocks: string[]): { weights: Record<string, number>; fallback: boolean; observations: number } {
  const p = inputs.i2, names = ["IVV", ...stocks];
  const series = names.map(name => inputs.returns[name]);
  if (!stocks.length) return { weights: { IVV: p.ivv_weight }, fallback: true, observations: 0 };
  let rows: number[][] = [];
  if (series.every(item => Array.isArray(item))) {
    const length = Math.min(...series.map(item => item!.length));
    for (let t = 0; t < length; t++) {
      const row = series.map(item => item![item!.length - length + t]);
      if (row.every(value => typeof value === "number" && Number.isFinite(value))) rows.push(row as number[]);
    }
    rows = rows.slice(-p.lookback);
  }
  const cap = p.stock_cap_each_full_kelly, budget = p.stock_budget_full_kelly, n = stocks.length;
  let full: number[];
  const fallback = rows.length < p.min_observations || n < 2;
  if (fallback) {
    full = stocks.map(() => Math.min(cap, budget / n));
  } else {
    const means = names.map((_, j) => rows.reduce((sum, row) => sum + row[j], 0) / rows.length);
    const adjusted = rows.map(row => row.map((value, j) => value - 0.5 * means[j] - (j > 0 ? p.fee_daily : 0)));
    const growth = (w: number[]) => adjusted.map(row => 1 + p.ivv_weight * row[0] + w.reduce((sum, x, k) => sum + x * row[k + 1], 0));
    const objective = (w: number[]) => { const g = growth(w); return g.some(x => x <= 0) ? -Infinity : g.reduce((s, x) => s + Math.log(x), 0) / g.length; };
    let w = project(stocks.map(() => 0.4 / n), cap, budget), value = objective(w), step = 1;
    for (let iter = 0; iter < 3000; iter++) {
      const g = growth(w);
      const grad = w.map((_, k) => adjusted.reduce((sum, row, t) => sum + row[k + 1] / g[t], 0) / adjusted.length);
      let moved = false;
      for (let tries = 0; tries < 40; tries++) {
        const next = project(w.map((x, k) => x + step * grad[k]), cap, budget), nextValue = objective(next);
        if (nextValue > value + 1e-15) {
          const change = Math.max(...next.map((x, k) => Math.abs(x - w[k])));
          w = next; value = nextValue; step *= 1.5; moved = change > 1e-10; break;
        }
        step /= 2;
      }
      if (!moved) break;
    }
    full = w;
  }
  const weights: Record<string, number> = { IVV: p.ivv_weight };
  stocks.forEach((ticker, k) => { weights[ticker] = Math.max(0, full[k]) * p.kelly_fraction; });
  return { weights, fallback, observations: rows.length };
}

/** S1: I1 leader pool (top 20 by I1 score) ordered by 12-1 momentum, one name per GICS sector, 3 names. */
export function s1Names(report: Report, inputs: Inputs, existing: string[], equity: number): { names: WeightedName[]; order: string[] } {
  const p = inputs.s1, weight = p.stock_budget / p.positions;
  const pool = report.candidates.filter(item => item.ticker !== "IVV")
    .sort((a, b) => a.rank - b.rank)
    .filter(item => item.close <= p.price_margin * equity * p.pool_price_weight)
    .slice(0, p.pool_size);
  const order = pool.map(item => item.ticker)
    .filter(ticker => typeof inputs.tickers[ticker]?.mom_12_1 === "number")
    .sort((a, b) => inputs.tickers[b].mom_12_1! - inputs.tickers[a].mom_12_1! || a.localeCompare(b))
    .filter(ticker => report.quotes[ticker]?.close <= p.price_margin * equity * weight);
  const keep = existing.filter(ticker => ticker !== "IVV" && order.slice(0, p.hold_order_rank).includes(ticker))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const chosen: string[] = [], sectors: Record<string, number> = {};
  for (const ticker of [...keep, ...order.filter(item => !keep.includes(item))]) {
    const sector = inputs.tickers[ticker]?.gics_sector ?? `own::${ticker}`;
    if ((sectors[sector] ?? 0) >= p.max_names_per_gics_sector) continue;
    chosen.push(ticker); sectors[sector] = (sectors[sector] ?? 0) + 1;
    if (chosen.length === p.positions) break;
  }
  const name = (ticker: string) => report.quotes[ticker]?.name ?? ticker;
  return {
    order,
    names: [{ ticker: "IVV", name: name("IVV"), weight: p.ivv_weight, note: "시장 코어: S&P 500 ETF 20% 고정 (SPYM, IVV 대체)" },
      ...chosen.map(ticker => ({ ticker, name: name(ticker), weight,
        note: `${keep.includes(ticker) ? `유지(모멘텀 순위 ${p.hold_order_rank}위 이내)` : "신규"} · 모멘텀 순위 ${order.indexOf(ticker) + 1}위 · ${inputs.tickers[ticker]?.gics_sector ?? "섹터 미확인"}` }))],
  };
}
