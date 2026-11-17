import type { PortfolioCashQuote, PortfolioCoreQuote, PortfolioReportPayload as Report, PortfolioStrategyInputs as Inputs } from "../../api/portfolioReport";
import { DEFAULT_CASH, H2B_MAX_STOCKS, MAX_CASH, MissingStrategyInputs, STRATEGIES, h2bMidReached, holdsBil, i2Weights, usesKelly, type StrategyId } from "./portfolioStrategies";

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
  /** weight is the target share of equity; absent (I1) means equal weight. */
  names: { ticker: string; name: string; weight?: number }[]; feeRate: number; reason: string;
  driftThreshold?: number;
  selectionDetails?: SelectionDetail[];
}
export interface SelectionDetail { ticker: string; rank: number; score: number; baseScore: number; themeScore: number; sector: string; theme: string; reason: string; weight?: number; }
export interface AccountDay {
  reportDate: string; marketDate: string; equity: number; cash: number;
  realizedPnl: number; unrealizedPnl: number; totalPnl: number; returnRate: number;
  holdings: (Holding & { close: number; value: number; pnl: number; returnRate: number })[];
  trades: Trade[]; pending: Order | null; sourceRevision?: string;
  targetNames?: string[];
  explanation?: string[];
  selectionDetails?: SelectionDetail[];
  selectionReportDate?: string;
  targetWeights?: Record<string, number>;
}
export interface PortfolioAccount {
  version: 3; startDate: string; initialCapital: number; createdAt: string;
  cash: number; holdings: Holding[]; trades: Trade[]; days: AccountDay[];
  targetNames: string[]; reviewedMonth: string; pending: Order | null;
  /** Absent means the original I1 account (backward compatible). */
  strategy?: StrategyId;
  targetWeights?: Record<string, number>;
  /**
   * Chosen cash share. I1: kept uninvested at every rebalance (absent = 0).
   * I2/C1: replaces the design's planned cash (absent = 40%, the original design); C1 holds it in BIL.
   */
  cashReserve?: number;
  /** H2b: the month-end (a) and mid-month (b) C1 tranches; each keeps its own I1 selection path. */
  tranches?: { a?: Tranche; b?: Tranche };
  /** H2b: month (YYYY-MM) whose mid-month tranche review is done. */
  reviewedHalf?: string;
}
/** One H2b tranche: its I1 selection (signal tickers, IVV) and C1 weights before BIL. */
export interface Tranche { reportDate: string; signalDate: string; names: { ticker: string; name: string }[]; weights: Record<string, number>; }
export const ACCOUNT_KEY = "stock_strategy.us_portfolio.integer.v3";
export const LEGACY_KEY = "stock_strategy.us_portfolio.device.v1";
/** I1 keeps its original storage key; I2 and C1 accounts are stored separately. */
export const accountKey = (strategy: StrategyId) => strategy === "i1" ? ACCOUNT_KEY : `${ACCOUNT_KEY}.${strategy}`;
export const strategyOf = (account: PortfolioAccount): StrategyId => account.strategy ?? "i1";
export const cashReserveOf = (account: PortfolioAccount): number => account.cashReserve ?? DEFAULT_CASH[strategyOf(account)];

function nextWeekday(day: string): string {
  const value = new Date(`${day}T00:00:00Z`);
  do { value.setUTCDate(value.getUTCDate() + 1); } while ([0, 6].includes(value.getUTCDay()));
  return value.toISOString().slice(0, 10);
}

export function createAccount(startDate: string, initialCapital: number, strategy: StrategyId = "i1", cashReserve = DEFAULT_CASH[strategy]): PortfolioAccount {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(initialCapital) || initialCapital <= 0) {
    throw new Error("시작일과 0보다 큰 투자금을 입력해 주세요.");
  }
  if (!Number.isFinite(cashReserve) || cashReserve < 0 || cashReserve > MAX_CASH[strategy] + 1e-12) {
    throw new Error(`현금 비중은 0%에서 ${Math.round(MAX_CASH[strategy] * 100)}% 사이로 선택해 주세요.`);
  }
  return { version: 3, startDate, initialCapital, createdAt: new Date().toISOString(),
    cash: initialCapital, holdings: [], trades: [], days: [], targetNames: [], reviewedMonth: "", pending: null,
    ...(strategy === "i1" ? {} : { strategy, targetWeights: {} }), ...(usesKelly(strategy) || cashReserve > 0 ? { cashReserve } : {}) };
}
const targetWeight = (order: Order, ticker: string) => {
  const item = order.names.find(name => name.ticker === ticker);
  return item?.weight ?? 1 / order.names.length;
};
/**
 * Integer-share accounts hold the S&P 500 core through SPYM instead of IVV: one IVV
 * share (about $770) is larger than a 20% slice of a small account. IVV remains the
 * report's ranking and I2 sizing proxy; only the account position is substituted.
 */
export const CORE_ETF = "SPYM";
export const SIGNAL_CORE = "IVV";
export const isCore = (ticker: string) => ticker === CORE_ETF || ticker === SIGNAL_CORE;
/** Adds the published SPYM close of the report's US session to the report quotes (in memory only). */
export function withCoreQuote(report: Report, quote: PortfolioCoreQuote): Report {
  if (quote.report_date_kst !== report.report_date_kst || quote.signal_market_date !== report.signal_market_date || quote.ticker !== CORE_ETF) {
    throw new Error(`${report.report_date_kst}: S&P 500 ETF(SPYM) 종가의 미국장 기준일이 보고서와 다릅니다.`);
  }
  const base = report.quotes[SIGNAL_CORE] ?? { sector: "ETF", rank: null, themes: "", score: null, base_score: null, theme_strength: null, trend_200: null };
  return { ...report, quotes: { ...report.quotes, [CORE_ETF]: { ...base, ticker: CORE_ETF, name: quote.name, close: quote.close } } };
}
/** C1 holds its planned cash share in a 1-3 month Treasury bill ETF. */
export const CASH_ETF = "BIL";
export const isCashEtf = (ticker: string) => ticker === CASH_ETF;
/** Adds the published BIL close of the report's US session to the report quotes (in memory only). */
export function withCashQuote(report: Report, quote: PortfolioCashQuote): Report {
  if (quote.report_date_kst !== report.report_date_kst || quote.signal_market_date !== report.signal_market_date || quote.ticker !== CASH_ETF) {
    throw new Error(`${report.report_date_kst}: 단기국채 ETF(BIL) 종가의 미국장 기준일이 보고서와 다릅니다.`);
  }
  return { ...report, quotes: { ...report.quotes, [CASH_ETF]: { ticker: CASH_ETF, name: quote.name, sector: "현금 대체", close: quote.close,
    rank: null, themes: "단기 국채", score: null, base_score: null, theme_strength: null, trend_200: null } } };
}
const toCore = <T extends { ticker: string; name: string }>(item: T, report: Report): T =>
  item.ticker === SIGNAL_CORE ? { ...item, ticker: CORE_ETF, name: report.quotes[CORE_ETF]?.name ?? "SPDR Portfolio S&P 500 ETF" } : item;
/** Account targets refer to SPYM; the report's selection rules refer to IVV. */
const asSignal = (tickers: string[]) => tickers.map(ticker => ticker === CORE_ETF ? SIGNAL_CORE : ticker);
function price(report: Report, ticker: string): number {
  if (ticker === CASH_ETF && !report.quotes[CASH_ETF]) {
    throw new Error(`${report.report_date_kst}: 단기국채 ETF(BIL) 종가 자료가 아직 게시되지 않았습니다. 'Backfill portfolio strategy inputs' 워크플로를 실행하면 생성됩니다.`);
  }
  if (ticker === CORE_ETF && !report.quotes[CORE_ETF]) {
    throw new Error(`${report.report_date_kst}: S&P 500 ETF(SPYM) 종가 자료가 아직 게시되지 않았습니다. 'Backfill portfolio strategy inputs' 워크플로를 실행하면 생성됩니다.`);
  }
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

function execute(account: PortfolioAccount, report: Report, order: Order, explanation: string[]): Trade[] {
  if (order.executionDate !== report.signal_market_date) throw new Error(`${order.executionDate} 체결 종가 자료가 빠져 있습니다.`);
  const equity = account.cash + account.holdings.reduce((sum, item) => sum + item.shares * price(report, item.ticker), 0);
  const targets = new Map(order.names.map(item => [item.ticker,
    Math.floor(equity * targetWeight(order, item.ticker) / price(report, item.ticker))]));
  if (order.reason.startsWith("월간") || order.reason.startsWith("월중")) {
    for (const holding of account.holdings) {
      if (!targets.has(holding.ticker)) continue;
      const gap = Math.abs(holding.shares * price(report, holding.ticker) / equity - targetWeight(order, holding.ticker));
      if (gap < (order.driftThreshold ?? 0.03)) {
        targets.set(holding.ticker, holding.shares);
        explanation.push(`${holding.ticker}: 체결 종가 기준 목표비중 차이 ${(gap * 100).toFixed(2)}%p로 조정 기준 미만이므로 수량 유지.`);
      }
    }
  }
  const trades: Trade[] = [];
  const record = (holding: Holding, side: Trade["side"], shares: number, close: number, fee: number, pnl: number) => {
    const trade: Trade = { id: `${order.reportDate}:${order.executionDate}:${holding.ticker}:${side}`,
      reportDate: order.reportDate, signalDate: order.signalDate, executionDate: order.executionDate,
      ticker: holding.ticker, name: holding.name, side, shares, price: close, fee, realizedPnl: pnl, reason: order.reason };
    trades.push(trade); account.trades.push(trade);
  };
  const delta = (ticker: string) => (targets.get(ticker) ?? 0) - (account.holdings.find(item => item.ticker === ticker)?.shares ?? 0);
  const executionOrder = [...new Set([...account.holdings.map(item => item.ticker), ...targets.keys()])]
    .sort((a, b) => delta(a) - delta(b) || a.localeCompare(b));
  for (const holding of [...account.holdings].sort((a, b) => executionOrder.indexOf(a.ticker) - executionOrder.indexOf(b.ticker))) {
    const shares = Math.max(0, holding.shares - (targets.get(holding.ticker) ?? 0));
    if (!shares) continue;
    const close = price(report, holding.ticker), fee = shares * close * order.feeRate;
    const removedCost = holding.cost * shares / holding.shares, proceeds = shares * close - fee;
    record(holding, "SELL", shares, close, fee, proceeds - removedCost);
    account.cash += proceeds; holding.cost -= removedCost; holding.shares -= shares;
  }
  account.holdings = account.holdings.filter(item => item.shares > 0);
  for (const item of [...order.names].sort((a, b) => executionOrder.indexOf(a.ticker) - executionOrder.indexOf(b.ticker))) {
    let holding = account.holdings.find(position => position.ticker === item.ticker);
    const close = price(report, item.ticker);
    const shares = Math.min(Math.max(0, targets.get(item.ticker)! - (holding?.shares ?? 0)),
      Math.floor((account.cash + 1e-9) / (close * (1 + order.feeRate))));
    if (!shares) {
      if (!holding) explanation.push(`${item.ticker}: 배정금액 또는 잔여 현금으로 거래비용을 포함한 1주 매수가 불가능하여 미매수.`);
      continue;
    }
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
  if (account.strategy || account.cashReserve) account.targetWeights = Object.fromEntries(order.names.map(item => [item.ticker, targetWeight(order, item.ticker)]));
  return trades;
}

/** Append new reports only; refreshes and past revisions never rewrite fills. */
export function advanceAccount(original: PortfolioAccount, reports: Report[], inputs: Record<string, Inputs> = {}): PortfolioAccount {
  const account: PortfolioAccount = structuredClone(original);
  const strategy = strategyOf(account), label = STRATEGIES.find(item => item.id === strategy)!.label.split(" ")[0];
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
    const explanation: string[] = [];
    let selectionDetails = previous?.selectionDetails;
    let selectionReportDate = previous?.selectionReportDate;
    if (account.pending && report.signal_market_date >= account.pending.executionDate) {
      trades = execute(account, report, account.pending, explanation);
      explanation.unshift(trades.length ? `예약된 주문을 미국 ${report.signal_market_date} 종가로 ${trades.length}건 체결했습니다.` : "예약 주문을 점검했지만 비중 유지 조건 또는 정수 수량·현금 제약으로 체결 수량이 없어 금일 거래는 없습니다.");
      account.pending = null;
    }
    const holdings = account.holdings.map(holding => {
      const close = price(report, holding.ticker), value = holding.shares * close;
      return { ...holding, close, value, pnl: value - holding.cost, returnRate: value / holding.cost - 1 };
    });
    const equity = account.cash + holdings.reduce((sum, item) => sum + item.value, 0);
    const initial = account.days.length === 0, month = day.slice(0, 7);
    const reserve = cashReserveOf(account);
    const monthDue = initial || month !== account.reviewedMonth;
    // H2b only: the mid-month tranche is reviewed on the report whose US session is the last one on
    // or before the 15th (keyed by the US month); a report blocked by a pending order catches up next.
    const signalMonth = report.signal_market_date.slice(0, 7);
    const midReached = h2bMidReached(report.signal_market_date, report.proposed_execution_date);
    const halfDue = strategy === "h2b" && !initial && midReached && account.reviewedHalf !== signalMonth;
    if (!account.pending && (monthDue || halfDue)) {
      let names: Order["names"];
      const notes: Record<string, string> = {};
      const extra: string[] = [];
      if (strategy === "i1") {
        names = initial ? report.selection.map(({ ticker, name }) => ({ ticker, name })) : selectNames(report, asSignal(account.targetNames));
      } else {
        const input = inputs[day];
        if (!input) throw new MissingStrategyInputs(day);
        if (input.signal_market_date !== report.signal_market_date) throw new Error(`${day}: I2·C1·H2b 계산 자료의 미국장 기준일이 보고서와 다릅니다.`);
        const kelly = (base: { ticker: string; name: string }[], into: Record<string, string>) => {
          const sized = i2Weights(input, base.map(item => item.ticker).filter(ticker => ticker !== "IVV"));
          // The chosen cash share replaces the design's planned cash: the half-Kelly stock
          // weights (designed to sum to at most 40%) are rescaled to a 1 - 20% - cash ceiling.
          const design = input.i2.stock_budget_full_kelly * input.i2.kelly_fraction;
          const ceiling = Math.max(0, 1 - input.i2.ivv_weight - reserve), scale = ceiling / design;
          const sizedNames = [...(base.some(item => item.ticker === "IVV") ? [] : [{ ticker: "IVV", name: report.quotes.IVV?.name ?? "IVV" }]), ...base]
            .map(item => ({ ...item, weight: item.ticker === "IVV" ? sized.weights.IVV : (sized.weights[item.ticker] ?? 0) * scale }));
          for (const item of sizedNames) into[item.ticker] = item.ticker === "IVV" ? "시장 코어 20% 고정 (S&P 500 ETF, IVV 수익률로 비중 계산)"
            : `I1 선정 종목 · 하프 켈리 ${((sized.weights[item.ticker] ?? 0) * 100).toFixed(1)}%${Math.abs(scale - 1) < 1e-9 ? "" : ` × ${scale.toFixed(2)} = ${(item.weight * 100).toFixed(1)}%`} (현금 비중 ${Math.round(reserve * 100)}% → 개별 종목 한도 ${Math.round(ceiling * 100)}%)${sized.fallback ? ` · 관측 ${sized.observations}일 부족 등으로 균등 배분` : ` · 최근 ${sized.observations}거래일 수익률`}`;
          return sizedNames;
        };
        if (strategy !== "h2b") {
          names = kelly(initial ? report.selection.map(({ ticker, name }) => ({ ticker, name })) : selectNames(report, asSignal(account.targetNames)), notes);
        } else {
          // H2b: refresh the tranche that is due (both on the start day), each from its own I1 path.
          const tranches = { ...(account.tranches ?? {}) };
          const due: ("a" | "b")[] = initial || (monthDue && halfDue) ? ["a", "b"] : monthDue ? ["a"] : ["b"];
          for (const key of due) {
            const previousNames = tranches[key]?.names.map(item => item.ticker) ?? asSignal(account.targetNames);
            const base = initial ? report.selection.map(({ ticker, name }) => ({ ticker, name })) : selectNames(report, previousNames);
            const sized = kelly(base, {});
            tranches[key] = { reportDate: day, signalDate: report.signal_market_date, names: base,
              weights: Object.fromEntries(sized.map(item => [item.ticker, item.weight])) };
          }
          account.tranches = tranches;
          const a = tranches.a!, b = tranches.b!, combined: Record<string, number> = {};
          for (const tranche of [a, b]) for (const [ticker, weight] of Object.entries(tranche.weights)) combined[ticker] = (combined[ticker] ?? 0) + 0.5 * weight;
          const stocks = Object.keys(combined).filter(ticker => ticker !== SIGNAL_CORE && combined[ticker] > 1e-12)
            .sort((x, y) => combined[y] - combined[x] || x.localeCompare(y));
          const kept = stocks.slice(0, H2B_MAX_STOCKS), cut = stocks.slice(H2B_MAX_STOCKS);
          const nameOf = (ticker: string) => [...a.names, ...b.names].find(item => item.ticker === ticker)?.name ?? report.quotes[ticker]?.name ?? ticker;
          const pctOf = (value: number) => `${(value * 100).toFixed(1)}%`;
          names = [SIGNAL_CORE, ...kept].map(ticker => ({ ticker, name: ticker === SIGNAL_CORE ? report.quotes.IVV?.name ?? "IVV" : nameOf(ticker), weight: combined[ticker] ?? 0 }));
          for (const item of names) notes[item.ticker] = item.ticker === SIGNAL_CORE ? "시장 코어 20% 고정 (두 묶음 공통)"
            : `월말 묶음(${a.reportDate}) ${pctOf(a.weights[item.ticker] ?? 0)} · 월중 묶음(${b.reportDate}) ${pctOf(b.weights[item.ticker] ?? 0)} → 각 50% 합산 ${pctOf(item.weight ?? 0)} (하프 켈리, 현금 비중 ${Math.round(reserve * 100)}%)`;
          extra.push(`${initial ? "최초 투자: 두 묶음 모두 시작 보고서로 계산했습니다." : due.length === 2 ? "밀린 월중 점검과 월간 점검이 겹쳐 두 묶음을 모두 다시 계산했습니다." : monthDue ?`월말 묶음을 다시 계산했습니다(월중 묶음은 ${b.reportDate} 그대로).` : `월중 묶음을 다시 계산했습니다(월말 묶음은 ${a.reportDate} 그대로).`} 두 묶음을 50%씩 합산합니다.`);
          if (cut.length) extra.push(`개별 종목 ${H2B_MAX_STOCKS}개 상한: ${cut.map(ticker => `${ticker} ${pctOf(combined[ticker])}`).join(", ")}는 제외하고 그 몫은 BIL로 보유합니다.`);
        }
      }
      if (notes[SIGNAL_CORE] !== undefined) notes[CORE_ETF] = notes[SIGNAL_CORE];
      names = names.map(item => toCore(item, report)).filter(item => item.ticker !== CASH_ETF);
      if (holdsBil(strategy)) {
        // C1: the cash share left by the I2 sizing (chosen cash + unused Kelly budget) is held in BIL.
        const invested = names.reduce((sum, item) => sum + (item.weight ?? 0), 0), bill = Math.max(0, 1 - invested);
        if (bill > 1e-9) {
          names = [...names, { ticker: CASH_ETF, name: report.quotes[CASH_ETF]?.name ?? "SPDR Bloomberg 1-3 Month T-Bill ETF", weight: bill }];
          notes[CASH_ETF] = `남는 현금 몫 ${(bill * 100).toFixed(1)}% → 단기국채 ETF(BIL) (현금 비중 ${Math.round(reserve * 100)}% + 하프 켈리 미사용분)`;
        }
      }
      if (reserve > 0 && strategy === "i1") {
        // I1: scale every target so the chosen cash share stays uninvested at each rebalance.
        const count = names.length;
        names = names.map(item => ({ ...item, weight: (item.weight ?? 1 / count) * (1 - reserve) }));
      }
      const changed = names.length !== account.targetNames.length || names.some(item => !account.targetNames.includes(item.ticker));
      selectionDetails = names.map(item => {
        if (item.ticker === CASH_ETF) return { ticker: item.ticker, rank: 0, score: 0, baseScore: 0, themeScore: 0, sector: "현금 대체",
          theme: "1~3개월 미국 국채", ...(item.weight === undefined ? {} : { weight: item.weight }), reason: notes[CASH_ETF] ?? "남는 현금 몫 → BIL" };
        const signalTicker = item.ticker === CORE_ETF ? SIGNAL_CORE : item.ticker;
        // H2b can keep a tranche stock that left today's candidate list; fall back to the report quote row.
        const candidate = report.candidates.find(row => row.ticker === signalTicker), quote = report.quotes[signalTicker];
        const rank = candidate?.rank ?? quote?.rank ?? 0;
        return { ticker: item.ticker, rank, score: candidate?.score ?? quote?.score ?? 0, baseScore: candidate?.base_score ?? quote?.base_score ?? 0,
          themeScore: candidate?.theme_strength ?? quote?.theme_strength ?? 0, sector: candidate?.sector ?? quote?.sector ?? "—", theme: candidate?.themes ?? quote?.themes ?? "",
          ...(item.weight === undefined ? {} : { weight: item.weight }),
          reason: notes[item.ticker] ?? (item.ticker === CORE_ETF ? "시장 코어: S&P 500 ETF(SPYM, IVV 대체) 우선 편입" : !initial && account.targetNames.includes(item.ticker) && rank > 0 && rank <= report.policy.hold_rank ? `유지순위 ${report.policy.hold_rank}위 이내 · 분산 제한 통과` : "점수 순위와 섹터·상관 제한을 통과하여 선정") };
      });
      selectionReportDate = day;
      const i1 = strategy === "i1", review = monthDue ? "월간 점검" : "월중 점검";
      const tranche = strategy !== "h2b" ? "" : monthDue ? " 월말 묶음 갱신" : " 월중 묶음 갱신";
      account.pending = { reportDate: day, signalDate: report.signal_market_date,
        executionDate: report.proposed_execution_date, names, feeRate: report.policy.transaction_cost_each_side ?? 0.001,
        driftThreshold: report.policy.drift_threshold, selectionDetails,
        reason: initial ? (i1 ? "시작일 i1 최초 매수" : `시작일 ${label} 최초 매수`)
          : changed ? (i1 ? "월간 점검: 유지순위·섹터·상관 제한에 따른 종목 교체" : `${review}: ${label}${tranche} 규칙에 따른 종목 교체`)
          : (i1 ? "월간 점검: 동일 종목의 비중 확인" : `${review}: ${label}${tranche} 동일 종목의 목표비중 확인`) };
      explanation.push(initial ? (i1 ? "최초 투자: i1 선정 종목으로 정수 매수 주문을 준비했습니다." : `최초 투자: ${label} 목표 비중으로 정수 매수 주문을 준비했습니다.`) : changed ? `${review}에서 목표 종목이 변경되어 교체 주문을 준비했습니다.` : `${review} 결과 목표 종목은 같습니다. 체결 종가에서 종목별 목표비중 차이를 확인하며, 기준 미만인 기존 종목은 거래하지 않습니다.`);
      explanation.push(...extra);
      if (monthDue) account.reviewedMonth = month;
      if (halfDue || (initial && strategy === "h2b" && midReached)) account.reviewedHalf = signalMonth;
    }
    if (account.pending) explanation.push(`미국 ${account.pending.executionDate} 종가가 확인되는 보고서까지 주문을 대기합니다. 대기 주문은 아직 체결된 거래가 아닙니다.`);
    if (!explanation.length) explanation.push("금일 거래 없음: 월간 종목 점검일이 아니고 대기 주문도 없어 기존 수량을 유지합니다. 일별 순위가 달라져도 매일 종목을 교체하지 않습니다.");
    if (previous?.marketDate === report.signal_market_date) explanation.push("이전 보고서와 미국장 기준일이 같습니다. 새 미국 종가가 없어 같은 가격으로 평가합니다.");
    const realizedPnl = account.trades.reduce((sum, trade) => sum + trade.realizedPnl, 0);
    account.days.push({ reportDate: day, marketDate: report.signal_market_date, equity, cash: account.cash,
      realizedPnl, unrealizedPnl: holdings.reduce((sum, item) => sum + item.pnl, 0),
      totalPnl: equity - account.initialCapital, returnRate: equity / account.initialCapital - 1,
      holdings, trades, pending: structuredClone(account.pending), sourceRevision: report.generated_at,
      targetNames: [...account.targetNames], explanation, selectionDetails, selectionReportDate,
      ...(account.strategy || account.cashReserve ? { targetWeights: { ...(account.targetWeights ?? {}) } } : {}) });
  }
  return account;
}
