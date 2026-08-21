import type {
  PortfolioReportPayload,
  PortfolioReportSelection,
} from "../../api/portfolioReport";

export type PortfolioActionKind = "BUY" | "HOLD" | "SELL" | "ADD" | "REDUCE" | "REVIEW";

export interface DevicePosition {
  ticker: string;
  name: string;
  sector: string;
  themes: string;
  weight: number;
  shares: number;
  entryPrice: number;
  highWatermark: number;
}

export interface DeviceHistory {
  reportDate: string;
  marketDate: string;
  type: "INITIAL" | "DAILY" | "APPLY" | "CAPITAL_CHANGE";
  summary: string;
  recordedAt: string;
  /** Model portfolio value when this record was made. Older records may not have it. */
  equity?: number;
}

export interface PortfolioDeviceState {
  schemaVersion: 2;
  strategyId: string;
  capital: number;
  fractional: boolean;
  cash: number;
  positions: DevicePosition[];
  initialReport: {
    reportDate: string;
    marketDate: string;
    strategyId: string;
  };
  lastReviewMonth: string;
  history: DeviceHistory[];
}

export interface PortfolioSuggestedAction extends DevicePosition {
  action: PortfolioActionKind;
  reason: string;
  currentWeight: number;
  targetShares: number;
  close: number | null;
  rank: number | null;
  loss: number | null;
  drawdown: number | null;
}

export interface PortfolioSnapshot {
  equity: number;
  stockValue: number;
  monthReview: boolean;
  actions: PortfolioSuggestedAction[];
}

export interface HistoryPerformance {
  elapsedDays: number;
  returnRate: number;
}

function utcDay(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(value) ? value : null;
}

/** Calculates performance from a saved record to the currently loaded report date. */
export function calculateHistoryPerformance(
  record: DeviceHistory,
  currentEquity: number,
  currentReportDate: string,
): HistoryPerformance | null {
  const recordEquity = record.equity;
  if (!Number.isFinite(recordEquity) || !recordEquity || recordEquity <= 0 || !Number.isFinite(currentEquity)) {
    return null;
  }
  const start = utcDay(record.reportDate);
  const end = utcDay(currentReportDate);
  if (start === null || end === null) return null;
  return {
    elapsedDays: Math.max(0, Math.round((end - start) / 86_400_000)),
    returnRate: currentEquity / recordEquity - 1,
  };
}

export function floorShares(raw: number, fractional: boolean, precision = 3): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (!fractional) return Math.floor(raw);
  const factor = 10 ** precision;
  return Math.floor(raw * factor) / factor;
}

export function allocatePortfolio(
  payload: PortfolioReportPayload,
  capital: number,
  fractional: boolean,
  source: readonly PortfolioReportSelection[] = payload.selection,
): { positions: DevicePosition[]; cash: number } {
  let used = 0;
  const positions = source.map((item) => {
    const quote = payload.quotes[item.ticker];
    const price = quote?.close ?? item.reference_close;
    const shares = floorShares(
      capital * item.weight / price,
      fractional,
      payload.fractional_precision,
    );
    used += shares * price;
    return {
      ticker: item.ticker,
      name: item.name,
      sector: item.sector,
      themes: item.themes,
      weight: item.weight,
      shares,
      entryPrice: price,
      highWatermark: price,
    };
  });
  return { positions, cash: Math.max(0, capital - used) };
}

export function buildSnapshot(
  payload: PortfolioReportPayload,
  state: PortfolioDeviceState,
): PortfolioSnapshot {
  let stockValue = 0;
  const updatedPositions = state.positions.map((position) => {
    const quote = payload.quotes[position.ticker];
    if (!quote) return position;
    stockValue += position.shares * quote.close;
    return {
      ...position,
      highWatermark: Math.max(position.highWatermark, quote.close),
    };
  });
  const equity = state.cash + stockValue;
  const monthReview = state.lastReviewMonth !== payload.report_date_kst.slice(0, 7);
  const actions = updatedPositions.map<PortfolioSuggestedAction>((position) => {
    const quote = payload.quotes[position.ticker];
    if (!quote) {
      return {
        ...position,
        action: "REVIEW",
        reason: "현재 가격 누락: 수동 확인 필요",
        currentWeight: 0,
        targetShares: position.shares,
        close: null,
        rank: null,
        loss: null,
        drawdown: null,
      };
    }
    const value = position.shares * quote.close;
    const currentWeight = value / Math.max(equity, 1);
    const loss = quote.close / position.entryPrice - 1;
    const drawdown = quote.close / Math.max(position.highWatermark, quote.close) - 1;
    const targetShares = floorShares(
      equity * position.weight / quote.close,
      state.fractional,
      payload.fractional_precision,
    );
    let action: PortfolioActionKind = "HOLD";
    let reason = "예외 청산 신호 없음";
    if (loss <= -payload.policy.stop_loss) {
      action = "SELL";
      reason = `기준가 대비 ${(loss * 100).toFixed(1)}%: 손실 제한선 도달`;
    } else if (drawdown <= -payload.policy.trailing_stop) {
      action = "SELL";
      reason = `보유 후 고점 대비 ${(drawdown * 100).toFixed(1)}%: 추적 제한선 도달`;
    } else if (monthReview && (quote.rank === null || quote.rank > payload.policy.hold_rank)) {
      action = "REVIEW";
      reason = `월간 점검: 순위 ${quote.rank ?? "필터 밖"}로 10위 유지구간 이탈`;
    } else if (
      monthReview
      && Math.abs(currentWeight - position.weight) > payload.policy.drift_threshold
    ) {
      action = currentWeight > position.weight ? "REDUCE" : "ADD";
      reason = `월간 점검: 목표비중과 ${((currentWeight - position.weight) * 100).toFixed(1)}%p 차이`;
    }
    return {
      ...position,
      highWatermark: Math.max(position.highWatermark, quote.close),
      action,
      reason,
      currentWeight,
      targetShares,
      close: quote.close,
      rank: quote.rank,
      loss,
      drawdown,
    };
  });
  return { equity, stockValue, monthReview, actions };
}

export function applyActions(
  payload: PortfolioReportPayload,
  state: PortfolioDeviceState,
  snapshot: PortfolioSnapshot,
): PortfolioDeviceState {
  let cash = state.cash;
  const positions = snapshot.actions.flatMap<DevicePosition>((action) => {
    if (action.action === "SELL" && action.close !== null) {
      cash += action.shares * action.close;
      return [];
    }
    if (
      (action.action === "ADD" || action.action === "REDUCE")
      && action.close !== null
    ) {
      let targetShares = action.targetShares;
      if (targetShares > action.shares) {
        const affordable = floorShares(
          cash / action.close,
          state.fractional,
          payload.fractional_precision,
        );
        targetShares = action.shares + Math.min(targetShares - action.shares, affordable);
      }
      const delta = targetShares - action.shares;
      cash -= delta * action.close;
      return [{
        ticker: action.ticker,
        name: action.name,
        sector: action.sector,
        themes: action.themes,
        weight: action.weight,
        shares: targetShares,
        entryPrice: action.entryPrice,
        highWatermark: action.highWatermark,
      }];
    }
    return [{
      ticker: action.ticker,
      name: action.name,
      sector: action.sector,
      themes: action.themes,
      weight: action.weight,
      shares: action.shares,
      entryPrice: action.entryPrice,
      highWatermark: action.highWatermark,
    }];
  });
  return {
    ...state,
    cash: Math.max(0, cash),
    positions,
    lastReviewMonth: snapshot.monthReview
      ? payload.report_date_kst.slice(0, 7)
      : state.lastReviewMonth,
  };
}
