import raw from "../../../public/data/portfolio-reports/latest.json";
import type { PortfolioReportPayload } from "../../api/portfolioReport";

export function fixture(day = "2026-08-31", market = "2026-08-28", execution = day): PortfolioReportPayload {
  const names = ["IVV", "A", "B", "C", "D", "Z"];
  const candidates = names.map((ticker, i) => ({ ticker, name: `Company ${ticker}`, sector: ticker,
    themes: "Theme", close: 100, rank: i + 1, score: 1 - i / 10, base_score: 0.5, theme_strength: 0.5, trend_200: 0.1 }));
  return { ...raw, report_date_kst: day, signal_market_date: market, proposed_execution_date: execution,
    generated_at: `${day}T00:00:00Z`, stale_preview: false,
    strategy: { ...raw.strategy, id: "i1_core_satellite" },
    candidates, quotes: Object.fromEntries(candidates.map(item => [item.ticker, item])),
    selection: candidates.slice(0, 5).map(item => ({ ...item, reference_close: item.close, weight: 0.2 })),
    selection_correlations: Object.fromEntries(names.map(name => [name, Object.fromEntries(names.map(other => [other, name === other ? 1 : 0]))])),
    policy: { ...raw.policy, stop_loss: null, trailing_stop: null, hold_rank: 10, transaction_cost_each_side: 0.001 } };
}
export const chain = () => [fixture(), fixture("2026-09-01", "2026-08-31"), fixture("2026-09-02", "2026-09-01")];
