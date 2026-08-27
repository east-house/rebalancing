export type StrategyName = "IRCS-BBCCI-M" | "IRCS-BBCCI-M-R2";

export interface TradingTestIndexItem {
  reportDate: string;
  marketDate: string;
  generatedAt: string;
  mEquity: number;
  r2Equity: number;
  mNextActionCount: number;
  r2NextActionCount: number;
}

export interface TradingTestIndex {
  schemaVersion: number;
  updatedAt: string;
  latestReportDate: string;
  reports: TradingTestIndexItem[];
}

export interface PositionSnapshot {
  ticker: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  themeBucket: string;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedReturn: number;
}

export interface AccountSnapshot {
  cash: number;
  marketValue: number;
  equity: number;
  totalReturn: number;
  realizedPnl: number;
  unrealizedPnl: number;
  feesPaid: number;
  positions: PositionSnapshot[];
  positionCount: number;
  closedTrades: number;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdown: number;
}

export interface TradingAction {
  side: "BUY" | "SELL" | "HOLD";
  ticker: string | null;
  shares?: number;
  price?: number | null;
  notional?: number;
  fee?: number;
  netPnl?: number;
  reason: string;
  themeBucket?: string;
  score?: number;
  signalClose?: number;
  targetRoom?: number;
}

export interface StrategyDecision {
  signalDate: string;
  candidateDate?: string;
  strategy: StrategyName;
  marketGate?: {
    open: boolean;
    baseOpen: boolean;
    cciRising: boolean;
    ivvCci: number;
    ivvCciChange: number;
    ivvBandPosition: number;
    ivvClose: number;
  };
  rawSignals?: number;
  orders: TradingAction[];
  summary: string;
}

export interface TradingTestReport {
  schemaVersion: number;
  strategyVersion: string;
  reportDate: string;
  marketDate: string;
  generatedAt: string;
  executionPriceBasis: string;
  oneWayCost: number;
  accounts: Record<StrategyName, AccountSnapshot>;
  completedActions: Record<StrategyName, TradingAction[]>;
  nextActions: Record<StrategyName, StrategyDecision>;
  benchmark: {
    ticker: "IVV";
    initialClose: number;
    currentClose: number;
    totalReturn: number;
  };
  dataQuality: {
    marketDate: string;
    universeCount: number;
    latestCoverage: number;
    missingSymbols: string[];
    snapshot: string;
  };
  disclaimer: string;
}

async function fetchJson<T>(primary: string, fallback: string): Promise<T> {
  let lastError: unknown;
  for (const path of [primary, fallback]) {
    try {
      const response = await fetch(path, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("매매테스트 보고서를 불러오지 못했습니다.");
}

function assertIndex(value: TradingTestIndex): TradingTestIndex {
  if (value.schemaVersion !== 1 || !Array.isArray(value.reports)) {
    throw new Error("지원하지 않는 매매테스트 목록 형식입니다.");
  }
  return value;
}

function assertReport(value: TradingTestReport): TradingTestReport {
  if (
    value.schemaVersion !== 1
    || !value.reportDate
    || !value.marketDate
    || !value.accounts
    || !value.nextActions
  ) {
    throw new Error("지원하지 않는 매매테스트 보고서 형식입니다.");
  }
  return value;
}

export async function loadTradingTestIndex(): Promise<TradingTestIndex> {
  return assertIndex(await fetchJson(
    "/api/trading-test-reports",
    "/data/trading-test-reports/index.json",
  ));
}

export async function loadTradingTestReport(reportDate: string): Promise<TradingTestReport> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    throw new Error("잘못된 보고서 날짜입니다.");
  }
  return assertReport(await fetchJson(
    `/api/trading-test-reports/${reportDate}`,
    `/data/trading-test-reports/${reportDate}.json`,
  ));
}

