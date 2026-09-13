import type { PortfolioReportPayload as Report } from "../../api/portfolioReport";

export interface Holding {
  ticker: string; name: string; shares: number; cost: number;
  firstBuyDate: string; lastBuyDate: string;
}
export interface Trade {
  id: string; reportDate: string; signalDate: string; executionDate: string;
  ticker: string; name: string; side: "BUY" | "SELL"; shares: number;
  price: number; fee: number; realizedPnl: number; reason: string;
}
export interface Order {
  reportDate: string; signalDate: string; executionDate: string;
  names: { ticker: string; name: string }[]; feeRate: number; reason: string;
}
export interface AccountDay {
  reportDate: string; marketDate: string; equity: number; cash: number;
  realizedPnl: number; unrealizedPnl: number; totalPnl: number; returnRate: number;
  holdings: (Holding & { close: number; value: number; pnl: number; returnRate: number })[];
  trades: Trade[]; pending: Order | null; sourceRevision?: string;
}
export interface PortfolioAccount {
  version: 3; startDate: string; initialCapital: number; createdAt: string;
  cash: number; holdings: Holding[]; trades: Trade[]; days: AccountDay[];
  targetNames: string[]; reviewedMonth: string; pending: Order | null;
}
export const ACCOUNT_KEY = "stock_strategy.us_portfolio.integer.v3";
export const LEGACY_KEY = "stock_strategy.us_portfolio.device.v1";

function nextWeekday(day: string): string {
  const value = new Date(`${day}T00:00:00Z`);
  do { value.setUTCDate(value.getUTCDate() + 1); } while ([0, 6].includes(value.getUTCDay()));
  return value.toISOString().slice(0, 10);
}

export function createAccount(startDate: string, initialCapital: number): PortfolioAccount {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw new Error("시작일과 0보다 큰 투자금을 입력해 주세요.");
  }
  return { version: 3, startDate, initialCapital, createdAt: new Date().toISOString(),
    cash: initialCapital, holdings: [], trades: [], days: [], targetNames: [], reviewedMonth: "", pending: null };
}
function price(report: Report, ticker: string): number {
  const value = report.quotes[ticker]?.close;
  if (!Number.isFinite(value) || !(value > 0)) throw new Error(`${report.report_date_kst}: ${ticker} 종가 누락으로 계좌 갱신을 중단했습니다.`);
  return value;
}

/** Canonical I1 retained-rank, sector and absolute-correlation selection. */
export function selectNames(report: Report, existing: string[]): { ticker: string; name: string }[] {
  if (!report.selection_correlations) throw new Error("계좌 추적에 필요한 i1 자료가 아직 준비되지 않았습니다.");
  const candidates = [...report.candidates].sort((a, b) => a.rank - b.rank);
  const indexed = new Map(candidates.map(item => [item.ticker, item]));
  const retained = existing.filter(ticker => indexed.has(ticker) && indexed.get(ticker)!.rank <= report.policy.hold_rank)
    .sort((a, b) => indexed.get(a)!.rank - indexed.get(b)!.rank);
  const order = [...retained, ...candidates.map(item => item.ticker).filter(ticker => !retained.includes(ticker))];
  const selected: string[] = [], sectors: Record<string, number> = {};
  for (const ticker of order) {
    const item = indexed.get(ticker)!;
    if ((sectors[item.sector] ?? 0) >= report.policy.maximum_names_per_sector) continue;
    if (selected.some(other => Math.abs(report.selection_correlations![ticker]?.[other] ?? 0) > report.policy.maximum_pairwise_correlation)) continue;
    selected.push(ticker); sectors[item.sector] = (sectors[item.sector] ?? 0) + 1;
    if (selected.length === report.policy.maximum_positions) break;
  }
  if (!selected.length) throw new Error("i1 선정 조건을 통과한 종목이 없습니다.");
  return selected.map(ticker => ({ ticker, name: indexed.get(ticker)!.name }));
}

function execute(account: PortfolioAccount, report: Report, order: Order): Trade[] {
  if (order.executionDate !== report.signal_market_date) throw new Error(`${order.executionDate} 체결 종가 자료가 빠져 있습니다.`);
  const equity = account.cash + account.holdings.reduce((sum, item) => sum + item.shares * price(report, item.ticker), 0);
  const targets = new Map(order.names.map(item => [item.ticker,
    Math.floor(equity / order.names.length / (price(report, item.ticker) * (1 + order.feeRate)))]));
  const trades: Trade[] = [];
  const record = (holding: Holding, side: Trade["side"], shares: number, close: number, fee: number, pnl: number) => {
    const trade: Trade = { id: `${order.reportDate}:${order.executionDate}:${holding.ticker}:${side}`,
      reportDate: order.reportDate, signalDate: order.signalDate, executionDate: order.executionDate,
      ticker: holding.ticker, name: holding.name, side, shares, price: close, fee, realizedPnl: pnl, reason: order.reason };
    trades.push(trade); account.trades.push(trade);
  };
  for (const holding of account.holdings) {
    const shares = Math.max(0, holding.shares - (targets.get(holding.ticker) ?? 0));
    if (!shares) continue;
    const close = price(report, holding.ticker), fee = shares * close * order.feeRate;
    const removedCost = holding.cost * shares / holding.shares, proceeds = shares * close - fee;
    record(holding, "SELL", shares, close, fee, proceeds - removedCost);
    account.cash += proceeds; holding.cost -= removedCost; holding.shares -= shares;
  }
  account.holdings = account.holdings.filter(item => item.shares > 0);
  for (const item of order.names) {
    let holding = account.holdings.find(position => position.ticker === item.ticker);
    const close = price(report, item.ticker);
    const shares = Math.min(Math.max(0, targets.get(item.ticker)! - (holding?.shares ?? 0)),
      Math.floor((account.cash + 1e-9) / (close * (1 + order.feeRate))));
    if (!shares) continue;
    if (!holding) {
      holding = { ...item, shares: 0, cost: 0, firstBuyDate: order.executionDate, lastBuyDate: order.executionDate };
      account.holdings.push(holding);
    }
    const fee = shares * close * order.feeRate;
    record(holding, "BUY", shares, close, fee, 0);
    holding.shares += shares; holding.cost += shares * close + fee; holding.lastBuyDate = order.executionDate;
    account.cash -= shares * close + fee;
  }
  if (account.cash < -1e-7) throw new Error("계좌 현금 검증에 실패했습니다.");
  account.cash = Math.max(0, account.cash); account.targetNames = order.names.map(item => item.ticker);
  return trades;
}

/** Append new reports only; refreshes and past revisions never rewrite fills. */
export function advanceAccount(original: PortfolioAccount, reports: Report[]): PortfolioAccount {
  const account: PortfolioAccount = structuredClone(original);
  const ordered = [...reports].sort((a, b) => a.report_date_kst.localeCompare(b.report_date_kst));
  for (const report of ordered) {
    const day = report.report_date_kst;
    if (day < account.startDate || day <= (account.days.at(-1)?.reportDate ?? "")) continue;
    if (!account.days.length && day !== account.startDate) throw new Error("시작일 보고서가 빠져 있습니다.");
    if (report.strategy.id !== "i1_core_satellite" || report.stale_preview) throw new Error(`${day}: 유효한 i1 보고서가 아닙니다.`);
    if (report.proposed_execution_date <= report.signal_market_date) throw new Error("판단일 이후 체결일이 필요합니다.");
    const previous = account.days.at(-1);
    if (previous && day !== nextWeekday(previous.reportDate)) throw new Error(`${nextWeekday(previous.reportDate)} 보고서가 빠져 있어 계좌 갱신을 중단했습니다.`);
    if (previous && report.signal_market_date < previous.marketDate) throw new Error("미국 거래일 순서가 올바르지 않습니다.");
    let trades: Trade[] = [];
    if (account.pending && report.signal_market_date >= account.pending.executionDate) {
      trades = execute(account, report, account.pending); account.pending = null;
    }
    const holdings = account.holdings.map(holding => {
      const close = price(report, holding.ticker), value = holding.shares * close;
      return { ...holding, close, value, pnl: value - holding.cost, returnRate: value / holding.cost - 1 };
    });
    const equity = account.cash + holdings.reduce((sum, item) => sum + item.value, 0);
    const initial = account.days.length === 0, month = day.slice(0, 7);
    if (!account.pending && (initial || month !== account.reviewedMonth)) {
      const names = initial ? report.selection.map(({ ticker, name }) => ({ ticker, name })) : selectNames(report, account.targetNames);
      const changed = names.length !== account.targetNames.length || names.some(item => !account.targetNames.includes(item.ticker));
      const drift = names.some(item => Math.abs((holdings.find(position => position.ticker === item.ticker)?.value ?? 0) / equity - 1 / names.length) > report.policy.drift_threshold);
      if (initial || changed || drift) account.pending = { reportDate: day, signalDate: report.signal_market_date,
        executionDate: report.proposed_execution_date, names, feeRate: report.policy.transaction_cost_each_side ?? 0.001,
        reason: initial ? "시작일 i1 최초 매수" : changed ? "월간 점검: 유지순위·섹터·상관 제한에 따른 종목 교체" : "월간 점검: 목표비중 조정" };
      account.reviewedMonth = month;
    }
    const realizedPnl = account.trades.reduce((sum, trade) => sum + trade.realizedPnl, 0);
    account.days.push({ reportDate: day, marketDate: report.signal_market_date, equity, cash: account.cash,
      realizedPnl, unrealizedPnl: holdings.reduce((sum, item) => sum + item.pnl, 0),
      totalPnl: equity - account.initialCapital, returnRate: equity / account.initialCapital - 1,
      holdings, trades, pending: structuredClone(account.pending), sourceRevision: report.generated_at });
  }
  return account;
}
