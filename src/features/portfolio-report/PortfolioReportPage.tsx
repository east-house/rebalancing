import {
  CircleAlert,
  Database,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { loadPortfolioReport, type PortfolioReportPayload } from "../../api/portfolioReport";
import ProductTabs from "../../components/ProductTabs";
import SiteFooter from "../../components/SiteFooter";
import {
  allocatePortfolio,
  applyActions,
  buildSnapshot,
  type DeviceHistory,
  type PortfolioActionKind,
  type PortfolioDeviceState,
} from "./portfolioReportModel";
import "./portfolioReportPage.css";

const STORAGE_KEY = "stock_strategy.us_portfolio.device.v1";

interface PortfolioReportPageProps {
  onOpenReport: () => void;
  onOpenPortfolio: () => void;
  onOpenPortfolioReport: () => void;
  onOpenEtfCompare: () => void;
}

const ACTION_LABEL: Record<PortfolioActionKind, string> = {
  BUY: "매수",
  HOLD: "유지",
  SELL: "전량 매도",
  ADD: "추가 매수",
  REDUCE: "일부 매도",
  REVIEW: "교체 검토",
};

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number.isFinite(value) ? value : 0);
}

function pct(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function loadDeviceState(): PortfolioDeviceState | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as PortfolioDeviceState | null;
    return value?.schemaVersion === 2
      && typeof value.strategyId === "string"
      && Array.isArray(value.positions)
      ? value
      : null;
  } catch {
    return null;
  }
}

function saveDeviceState(state: PortfolioDeviceState | null) {
  if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  else localStorage.removeItem(STORAGE_KEY);
}

function historyItem(
  payload: PortfolioReportPayload,
  type: DeviceHistory["type"],
  summary: string,
): DeviceHistory {
  return {
    reportDate: payload.report_date_kst,
    marketDate: payload.signal_market_date,
    type,
    summary,
    recordedAt: new Date().toISOString(),
  };
}

export default function PortfolioReportPage({
  onOpenReport,
  onOpenPortfolio,
  onOpenPortfolioReport,
  onOpenEtfCompare,
}: PortfolioReportPageProps) {
  const [payload, setPayload] = useState<PortfolioReportPayload | null>(null);
  const [deviceState, setDeviceState] = useState<PortfolioDeviceState | null>(() => loadDeviceState());
  const [capital, setCapital] = useState(2_819);
  const [fractional, setFractional] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    loadPortfolioReport()
      .then((value) => {
        if (!active) return;
        setPayload(value);
        setCapital(deviceState?.capital ?? value.default_capital);
        setFractional(deviceState?.fractional ?? value.default_fractional_shares);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "포트폴리오 보고서를 불러오지 못했습니다.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const initialPlan = useMemo(
    () => payload ? allocatePortfolio(payload, Math.max(100, capital), fractional) : null,
    [capital, fractional, payload],
  );
  const snapshot = useMemo(
    () => payload && deviceState ? buildSnapshot(payload, deviceState) : null,
    [deviceState, payload],
  );
  const actionable = snapshot?.actions.filter((item) => item.action !== "HOLD") ?? [];

  useEffect(() => {
    if (!payload || !deviceState || !snapshot) return;
    if (deviceState.history.some((item) => item.type === "DAILY" && item.reportDate === payload.report_date_kst)) return;
    const next = {
      ...deviceState,
      positions: snapshot.actions.map(({ action: _action, reason: _reason, currentWeight: _currentWeight, targetShares: _targetShares, close: _close, rank: _rank, loss: _loss, drawdown: _drawdown, ...position }) => position),
      history: [...deviceState.history, historyItem(payload, "DAILY", actionable.length ? `${actionable.length}건 확인 필요` : "전 종목 유지")].slice(-180),
    };
    saveDeviceState(next);
    setDeviceState(next);
  }, [actionable.length, deviceState, payload, snapshot]);

  const saveInitial = () => {
    if (!payload || !initialPlan) return;
    const state: PortfolioDeviceState = {
      schemaVersion: 2,
      strategyId: payload.strategy.id,
      capital: Math.max(100, capital),
      fractional,
      cash: initialPlan.cash,
      positions: initialPlan.positions,
      initialReport: {
        reportDate: payload.report_date_kst,
        marketDate: payload.signal_market_date,
        strategyId: payload.strategy.id,
      },
      lastReviewMonth: payload.report_date_kst.slice(0, 7),
      history: [historyItem(payload, "INITIAL", `${money(Math.max(100, capital))} · 5종목 각 20% · ${payload.strategy.name}`) ],
    };
    saveDeviceState(state);
    setDeviceState(state);
  };

  const applyToday = () => {
    if (!payload || !deviceState || !snapshot) return;
    const applied = applyActions(payload, deviceState, snapshot);
    const count = snapshot.actions.filter((item) => ["SELL", "ADD", "REDUCE"].includes(item.action)).length;
    const next = {
      ...applied,
      history: [...applied.history, historyItem(payload, "APPLY", `${count}건 모델 기록에 반영`)].slice(-180),
    };
    saveDeviceState(next);
    setDeviceState(next);
  };

  const changeCapital = () => {
    if (!payload || !deviceState) return;
    const source = deviceState.positions.map((position) => ({
      ...payload.selection.find((item) => item.ticker === position.ticker)!,
      ticker: position.ticker,
      name: position.name,
      sector: position.sector,
      themes: position.themes,
      weight: position.weight,
      reference_close: payload.quotes[position.ticker]?.close ?? position.entryPrice,
      close: payload.quotes[position.ticker]?.close ?? position.entryPrice,
      rank: payload.quotes[position.ticker]?.rank ?? 999,
      trend_200: payload.quotes[position.ticker]?.trend_200 ?? 0,
    }));
    const plan = allocatePortfolio(payload, Math.max(100, capital), fractional, source);
    const positions = plan.positions.map((position) => {
      const previous = deviceState.positions.find((item) => item.ticker === position.ticker);
      return {
        ...position,
        entryPrice: previous?.entryPrice ?? position.entryPrice,
        highWatermark: Math.max(previous?.highWatermark ?? 0, position.highWatermark),
      };
    });
    const next: PortfolioDeviceState = {
      ...deviceState,
      capital: Math.max(100, capital),
      fractional,
      cash: plan.cash,
      positions,
      history: [...deviceState.history, historyItem(payload, "CAPITAL_CHANGE", `${money(Math.max(100, capital))}로 목표비중 재계산`)].slice(-180),
    };
    saveDeviceState(next);
    setDeviceState(next);
  };

  const reset = () => {
    if (!window.confirm("이 기기에 저장된 포트폴리오와 기록을 모두 삭제할까요?")) return;
    saveDeviceState(null);
    setDeviceState(null);
  };

  if (loading) return <main className="portfolio-report-loading"><RefreshCw className="spin" /> 포트폴리오 보고서를 불러오는 중입니다.</main>;

  return (
    <div className="portfolio-report-shell">
      <header className="portfolio-report-topbar">
        <div className="portfolio-report-brand"><WalletCards size={19} /><div><strong>포트폴리오 보고서</strong><span>MODEL DECISION REPORT</span></div></div>
        <ProductTabs
          current="portfolio-report"
          onOpenReport={onOpenReport}
          onOpenPortfolio={onOpenPortfolio}
          onOpenPortfolioReport={onOpenPortfolioReport}
          onOpenEtfCompare={onOpenEtfCompare}
        />
      </header>

      <main className="portfolio-report-main">
        {error || !payload ? <div className="portfolio-report-alert"><CircleAlert size={18} />{error || "표시할 포트폴리오 보고서가 없습니다."}</div> : (
          <>
            <section className="portfolio-report-hero">
              <div><span className="portfolio-report-eyebrow">{payload.report_date_kst} · 07:30 KST</span><h1>오늘 확인할 매수·매도와<br />리밸런싱 제안</h1><p>{payload.strategy.name} · 미국 {payload.signal_market_date} 종가까지 반영한 5종목 모델입니다. 실제 주문은 실행하지 않습니다.</p></div>
              <dl><div><dt>시장 상태</dt><dd>{payload.market.state}</dd></div><div><dt>IVV 장기선</dt><dd>{pct(payload.market.ivv_vs_sma_200)}</dd></div><div><dt>정기 점검</dt><dd>월 1회</dd></div><div><dt>자동매매</dt><dd>없음</dd></div></dl>
            </section>

            <div className="portfolio-report-privacy"><LockKeyhole size={18} /><div><strong>금액·보유수량·기록은 이 브라우저에만 저장됩니다.</strong><p>서버 전송과 기기간 동기화가 없으며 브라우저 데이터를 삭제하면 함께 삭제됩니다.</p></div></div>

            {!deviceState && initialPlan ? (
              <section className="portfolio-report-card">
                <div className="portfolio-report-card__head"><div><span>INITIAL BUY PLAN</span><h2>초기 포트폴리오 매수안</h2><p>투자금을 5종목에 각 20%씩 배정합니다. 금액과 소수점 거래 여부를 바꾸면 수량을 다시 계산합니다.</p></div><TrendingUp size={20} /></div>
                <div className="portfolio-report-controls"><label>투자금액(USD)<input type="number" min="100" step="1" value={capital} onChange={(event) => setCapital(Number(event.target.value))} /></label><label className="portfolio-report-check"><input type="checkbox" checked={fractional} onChange={(event) => setFractional(event.target.checked)} /> 소수점 주식 사용</label><button type="button" onClick={saveInitial}>초기 리포트 저장</button></div>
                <div className="portfolio-report-table-wrap"><table><thead><tr><th>회사(티커)</th><th>연결 테마</th><th>제안</th><th>목표비중</th><th>배정금액</th><th>기준 종가</th><th>계산 수량</th><th>후보 순위</th></tr></thead><tbody>{initialPlan.positions.map((position) => { const quote = payload.quotes[position.ticker]; return <tr key={position.ticker}><td><strong>{position.name}</strong><small>{position.ticker} · {position.sector}</small></td><td>{position.themes}</td><td><span className="portfolio-action buy">매수</span></td><td>{(position.weight * 100).toFixed(0)}%</td><td>{money(capital * position.weight)}</td><td>{money(quote?.close ?? position.entryPrice)}</td><td>{position.shares.toLocaleString("en-US", { maximumFractionDigits: 3 })}</td><td>{quote?.rank ?? "—"}</td></tr>; })}</tbody></table></div>
                <p className="portfolio-report-cash">계산 후 예상 현금 {money(initialPlan.cash)} · 실제 체결가격과 수수료에 따라 달라질 수 있습니다.</p>
              </section>
            ) : null}

            {deviceState && snapshot ? (
              <>
                <section className="portfolio-decision-summary">
                  <div><span>오늘의 결론</span><h2>{actionable.length ? `${actionable.length}건의 행동을 확인하세요.` : "오늘은 거래 없이 포트폴리오를 유지합니다."}</h2></div>
                  <dl><div><dt>모델 평가액</dt><dd>{money(snapshot.equity)}</dd></div><div><dt>주식 / 현금</dt><dd>{(snapshot.stockValue / Math.max(snapshot.equity, 1) * 100).toFixed(0)}% / {(deviceState.cash / Math.max(snapshot.equity, 1) * 100).toFixed(0)}%</dd></div><div><dt>제안 행동</dt><dd>{actionable.length}건</dd></div></dl>
                </section>

                <div className="portfolio-report-grid">
                  <section className="portfolio-report-card portfolio-report-actions">
                    <div className="portfolio-report-card__head"><div><span>DAILY ACTIONS</span><h2>오늘 확인할 행동</h2><p>손실 제한과 추적 제한은 매일, 순위·목표비중은 매월 첫 평일 리포트에서 점검합니다.</p></div><ShieldCheck size={20} /></div>
                    <div className="portfolio-report-table-wrap"><table><thead><tr><th>회사(티커)</th><th>판단</th><th>현재비중</th><th>목표비중</th><th>후보순위</th><th>이유</th></tr></thead><tbody>{snapshot.actions.map((action) => <tr key={action.ticker}><td><strong>{action.name}</strong><small>{action.ticker} · {action.sector}</small></td><td><span className={`portfolio-action ${action.action.toLowerCase()}`}>{ACTION_LABEL[action.action]}</span></td><td>{pct(action.currentWeight)}</td><td>{(action.weight * 100).toFixed(0)}%</td><td>{action.rank ?? "—"}</td><td>{action.reason}</td></tr>)}</tbody></table></div>
                    <button className="portfolio-report-secondary" type="button" onClick={applyToday}>매수·매도 제안을 모델 기록에 반영</button>
                  </section>

                  <aside className="portfolio-report-side">
                    <section className="portfolio-report-card"><h2>투자금 변경</h2><p>현재 종목과 목표비중을 유지한 채 수량을 다시 계산합니다.</p><div className="portfolio-report-side-controls"><label>새 투자금액<input type="number" min="100" step="1" value={capital} onChange={(event) => setCapital(Number(event.target.value))} /></label><label className="portfolio-report-check"><input type="checkbox" checked={fractional} onChange={(event) => setFractional(event.target.checked)} /> 소수점 주식</label><button type="button" onClick={changeCapital}>비율대로 변경</button></div></section>
                    <section className="portfolio-report-card"><h2>이 기기의 기록</h2><div className="portfolio-report-history">{deviceState.history.slice(-8).reverse().map((item) => <article key={`${item.recordedAt}-${item.type}`}><div><strong>{item.reportDate}</strong><small>{item.type} · 미국 {item.marketDate}</small></div><span>{item.summary}</span></article>)}</div></section>
                    <button className="portfolio-report-danger" type="button" onClick={reset}>이 기기의 포트폴리오 기록 삭제</button>
                  </aside>
                </div>

                <section className="portfolio-report-card">
                  <div className="portfolio-report-card__head"><div><span>MODEL PORTFOLIO</span><h2>현재 모델 포트폴리오</h2><p>실제 증권사 잔고가 아니라 이 브라우저에서 제안을 반영했다고 가정한 기록입니다.</p></div><Database size={20} /></div>
                  <div className="portfolio-report-table-wrap"><table><thead><tr><th>회사(티커)</th><th>수량</th><th>현재가</th><th>평가액</th><th>비중</th><th>기준가 대비</th></tr></thead><tbody>{snapshot.actions.filter((action) => action.shares > 0).map((action) => <tr key={action.ticker}><td><strong>{action.name}</strong><small>{action.ticker}</small></td><td>{action.shares.toLocaleString("en-US", { maximumFractionDigits: 3 })}</td><td>{action.close === null ? "—" : money(action.close)}</td><td>{money(action.shares * (action.close ?? 0))}</td><td>{pct(action.currentWeight)}</td><td className={(action.loss ?? 0) >= 0 ? "is-up" : "is-down"}>{pct(action.loss)}</td></tr>)}</tbody></table></div>
                </section>
              </>
            ) : null}

            <section className="portfolio-report-method">
              <h2>추천 기준과 한계</h2>
              <ol><li>S&amp;P 500 종목 중 가격·유동성·변동성 조건을 통과한 상위 200개를 계산합니다.</li><li>안정 모멘텀 점수 85%에 시장 리포트의 테마 강도 15%를 결합합니다.</li><li>섹터당 최대 2종목과 종목 간 상관 0.80 제한을 적용해 최종 5종목을 선택합니다.</li><li>매입가 대비 -12% 또는 보유 후 고점 대비 -15%면 전량 매도를 제안하고, 매월 첫 평일에는 순위와 목표비중을 점검합니다.</li></ol>
              <p><CircleAlert size={16} /> 본 보고서는 규칙 기반 모델의 정보 제공 결과이며 개인의 재무상황을 반영한 투자자문이 아닙니다. 실제 투자 판단과 주문 책임은 이용자에게 있습니다.</p>
            </section>
          </>
        )}
        <SiteFooter className="portfolio-report-footer" note="브라우저에만 저장되는 5종목 모델 포트폴리오 의사결정 자료" />
      </main>
    </div>
  );
}
