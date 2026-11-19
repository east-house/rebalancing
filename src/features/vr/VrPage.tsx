import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Download, RotateCcw, Scale, Upload } from "lucide-react";
import ProductTabs from "../../components/ProductTabs";
import SiteFooter from "../../components/SiteFooter";
import {
  DEFAULT_INITIAL_POOL_RATIO, VR_DEFAULT_SETTINGS, V_FORMULA_LABELS, addFill, buildOrders, closeCycle, createExistingAccount, fillTotals, overdueCycles, removeFill,
  createNewAccount, createQuickResumeAccount, currentCycle, formatOrdersText, gForWeek, poolLimitForWeek, reopenLastCycle,
  suggestInitialBuy, totalDeposits, validateSettings, valuationStatus,
  type FillSide, type OrderRow, type VBasis, type VFormula, type VrAccount, type VrCycle, type VrSettings,
} from "./vrModel";
import { fetchCloseBefore, fetchPriceHistory, todayLocal, type ReferenceClose } from "./vrPrices";
import { VrBandChart, VrPriceChart, countFills } from "./VrCharts";
import { deleteVrAccount, exportVrAccount, loadVrAccount, parseVrAccount, saveVrAccount } from "./vrStorage";
import "./vr.css";

interface Props {
  onOpenReport: () => void; onOpenPortfolio: () => void; onOpenPortfolioReport: () => void;
  onOpenTradingTestReport?: () => void; onOpenSoxlLoc?: () => void; onOpenVr?: () => void; onOpenEtfCompare: () => void;
}

const money = (value: number | null | undefined, digits = 2) => value == null ? "—" : `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const num = (value: string) => value.trim() === "" ? Number.NaN : Number(value);
const errorText = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;
const roundPct = (value: number) => Math.round(value * 100) / 100;
const clampDate = (date: string, min: string, max: string) => date < min ? min : date > max ? max : date;

type SettingsForm = Record<"ticker" | "g" | "bandPct" | "poolLimitPct" | "deposit", string> & { formula: VFormula };
const toForm = (s: VrSettings): SettingsForm => ({ ticker: s.ticker, g: String(s.g), bandPct: String(s.bandPct), poolLimitPct: String(s.poolLimitPct), deposit: String(s.deposit), formula: s.formula });
const fromForm = (f: SettingsForm): VrSettings => validateSettings({ ticker: f.ticker, g: num(f.g), bandPct: num(f.bandPct), poolLimitPct: num(f.poolLimitPct), deposit: num(f.deposit), formula: f.formula });

function SettingsFields({ form, onChange }: { form: SettingsForm; onChange: (patch: Partial<SettingsForm>) => void }) {
  return <>
    <div className="vr-fields">
      <label>종목<input value={form.ticker} onChange={(e) => onChange({ ticker: e.target.value })} /></label>
      <label>기준 G (52주마다 +1)<input type="number" min="1" step="any" value={form.g} onChange={(e) => onChange({ g: e.target.value })} /></label>
      <label>2주 적립금 (USD)<input type="number" min="0" step="any" value={form.deposit} onChange={(e) => onChange({ deposit: e.target.value })} /></label>
      <label>밴드 폭 (±%)<input type="number" min="1" max="99" step="any" value={form.bandPct} onChange={(e) => onChange({ bandPct: e.target.value })} /></label>
      <label>시작 Pool 사용 한도 (%)<input type="number" min="1" max="100" step="any" value={form.poolLimitPct} onChange={(e) => onChange({ poolLimitPct: e.target.value })} /></label>
    </div>
    <fieldset className="vr-radio">
      <legend>V 공식</legend>
      {(Object.keys(V_FORMULA_LABELS) as VFormula[]).map((key) => <label key={key}>
        <input type="radio" name="vr-formula" value={key} checked={form.formula === key} onChange={() => onChange({ formula: key })} />{V_FORMULA_LABELS[key]}
      </label>)}
    </fieldset>
  </>;
}

type SetupMode = "new" | "quick" | "existing";
const SETUP_TABS: Array<[SetupMode, string]> = [["quick", "이어가기 (평단가로)"], ["existing", "이어가기 (V를 알 때)"], ["new", "새로 시작"]];

function SetupPanel({ onCreate }: { onCreate: (account: VrAccount) => void }) {
  const [mode, setMode] = useState<SetupMode>("quick");
  const [settings, setSettings] = useState<SettingsForm>(toForm(VR_DEFAULT_SETTINGS));
  const [plan, setPlan] = useState({ principal: "", refPrice: "", ratio: String(DEFAULT_INITIAL_POOL_RATIO) });
  const [fill, setFill] = useState({ date: "", shares: "", close: "", pool: "" });
  const [existing, setExisting] = useState({ cycleStartDate: "", week: "2", previousV: "", shares: "", poolBeforeDeposit: "", previousClose: "" });
  const [quick, setQuick] = useState({ cycleStartDate: todayLocal(), week: "", shares: "", averageCost: "", referenceClose: "", pool: "0", basis: "cost" as VBasis });
  const [closeInfo, setCloseInfo] = useState<{ status: "idle" | "loading" | "ok" | "error" | "manual"; text: string }>({ status: "idle", text: "" });
  const [error, setError] = useState("");

  const suggestion = useMemo(() => {
    try { return suggestInitialBuy(num(plan.principal), num(plan.refPrice), num(plan.ratio)); } catch { return null; }
  }, [plan]);

  // 간단 이어가기: 사이클 시작일 이전 마지막 종가를 사이트 가격 API에서 채운다. 직접 고친 값은 덮어쓰지 않는다.
  const ticker = settings.ticker.trim().toUpperCase();
  const manualClose = closeInfo.status === "manual";
  useEffect(() => {
    if (mode !== "quick" || manualClose || !ticker || !/^\d{4}-\d{2}-\d{2}$/.test(quick.cycleStartDate)) return;
    let cancelled = false;
    setCloseInfo({ status: "loading", text: `${ticker} 종가를 불러오는 중…` });
    fetchCloseBefore(ticker, quick.cycleStartDate)
      .then((point) => {
        if (cancelled) return;
        setQuick((prev) => ({ ...prev, referenceClose: String(point.close) }));
        setCloseInfo({ status: "ok", text: `${point.date} 종가 자동 입력 (수정 가능)` });
      })
      .catch((cause) => { if (!cancelled) setCloseInfo({ status: "error", text: `${errorText(cause, "종가를 불러오지 못했습니다.")} 직접 입력하세요.` }); });
    return () => { cancelled = true; };
  }, [mode, ticker, quick.cycleStartDate, manualClose]);

  const quickPreview = useMemo(() => {
    if (mode !== "quick") return null;
    try {
      const account = createQuickResumeAccount(fromForm(settings), {
        cycleStartDate: quick.cycleStartDate, week: num(quick.week), shares: num(quick.shares), averageCost: num(quick.averageCost),
        referenceClose: num(quick.referenceClose), poolBeforeDeposit: num(quick.pool || "0"), basis: quick.basis,
      }, "preview");
      const cycle = account.cycles[0];
      return { cycle, status: valuationStatus(cycle, cycle.referenceClose) };
    } catch { return null; }
  }, [mode, settings, quick]);

  function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      const s = fromForm(settings);
      if (mode === "quick") {
        if (!quick.cycleStartDate) throw new Error("이번 사이클 시작일을 입력하세요.");
        onCreate(createQuickResumeAccount(s, {
          cycleStartDate: quick.cycleStartDate, week: num(quick.week), shares: num(quick.shares), averageCost: num(quick.averageCost),
          referenceClose: num(quick.referenceClose), poolBeforeDeposit: num(quick.pool || "0"), basis: quick.basis,
        }));
      } else if (mode === "new") {
        if (!fill.date) throw new Error("0일차 날짜를 입력하세요.");
        onCreate(createNewAccount(s, { date: fill.date, shares: num(fill.shares), close: num(fill.close), pool: num(fill.pool) }));
      } else {
        if (!existing.cycleStartDate) throw new Error("이번 사이클 시작일을 입력하세요.");
        onCreate(createExistingAccount(s, {
          cycleStartDate: existing.cycleStartDate, week: num(existing.week), previousV: num(existing.previousV),
          shares: num(existing.shares), poolBeforeDeposit: num(existing.poolBeforeDeposit), previousClose: num(existing.previousClose),
        }));
      }
    } catch (cause) { setError(errorText(cause, "계좌를 시작할 수 없습니다.")); }
  }

  return <section className="vr-panel" aria-labelledby="vr-setup-title">
    <h2 id="vr-setup-title">01 <span>적립식 계좌 시작</span></h2>
    <div className="vr-segment" role="tablist" aria-label="시작 방식">
      {SETUP_TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={mode === key} className={mode === key ? "is-active" : ""} onClick={() => { setMode(key); setError(""); }}>{label}</button>)}
    </div>
    <form onSubmit={submit}>
      <h3>운용 설정</h3>
      <p className="vr-hint">기본값: 기준 G 10, 밴드 ±15%, 시작 Pool 사용 한도 75%. G는 52주마다 1씩 오르고, Pool 한도는 26주차부터 26주마다 5%p 내려 최저 10%가 됩니다(시트 v5.0.4 규칙). 설정은 나중에 바꿀 수 있고 다음 사이클부터 적용됩니다.</p>
      <SettingsFields form={settings} onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))} />
      {mode === "quick" ? <>
        <h3>현재 계좌 (아는 값만)</h3>
        <p className="vr-hint">현재 주차, 보유 수량, 평단가와 위의 2주 적립금만 있으면 이어서 시작합니다. 직전 V는 모르므로 아래 기준으로 대신 정합니다. 직전 마감 종가는 사이트 가격 자료에서 자동으로 채웁니다.</p>
        <div className="vr-fields">
          <label>현재 주차<input type="number" min="1" step="1" value={quick.week} onChange={(e) => setQuick({ ...quick, week: e.target.value })} /></label>
          <label>보유 수량 (주)<input type="number" min="1" step="1" value={quick.shares} onChange={(e) => setQuick({ ...quick, shares: e.target.value })} /></label>
          <label>평단가 (USD)<input type="number" min="0" step="any" value={quick.averageCost} onChange={(e) => setQuick({ ...quick, averageCost: e.target.value })} /></label>
          <label>이번 사이클 시작일<input type="date" value={quick.cycleStartDate} onChange={(e) => setQuick({ ...quick, cycleStartDate: e.target.value })} /></label>
          <label>직전 마감 종가 (USD)<input type="number" min="0" step="any" value={quick.referenceClose} onChange={(e) => { setQuick({ ...quick, referenceClose: e.target.value }); setCloseInfo({ status: "manual", text: "직접 입력한 종가를 사용합니다." }); }} /></label>
          <label>현재 현금 Pool (모르면 0)<input type="number" min="0" step="any" value={quick.pool} onChange={(e) => setQuick({ ...quick, pool: e.target.value })} /></label>
        </div>
        {closeInfo.text && <p className={closeInfo.status === "error" ? "vr-error" : "vr-hint"} aria-live="polite">{closeInfo.text}</p>}
        <fieldset className="vr-radio">
          <legend>직전 V 대신 쓸 값</legend>
          <label><input type="radio" name="vr-basis" checked={quick.basis === "cost"} onChange={() => setQuick({ ...quick, basis: "cost" })} />평단가 기준: 보유 수량 × 평단가 (매수 원금)</label>
          <label><input type="radio" name="vr-basis" checked={quick.basis === "market"} onChange={() => setQuick({ ...quick, basis: "market" })} />평가금 기준: 보유 수량 × 직전 마감 종가 (밴드 한가운데서 다시 시작)</label>
        </fieldset>
        <p className="vr-hint">이 대체값은 원 방법론이나 시트에 있는 규칙이 아니라 직전 V를 모를 때 쓰는 근사입니다. 평단가 기준은 평가손실 중이면 바로 매수 구간, 평가이익 중이면 매도 구간에서 시작할 수 있습니다. 주차가 홀수면 다음 짝수 주차 사이클로 시작합니다. Pool을 0으로 두면 이번 사이클에는 적립금만큼만 매수할 수 있습니다.</p>
        {quickPreview && <p className="vr-suggest" aria-live="polite">
          {quickPreview.cycle.week}주차 시작 미리보기: 직전 V {money(quickPreview.cycle.previousV)} → V {money(quickPreview.cycle.v, 3)} (최소 {money(quickPreview.cycle.lower)} ~ 최대 {money(quickPreview.cycle.upper)}), G {quickPreview.cycle.g}, Pool 한도 {quickPreview.cycle.poolLimitPct}%.
          {" "}직전 종가 평가금 {money(quickPreview.status.value)} · {quickPreview.status.zone === "below" ? "V 최소 아래: 매수 구간" : quickPreview.status.zone === "above" ? "V 최대 위: 매도 구간" : "밴드 안"}
        </p>}
      </> : mode === "new" ? <>
        <h3>0일차 매수 계획 (참고)</h3>
        <p className="vr-hint">매수액 = 원금 ÷ (1 + P/V). P/V 0.15는 quantstack이 G 10에 제시한 값이며, 적립식 초기 비율은 원 방법론과 시트 모두에 정해져 있지 않습니다.</p>
        <div className="vr-fields">
          <label>원금 (USD)<input type="number" min="0" step="any" value={plan.principal} onChange={(e) => setPlan({ ...plan, principal: e.target.value })} /></label>
          <label>기준 가격 (USD)<input type="number" min="0" step="any" value={plan.refPrice} onChange={(e) => setPlan({ ...plan, refPrice: e.target.value })} /></label>
          <label>초기 P/V<input type="number" min="0" step="any" value={plan.ratio} onChange={(e) => setPlan({ ...plan, ratio: e.target.value })} /></label>
        </div>
        <p className="vr-suggest" aria-live="polite">{suggestion ? `제안: ${suggestion.shares}주 매수(${money(suggestion.cost)}), Pool ${money(suggestion.pool)}` : "원금과 기준 가격을 입력하면 제안 수량을 계산합니다."}</p>
        <h3>0일차(0주차) 결과</h3>
        <p className="vr-hint">V0 = 보유 수량 × 0일차 마감 종가(시트 방식). 첫 사이클(2주차)은 0일차 14일 뒤에 열립니다.</p>
        <div className="vr-fields">
          <label>0일차 날짜<input type="date" value={fill.date} onChange={(e) => setFill({ ...fill, date: e.target.value })} /></label>
          <label>보유 수량 (주)<input type="number" min="1" step="1" value={fill.shares} onChange={(e) => setFill({ ...fill, shares: e.target.value })} /></label>
          <label>0일차 마감 종가 (USD)<input type="number" min="0" step="any" value={fill.close} onChange={(e) => setFill({ ...fill, close: e.target.value })} /></label>
          <label>남은 현금 Pool (USD)<input type="number" min="0" step="any" value={fill.pool} onChange={(e) => setFill({ ...fill, pool: e.target.value })} /></label>
        </div>
      </> : <>
        <h3>현재 계좌</h3>
        <p className="vr-hint">직전 사이클의 V와 마감 종가, 지금의 실제 보유 수량·현금으로 이번 사이클 V를 계산합니다. 주차는 시트의 Week(2주마다 2씩 증가)입니다. Pool은 이번 적립금을 넣기 전 금액입니다.</p>
        <div className="vr-fields">
          <label>이번 사이클 시작일<input type="date" value={existing.cycleStartDate} onChange={(e) => setExisting({ ...existing, cycleStartDate: e.target.value })} /></label>
          <label>이번 사이클 주차 (짝수)<input type="number" min="2" step="2" value={existing.week} onChange={(e) => setExisting({ ...existing, week: e.target.value })} /></label>
          <label>직전 사이클 V (USD)<input type="number" min="0" step="any" value={existing.previousV} onChange={(e) => setExisting({ ...existing, previousV: e.target.value })} /></label>
          <label>직전 사이클 마감 종가 (USD)<input type="number" min="0" step="any" value={existing.previousClose} onChange={(e) => setExisting({ ...existing, previousClose: e.target.value })} /></label>
          <label>현재 보유 수량 (주)<input type="number" min="0" step="1" value={existing.shares} onChange={(e) => setExisting({ ...existing, shares: e.target.value })} /></label>
          <label>현재 Pool, 적립 전 (USD)<input type="number" min="0" step="any" value={existing.poolBeforeDeposit} onChange={(e) => setExisting({ ...existing, poolBeforeDeposit: e.target.value })} /></label>
        </div>
      </>}
      <button className="vr-primary" type="submit">계좌 시작</button>
      {error && <p className="vr-error" role="alert">{error}</p>}
    </form>
  </section>;
}

function OrderTable({ title, rows, side, onPick }: { title: string; rows: OrderRow[]; side: FillSide; onPick: (row: OrderRow, side: FillSide) => void }) {
  return <div className={`vr-orders vr-orders--${side}`}>
    <h3>{title} <small>{rows.length}줄</small></h3>
    {rows.length === 0 ? <p className="vr-hint">주문 없음</p> : <div className="vr-orders-scroll"><table>
      <thead><tr><th>순번</th><th>지정가</th><th>수량</th><th>체결 후 보유</th><th>체결 후 Pool</th><th><span className="vr-sr">체결 기록</span></th></tr></thead>
      <tbody>{rows.map((row, i) => <tr key={row.holdings}><td>{i + 1}</td><td>{money(row.price)}</td><td>1주</td><td>{row.holdings}주</td><td>{money(row.poolAfter)}</td>
        <td><button type="button" className="vr-mini" aria-label={`${title} ${i + 1}번 ${money(row.price)} 체결 기록`} onClick={() => onPick(row, side)}>체결</button></td></tr>)}</tbody>
    </table></div>}
  </div>;
}

function fillSummary(cycle: VrCycle): string {
  const t = fillTotals(cycle);
  if (t.count === 0) return "—";
  return [t.buyQuantity ? `매수 ${t.buyQuantity}` : "", t.sellQuantity ? `매도 ${t.sellQuantity}` : ""].filter(Boolean).join(" · ");
}

function formulaExplain(cycle: VrCycle): string {
  const base = `직전 V ${money(cycle.previousV, 3)} + Pool ${money(cycle.poolBeforeDeposit)} ÷ ${cycle.g}`;
  if (cycle.formula === "basic") return `V = ${base} + 적립금 ${money(cycle.deposit)} (기본 공식)`;
  return `V = ${base} + (직전 마감 평가금 ${money(cycle.previousValuation)} − 직전 V) ÷ 2√${cycle.g} + 적립금 ${money(cycle.deposit)} (실력공식)`;
}

function AccountView({ account, onChange, onReset }: { account: VrAccount; onChange: (next: VrAccount) => void; onReset: () => void }) {
  const cycle = currentCycle(account);
  const orders = useMemo(() => buildOrders(cycle), [cycle]);
  const [refPrice, setRefPrice] = useState("");
  const [closeForm, setCloseForm] = useState({ shares: String(cycle.shares), pool: "", price: "" });
  const [settings, setSettings] = useState<SettingsForm>(toForm(account.settings));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [history, setHistory] = useState<{ status: "loading" | "ready" | "error"; prices: ReferenceClose[] }>({ status: "loading", prices: [] });
  const ticker = account.settings.ticker;
  useEffect(() => {
    let alive = true;
    setHistory({ status: "loading", prices: [] });
    fetchPriceHistory(ticker).then((prices) => { if (alive) setHistory({ status: "ready", prices }); }).catch(() => { if (alive) setHistory({ status: "error", prices: [] }); });
    return () => { alive = false; };
  }, [ticker]);
  const latest = history.prices.at(-1);
  const today = todayLocal();
  const totals = useMemo(() => fillTotals(cycle), [cycle]);
  const overdue = overdueCycles(cycle, today);
  // 사이클이 끝났으면 종료일 이전 마지막 종가를 마감 종가로 제안한다.
  const endClose = useMemo(() => overdue > 0 ? [...history.prices].reverse().find((p) => p.date >= cycle.startDate && p.date <= cycle.endDate) : undefined, [overdue, history.prices, cycle.startDate, cycle.endDate]);
  const [fillForm, setFillForm] = useState({ date: clampDate(today, cycle.startDate, cycle.endDate), side: "buy" as FillSide, price: "", quantity: "1" });
  useEffect(() => { setRefPrice(""); setFillForm((f) => ({ ...f, date: clampDate(todayLocal(), cycle.startDate, cycle.endDate), price: "", quantity: "1" })); }, [cycle.index, cycle.startDate, cycle.endDate]);
  useEffect(() => {
    setCloseForm({ shares: String(totals.shares), pool: String(totals.pool), price: endClose ? String(endClose.close) : "" });
  }, [cycle.index, totals.shares, totals.pool, endClose]);

  const check = useMemo(() => {
    const manual = num(refPrice);
    const price = Number.isFinite(manual) && manual > 0 ? manual : latest?.close;
    if (price == null || totals.shares === 0) return null;
    return { price, source: Number.isFinite(manual) && manual > 0 ? "입력한 가격" : `${latest!.date} 종가`, ...valuationStatus({ ...cycle, shares: totals.shares }, price), fills: countFills(orders, price) };
  }, [cycle, orders, refPrice, latest, totals.shares]);
  const nextWeek = cycle.week + 2;
  const nextG = gForWeek(account.settings.g, nextWeek);
  const nextLimit = poolLimitForWeek(account.settings.poolLimitPct, nextWeek);

  function close(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      onChange(closeCycle(account, { shares: num(closeForm.shares), pool: num(closeForm.pool), price: num(closeForm.price) }));
      setMessage(`${cycle.week}주차 사이클을 마감하고 ${nextWeek}주차 사이클을 열었습니다.`);
    } catch (cause) { setError(errorText(cause, "사이클을 마감할 수 없습니다.")); }
  }
  function recordFill(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      onChange(addFill(account, { date: fillForm.date, side: fillForm.side, price: num(fillForm.price), quantity: num(fillForm.quantity) }));
      setMessage(`${fillForm.date} ${fillForm.side === "buy" ? "매수" : "매도"} ${fillForm.quantity}주 × ${money(num(fillForm.price))} 체결을 기록했습니다.`);
      setFillForm((f) => ({ ...f, price: "", quantity: "1" }));
    } catch (cause) { setError(errorText(cause, "체결을 기록할 수 없습니다.")); }
  }
  function deleteFill(id: string) {
    setError(""); onChange(removeFill(account, id)); setMessage("체결 기록을 삭제했습니다.");
  }
  function pickOrder(row: OrderRow, side: FillSide) {
    setFillForm((f) => ({ ...f, side, price: String(row.price), quantity: "1" }));
    document.getElementById("vr-fills-title")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }
  function saveSettings(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try { onChange({ ...account, settings: fromForm(settings) }); setMessage("설정을 저장했습니다. 다음 사이클부터 적용됩니다."); }
    catch (cause) { setError(errorText(cause, "설정을 저장할 수 없습니다.")); }
  }
  function undo() {
    if (!window.confirm("직전 마감을 취소하고 그 사이클을 다시 열까요? 현재 열린 사이클은 지워집니다.")) return;
    try { onChange(reopenLastCycle(account)); setMessage("직전 마감을 취소했습니다."); } catch (cause) { setError(errorText(cause, "되돌릴 수 없습니다.")); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(formatOrdersText(account.settings.ticker, cycle, orders)); setMessage("주문표를 복사했습니다."); }
    catch { setMessage("복사할 수 없습니다. 화면의 주문표를 직접 확인하세요."); }
  }

  return <>
    {overdue > 0 && <div className="vr-due" role="status">
      <strong>{cycle.week}주차 사이클이 {cycle.endDate}에 끝났습니다.</strong>
      <span>{overdue > 1 ? `오늘까지 ${overdue}개 사이클이 지났습니다. 마감할 때마다 다음 사이클이 하나씩 열리니 차례로 마감하세요. ` : ""}06에서 마감 값을 확인하고 "사이클 마감"을 누르면 {nextWeek}주차 V와 주문표가 만들어집니다.</span>
      <a href="#vr-close-title">마감하러 가기</a>
    </div>}
    <section className="vr-panel" aria-labelledby="vr-guide-title">
      <h2 id="vr-guide-title">01 <span>2주 사용 순서</span></h2>
      <ol className="vr-steps">
        <li><strong>시작일 {cycle.startDate}</strong><span>적립금 {money(cycle.deposit)}을 입금합니다. 02의 V와 Pool은 이 입금을 포함한 값입니다.</span></li>
        <li><strong>주문 걸기</strong><span>04 주문표의 매수·매도 가격을 증권사에 1주씩 지정가로 걸어 둡니다(주문표 복사 버튼). 증권사 주문이 당일만 유효하면 거래일마다 다시 겁니다.</span></li>
        <li><strong>2주 동안</strong><span>체결되면 05에 체결가·수량을 기록합니다(주문표의 "체결" 버튼으로 가격 입력). 보유 수량과 Pool이 자동 계산되어 02·03에 반영됩니다.</span></li>
        <li><strong>{cycle.endDate} 장 마감 후</strong><span>2주는 자동으로 넘어가지 않습니다. 06에 미리 채워진 값을 증권사 잔고와 맞춰 보고 "사이클 마감"을 누르면 다음 사이클이 열립니다.</span></li>
      </ol>
    </section>

    <section className="vr-panel" aria-labelledby="vr-cycle-title">
      <h2 id="vr-cycle-title">02 <span>{cycle.week}주차 · {cycle.startDate} ~ {cycle.endDate}</span></h2>
      <dl className="vr-stats">
        <div><dt>V (목표 평가금)</dt><dd>{money(cycle.v, 3)}</dd></div>
        <div><dt>V 최소 / 최대</dt><dd>{money(cycle.lower)} / {money(cycle.upper)}</dd></div>
        <div><dt>보유 수량{totals.count > 0 ? " (체결 반영)" : ""}</dt><dd>{totals.shares}주{totals.count > 0 && <small> (시작 {cycle.shares}주)</small>}</dd></div>
        <div><dt>{totals.count > 0 ? "현재 Pool (체결 반영)" : "시작일 Pool (적립 후)"}</dt><dd>{money(totals.pool)}{totals.count > 0 && <small> (시작 {money(cycle.pool)})</small>}</dd></div>
        <div><dt>Pool 사용 한도</dt><dd>{money(cycle.poolCap)} <small>({cycle.poolLimitPct}%)</small></dd></div>
        <div><dt>G · 적립금</dt><dd>{cycle.g} · {money(cycle.deposit)}</dd></div>
      </dl>
      <p className="vr-hint">{formulaExplain(cycle)}.</p>
      <p className="vr-hint">다음 {nextWeek}주차: G {nextG}, Pool 사용 한도 {nextLimit}%{nextG !== cycle.g || nextLimit !== cycle.poolLimitPct ? " (변경됨)" : ""}.</p>
      <h3>지금 밴드 위치</h3>
      <p className="vr-hint">평가금(보유 {totals.shares}주 × 가격)이 V 최소보다 낮으면 매수 주문이, V 최대보다 높으면 매도 주문이 체결되는 가격입니다. 주문을 걸어 두었다면 따로 할 일은 없습니다.</p>
      <div className="vr-check">
        {check
          ? <p className={`vr-zone vr-zone--${check.zone}`}>{check.source} {money(check.price)} × {totals.shares}주 = 평가금 {money(check.value)} · {check.zone === "below" ? `V 최소 아래: 주문표 매수 ${check.fills.buys}줄까지 체결되는 가격` : check.zone === "above" ? `V 최대 위: 주문표 매도 ${check.fills.sells}줄까지 체결되는 가격` : "밴드 안: 체결 없음"}</p>
          : <p className="vr-zone">{history.status === "loading" ? "최근 종가를 불러오는 중입니다." : "최근 종가를 불러오지 못했습니다. 오른쪽에 가격을 넣어 확인하세요."}</p>}
        <label>다른 가격으로 확인 (선택, USD)<input type="number" min="0" step="any" value={refPrice} placeholder={latest ? String(latest.close) : ""} onChange={(e) => setRefPrice(e.target.value)} /></label>
      </div>
    </section>

    <section className="vr-panel" aria-labelledby="vr-chart-title">
      <h2 id="vr-chart-title">03 <span>그래프</span></h2>
      {history.status === "error" && <p className="vr-hint">종가 데이터를 불러오지 못해 V 밴드만 표시합니다.</p>}
      <h3>V 밴드와 평가금</h3>
      <p className="vr-hint">회색 띠가 사이클별 V 최소~최대, 진한 선이 V입니다. 파란 선(평가금)이 띠 아래로 내려가면 매수, 위로 올라가면 매도가 체결됩니다. 평가금은 (사이클 시작 수량 + 그날까지 기록한 체결) × 종가입니다. 체결을 기록하지 않은 사이클은 시작 수량으로 그립니다. 가격 데이터는 최근 약 1년치입니다.</p>
      <VrBandChart cycles={account.cycles} prices={history.prices} />
      <h3>최근 종가와 이번 주문 가격</h3>
      <p className="vr-hint">녹색 선이 매수 지정가, 주황 선이 매도 지정가이고, 기록한 체결은 점으로 표시합니다. 종가가 녹색 선 아래로 내려가면 그 줄의 매수가, 주황 선 위로 올라가면 매도가 체결됩니다.</p>
      {history.status === "ready" ? <VrPriceChart cycle={cycle} orders={orders} prices={history.prices} /> : <p className="vr-hint">{history.status === "loading" ? "종가를 불러오는 중입니다." : "종가 데이터가 없어 가격 그래프를 그릴 수 없습니다."}</p>}
    </section>

    <section className="vr-panel" aria-labelledby="vr-orders-title">
      <h2 id="vr-orders-title">04 <span>{cycle.week}주차 예약 주문표 · 지정가 1주씩</span></h2>
      <p className="vr-hint">
        시트 v5.0.4 규칙입니다. 매수 k번째는 V 최소 ÷ (보유 + k − 1), 매도 k번째는 V 최대 ÷ (보유 − k + 1)이며 1주씩 지정가 잔량 주문으로 사이클 끝까지 걸어 둡니다.
        매수는 매수 후 Pool이 {money(cycle.poolReserve)}(시작일 Pool × {roundPct(100 - cycle.poolLimitPct)}%) 이상이고 단가가 {money(orders.buyPriceFloor)}(직전 마감 종가 × 60%) 이상인 줄까지 만든 뒤 1줄을 더합니다. 매도는 1주가 남을 때까지 제한 없이 만듭니다.
        시트는 단가를 반올림하지 않으므로, 여기서는 매수가를 센트 단위로 내리고 매도가를 올립니다.
      </p>
      {cycle.shares === 0 && <p className="vr-error">보유 수량이 0주라 주문표를 만들 수 없습니다.</p>}
      <div className="vr-order-grid">
        <OrderTable title="매수" rows={orders.buys} side="buy" onPick={pickOrder} />
        <OrderTable title="매도" rows={orders.sells} side="sell" onPick={pickOrder} />
      </div>
      <button type="button" className="vr-secondary" onClick={() => void copy()}>주문표 복사</button>
    </section>

    <section className="vr-panel" aria-labelledby="vr-fills-title">
      <h2 id="vr-fills-title">05 <span>체결 기록 · {cycle.week}주차</span></h2>
      <p className="vr-hint">증권사에서 체결된 매수·매도를 기록합니다. 04 주문표의 "체결" 버튼을 누르면 가격이 채워집니다. 기록은 선택 사항이며, 기록하면 보유 수량·Pool이 자동 계산되어 06 마감 칸에 채워집니다. 수수료·세금은 반영하지 않습니다.</p>
      <form onSubmit={recordFill}>
        <div className="vr-fields vr-fields--fill">
          <label>체결일<input type="date" min={cycle.startDate} max={cycle.endDate} value={fillForm.date} onChange={(e) => setFillForm({ ...fillForm, date: e.target.value })} /></label>
          <label>구분<select value={fillForm.side} onChange={(e) => setFillForm({ ...fillForm, side: e.target.value as FillSide })}><option value="buy">매수</option><option value="sell">매도</option></select></label>
          <label>체결가 (USD)<input type="number" min="0" step="any" value={fillForm.price} onChange={(e) => setFillForm({ ...fillForm, price: e.target.value })} /></label>
          <label>체결 수량 (주)<input type="number" min="1" step="1" value={fillForm.quantity} onChange={(e) => setFillForm({ ...fillForm, quantity: e.target.value })} /></label>
        </div>
        <button className="vr-secondary" type="submit">체결 추가</button>
      </form>
      {totals.count === 0 ? <p className="vr-hint">이번 사이클에 기록한 체결이 없습니다.</p> : <>
        <div className="vr-table-wrap"><table className="vr-ledger vr-fills">
          <thead><tr><th>체결일</th><th>구분</th><th>체결가</th><th>수량</th><th>금액</th><th><span className="vr-sr">삭제</span></th></tr></thead>
          <tbody>{(cycle.fills ?? []).map((f) => <tr key={f.id}>
            <td>{f.date}</td><td className={`vr-side vr-side--${f.side}`}>{f.side === "buy" ? "매수" : "매도"}</td><td>{money(f.price)}</td><td>{f.quantity}주</td><td>{money(f.price * f.quantity)}</td>
            <td><button type="button" className="vr-mini" aria-label={`${f.date} ${f.side === "buy" ? "매수" : "매도"} ${money(f.price)} 기록 삭제`} onClick={() => deleteFill(f.id)}>삭제</button></td>
          </tr>)}</tbody>
        </table></div>
        <p className="vr-fill-sum">매수 {totals.buyQuantity}주 {money(totals.buyAmount)} · 매도 {totals.sellQuantity}주 {money(totals.sellAmount)} → 보유 {totals.shares}주 · Pool {money(totals.pool)}</p>
      </>}
    </section>

    <section className="vr-panel" aria-labelledby="vr-close-title">
      <h2 id="vr-close-title">06 <span>사이클 마감 · 다음 사이클 열기</span></h2>
      <p className="vr-hint">2주가 지나도 자동으로 넘어가지 않습니다. {cycle.endDate} 이전 마지막 거래일 장 마감 후 증권사의 실제 잔고를 확인하고 이 버튼을 눌러야 다음 사이클이 열립니다. Pool은 다음 적립금을 넣기 전 현금입니다.</p>
      <p className="vr-hint">미리 채운 값: 보유 수량·Pool은 {totals.count > 0 ? `05 체결 기록 ${totals.count}건 기준 계산값` : "체결 기록이 없어 사이클 시작 값 그대로"}, 마감 종가는 {endClose ? `${endClose.date} 종가` : "사이클이 끝나면 자동 입력"}입니다. 증권사 잔고와 다르면 고쳐서 마감하세요.</p>
      <form onSubmit={close}>
        <div className="vr-fields">
          <label>마감 보유 수량 (주)<input type="number" min="0" step="1" value={closeForm.shares} onChange={(e) => setCloseForm({ ...closeForm, shares: e.target.value })} /></label>
          <label>마감 Pool, 적립 전 (USD)<input type="number" min="0" step="any" value={closeForm.pool} onChange={(e) => setCloseForm({ ...closeForm, pool: e.target.value })} /></label>
          <label>마감 종가 (USD)<input type="number" min="0" step="any" value={closeForm.price} onChange={(e) => setCloseForm({ ...closeForm, price: e.target.value })} /></label>
        </div>
        <button className="vr-primary" type="submit">사이클 마감</button>
      </form>
      {account.cycles.length > 1 && <button type="button" className="vr-link" onClick={undo}><RotateCcw size={14} /> 직전 마감 취소</button>}
    </section>

    {(message || error) && <p className={error ? "vr-error" : "vr-message"} role={error ? "alert" : "status"}>{error || message}</p>}

    <section className="vr-panel" aria-labelledby="vr-ledger-title">
      <h2 id="vr-ledger-title">07 <span>사이클 원장</span></h2>
      <p className="vr-hint">시작 {account.start.date} · {account.start.kind === "new" ? `0일차 ${account.start.shares}주 × 종가 ${money(account.start.price)} = V0 ${money(account.start.v0)}, Pool ${money(account.start.pool)}` : account.start.kind === "quick" ? `${account.start.shares}주 · 평단가 ${money(account.start.averageCost)} · 직전 종가 ${money(account.start.price)}로 이어받음, 직전 V 대체값 ${money(account.start.v0)}(${account.start.basis === "market" ? "평가금" : "평단가"} 기준)` : `이어받은 직전 V ${money(account.start.v0, 3)}`} · 누적 적립금 {money(totalDeposits(account))}</p>
      <div className="vr-table-wrap"><table className="vr-ledger">
        <thead><tr><th>주차</th><th>시작일</th><th>공식</th><th>G</th><th>V</th><th>V 최소~최대</th><th>시작 수량</th><th>Pool(적립 후)</th><th>체결 기록</th><th>마감 수량</th><th>마감 Pool</th><th>마감 종가</th><th>마감 평가금</th><th>총자산</th></tr></thead>
        <tbody>{[...account.cycles].reverse().map((c) => {
          const value = c.close ? c.close.shares * c.close.price : null;
          return <tr key={c.index}>
            <td>{c.week}{c.close ? "" : " (진행)"}</td><td>{c.startDate}</td><td>{c.formula === "basic" ? "기본" : "실력"}</td><td>{c.g}</td><td>{money(c.v, 3)}</td>
            <td>{money(c.lower)}~{money(c.upper)}</td><td>{c.shares}</td><td>{money(c.pool)}</td><td>{fillSummary(c)}</td><td>{c.close?.shares ?? "—"}</td>
            <td>{money(c.close?.pool)}</td><td>{money(c.close?.price)}</td><td>{money(value)}</td><td>{money(value == null ? null : value + c.close!.pool)}</td>
          </tr>;
        })}</tbody>
      </table></div>
    </section>

    <section className="vr-panel" aria-labelledby="vr-settings-title">
      <h2 id="vr-settings-title">08 <span>설정 변경</span></h2>
      <form onSubmit={saveSettings}>
        <SettingsFields form={settings} onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))} />
        <button className="vr-secondary" type="submit">설정 저장</button>
      </form>
      <button type="button" className="vr-link vr-danger" onClick={onReset}>이 브라우저의 VR 기록 삭제</button>
    </section>
  </>;
}


export default function VrPage(props: Props) {
  const [account, setAccount] = useState<VrAccount | null>(() => loadVrAccount());
  const [storageNote, setStorageNote] = useState("");

  function update(next: VrAccount) {
    setAccount(next);
    setStorageNote(saveVrAccount(next) ? "" : "브라우저 저장소에 저장하지 못했습니다. JSON 백업을 내려받아 두세요.");
  }
  function reset() {
    if (!window.confirm("이 브라우저에 저장된 VR 계좌 기록을 모두 삭제할까요? 먼저 JSON 백업을 권장합니다.")) return;
    deleteVrAccount(); setAccount(null);
  }
  function download() {
    if (!account) return;
    const url = URL.createObjectURL(new Blob([exportVrAccount(account)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `vr-${account.settings.ticker}-${currentCycle(account).startDate}.json`;
    link.click(); URL.revokeObjectURL(url);
  }
  async function importFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 2_000_000) { setStorageNote("백업 파일은 2MB 이하여야 합니다."); return; }
    const parsed = parseVrAccount(await file.text());
    if (!parsed) { setStorageNote("VR 백업 파일 형식이 아닙니다."); return; }
    if (account && !window.confirm("현재 기록을 백업 파일 내용으로 바꿀까요?")) return;
    update(parsed); setStorageNote("백업을 불러왔습니다.");
  }

  return <div className="vr-page">
    <header className="vr-topbar"><a className="vr-brand" href="/"><Scale size={22} /><strong>TM Reports</strong></a><ProductTabs current="vr" {...props} /></header>
    <main className="vr-main">
      <div className="vr-intro"><div><p className="vr-eyebrow">VALUE REBALANCING · 적립식</p><h1>라오어 VR 적립식</h1><p>2주마다 V를 올리고, 밴드를 벗어날 때 체결되는 1주 단위 예약 주문표를 만듭니다.</p></div><span className="vr-chip">브라우저에만 저장</span></div>
      <div className="vr-notice"><strong>계산 기준과 한계</strong><p>기본 V 공식은 비공식 해설(quantstack.app/vr), 실력공식·주문표·Pool 한도 감소·G 상향은 구글 시트 "VR 5.0.4 실력공식(글로벌커머스)"의 규칙을 따릅니다. 둘 다 라오어 카페 원문과 대조하지 않았습니다. 주문 전송·체결 확인 기능은 없으며, 계좌 기록은 이 브라우저에만 저장되고 서버로 전송되지 않습니다.</p></div>
      <div className="vr-backup">
        <span>{account ? `저장된 계좌: ${account.settings.ticker} · ${currentCycle(account).week}주차 진행 중` : "저장된 계좌가 없습니다."}</span>
        <div>
          {account && <button type="button" className="vr-secondary" onClick={download}><Download size={14} /> JSON 백업</button>}
          <label className="vr-secondary vr-upload"><Upload size={14} /> 백업 불러오기<input type="file" accept=".json,application/json" aria-label="VR 백업 불러오기" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
        </div>
      </div>
      {storageNote && <p className="vr-message" role="status">{storageNote}</p>}
      {account ? <AccountView account={account} onChange={update} onReset={reset} /> : <SetupPanel onCreate={update} />}
    </main><SiteFooter />
  </div>;
}
