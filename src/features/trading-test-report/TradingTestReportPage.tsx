import {
  Activity,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  FlaskConical,
  Landmark,
  RefreshCw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  loadTradingTestIndex,
  loadTradingTestReport,
  type AccountSnapshot,
  type StrategyName,
  type TradingAction,
  type TradingTestIndex,
  type TradingTestReport,
} from "../../api/tradingTestReports";
import ProductTabs from "../../components/ProductTabs";
import SiteFooter from "../../components/SiteFooter";
import "./tradingTestReportPage.css";

interface Props {
  onOpenReport: () => void;
  onOpenPortfolio: () => void;
  onOpenPortfolioReport: () => void;
  onOpenTradingTestReport?: () => void;
  onOpenEtfCompare: () => void;
}

const STRATEGIES: StrategyName[] = ["IRCS-BBCCI-M", "IRCS-BBCCI-M-R2"];
const LABEL: Record<StrategyName, string> = {
  "IRCS-BBCCI-M": "M 기본형",
  "IRCS-BBCCI-M-R2": "M-R2 검증형",
};

function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", minimumFractionDigits: 2,
  }).format(value);
}

function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function dateLabel(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}.${month}.${day}`;
}

function actionLabel(action: TradingAction): string {
  if (action.side === "BUY") return "매수";
  if (action.side === "SELL") return "매도";
  return "유지";
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    no_pending_orders: "전일 확정 주문 없음",
    ircs_entry: "IRCS 진입 신호",
    middle_band_target: "볼린저 중단 목표 도달",
    left_sp500_universe: "S&P 500 구성종목 제외",
  };
  return labels[reason] ?? reason;
}

function AccountCard({ name, account }: { name: StrategyName; account: AccountSnapshot }) {
  return (
    <article className="trading-account-card">
      <div className="trading-account-card__head">
        <div><span>{name}</span><h2>{LABEL[name]}</h2></div>
        <b className={account.totalReturn < 0 ? "is-down" : "is-up"}>{pct(account.totalReturn)}</b>
      </div>
      <strong className="trading-account-equity">{money(account.equity)}</strong>
      <dl>
        <div><dt>현금</dt><dd>{money(account.cash)}</dd></div>
        <div><dt>보유 평가액</dt><dd>{money(account.marketValue)}</dd></div>
        <div><dt>실현손익</dt><dd>{money(account.realizedPnl)}</dd></div>
        <div><dt>미실현손익</dt><dd>{money(account.unrealizedPnl)}</dd></div>
        <div><dt>누적비용</dt><dd>{money(account.feesPaid)}</dd></div>
        <div><dt>MDD</dt><dd>{pct(account.maxDrawdown)}</dd></div>
        <div><dt>완료거래</dt><dd>{account.closedTrades}건</dd></div>
        <div><dt>PF</dt><dd>{account.profitFactor?.toFixed(2) ?? "표본 없음"}</dd></div>
      </dl>
    </article>
  );
}

function ActionRows({ actions }: { actions: TradingAction[] }) {
  if (!actions.length) {
    return <tr><td colSpan={7} className="trading-empty">해당 날짜의 체결 내역이 없습니다.</td></tr>;
  }
  return <>{actions.map((action, index) => (
    <tr key={`${action.side}-${action.ticker ?? "cash"}-${index}`}>
      <td><span className={`trading-action is-${action.side.toLowerCase()}`}>{actionLabel(action)}</span></td>
      <td><strong>{action.ticker ?? "현금"}</strong></td>
      <td>{action.shares ? action.shares.toLocaleString("en-US", { maximumFractionDigits: 3 }) : "—"}</td>
      <td>{money(action.price)}</td><td>{money(action.notional)}</td><td>{money(action.fee)}</td>
      <td>{reasonLabel(action.reason)}</td>
    </tr>
  ))}</>;
}

export default function TradingTestReportPage({
  onOpenReport, onOpenPortfolio, onOpenPortfolioReport,
  onOpenTradingTestReport, onOpenEtfCompare,
}: Props) {
  const [index, setIndex] = useState<TradingTestIndex | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [report, setReport] = useState<TradingTestReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    loadTradingTestIndex().then((value) => {
      if (!active) return;
      setIndex(value);
      setSelectedDate(value.latestReportDate || value.reports[0]?.reportDate || "");
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "목록을 불러오지 못했습니다.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedDate) return;
    let active = true;
    setLoading(true); setError("");
    const generatedAt = index?.reports.find((item) => item.reportDate === selectedDate)?.generatedAt;
    loadTradingTestReport(selectedDate, generatedAt)
      .then((value) => { if (active) setReport(value); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "보고서를 불러오지 못했습니다.");
      }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [index, selectedDate]);

  const allPositions = useMemo(() => report
    ? STRATEGIES.flatMap((strategy) => report.accounts[strategy].positions.map((position) => ({ strategy, ...position })))
    : [], [report]);

  return (
    <div className="trading-report-shell">
      <header className="trading-report-topbar">
        <div className="trading-report-brand"><FlaskConical size={19} /><div><strong>매매테스트 보고서</strong><span>IRCS PAPER FORWARD TEST</span></div></div>
        <ProductTabs current="trading-test-report" onOpenReport={onOpenReport}
          onOpenPortfolio={onOpenPortfolio} onOpenPortfolioReport={onOpenPortfolioReport}
          onOpenTradingTestReport={onOpenTradingTestReport} onOpenEtfCompare={onOpenEtfCompare} />
      </header>
      <div className="trading-report-layout">
        <aside className="trading-report-sidebar" aria-label="날짜별 매매테스트 보고서">
          <div><span>FORWARD ARCHIVE</span><strong>날짜별 리포트</strong><p>한국시간 저녁 7시 · 완료된 미국장 기준</p></div>
          <nav>{index?.reports.map((item) => (
            <button type="button" key={item.reportDate}
              className={item.reportDate === selectedDate ? "is-active" : ""}
              aria-current={item.reportDate === selectedDate ? "page" : undefined}
              onClick={() => setSelectedDate(item.reportDate)}>
              <CalendarDays size={15} /><span><strong>{dateLabel(item.reportDate)}</strong><small>미국장 {dateLabel(item.marketDate)}</small></span><ChevronRight size={14} />
            </button>
          ))}</nav>
        </aside>
        <main className="trading-report-main">
          {loading && !report ? <div className="trading-report-state"><RefreshCw className="spin" /> 보고서를 불러오는 중입니다.</div> : null}
          {error ? <div className="trading-report-state is-error"><CircleAlert size={18} />{error}</div> : null}
          {report ? <>
            <section className="trading-report-hero">
              <div><span>{dateLabel(report.reportDate)} · 미국장 {dateLabel(report.marketDate)}</span><h1>어제 정한 행동의 결과와<br />다음 거래일 행동</h1><p>M과 R2를 각각 $21,000 독립 계좌로 추적합니다. 실제 주문이 아닌 조정종가 기반 포워드 기록입니다.</p></div>
              <dl><div><dt>IVV 누적수익률</dt><dd>{pct(report.benchmark.totalReturn)}</dd></div><div><dt>가격 기준</dt><dd>조정종가</dd></div><div><dt>편도 비용</dt><dd>{pct(report.oneWayCost, 1)}</dd></div><div><dt>데이터 완전성</dt><dd>{pct(report.dataQuality.latestCoverage, 1)}</dd></div></dl>
            </section>
            <section className="trading-account-grid">{STRATEGIES.map((strategy) => <AccountCard key={strategy} name={strategy} account={report.accounts[strategy]} />)}</section>
            <section className="trading-report-card">
              <div className="trading-card-head"><div><span>COMPLETED</span><h2>오늘 확인된 가상 체결</h2><p>전일에 확정된 행동을 미국장 {report.marketDate} 조정종가로 처리한 결과입니다.</p></div><CircleCheck size={21} /></div>
              {STRATEGIES.map((strategy) => <div className="trading-strategy-block" key={strategy}><h3>{LABEL[strategy]} <small>{strategy}</small></h3><div className="trading-table-wrap"><table><thead><tr><th>행동</th><th>종목</th><th>수량</th><th>체결가</th><th>거래금액</th><th>비용</th><th>이유</th></tr></thead><tbody><ActionRows actions={report.completedActions[strategy]} /></tbody></table></div></div>)}
            </section>
            <section className="trading-report-card">
              <div className="trading-card-head"><div><span>NEXT SESSION</span><h2>다음 미국 거래일 행동</h2><p>{report.marketDate} 종가까지만 이용해 확정했으며 다음 장중 움직임으로 변경하지 않습니다.</p></div><ShieldCheck size={21} /></div>
              <div className="trading-next-grid">{STRATEGIES.map((strategy) => { const decision = report.nextActions[strategy]; const gate = decision.marketGate; return <article key={strategy}>
                <div className="trading-next-title"><div><span>{strategy}</span><h3>{LABEL[strategy]}</h3></div><b className={gate?.open ? "is-open" : "is-closed"}>{gate?.open ? "진입 허용" : "진입 대기"}</b></div>
                <dl><div><dt>IVV CCI</dt><dd>{gate?.ivvCci.toFixed(2) ?? "—"}</dd></div><div><dt>CCI 변화</dt><dd>{gate ? `${gate.ivvCciChange > 0 ? "+" : ""}${gate.ivvCciChange.toFixed(2)}` : "—"}</dd></div><div><dt>밴드 위치</dt><dd>{gate?.ivvBandPosition.toFixed(3) ?? "—"}</dd></div><div><dt>원신호</dt><dd>{decision.rawSignals ?? 0}개</dd></div></dl>
                {decision.orders.length ? <ul>{decision.orders.map((order, orderIndex) => <li key={`${order.side}-${order.ticker}-${orderIndex}`}><span className={`trading-action is-${order.side.toLowerCase()}`}>{actionLabel(order)}</span><strong>{order.ticker}</strong><small>{reasonLabel(order.reason)}</small></li>)}</ul> : <div className="trading-no-action"><Landmark size={18} /><div><strong>주문 없음</strong><span>현금 또는 현재 보유종목을 유지합니다.</span></div></div>}
              </article>; })}</div>
            </section>
            <section className="trading-report-card">
              <div className="trading-card-head"><div><span>OPEN POSITIONS</span><h2>현재 보유종목</h2><p>계좌별 수량, 매입가, 현재 평가액과 미실현손익입니다.</p></div><WalletCards size={21} /></div>
              <div className="trading-table-wrap"><table><thead><tr><th>전략</th><th>종목</th><th>수량</th><th>매입일</th><th>매입가</th><th>현재가</th><th>평가액</th><th>미실현손익</th></tr></thead><tbody>{allPositions.length ? allPositions.map((position) => <tr key={`${position.strategy}-${position.ticker}`}><td>{LABEL[position.strategy]}</td><td><strong>{position.ticker}</strong><small>{position.themeBucket}</small></td><td>{position.shares.toLocaleString("en-US", { maximumFractionDigits: 3 })}</td><td>{position.entryDate}</td><td>{money(position.entryPrice)}</td><td>{money(position.currentPrice)}</td><td>{money(position.marketValue)}</td><td className={position.unrealizedPnl < 0 ? "is-down" : "is-up"}>{money(position.unrealizedPnl)}<small>{pct(position.unrealizedReturn)}</small></td></tr>) : <tr><td colSpan={8} className="trading-empty">현재 두 계좌 모두 보유종목이 없습니다.</td></tr>}</tbody></table></div>
            </section>
            <section className="trading-method"><div><Activity size={20} /><h2>검증 원칙</h2></div><ol><li>신호일 종가까지의 정보로만 다음 거래일 행동을 확정합니다.</li><li>확정 행동은 다음 완료 미국장의 조정종가와 편도 비용 0.1%로 처리합니다.</li><li>두 계좌는 각각 $21,000, 최대 4종목, 동일 비중, 테마 중복 금지입니다.</li><li>R2는 M 조건에 IVV CCI 상승과 목표여유 2%를 추가한 검증형입니다.</li><li>과거 체결과 신호는 이후 데이터로 다시 계산하거나 수정하지 않습니다.</li></ol><p><CircleAlert size={16} /> {report.disclaimer} 실제 체결 가능성, 슬리피지, 세금과 환율은 별도로 고려해야 합니다.</p></section>
          </> : null}
          <SiteFooter className="trading-report-footer" note="IRCS M·R2 조정종가 기반 포워드 가상계좌 기록" />
        </main>
      </div>
    </div>
  );
}
