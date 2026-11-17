import { useEffect, useState } from "react";
import { Download, RefreshCw, WalletCards } from "lucide-react";
import { loadPortfolioCashQuote, loadPortfolioCoreQuote, loadPortfolioReport, loadPortfolioReportIndex, loadPortfolioStrategyInputs, type PortfolioReportIndex, type PortfolioReportPayload, type PortfolioStrategyInputs } from "../../api/portfolioReport";
import { useReportRefresh } from "../../api/useReportRefresh";
import ProductTabs from "../../components/ProductTabs";
import SiteFooter from "../../components/SiteFooter";
import PortfolioDecisionReport from "./PortfolioDecisionReport";
import PortfolioPublicationStatus from "./PortfolioPublicationStatus";
import { CASH_ETF, CORE_ETF, LEGACY_KEY, accountKey, advanceAccount, cashReserveOf, createAccount, isCashEtf, isCore, strategyOf, withCashQuote, withCoreQuote, type PortfolioAccount, type AccountDay } from "./portfolioReportModel";
import { DEFAULT_CASH, H2B_MAX_STOCKS, H2B_MID_DAY, MissingStrategyInputs, STRATEGIES, h2bMidReached, holdsBil, type StrategyId } from "./portfolioStrategies";
import "./portfolioReportPage.css";
import "./portfolioAccount.css";

interface Props {
  onOpenReport: () => void; onOpenPortfolio: () => void; onOpenPortfolioReport: () => void;
  onOpenTradingTestReport?: () => void; onOpenEtfCompare: () => void;
}
const SELECTED_KEY = "stock_strategy.us_portfolio.selected_strategy";
const money = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const pct = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
const share = (value: number) => `${(value * 100).toFixed(1)}%`;
const signed = (value: number) => `${value > 0 ? "+" : ""}${money(value)}`;
const ids = STRATEGIES.map(item => item.id);
const RESERVE_OPTIONS = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
/** "현금 비중 30.0% 설정 (기본 40.0%)" or "현금 비중 40.0% (기본 설계)"; C1 holds that share in BIL. */
export function reserveLabel(strategy: StrategyId, value: number) {
  const base = DEFAULT_CASH[strategy], what = holdsBil(strategy) ? "현금 몫(BIL 보유)" : "현금 비중";
  return Math.abs(value - base) < 1e-9 ? `${what} ${share(value)} (기본 설계)` : `${what} ${share(value)} 설정 (기본 ${share(base)})`;
}
function savedAccount(strategy: StrategyId): PortfolioAccount | null {
  try {
    const value = JSON.parse(localStorage.getItem(accountKey(strategy)) ?? "null") as PortfolioAccount | null;
    return value?.version === 3 && Array.isArray(value.days) && Array.isArray(value.trades) && strategyOf(value) === strategy
      && value.holdings.every(item => Number.isInteger(item.shares) && item.shares > 0) ? value : null;
  } catch { return null; }
}
function savedSelection(): StrategyId {
  try { const value = localStorage.getItem(SELECTED_KEY) as StrategyId | null; return value && ids.includes(value) ? value : "i1"; }
  catch { return "i1"; }
}
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Cash, BIL (C1 cash ETF), S&P 500 core ETF (SPYM, or IVV held by older accounts) and individual-stock shares of equity. */
export function allocation(day: AccountDay) {
  const ivv = day.holdings.filter(item => isCore(item.ticker)).reduce((sum, item) => sum + item.value, 0);
  const bil = day.holdings.filter(item => isCashEtf(item.ticker)).reduce((sum, item) => sum + item.value, 0);
  const stocks = day.holdings.filter(item => !isCore(item.ticker) && !isCashEtf(item.ticker));
  const stockValue = stocks.reduce((sum, item) => sum + item.value, 0);
  const equity = day.equity || 1;
  return { cash: day.cash / equity, ivv: ivv / equity, bil: bil / equity, stocks: stockValue / equity, stockCount: stocks.length,
    cashValue: day.cash, ivvValue: ivv, bilValue: bil, stockValue };
}
function targetMix(day: AccountDay) {
  const names = day.pending?.names ?? (day.targetNames ?? []).map(ticker => ({ ticker, weight: day.targetWeights?.[ticker] }));
  if (!names.length) return null;
  const weight = (item: { ticker: string; weight?: number }) => item.weight ?? 1 / names.length;
  const ivv = names.filter(item => isCore(item.ticker)).reduce((sum, item) => sum + weight(item), 0);
  const bil = names.filter(item => isCashEtf(item.ticker)).reduce((sum, item) => sum + weight(item), 0);
  const stocks = names.filter(item => !isCore(item.ticker) && !isCashEtf(item.ticker)).reduce((sum, item) => sum + weight(item), 0);
  return { ivv, bil, stocks, cash: Math.max(0, 1 - ivv - bil - stocks), names: names.map(item => ({ ticker: item.ticker, weight: weight(item) })) };
}

async function loadInputs(days: string[], releaseId: string | undefined, into: Record<string, PortfolioStrategyInputs>) {
  for (let i = 0; i < days.length; i += 4) {
    await Promise.all(days.slice(i, i + 4).filter(day => !into[day]).map(async day => {
      try { into[day] = await loadPortfolioStrategyInputs(day, releaseId); } catch { /* resolved lazily below */ }
    }));
  }
}

export async function updateAccount(account: PortfolioAccount, index: PortfolioReportIndex): Promise<PortfolioAccount> {
  const dates = index.reports.map(item => item.reportDate).filter(day => day >= account.startDate && day > (account.days.at(-1)?.reportDate ?? "")).sort();
  if (new Set(dates).size !== dates.length) throw new Error("보고서 목록에 중복 날짜가 있습니다.");
  const reports: PortfolioReportPayload[] = [];
  for (let i = 0; i < dates.length; i += 4) {
    reports.push(...await Promise.all(dates.slice(i, i + 4).map(async day => {
      const report = await loadPortfolioReport(day, index.releaseId);
      if (report.report_date_kst !== day || (index.releaseId && report.releaseId !== index.releaseId)) throw new Error("보고서 날짜 또는 게시 버전이 일치하지 않습니다.");
      let withCore;
      try { withCore = withCoreQuote(report, await loadPortfolioCoreQuote(day, index.releaseId)); }
      catch (reason) {
        if (reason instanceof Error && reason.message.includes("미국장 기준일")) throw reason;
        throw new Error(`${day}: S&P 500 ETF(${CORE_ETF}) 종가 자료가 아직 게시되지 않았습니다. 'Backfill portfolio strategy inputs' 워크플로를 실행하면 생성됩니다.`);
      }
      if (!holdsBil(strategyOf(account))) return withCore;
      try { return withCashQuote(withCore, await loadPortfolioCashQuote(day, index.releaseId)); }
      catch (reason) {
        if (reason instanceof Error && reason.message.includes("미국장 기준일")) throw reason;
        throw new Error(`${day}: 단기국채 ETF(${CASH_ETF}) 종가 자료가 아직 게시되지 않았습니다. 'Backfill portfolio strategy inputs' 워크플로를 실행하면 생성됩니다.`);
      }
    })));
  }
  if (strategyOf(account) === "i1") return advanceAccount(account, reports);
  // I2/C1 decide only on the start day and monthly review days; preload the first reports of each month.
  // H2b also reviews its mid-month tranche on the report whose US session is the last one on or before the 15th.
  const inputs: Record<string, PortfolioStrategyInputs> = {};
  const mid = (i: number) => h2bMidReached(reports[i].signal_market_date, reports[i].proposed_execution_date);
  const usMonth = (i: number) => reports[i].signal_market_date.slice(0, 7);
  const firstMid = (i: number) => strategyOf(account) === "h2b" && mid(i) && (i === 0 || !mid(i - 1) || usMonth(i) !== usMonth(i - 1));
  await loadInputs(dates.filter((day, i) => i === 0 || day.slice(0, 7) !== dates[i - 1].slice(0, 7) || (i > 1 && day.slice(0, 7) !== dates[i - 2].slice(0, 7))
    || firstMid(i) || (i > 0 && firstMid(i - 1))), index.releaseId, inputs);
  for (let attempt = 0; attempt < 24; attempt++) {
    try { return advanceAccount(account, reports, inputs); }
    catch (error) {
      if (!(error instanceof MissingStrategyInputs) || inputs[error.day]) throw error;
      try { inputs[error.day] = await loadPortfolioStrategyInputs(error.day, index.releaseId); }
      catch { throw new Error(`${error.day}: I2·C1 계산 자료가 아직 게시되지 않았습니다. 이전 날짜는 'Backfill portfolio strategy inputs' 워크플로를 실행하면 생성됩니다.`); }
    }
  }
  throw new Error("I2·C1 계산 자료를 불러오지 못했습니다.");
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

function AllocationCard({ day, strategy, reserve }: { day: AccountDay; strategy: StrategyId; reserve: number }) {
  const mix = allocation(day), target = targetMix(day);
  return <section className="portfolio-report-card account-allocation" aria-label="자산 구성">
    <h2>자산 구성 · 현금{holdsBil(strategy) ? "·단기국채" : ""}과 S&amp;P 500 ETF</h2>
    <p className="allocation-note">계좌는 IVV(1주 약 $770) 대신 같은 S&amp;P 500 지수를 따르는 SPYM(1주 약 $90)으로 코어 20%를 보유합니다. 순위·비중 계산은 보고서의 IVV 자료를 그대로 씁니다.</p>
    {strategy === "h2b" && <p className="allocation-note">H2b는 월말 신호 묶음과 월중 신호 묶음의 C1 목표를 50%씩 합칩니다. 개별 종목은 합산 비중이 큰 {H2B_MAX_STOCKS}개까지 보유하고, 남는 몫은 단기국채 ETF(BIL)로 둡니다.</p>}
    {holdsBil(strategy) && <p className="allocation-note">{strategy === "h2b" ? "H2b(C1과 같이)는" : "C1은"} I2가 현금으로 두는 몫을 1~3개월 미국 국채 ETF(BIL)로 보유합니다. BIL도 매일 가격이 움직이며 배당 지급일에 가격이 내려가고 배당으로 보전됩니다.</p>}
    <div className="allocation-bar" role="img" aria-label={`개별 주식 ${share(mix.stocks)}, S&P 500 ETF ${share(mix.ivv)}, 단기국채 BIL ${share(mix.bil)}, 현금 ${share(mix.cash)}`}>
      <span className="is-stocks" style={{ width: `${mix.stocks * 100}%` }} />
      <span className="is-ivv" style={{ width: `${mix.ivv * 100}%` }} />
      <span className="is-bil" style={{ width: `${mix.bil * 100}%` }} />
      <span className="is-cash" style={{ width: `${mix.cash * 100}%` }} />
    </div>
    <div className="allocation-legend">
      <div><i className="is-stocks" /><span>개별 주식 {mix.stockCount}종목</span><strong>{share(mix.stocks)}</strong><small>{money(mix.stockValue)}</small></div>
      <div><i className="is-ivv" /><span>S&amp;P 500 ETF (SPYM)</span><strong>{share(mix.ivv)}</strong><small>{money(mix.ivvValue)}</small></div>
      {(holdsBil(strategy) || mix.bil > 0) && <div><i className="is-bil" /><span>단기국채 ETF (BIL)</span><strong>{share(mix.bil)}</strong><small>{money(mix.bilValue)}</small></div>}
      <div><i className="is-cash" /><span>현금</span><strong>{share(mix.cash)}</strong><small>{money(mix.cashValue)}</small></div>
    </div>
    {target && <p className="allocation-target">{day.pending ? "대기 주문의 목표" : "현재 목표"} 비중: 개별 주식 {share(target.stocks)} · S&amp;P 500 ETF {share(target.ivv)}{target.bil > 0 ? ` · 단기국채 BIL ${share(target.bil)}` : ""} · 계획 현금 {share(target.cash)} ({reserveLabel(strategy, reserve)})
      <small>{target.names.map(item => `${item.ticker} ${share(item.weight)}`).join(" · ")}. 정수 주식만 사므로 실제 현금은 계획보다 조금 많을 수 있습니다.</small></p>}
  </section>;
}

function Comparison({ accounts, current, onSelect }: { accounts: Record<StrategyId, PortfolioAccount | null>; current: StrategyId; onSelect: (id: StrategyId) => void }) {
  const rows = STRATEGIES.map(info => ({ info, account: accounts[info.id], day: accounts[info.id]?.days.at(-1) }));
  if (rows.filter(row => row.day).length < 2) return null;
  return <section className="portfolio-report-card"><h2>매매법 비교</h2><p>시작일·투자금·현금 비중이 다르면 수익률을 직접 비교할 수 없습니다. 같은 조건으로 시작하면 같은 조건의 비교가 됩니다.</p>
    <div className="portfolio-report-table-wrap"><table><thead><tr><th>매매법</th><th>시작일 / 투자금</th><th>최신 보고일</th><th>총자산</th><th>수익률</th><th>현금</th><th>단기국채 BIL</th><th>S&amp;P 500 ETF</th><th>개별 주식</th></tr></thead>
      <tbody>{rows.map(({ info, account, day }) => { const mix = day ? allocation(day) : null; return <tr key={info.id} className={info.id === current ? "is-current" : undefined}>
        <td><button type="button" onClick={() => onSelect(info.id)}>{info.label}</button></td>
        {account && day && mix ? <><td>{account.startDate}<small>{money(account.initialCapital)} · {reserveLabel(info.id, cashReserveOf(account))}</small></td><td>{day.reportDate}</td><td>{money(day.equity)}</td><td className={day.returnRate >= 0 ? "is-up" : "is-down"}>{pct(day.returnRate)}</td><td>{share(mix.cash)}</td><td>{share(mix.bil)}</td><td>{share(mix.ivv)}</td><td>{share(mix.stocks)} · {mix.stockCount}종목</td></> : <td colSpan={8}>계좌 미시작</td>}
      </tr>; })}</tbody></table></div></section>;
}

export default function PortfolioReportPage(props: Props) {
  const refresh = useReportRefresh();
  const [strategy, setStrategy] = useState<StrategyId>(savedSelection);
  const [accounts, setAccounts] = useState<Record<StrategyId, PortfolioAccount | null>>(() => ({ i1: savedAccount("i1"), i2: savedAccount("i2"), c1: savedAccount("c1"), h2b: savedAccount("h2b") }));
  const [index, setIndex] = useState<PortfolioReportIndex | null>(null);
  const [capital, setCapital] = useState(2819);
  const [start, setStart] = useState("2026-08-17");
  const [reserve, setReserve] = useState(() => DEFAULT_CASH[savedSelection()]);
  const [viewDate, setViewDate] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [legacy] = useState(() => localStorage.getItem(LEGACY_KEY));
  const account = accounts[strategy];
  const info = STRATEGIES.find(item => item.id === strategy)!;

  const persist = (next: PortfolioAccount) => {
    const id = strategyOf(next);
    try { localStorage.setItem(accountKey(id), JSON.stringify(next)); }
    catch { throw new Error("계좌 기록을 저장하지 못했습니다. 기존 계좌는 유지됩니다."); }
    setAccounts(previous => ({ ...previous, [id]: next }));
  };
  const select = (id: StrategyId) => {
    setStrategy(id); setViewDate(""); setError(""); setReserve(DEFAULT_CASH[id]);
    try { localStorage.setItem(SELECTED_KEY, id); } catch { /* selection is a convenience only */ }
  };
  useEffect(() => {
    let active = true;
    setBusy(true);
    (async () => {
      const problems: string[] = [];
      try {
        const list = await loadPortfolioReportIndex();
        if (!active) return;
        setIndex(list);
        if (!list.reports.some(item => item.reportDate === start)) setStart([...list.reports].sort((a, b) => a.reportDate.localeCompare(b.reportDate))[0]?.reportDate ?? "");
        for (const id of ids) {
          const saved = savedAccount(id);
          if (!saved) continue;
          try { const next = await updateAccount(saved, list); if (active) persist(next); }
          catch (reason) { problems.push(`${STRATEGIES.find(item => item.id === id)!.label}: ${reason instanceof Error ? reason.message : "갱신 실패"}`); }
        }
        if (active) setError(problems.join(" / "));
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "보고서 조회 실패"); }
      finally { if (active) setBusy(false); }
    })();
    return () => { active = false; };
  }, [refresh]);

  const begin = async () => {
    if (!index || busy) return;
    setBusy(true); setError("");
    try {
      const next = await updateAccount(createAccount(start, capital, strategy, reserve), index);
      if (!next.days.length) throw new Error("선택한 시작일의 보고서가 없습니다.");
      persist(next); setViewDate("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "계좌 생성 실패"); }
    finally { setBusy(false); }
  };
  const day = account?.days.find(item => item.reportDate === viewDate) ?? account?.days.at(-1);
  const visibleDays = account?.days.filter(item => item.reportDate <= (day?.reportDate ?? "")) ?? [];
  const visibleTrades = account?.trades.filter(item => item.executionDate <= (day?.marketDate ?? "")) ?? [];
  const pendingWeights = day?.pending?.names.some(item => item.weight !== undefined);

  return <div className="portfolio-report-shell">
    <header className="portfolio-report-topbar"><div className="portfolio-report-brand"><WalletCards size={20} /><div><strong>포트폴리오 보고서</strong><span>{info.label.split(" ")[0]} ACCOUNT TRACKER</span></div></div><ProductTabs current="portfolio-report" {...props} /></header>
    <main className="portfolio-report-main account-main">
      <nav className="strategy-tabs" aria-label="매매법 선택">{STRATEGIES.map(item => <button type="button" key={item.id} aria-pressed={item.id === strategy} className={item.id === strategy ? "is-active" : undefined} onClick={() => select(item.id)}>{item.label}{accounts[item.id] ? "" : " · 미시작"}</button>)}</nav>
      <section className="account-heading"><div><span className="portfolio-report-eyebrow">{info.title} · 정수 주식 운용</span><h1>내 투자금은 얼마나 변했을까?</h1><p>{info.summary} 시작일부터 매수·매도와 손익을 이어서 기록하는 가상계좌입니다. 실제 증권사 주문은 실행하지 않습니다.</p></div>
        {account && <button type="button" className="portfolio-report-secondary" onClick={() => download(account, `${strategy}-account-backup.json`)}><Download size={16} /> 계좌 기록 다운로드</button>}</section>
      {busy && <p role="status"><RefreshCw size={15} className="spin" /> 보고서를 확인하고 거래일 순서대로 계좌를 갱신하고 있습니다.</p>}
      {error && <p role="alert" className="portfolio-report-alert">{error}</p>}
      <PortfolioPublicationStatus reportDate={day?.reportDate ?? index?.reports[0]?.reportDate} generatedAt={day?.sourceRevision ?? index?.reports.find(item => item.reportDate === (day?.reportDate ?? index.reports[0]?.reportDate))?.generatedAt} />
      <Comparison accounts={accounts} current={strategy} onSelect={select} />
      {!account && <section className="portfolio-report-card"><h2>{info.label.split(" ")[0]} 시작일 · 초기 투자금 · 현금 비중</h2><p>시작 보고서의 {info.label.split(" ")[0]} 목표 종목·비중으로 다음 미국 거래일 종가에 가상 매수합니다. 1주 미만은 매수하지 않고 현금으로 남깁니다. {strategy === "i1" ? "현금 비중을 고르면(기본 0%) 매 리밸런싱마다 총자산의 그 비율을 현금으로 두고, 나머지에 매매법의 목표 비중을 같은 비율로 적용합니다." : `${info.label}의 현금 비중은 기존 설계의 계획 현금(기본 40%)을 대신합니다. S&P 500 ETF 20%는 그대로 두고 개별 종목 합계 한도가 (80% − 현금 비중)이 되며, 종목 간 비율은 하프 켈리 계산을 따릅니다.${holdsBil(strategy) ? ` ${info.label}은 이 현금 몫(하프 켈리 미사용분 포함)을 현금 대신 단기국채 ETF(BIL)로 보유합니다.` : ""}${strategy === "h2b" ? " 시작일에는 두 묶음을 같은 시작 보고서로 계산합니다." : ""}`}{strategy !== "i1" && " I2·C1·H2b는 해당 날짜의 계산 자료(수익률)가 게시된 보고일부터 시작할 수 있습니다."}</p>
        <div className="portfolio-report-controls"><label>시작 보고일<select aria-label="시작 보고일" value={start} onChange={event => setStart(event.target.value)}>{[...(index?.reports ?? [])].sort((a, b) => a.reportDate.localeCompare(b.reportDate)).map(item => <option key={item.reportDate} value={item.reportDate}>{item.reportDate}</option>)}</select></label>
          <label>초기 투자금(USD)<input aria-label="초기 투자금(USD)" type="number" min="1" step="1" value={capital} onChange={event => setCapital(Number(event.target.value))} /></label>
          <label>현금 비중<select aria-label="현금 비중" value={reserve} onChange={event => setReserve(Number(event.target.value))}>{RESERVE_OPTIONS.map(value => <option key={value} value={value}>{`${Math.round(value * 100)}%${Math.abs(value - DEFAULT_CASH[strategy]) < 1e-9 ? " (기본 설계)" : ""}`}</option>)}</select></label>
          <button type="button" disabled={busy || !index} onClick={begin}>이 금액으로 계좌 시작</button></div>
        {legacy && strategy === "i1" && <p>이전 방식의 기록은 별도로 보존돼 있습니다. 새 계좌의 체결 내역으로 변환하지 않습니다. <button type="button" onClick={() => download(JSON.parse(legacy), "previous-portfolio-backup.json")}>이전 기록 다운로드</button></p>}</section>}
      {account && day && <>
        <div className="account-period"><strong>시작 {account.startDate} · 초기 투자금 {money(account.initialCapital)} · {reserveLabel(strategy, cashReserveOf(account))}</strong><label>계좌 조회일 <select aria-label="계좌 조회일" value={viewDate} onChange={event => setViewDate(event.target.value)}><option value="">최신 계좌</option>{[...account.days].reverse().map(item => <option key={item.reportDate} value={item.reportDate}>{item.reportDate} · 미국장 {item.marketDate}</option>)}</select></label></div>
        <p>{day.reportDate} 보고서 · 미국 {day.marketDate} 종가 기준{viewDate ? " · 해당 날짜에 저장된 보유 내역과 손익" : ""}</p>
        <section className="account-metrics" aria-label="계좌 손익 요약">
          <div><span>현재 총자산</span><strong>{money(day.equity)}</strong><small>주식·ETF 평가액 + 현금</small></div>
          <div className={day.totalPnl >= 0 ? "is-up" : "is-down"}><span>총손익 / 수익률</span><strong>{signed(day.totalPnl)}</strong><small>{pct(day.returnRate)} · 초기 투자금 대비</small></div>
          <div><span>보유 현금 / 비중</span><strong>{money(day.cash)}</strong><small>총자산의 {share(allocation(day).cash)} · 정수 매수 후 남은 금액 포함</small></div>
          <div><span>S&amp;P 500 ETF 보유 / 비중</span><strong>{money(allocation(day).ivvValue)}</strong><small>총자산의 {share(allocation(day).ivv)}</small></div>
          <div><span>실현손익</span><strong>{signed(day.realizedPnl)}</strong><small>매도로 확정된 손익</small></div>
          <div><span>평가손익</span><strong>{signed(day.unrealizedPnl)}</strong><small>보유 종목의 미확정 손익</small></div>
        </section>
        <AllocationCard day={day} strategy={strategy} reserve={cashReserveOf(account)} />
        <aside className="account-pnl-guide" aria-label="손익 계산 안내">
          <strong>총손익 = 실현손익 + 평가손익</strong>
          <p>총손익은 현재 총자산에서 초기 투자금을 뺀 금액입니다. 실현손익은 이미 매도한 주식에서 확정된 손익이고, 평가손익은 아직 보유 중인 주식의 평가액에서 매수원가를 뺀 금액입니다.</p>
          <p>예: 매도해서 번 돈이 $100이고 보유 주식의 평가손실이 $30이면 총손익은 +$70입니다. 아직 매도가 없으면 총손익과 평가손익이 같습니다.</p>
        </aside>
        <PortfolioDecisionReport days={visibleDays} releaseId={index?.releaseId} strategy={strategy} cashReserve={cashReserveOf(account)} />
        <section className="portfolio-report-card account-notice"><h2>변경사항과 다음 주문</h2>
          <p>{day.trades.length ? `미국 ${day.marketDate} 종가로 ${day.trades.length}건의 매매를 반영했습니다.` : "이 보고일에 새로 반영된 체결은 없습니다."}</p>
          {day.pending ? <><strong>{day.pending.reason}</strong><p>판단에 사용한 미국장 {day.pending.signalDate} → 체결 예정 미국장 {day.pending.executionDate}</p><p>목표 종목: {pendingWeights ? day.pending.names.map(item => `${item.ticker} ${share(item.weight ?? 0)}`).join(" · ") + ` · 계획 현금 ${share(Math.max(0, 1 - day.pending.names.reduce((sum, item) => sum + (item.weight ?? 0), 0)))}` : `${day.pending.names.map(item => item.ticker).join(" · ")} · 동일비중`}</p><p>해당 거래일 종가가 확인되는 보고서에서 정수 수량을 계산해 자동 반영합니다.</p></> : <p>현재 보유를 유지합니다. 매월 첫 보고일에 종목과 목표비중을 다시 확인합니다.{strategy === "h2b" ? ` 월중 묶음은 매월 미국장 ${H2B_MID_DAY}일 이전 마지막 거래일 종가를 기준으로 하는 보고서에서 다시 확인합니다.` : ""}</p>}
          <details><summary>누적 변경 알림 ({visibleDays.filter(item => item.trades.length || item.pending?.reportDate === item.reportDate).length})</summary>{visibleDays.filter(item => item.trades.length || item.pending?.reportDate === item.reportDate).map(item => <p key={item.reportDate}>{item.reportDate} · {item.trades.length ? `${item.trades.length}건 체결` : item.pending?.reason}</p>)}</details>
        </section>
        <section className="portfolio-report-card"><EquityChart days={visibleDays} capital={account.initialCapital} /></section>
        <section className="portfolio-report-card"><h2>보유 종목과 수익</h2><p>평균매수단가는 매수 비용을 포함합니다. 비중은 총자산(현금 포함) 대비입니다. S&amp;P 500 ETF(SPYM, IVV 대체)는 시장 코어로 따로 표시합니다.</p>
          {(day.targetNames ?? []).some(ticker => !day.holdings.some(item => item.ticker === ticker)) && <p>목표 종목 중 미보유: {(day.targetNames ?? []).filter(ticker => !day.holdings.some(item => item.ticker === ticker)).join(" · ")}. 배정금액으로 1주를 살 수 없으면 해당 금액은 현금으로 남깁니다.</p>}
          {!day.holdings.length ? <p>아직 체결된 보유 종목이 없습니다. 주문 대기 또는 1주 매수에 필요한 금액 부족으로 현금을 보유하고 있습니다.</p> : <div className="portfolio-report-table-wrap"><table><thead><tr><th>종목</th><th>구분</th><th>비중</th><th>최초 매수일 / 최근 매수일</th><th>수량</th><th>평균매수단가</th><th>기준 종가</th><th>매수원가</th><th>평가액</th><th>평가손익</th><th>수익률</th></tr></thead><tbody>
            {[...day.holdings].sort((a, b) => { const order = (t: string) => isCore(t) ? 0 : isCashEtf(t) ? 2 : 1; return order(a.ticker) - order(b.ticker) || b.value - a.value; }).map(item => <tr key={item.ticker} className={isCore(item.ticker) ? "is-core" : isCashEtf(item.ticker) ? "is-bil" : undefined}><td><strong>{item.ticker}</strong><small>{item.name}</small></td><td>{isCore(item.ticker) ? "시장 ETF(코어)" : isCashEtf(item.ticker) ? "현금 대체(단기국채 ETF)" : "개별 주식"}</td><td>{share(item.value / day.equity)}</td><td>{item.firstBuyDate}<small>{item.lastBuyDate}</small></td><td>{item.shares}주</td><td>{money(item.cost / item.shares)}</td><td>{money(item.close)}</td><td>{money(item.cost)}</td><td>{money(item.value)}</td><td className={item.pnl >= 0 ? "is-up" : "is-down"}>{signed(item.pnl)}</td><td>{pct(item.returnRate)}</td></tr>)}
            <tr className="is-cash"><td><strong>현금</strong></td><td>현금</td><td>{share(day.cash / day.equity)}</td><td colSpan={5}>—</td><td>{money(day.cash)}</td><td colSpan={2}>—</td></tr>
          </tbody></table></div>}
        </section>
        <section className="portfolio-report-card"><h2>매수·매도 내역</h2><p>매매는 가상 체결이며, 편도 거래비용 0.10%를 반영합니다. 날짜는 미국 체결 거래일입니다.</p>
          {!visibleTrades.length ? <p>체결 내역이 없습니다.</p> : <div className="portfolio-report-table-wrap"><table><thead><tr><th>체결일</th><th>종목</th><th>매매</th><th>수량</th><th>체결가</th><th>거래금액</th><th>거래비용</th><th>실현손익</th><th>변경 사유 / 판단 기준일</th></tr></thead><tbody>{[...visibleTrades].reverse().map(item => <tr key={item.id}><td>{item.executionDate}</td><td>{item.ticker}</td><td>{item.side === "BUY" ? "매수" : "매도"}</td><td>{item.shares}주</td><td>{money(item.price)}</td><td>{money(item.shares * item.price)}</td><td>{money(item.fee)}</td><td>{item.side === "SELL" ? signed(item.realizedPnl) : "—"}</td><td>{item.reason}<small>미국 {item.signalDate} 종가</small></td></tr>)}</tbody></table></div>}
        </section>
        <section className="portfolio-report-card"><h2>일별 자산 기록</h2><div className="portfolio-report-table-wrap"><table><thead><tr><th>한국 보고일</th><th>미국장 기준일</th><th>총자산</th><th>현금</th><th>현금 비중</th><th>단기국채 BIL 비중</th><th>S&amp;P 500 ETF 비중</th><th>총손익</th><th>수익률</th><th>체결</th></tr></thead><tbody>{[...visibleDays].reverse().map(item => { const mix = allocation(item); return <tr key={item.reportDate}><td><button type="button" onClick={() => setViewDate(item.reportDate)}>{item.reportDate}</button></td><td>{item.marketDate}</td><td>{money(item.equity)}</td><td>{money(item.cash)}</td><td>{share(mix.cash)}</td><td>{share(mix.bil)}</td><td>{share(mix.ivv)}</td><td>{signed(item.totalPnl)}</td><td>{pct(item.returnRate)}</td><td>{item.trades.length}건</td></tr>; })}</tbody></table></div></section>
        <button type="button" className="portfolio-report-secondary" disabled={busy} onClick={() => {
          if (!window.confirm(`현재 ${info.label.split(" ")[0]} 계좌를 백업 보관하고 새 시작일·투자금·현금 비중으로 시작할까요?`)) return;
          try { localStorage.setItem(`${accountKey(strategy)}.previous`, JSON.stringify(account)); localStorage.removeItem(accountKey(strategy)); setAccounts(previous => ({ ...previous, [strategy]: null })); setViewDate(""); }
          catch { setError("기존 계좌를 보존하지 못해 새 계좌 전환을 중단했습니다."); }
        }}>기존 계좌를 보관하고 새로 시작</button>
      </>}
      <p className="account-footnote">계좌는 이 브라우저에 매매법별로 따로 저장됩니다. 새 보고서는 날짜순으로 이어서 처리하며, 이미 기록한 체결은 새로고침으로 중복 실행하거나 과거 가격 개정으로 다시 쓰지 않습니다. 과거 보고서에 기반한 재구성 결과입니다.</p>
    </main><SiteFooter className="portfolio-report-footer" note={`정수 주식으로 추적하는 ${info.label.split(" ")[0]} 가상계좌`} />
  </div>;
}
