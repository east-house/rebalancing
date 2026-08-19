export interface PortfolioReportQuote {
  ticker: string;
  name: string;
  sector: string;
  close: number;
  rank: number | null;
  themes: string;
  score: number | null;
  base_score: number | null;
  theme_strength: number | null;
  trend_200: number | null;
}

export interface PortfolioReportSelection {
  ticker: string;
  name: string;
  sector: string;
  themes: string;
  weight: number;
  reference_close: number;
  rank: number;
  score: number;
  base_score: number;
  theme_strength: number;
  trend_200: number;
}

export interface PortfolioReportCandidate extends PortfolioReportQuote {
  rank: number;
  score: number;
  base_score: number;
  theme_strength: number;
  trend_200: number;
}

export interface PortfolioReportPayload {
  schema_version: number;
  generated_at?: string;
  report_date_kst: string;
  report_time_kst: string;
  signal_market_date: string;
  proposed_execution_date: string;
  stale_preview: boolean;
  default_capital: number;
  default_fractional_shares: boolean;
  fractional_precision: number;
  strategy: {
    id: string;
    name: string;
    status: string;
    base_weight: number;
    theme_weight: number;
    benchmark: string;
  };
  selection: PortfolioReportSelection[];
  candidates: PortfolioReportCandidate[];
  quotes: Record<string, PortfolioReportQuote>;
  market: {
    state: string;
    ivv_close: number;
    ivv_vs_sma_200: number;
  };
  policy: {
    maximum_positions: number;
    hold_rank: number;
    maximum_names_per_sector: number;
    maximum_pairwise_correlation: number;
    stop_loss: number;
    trailing_stop: number;
    drift_threshold: number;
    review_frequency: string;
    market_regime_cash_overlay: boolean;
    stopped_capital_stays_cash_until_monthly_review: boolean;
    automatic_trading: boolean;
  };
  privacy: {
    storage: string;
    server_user_state: boolean;
    cross_device_sync: boolean;
    analytics: boolean;
  };
  data_snapshot: string;
}

function parsePayload(value: unknown): PortfolioReportPayload {
  if (
    typeof value !== "object"
    || value === null
    || (value as { schema_version?: unknown }).schema_version !== 2
    || !Array.isArray((value as { selection?: unknown }).selection)
    || typeof (value as { quotes?: unknown }).quotes !== "object"
    || typeof (value as { strategy?: { id?: unknown } }).strategy?.id !== "string"
  ) {
    throw new Error("포트폴리오 보고서 데이터 형식이 올바르지 않습니다.");
  }
  const payload = value as PortfolioReportPayload;
  if (payload.selection.length !== 5) {
    throw new Error("포트폴리오 보고서의 추천 종목은 5개여야 합니다.");
  }
  return payload;
}

async function fetchPayload(path: string): Promise<PortfolioReportPayload> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return parsePayload(await response.json());
}

export async function loadPortfolioReport(): Promise<PortfolioReportPayload> {
  try {
    return await fetchPayload("/api/portfolio-reports/latest");
  } catch {
    return fetchPayload("/data/portfolio-reports/latest.json");
  }
}
