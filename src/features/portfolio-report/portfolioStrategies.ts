import type { PortfolioStrategyInputs as Inputs } from "../../api/portfolioReport";

export type StrategyId = "i1" | "i2" | "c1" | "h2b";
export interface StrategyInfo { id: StrategyId; label: string; title: string; summary: string; }

export const STRATEGIES: StrategyInfo[] = [
  { id: "i1", label: "I1 (기존)", title: "I1 코어·위성",
    summary: "S&P 500 ETF(SPYM, IVV 대체) 포함 최대 5종목 동일비중(각 20%). 현금을 거의 두지 않습니다." },
  { id: "i2", label: "I2", title: "I2 · I1 종목 + 하프 켈리 비중",
    summary: "I1과 같은 종목에 S&P 500 ETF(SPYM) 20% 고정, 개별 종목은 하프 켈리 비율로 합계 한도(80% − 현금 비중) 안에서 배분. 기본 현금 비중 40%(개별 종목 한도 40%)." },
  { id: "c1", label: "C1", title: "C1 · I2 + 남는 현금은 단기국채(BIL)",
    summary: "I2와 같은 종목·하프 켈리 비중에 S&P 500 ETF(SPYM) 20%. I2가 현금으로 두는 몫(기본 40%)을 1~3개월 미국 국채 ETF(BIL)로 보유합니다." },
  { id: "h2b", label: "H2b", title: "H2b · C1 월말·월중 2개 묶음",
    summary: "C1을 두 묶음으로 나눠, 월말 신호 묶음과 월중(15일 이전 마지막 미국 거래일) 신호 묶음을 각각 50%씩 반영합니다. 개별 종목은 합산 비중 상위 4개까지, 남는 몫은 단기국채 ETF(BIL)." },
];

/**
 * Default cash share per strategy. For I2 and C1 the chosen cash share replaces the original
 * planned cash (40%): the individual-stock ceiling becomes 1 - 20% core - cash. C1 holds that
 * cash share in BIL instead of cash. For I1 the chosen share scales every target weight down.
 */
export const DEFAULT_CASH: Record<StrategyId, number> = { i1: 0, i2: 0.4, c1: 0.4, h2b: 0.4 };
export const MAX_CASH: Record<StrategyId, number> = { i1: 0.9, i2: 0.8, c1: 0.8, h2b: 0.8 };
/** Strategies sized by the I2 half-Kelly rule (C1 = I2 with the cash share held in BIL; H2b = two C1 tranches). */
export const usesKelly = (strategy: StrategyId) => strategy === "i2" || strategy === "c1" || strategy === "h2b";
/** Strategies that hold the remaining (cash) share in the BIL Treasury bill ETF. */
export const holdsBil = (strategy: StrategyId) => strategy === "c1" || strategy === "h2b";
/** H2b: at most this many individual stocks across the two tranches (largest combined weights). */
export const H2B_MAX_STOCKS = 4;
/**
 * H2b only: the mid-month tranche is reviewed on the first report dated on or after this
 * Korean day of the month. Its US signal session is the last one on or before the 15th
 * (research SPEC_C1PLUS). The monthly rule of every other strategy is unchanged.
 */
export const H2B_MID_DAY = 16;

export class MissingStrategyInputs extends Error {
  constructor(public day: string) { super(`${day}: I2·C1·H2b 계산 자료가 아직 게시되지 않았습니다.`); }
}

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
