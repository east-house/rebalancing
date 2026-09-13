import { useEffect, useState } from "react";
import { Download, RefreshCw, WalletCards } from "lucide-react";
import { loadPortfolioReport, loadPortfolioReportIndex, type PortfolioReportIndex } from "../../api/portfolioReport";
import { useReportRefresh } from "../../api/useReportRefresh";
import ProductTabs from "../../components/ProductTabs";
import SiteFooter from "../../components/SiteFooter";
import { ACCOUNT_KEY, LEGACY_KEY, advanceAccount, createAccount, type PortfolioAccount, type AccountDay } from "./portfolioReportModel";
import "./portfolioReportPage.css";
import "./portfolioAccount.css";

interface Props {
  onOpenReport: () => void; onOpenPortfolio: () => void; onOpenPortfolioReport: () => void;
  onOpenTradingTestReport?: () => void; onOpenEtfCompare: () => void;
}
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const pct = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${money(value)}`;
function savedAccount(): PortfolioAccount | null {
  try {
    const value = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? "null") as PortfolioAccount | null;
    return value?.version === 3 && Array.isArray(value.days) && Array.isArray(value.trades)
      && value.holdings.every(item => Number.isInteger(item.shares) && item.shares > 0) ? value : null;
  } catch { return null; }
}
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function updateAccount(account: PortfolioAccount, index: PortfolioReportIndex): Promise<PortfolioAccount> {
  const dates = index.reports.map(item => item.reportDate).filter(day => day >= account.startDate && day > (account.days.at(-1)?.reportDate ?? "")).sort();
  if (new Set(dates).size !== dates.length) throw new Error("보고서 목록에 중복 날짜가 있습니다.");
  const reports = [];
  for (let i = 0; i < dates.length; i += 4) {
    reports.push(...await Promise.all(dates.slice(i, i + 4).map(async day => {
      const report = await loadPortfolioReport(day, index.releaseId);
      if (report.report_date_kst !== day || (index.releaseId && report.releaseId !== index.releaseId)) throw new Error("보고서 날짜 또는 게시 버전이 일치하지 않습니다.");
      return report;
    })));
  }
  return advanceAccount(account, reports);
}

function EquityChart({ days, capital }: { days: AccountDay[]; capital: number }) {
  const values = [capital, ...days.map(day => day.equity)];
  const min = Math.min(...values), max = Math.max(...values), span = Math.max(max - min, capital * 0.01);
  const y = (value: number) => 150 - (value - min) / span * 125;
  const points = days.map((day, i) => `${20 + i / Math.max(1, days.length - 1) * 760},${y(day.equity)}`).join(" ");
  return <figure className="account-chart"><figcaption>총자산 추이 <span>점선: 초기 투자금 {money(capital)}</span></figcaption>
    <svg viewBox="0 0 800 180" role="img" aria-label="보고일별 총자산 추이"><line x1="20" x2="780" y1={y(capital)} y2={y(capital)} stroke="#94a3b8" strokeDasharray="5 5" /><polyline points={points} fill="none" stroke="#2563eb" strokeWidth="3" />
      {days.length === 1 && <circle cx="20" cy={y(days[0].equity)} r="4" fill="#2563eb" />}</svg>
    <div><span>{days[0]?.reportDate}</span><strong>{money(days.at(-1)?.equity ?? capital)}</strong><span>{days.at(-1)?.reportDate}</span></div>
  </figure>;
}

export default function PortfolioReportPage(props: Props) {
  const refresh = useReportRefresh();
  const [account, setAccount] = useState<PortfolioAccount | null>(savedAccount);
  const [index, setIndex] = useState<PortfolioReportIndex | null>(null);
  const [capital, setCapital] = useState(2819);
  const [start, setStart] = useState("2026-08-17");
  const [viewDate, setViewDate] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [legacy] = useState(() => localStorage.getItem(LEGACY_KEY));

  const persist = (next: PortfolioAccount) => {
    try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(next)); }
    catch { throw new Error("계좌 기록을 저장하지 못했습니다. 기존 계좌는 유지됩니다."); }
    setAccount(next);
  };
  useEffect(() => {
    let active = true;
    setBusy(true);
    (async () => {
      try {
        const list = await loadPortfolioReportIndex();
        if (!active) return;
        setIndex(list);
        if (!list.reports.some(item => item.reportDate === start)) setStart([...list.reports].sort((a, b) => a.reportDate.localeCompare(b.reportDate))[0]?.reportDate ?? "");
        if (account) {
          const next = await updateAccount(account, list);
          if (active) persist(next);
        }
        if (active) setError("");
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "보고서 조회 실패"); }
      finally { if (active) setBusy(false); }
    })();
    return () => { active = false; };
  }, [refresh]);

  const begin = async () => {
    if (!index || busy) return;
    setBusy(true); setError("");
    try {
      const next = await updateAccount(createAccount(start, capital), index);
      if (!next.days.length) throw new Error("선택한 시작일의 보고서가 없습니다.");
      persist(next); setViewDate("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "계좌 생성 실패"); }
    finally { setBusy(false); }
  };
  const day = account?.days.find(item => item.reportDate === viewDate) ?? account?.days.at(-1);
  const visibleDays = account?.days.filter(item => item.reportDate <= (day?.reportDate ?? "")) ?? [];
  const visibleTrades = account?.trades.filter(item => item.executionDate <= (day?.marketDate ?? "")) ?? [];

  return <div className="portfolio-report-shell">
    <header className="portfolio-report-topbar"><div className="portfolio-report-brand"><WalletCards size={20} /><div><strong>포트폴리오 보고서</strong><span>I1 ACCOUNT TRACKER</span></div></div><ProductTabs current="portfolio-report" {...props} /></header>
    <main className="portfolio-report-main account-main">
      <section className="account-heading"><div><span className="portfolio-report-eyebrow">I1 코어·위성 · 정수 주식 운용</span><h1>내 투자금은 얼마나 변했을까?</h1><p>시작일부터 매수·매도와 손익을 이어서 기록하는 가상계좌입니다. 실제 증권사 주문은 실행하지 않습니다.</p></div>
        {account && <button type="button" className="portfolio-report-secondary" onClick={() => download(account, "i1-account-backup.json")}><Download size={16} /> 계좌 기록 다운로드</button>}</section>
      {busy && <p role="status"><RefreshCw size={15} className="spin" /> 보고서를 확인하고 거래일 순서대로 계좌를 갱신하고 있습니다.</p>}
      {error && <p role="alert" className="portfolio-report-alert">{error}</p>}
      {!account && <section className="portfolio-report-card"><h2>시작일과 초기 투자금</h2><p>시작 보고서의 i1 종목을 선택하고 다음 미국 거래일 종가로 가상 매수합니다. 1주 미만은 매수하지 않고 현금으로 남깁니다.</p>
        <div className="portfolio-report-controls"><label>시작 보고일<select aria-label="시작 보고일" value={start} onChange={event => setStart(event.target.value)}>{[...(index?.reports ?? [])].sort((a, b) => a.reportDate.localeCompare(b.reportDate)).map(item => <option key={item.reportDate} value={item.reportDate}>{item.reportDate}</option>)}</select></label>
          <label>초기 투자금(USD)<input aria-label="초기 투자금(USD)" type="number" min="1" step="1" value={capital} onChange={event => setCapital(Number(event.target.value))} /></label>
          <button type="button" disabled={busy || !index} onClick={begin}>이 금액으로 계좌 시작</button></div>
        {legacy && <p>이전 방식의 기록은 별도로 보존돼 있습니다. 새 계좌의 체결 내역으로 변환하지 않습니다. <button type="button" onClick={() => download(JSON.parse(legacy), "previous-portfolio-backup.json")}>이전 기록 다운로드</button></p>}</section>}
      {account && day && <>
        <div className="account-period"><strong>시작 {account.startDate} · 초기 투자금 {money(account.initialCapital)}</strong><label>계좌 조회일 <select aria-label="계좌 조회일" value={viewDate} onChange={event => setViewDate(event.target.value)}><option value="">최신 계좌</option>{[...account.days].reverse().map(item => <option key={item.reportDate} value={item.reportDate}>{item.reportDate} · 미국장 {item.marketDate}</option>)}</select></label></div>
        <p>{day.reportDate} 보고서 · 미국 {day.marketDate} 종가 기준{viewDate ? " · 해당 날짜에 저장된 보유 내역과 손익" : ""}</p>
        <section className="account-metrics" aria-label="계좌 손익 요약">
          <div><span>현재 총자산</span><strong>{money(day.equity)}</strong><small>주식 평가액 + 현금</small></div>
          <div className={day.totalPnl >= 0 ? "is-up" : "is-down"}><span>총손익 / 수익률</span><strong>{signed(day.totalPnl)}</strong><small>{pct(day.returnRate)} · 초기 투자금 대비</small></div>
          <div><span>보유 현금</span><strong>{money(day.cash)}</strong><small>정수 매수 후 남은 금액 포함</small></div>
          <div><span>실현손익</span><strong>{signed(day.realizedPnl)}</strong><small>매도로 확정된 손익</small></div>
          <div><span>평가손익</span><strong>{signed(day.unrealizedPnl)}</strong><small>보유 종목의 미확정 손익</small></div>
        </section>
        <aside className="account-pnl-guide" aria-label="손익 계산 안내">
          <strong>총손익 = 실현손익 + 평가손익</strong>
          <p>총손익은 현재 총자산에서 초기 투자금을 뺀 금액입니다. 실현손익은 이미 매도한 주식에서 확정된 손익이고, 평가손익은 아직 보유 중인 주식의 평가액에서 매수원가를 뺀 금액입니다.</p>
          <p>예: 매도해서 번 돈이 $100이고 보유 주식의 평가손실이 $30이면 총손익은 +$70입니다. 아직 매도가 없으면 총손익과 평가손익이 같습니다.</p>
        </aside>
        <section className="portfolio-report-card account-notice"><h2>변경사항과 다음 주문</h2>
          <p>{day.trades.length ? `미국 ${day.marketDate} 종가로 ${day.trades.length}건의 매매를 반영했습니다.` : "이 보고일에 새로 반영된 체결은 없습니다."}</p>
          {day.pending ? <><strong>{day.pending.reason}</strong><p>판단에 사용한 미국장 {day.pending.signalDate} → 체결 예정 미국장 {day.pending.executionDate}</p><p>목표 종목: {day.pending.names.map(item => item.ticker).join(" · ")} · 동일비중</p><p>해당 거래일 종가가 확인되는 보고서에서 정수 수량을 계산해 자동 반영합니다.</p></> : <p>현재 보유를 유지합니다. 월간 점검에서 순위·섹터·상관 제한과 목표비중을 다시 확인합니다.</p>}
          <details><summary>누적 변경 알림 ({visibleDays.filter(item => item.trades.length || item.pending?.reportDate === item.reportDate).length})</summary>{visibleDays.filter(item => item.trades.length || item.pending?.reportDate === item.reportDate).map(item => <p key={item.reportDate}>{item.reportDate} · {item.trades.length ? `${item.trades.length}건 체결` : item.pending?.reason}</p>)}</details>
        </section>
        <section className="portfolio-report-card"><EquityChart days={visibleDays} capital={account.initialCapital} /></section>
        <section className="portfolio-report-card"><h2>보유 종목과 수익</h2><p>평균매수단가는 매수 비용을 포함합니다. 총손익 = 실현손익 + 평가손익입니다.</p>
          {(day.targetNames ?? []).some(ticker => !day.holdings.some(item => item.ticker === ticker)) && <p>목표 종목 중 미보유: {(day.targetNames ?? []).filter(ticker => !day.holdings.some(item => item.ticker === ticker)).join(" · ")}. 배정금액으로 1주를 살 수 없으면 해당 금액은 현금으로 남깁니다.</p>}
          {!day.holdings.length ? <p>아직 체결된 보유 종목이 없습니다. 주문 대기 또는 1주 매수에 필요한 금액 부족으로 현금을 보유하고 있습니다.</p> : <div className="portfolio-report-table-wrap"><table><thead><tr><th>종목</th><th>최초 매수일 / 최근 매수일</th><th>수량</th><th>평균매수단가</th><th>기준 종가</th><th>매수원가</th><th>평가액</th><th>평가손익</th><th>수익률</th></tr></thead><tbody>{day.holdings.map(item => <tr key={item.ticker}><td><strong>{item.ticker}</strong><small>{item.name}</small></td><td>{item.firstBuyDate}<small>{item.lastBuyDate}</small></td><td>{item.shares}주</td><td>{money(item.cost / item.shares)}</td><td>{money(item.close)}</td><td>{money(item.cost)}</td><td>{money(item.value)}</td><td className={item.pnl >= 0 ? "is-up" : "is-down"}>{signed(item.pnl)}</td><td>{pct(item.returnRate)}</td></tr>)}</tbody></table></div>}
        </section>
        <section className="portfolio-report-card"><h2>매수·매도 내역</h2><p>매매는 가상 체결이며, i1의 편도 거래비용 0.10%를 반영합니다. 날짜는 미국 체결 거래일입니다.</p>
          {!visibleTrades.length ? <p>체결 내역이 없습니다.</p> : <div className="portfolio-report-table-wrap"><table><thead><tr><th>체결일</th><th>종목</th><th>매매</th><th>수량</th><th>체결가</th><th>거래금액</th><th>거래비용</th><th>실현손익</th><th>변경 사유 / 판단 기준일</th></tr></thead><tbody>{[...visibleTrades].reverse().map(item => <tr key={item.id}><td>{item.executionDate}</td><td>{item.ticker}</td><td>{item.side === "BUY" ? "매수" : "매도"}</td><td>{item.shares}주</td><td>{money(item.price)}</td><td>{money(item.shares * item.price)}</td><td>{money(item.fee)}</td><td>{item.side === "SELL" ? signed(item.realizedPnl) : "—"}</td><td>{item.reason}<small>미국 {item.signalDate} 종가</small></td></tr>)}</tbody></table></div>}
        </section>
        <section className="portfolio-report-card"><h2>일별 자산 기록</h2><div className="portfolio-report-table-wrap"><table><thead><tr><th>한국 보고일</th><th>미국장 기준일</th><th>총자산</th><th>현금</th><th>총손익</th><th>수익률</th><th>체결</th></tr></thead><tbody>{[...visibleDays].reverse().map(item => <tr key={item.reportDate}><td><button type="button" onClick={() => setViewDate(item.reportDate)}>{item.reportDate}</button></td><td>{item.marketDate}</td><td>{money(item.equity)}</td><td>{money(item.cash)}</td><td>{signed(item.totalPnl)}</td><td>{pct(item.returnRate)}</td><td>{item.trades.length}건</td></tr>)}</tbody></table></div></section>
        <button type="button" className="portfolio-report-secondary" disabled={busy} onClick={() => {
          if (!window.confirm("현재 계좌를 백업 보관하고 새 시작일·투자금으로 시작할까요?")) return;
          try { localStorage.setItem(`${ACCOUNT_KEY}.previous`, JSON.stringify(account)); localStorage.removeItem(ACCOUNT_KEY); setAccount(null); setViewDate(""); }
          catch { setError("기존 계좌를 보존하지 못해 새 계좌 전환을 중단했습니다."); }
        }}>기존 계좌를 보관하고 새로 시작</button>
      </>}
      <p className="account-footnote">계좌는 이 브라우저에 저장됩니다. 새 보고서는 날짜순으로 이어서 처리하며, 이미 기록한 체결은 새로고침으로 중복 실행하거나 과거 가격 개정으로 다시 쓰지 않습니다. 과거 보고서에 기반한 재구성 결과입니다.</p>
    </main><SiteFooter className="portfolio-report-footer" note="정수 주식으로 추적하는 i1 가상계좌" />
  </div>;
}
