import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronDown, ClipboardCheck, Download, Flag, ListChecks, RotateCcw, Scale, Upload, Wallet } from "lucide-react";
import ProductTabs from "../../components/ProductTabs";
import SiteFooter from "../../components/SiteFooter";
import {
  DEFAULT_INITIAL_POOL_RATIO, VR_DEFAULT_SETTINGS, V_FORMULA_LABELS, addFill, buildOrders, closeCycle, costBasis, createExistingAccount, fillTotals, overdueCycles, removeFill,
  rescheduleCurrentCycle, setCurrentAverageCost, startingCapital, firstRealIndex, hasEstimatedHistory, removeEstimatedHistory,
  createNewAccount, createQuickResumeAccount, currentCycle, filledRows, formatOrdersText, remainingOrders, gForWeek, poolLimitForWeek, reopenLastCycle,
  suggestInitialBuy, totalDeposits, validateSettings, valuationStatus,
  type FillSide, type OrderRow, type VBasis, type VFormula, type VrAccount, type VrCycle, type VrSettings,
} from "./vrModel";
import { fetchCloseBefore, fetchPriceHistory, todayLocal, type ReferenceClose } from "./vrPrices";
import { VrPriceBandChart, countFills } from "./VrCharts";
import { calibrateBacktest, estimatePrincipal, mergeHistory, week0DateFor, type CalibratedBacktest } from "./vrBacktest";
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
  const [existing, setExisting] = useState({ cycleStartDate: "", week: "2", previousV: "", shares: "", poolBeforeDeposit: "", previousClose: "", averageCost: "" });
  const [quick, setQuick] = useState({ cycleStartDate: todayLocal(), week: "", shares: "", averageCost: "", referenceClose: "", pool: "0", basis: "cost" as VBasis });
  const [closeInfo, setCloseInfo] = useState<{ status: "idle" | "loading" | "ok" | "error" | "manual"; text: string }>({ status: "idle", text: "" });
  const [error, setError] = useState("");

  const suggestion = useMemo(() => {
    try { return suggestInitialBuy(num(plan.principal), num(plan.refPrice), num(plan.ratio)); } catch { return null; }
  }, [plan]);

  // 간단 이어가기: 직전 마감 종가는 사이클 시작일 이전 마지막 종가를 사이트 가격 API에서 자동으로 쓴다.
  // 가격을 불러오지 못했을 때만 직접 입력 칸을 연다.
  const ticker = settings.ticker.trim().toUpperCase();
  const closeEditable = closeInfo.status === "error" || closeInfo.status === "manual";
  useEffect(() => {
    if (mode !== "quick" || !ticker || !/^\d{4}-\d{2}-\d{2}$/.test(quick.cycleStartDate)) return;
    let cancelled = false;
    setQuick((prev) => ({ ...prev, referenceClose: "" }));
    setCloseInfo({ status: "loading", text: `${ticker} 종가를 불러오는 중…` });
    fetchCloseBefore(ticker, quick.cycleStartDate)
      .then((point) => {
        if (cancelled) return;
        setQuick((prev) => ({ ...prev, referenceClose: String(point.close) }));
        setCloseInfo({ status: "ok", text: `${point.date} 종가 자동 입력` });
      })
      .catch((cause) => { if (!cancelled) setCloseInfo({ status: "error", text: `${errorText(cause, "종가를 불러오지 못했습니다.")} 직접 입력하세요.` }); });
    return () => { cancelled = true; };
  }, [mode, ticker, quick.cycleStartDate]);

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
          ...(existing.averageCost.trim() ? { averageCost: num(existing.averageCost) } : {}),
        }));
      }
    } catch (cause) { setError(errorText(cause, "계좌를 시작할 수 없습니다.")); }
  }

  return <section className="vr-panel" aria-labelledby="vr-setup-title">
    <h2 id="vr-setup-title">적립식 계좌 시작</h2>
    <div className="vr-segment" role="tablist" aria-label="시작 방식">
      {SETUP_TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={mode === key} className={mode === key ? "is-active" : ""} onClick={() => { setMode(key); setError(""); }}>{label}</button>)}
    </div>
    <form onSubmit={submit}>
      <h3>운용 설정</h3>
      <Help><p>기본값: 기준 G 10, 밴드 ±15%, 시작 Pool 사용 한도 75%. G는 52주마다 1씩 오르고, Pool 한도는 26주차부터 26주마다 5%p 내려 최저 10%가 됩니다(시트 v5.0.4 규칙). 설정은 나중에 바꿀 수 있고 다음 사이클부터 적용됩니다.</p></Help>
      <SettingsFields form={settings} onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))} />
      {mode === "quick" ? <>
        <h3>현재 계좌 (아는 값만)</h3>
        <Help><p>현재 주차, 보유 수량, 평단가와 위의 2주 적립금만 있으면 이어서 시작합니다. 이번 주차 시작일은 오늘이 아니라 이번 2주가 시작된 날(예: 시트의 주차 시작 일요일)을 넣으세요. 직전 V는 모르므로 아래 기준으로 대신 정합니다. 직전 마감 종가는 이번 주차 시작일 전날까지의 마지막 종가를 사이트 가격 자료에서 자동으로 씁니다.</p></Help>
        <div className="vr-fields">
          <label>현재 주차<input type="number" min="1" step="1" value={quick.week} onChange={(e) => setQuick({ ...quick, week: e.target.value })} /></label>
          <label>보유 수량 (주)<input type="number" min="1" step="1" value={quick.shares} onChange={(e) => setQuick({ ...quick, shares: e.target.value })} /></label>
          <label>평단가 (USD)<input type="number" min="0" step="any" value={quick.averageCost} onChange={(e) => setQuick({ ...quick, averageCost: e.target.value })} /></label>
          <label>이번 주차 시작일<input type="date" value={quick.cycleStartDate} onChange={(e) => setQuick({ ...quick, cycleStartDate: e.target.value })} /></label>
          <label>직전 마감 종가 (USD){closeEditable
            ? <input type="number" min="0" step="any" value={quick.referenceClose} onChange={(e) => { setQuick({ ...quick, referenceClose: e.target.value }); setCloseInfo({ status: "manual", text: "가격 자료가 없어 직접 입력한 종가를 사용합니다." }); }} />
            : <input type="number" className="is-auto" readOnly tabIndex={-1} value={quick.referenceClose} placeholder="자동" />}</label>
          <label>현재 현금 Pool (모르면 0)<input type="number" min="0" step="any" value={quick.pool} onChange={(e) => setQuick({ ...quick, pool: e.target.value })} /></label>
        </div>
        {closeInfo.text && <p className={closeInfo.status === "error" ? "vr-error" : "vr-hint"} aria-live="polite">{closeInfo.text}</p>}
        <fieldset className="vr-radio">
          <legend>직전 V 대신 쓸 값</legend>
          <label><input type="radio" name="vr-basis" checked={quick.basis === "cost"} onChange={() => setQuick({ ...quick, basis: "cost" })} />평단가 기준: 보유 수량 × 평단가 (매수 원금)</label>
          <label><input type="radio" name="vr-basis" checked={quick.basis === "market"} onChange={() => setQuick({ ...quick, basis: "market" })} />평가금 기준: 보유 수량 × 직전 마감 종가 (밴드 한가운데서 다시 시작)</label>
        </fieldset>
        <Help><p>이 대체값은 원 방법론이나 시트에 있는 규칙이 아니라 직전 V를 모를 때 쓰는 근사입니다. 평단가 기준은 평가손실 중이면 바로 매수 구간, 평가이익 중이면 매도 구간에서 시작할 수 있습니다. 주차가 홀수면 다음 짝수 주차 사이클로 시작합니다. Pool을 0으로 두면 이번 사이클에는 적립금만큼만 매수할 수 있습니다.</p></Help>
        {quickPreview && <p className="vr-suggest" aria-live="polite">
          {quickPreview.cycle.week}주차 시작 미리보기: 직전 V {money(quickPreview.cycle.previousV)} → V {money(quickPreview.cycle.v, 3)} (최소 {money(quickPreview.cycle.lower)} ~ 최대 {money(quickPreview.cycle.upper)}), G {quickPreview.cycle.g}, Pool 한도 {quickPreview.cycle.poolLimitPct}%.
          {" "}직전 종가 평가금 {money(quickPreview.status.value)} · {quickPreview.status.zone === "below" ? "V 최소 아래: 매수 구간" : quickPreview.status.zone === "above" ? "V 최대 위: 매도 구간" : "밴드 안"}
        </p>}
      </> : mode === "new" ? <>
        <h3>0일차 매수 계획 (참고)</h3>
        <Help><p>매수액 = 원금 ÷ (1 + P/V). P/V 0.15는 quantstack이 G 10에 제시한 값이며, 적립식 초기 비율은 원 방법론과 시트 모두에 정해져 있지 않습니다.</p></Help>
        <div className="vr-fields">
          <label>원금 (USD)<input type="number" min="0" step="any" value={plan.principal} onChange={(e) => setPlan({ ...plan, principal: e.target.value })} /></label>
          <label>기준 가격 (USD)<input type="number" min="0" step="any" value={plan.refPrice} onChange={(e) => setPlan({ ...plan, refPrice: e.target.value })} /></label>
          <label>초기 P/V<input type="number" min="0" step="any" value={plan.ratio} onChange={(e) => setPlan({ ...plan, ratio: e.target.value })} /></label>
        </div>
        <p className="vr-suggest" aria-live="polite">{suggestion ? `제안: ${suggestion.shares}주 매수(${money(suggestion.cost)}), Pool ${money(suggestion.pool)}` : "원금과 기준 가격을 입력하면 제안 수량을 계산합니다."}</p>
        <h3>0일차(0주차) 결과</h3>
        <Help><p>V0 = 보유 수량 × 0일차 마감 종가(시트 방식). 첫 사이클(2주차)은 0일차 14일 뒤에 열립니다.</p></Help>
        <div className="vr-fields">
          <label>0일차 날짜<input type="date" value={fill.date} onChange={(e) => setFill({ ...fill, date: e.target.value })} /></label>
          <label>보유 수량 (주)<input type="number" min="1" step="1" value={fill.shares} onChange={(e) => setFill({ ...fill, shares: e.target.value })} /></label>
          <label>0일차 마감 종가 (USD)<input type="number" min="0" step="any" value={fill.close} onChange={(e) => setFill({ ...fill, close: e.target.value })} /></label>
          <label>남은 현금 Pool (USD)<input type="number" min="0" step="any" value={fill.pool} onChange={(e) => setFill({ ...fill, pool: e.target.value })} /></label>
        </div>
      </> : <>
        <h3>현재 계좌</h3>
        <Help><p>직전 사이클의 V와 마감 종가, 지금의 실제 보유 수량·현금으로 이번 사이클 V를 계산합니다. 주차는 시트의 Week(2주마다 2씩 증가)입니다. Pool은 이번 적립금을 넣기 전 금액입니다.</p></Help>
        <div className="vr-fields">
          <label>이번 사이클 시작일<input type="date" value={existing.cycleStartDate} onChange={(e) => setExisting({ ...existing, cycleStartDate: e.target.value })} /></label>
          <label>이번 사이클 주차 (짝수)<input type="number" min="2" step="2" value={existing.week} onChange={(e) => setExisting({ ...existing, week: e.target.value })} /></label>
          <label>직전 사이클 V (USD)<input type="number" min="0" step="any" value={existing.previousV} onChange={(e) => setExisting({ ...existing, previousV: e.target.value })} /></label>
          <label>직전 사이클 마감 종가 (USD)<input type="number" min="0" step="any" value={existing.previousClose} onChange={(e) => setExisting({ ...existing, previousClose: e.target.value })} /></label>
          <label>현재 보유 수량 (주)<input type="number" min="0" step="1" value={existing.shares} onChange={(e) => setExisting({ ...existing, shares: e.target.value })} /></label>
          <label>현재 Pool, 적립 전 (USD)<input type="number" min="0" step="any" value={existing.poolBeforeDeposit} onChange={(e) => setExisting({ ...existing, poolBeforeDeposit: e.target.value })} /></label>
          <label>현재 평단가 (선택, USD)<input type="number" min="0" step="any" value={existing.averageCost} onChange={(e) => setExisting({ ...existing, averageCost: e.target.value })} /></label>
        </div>
      </>}
      <button className="vr-primary" type="submit">계좌 시작</button>
      {error && <p className="vr-error" role="alert">{error}</p>}
    </form>
  </section>;
}

function OrderTable({ title, rows, side, filled, onPick }: { title: string; rows: OrderRow[]; side: FillSide; filled: number; onPick: (row: OrderRow, side: FillSide) => void }) {
  return <div className={`vr-orders vr-orders--${side}`}>
    <h3>{title} <small>{rows.length}줄{filled > 0 ? ` 중 ${filled}줄 체결 · 남은 ${rows.length - filled}줄` : ""}</small></h3>
    {rows.length === 0 ? <p className="vr-hint">주문 없음</p> : <div className="vr-orders-scroll"><table>
      <thead><tr><th>순번</th><th>지정가</th><th className="vr-col-qty">수량</th><th>체결 후 보유</th><th>체결 후 Pool</th><th><span className="vr-sr">체결 상태</span></th></tr></thead>
      <tbody>{rows.map((row, i) => {
        const done = i < filled;
        return <tr key={row.holdings} className={done ? "is-filled" : i === filled ? "is-next" : undefined}>
          <td>{i + 1}</td><td>{money(row.price)}</td><td className="vr-col-qty">1주</td><td>{row.holdings}주</td><td>{money(row.poolAfter)}</td>
          <td>{done
            ? <span className="vr-filled-tag"><Check size={12} aria-hidden="true" />체결됨</span>
            : <button type="button" className="vr-mini" aria-label={`${title} ${i + 1}번 ${money(row.price)} 체결 기록`} onClick={() => onPick(row, side)}>체결</button>}</td>
        </tr>;
      })}</tbody>
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

type FoldKey = "flow" | "orders" | "fills" | "close" | "charts" | "ledger" | "settings";

function Fold({ id, title, summary, open, onToggle, children }: {
  id: string; title: string; summary: ReactNode; open: boolean; onToggle: (open: boolean) => void; children: ReactNode;
}) {
  return <details className="vr-fold" id={id} open={open} onToggle={(e) => { const next = (e.currentTarget as HTMLDetailsElement).open; if (next !== open) onToggle(next); }}>
    <summary><span className="vr-fold-title">{title}</span><span className="vr-fold-summary">{summary}</span><ChevronDown className="vr-fold-icon" size={18} aria-hidden="true" /></summary>
    <div className="vr-fold-body">{children}</div>
  </details>;
}

/** 필요할 때만 펼쳐 보는 설명. 누르기 전에는 제목 한 줄만 보인다. */
function Help({ label = "설명", children }: { label?: string; children: ReactNode }) {
  return <details className="vr-help"><summary>{label}</summary><div className="vr-help-body">{children}</div></details>;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const signedMoney = (value: number, digits = 2) => `${value >= 0 ? "+" : "−"}${money(Math.abs(value), digits)}`;
const signedPct = (value: number) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(1)}%`;
const tone = (value: number) => value > 0 ? "vr-gain" : value < 0 ? "vr-loss" : "";

/** V 최소~최대 밴드 위에 지금 평가금 위치를 보여 주는 막대 */
function BandGauge({ cycle, value }: { cycle: VrCycle; value: number | null }) {
  const lo = Math.min(cycle.lower, value ?? cycle.lower) * 0.97;
  const hi = Math.max(cycle.upper, value ?? cycle.upper) * 1.03;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const pos = (v: number) => `${pct(v)}%`;
  const align = value == null ? "center" : pct(value) < 15 ? "start" : pct(value) > 85 ? "end" : "center";
  return <div className="vr-gauge" aria-hidden="true">
    <div className="vr-gauge-track">
      <span className="vr-gauge-zone vr-gauge-zone--buy" style={{ left: 0, width: pos(cycle.lower) }} />
      <span className="vr-gauge-band" style={{ left: pos(cycle.lower), width: `calc(${pos(cycle.upper)} - ${pos(cycle.lower)})` }} />
      <span className="vr-gauge-zone vr-gauge-zone--sell" style={{ left: pos(cycle.upper), right: 0 }} />
      <span className="vr-gauge-v" style={{ left: pos(cycle.v) }} />
      {value != null && <span className="vr-gauge-now" style={{ left: pos(value) }}><b data-align={align}>지금 {money(value, 0)}</b></span>}
    </div>
    <div className="vr-gauge-scale">
      <span style={{ left: pos(cycle.lower) }}>V 최소<br />{money(cycle.lower, 0)}</span>
      <span style={{ left: pos(cycle.v) }}>V 목표<br />{money(cycle.v, 0)}</span>
      <span style={{ left: pos(cycle.upper) }}>V 최대<br />{money(cycle.upper, 0)}</span>
    </div>
    <div className="vr-gauge-legend"><span><i className="vr-gauge-key vr-gauge-key--buy" />V 최소 아래: 매수 구간</span><span><i className="vr-gauge-key vr-gauge-key--band" />밴드 안: 거래 없음</span><span><i className="vr-gauge-key vr-gauge-key--sell" />V 최대 위: 매도 구간</span></div>
  </div>;
}

/** 종료일이 지난 주차를 확인 한 번으로 넘기는 안내창 */
function OverdueDialog({ cycle, overdue, shares, pool, endClose, onConfirm, onLater }: {
  cycle: VrCycle; overdue: number; shares: number; pool: number; endClose: ReferenceClose | undefined;
  onConfirm: () => void; onLater: () => void;
}) {
  return <div className="vr-modal-backdrop">
    <div className="vr-modal" role="alertdialog" aria-modal="true" aria-labelledby="vr-overdue-title" aria-describedby="vr-overdue-desc">
      <h2 id="vr-overdue-title">{cycle.week}주차가 끝났습니다</h2>
      <p id="vr-overdue-desc">{cycle.startDate} ~ {cycle.endDate} 주차의 종료일이 지났습니다. 확인을 누르면 체결 기록 기준 잔고로 {cycle.week}주차를 종료하고 {cycle.week + 2}주차를 엽니다.{overdue > 1 ? ` 지난 주차가 ${overdue}개라 확인할 때마다 하나씩 넘어갑니다.` : ""}</p>
      <dl className="vr-modal-values">
        <div><dt>보유 수량</dt><dd>{shares}주</dd></div>
        <div><dt>Pool (적립 전)</dt><dd>{money(pool)}</dd></div>
        <div><dt>종료 종가</dt><dd>{endClose ? `${money(endClose.close)} (${endClose.date})` : "불러오는 중"}</dd></div>
      </dl>
      <p className="vr-hint">빠진 체결이 있으면 "나중에"를 누르고 매일 체결 기록에 추가한 뒤 "주차 종료"를 누르세요.</p>
      <div className="vr-modal-actions">
        <button type="button" className="vr-link" onClick={onLater}>나중에</button>
        <button type="button" className="vr-primary vr-modal-ok" disabled={!endClose} onClick={onConfirm}>확인</button>
      </div>
    </div>
  </div>;
}

type HistoryForm = { week0Date: string; principal: string; poolRatio: string };

/** 이어받은 계좌의 0주차 ~ 직전 주차를 일별 종가로 재구성해 지난 기록에 넣는다. */
function HistoryBuilder({ preview, error, form, onForm, onApply, first, guess }: {
  preview: CalibratedBacktest | null; error: string; form: HistoryForm; onForm: (patch: Partial<HistoryForm>) => void;
  onApply: () => void; first: VrCycle; guess: number | null;
}) {
  const sim = preview ? preview.result.account.cycles.filter((c) => c.close && c.week < first.week) : [];
  const arrive = preview?.result.reached ? preview.result.account.cycles.at(-1)! : null;
  const start = preview?.result.account.start;
  return <div className="vr-history-builder">
    <h3>0 ~ {first.week - 2}주차 기록 만들기</h3>
    <Help><p>이 계좌는 {first.week}주차부터 기록해 이전 기록이 없습니다. 0주차부터 시트 규칙(2주마다 V 계산, 1주씩 지정가 주문표)대로 운용했다고 보고 일별 종가로 체결을 재생해 지난 기록을 채웁니다. 원금을 비워 두면 {first.week}주차 시작 잔고({first.shares}주 · 적립 전 Pool {money(first.poolBeforeDeposit)})에 가장 가깝게 도착하는 원금을 자동으로 찾습니다.</p></Help>
    <div className="vr-fields">
      <label>0주차 날짜<input type="date" value={form.week0Date} onChange={(e) => onForm({ week0Date: e.target.value })} /></label>
      <label>0주차 원금 (USD, 비우면 자동)<input type="number" min="0" step="any" value={form.principal} placeholder={guess == null ? "자동" : `자동 (어림 ${money(guess, 0)})`} onChange={(e) => onForm({ principal: e.target.value })} /></label>
      <label>0주차 Pool 비율 P/V<input type="number" min="0" step="any" value={form.poolRatio} onChange={(e) => onForm({ poolRatio: e.target.value })} /></label>
    </div>
    {error && <p className="vr-error">{error}</p>}
    {preview && start && <>
      {arrive
        ? <p className="vr-compare-line">0주차 {start.date} 원금 <b>{money(preview.principal)}</b>{preview.calibrated ? " (자동)" : ""}으로 시작하면 {first.week}주차 시작 때 <b>{arrive.shares}주 · Pool {money(arrive.poolBeforeDeposit)}</b>, 실제는 <b>{first.shares}주 · Pool {money(first.poolBeforeDeposit)}</b>입니다.
          {arrive.shares !== first.shares && <span className="vr-error"> 수량이 맞지 않습니다. 0주차 날짜·P/V를 고치거나 원금을 직접 넣어 보세요.</span>}</p>
        : <p className="vr-error">가격 자료가 {first.week - 2}주차까지 닿지 않습니다. 가격 자료는 최근 약 1년치입니다.</p>}
      <div className="vr-table-wrap"><table className="vr-ledger">
        <thead><tr><th>주차</th><th>기간</th><th>V</th><th>V 최소~최대</th><th>시작 수량</th><th>매수</th><th>매도</th><th>종료 수량</th><th>종료 Pool</th><th>종료 종가</th></tr></thead>
        <tbody>
          <tr><td>0</td><td>{start.date}</td><td>{money(start.v0, 0)}</td><td>—</td><td>—</td><td>{start.shares}주 × {money(start.price)}</td><td>—</td><td>{start.shares}</td><td>{money(start.pool)}</td><td>{money(start.price)}</td></tr>
          {sim.map((c) => {
            const t = fillTotals(c);
            return <tr key={c.index}>
              <td>{c.week}</td><td>{c.startDate} ~ {c.endDate.slice(5)}</td><td>{money(c.v, 0)}</td><td>{money(c.lower, 0)}~{money(c.upper, 0)}</td><td>{c.shares}</td>
              <td>{t.buyQuantity ? `${t.buyQuantity}주` : "—"}</td><td>{t.sellQuantity ? `${t.sellQuantity}주` : "—"}</td>
              <td>{c.close?.shares ?? "—"}</td><td>{money(c.close?.pool)}</td><td>{money(c.close?.price)}</td>
            </tr>;
          })}
        </tbody>
      </table></div>
      <button type="button" className="vr-primary" disabled={!arrive} onClick={onApply}>지난 기록에 넣기</button>
      <Help><p>넣으면 0 ~ {first.week - 2}주차가 "추정"으로 표시되어 아래 지난 기록과 그래프에 나옵니다. {first.week - 2}주차 종료 값은 실제 {first.week}주차 시작 잔고로 이어 붙이고, {first.week}주차부터의 V·주문표·체결 기록은 바뀌지 않습니다. 장중 고가·저가가 없어 종가가 지정가를 넘은 날만 체결로 보며 수수료·세금은 빠져 있습니다. 넣은 뒤에도 지울 수 있습니다.</p></Help>
    </>}
  </div>;
}

type StepState = "done" | "now" | "later";

function AccountView({ account, onChange, onReset }: { account: VrAccount; onChange: (next: VrAccount) => void; onReset: () => void }) {
  const cycle = currentCycle(account);
  const orders = useMemo(() => buildOrders(cycle), [cycle]);
  const filled = useMemo(() => filledRows(orders, cycle), [orders, cycle]);
  const remaining = useMemo(() => remainingOrders(orders, cycle), [orders, cycle]);
  const [refPrice, setRefPrice] = useState("");
  const [settings, setSettings] = useState<SettingsForm>(toForm(account.settings));
  const [fix, setFix] = useState({ startDate: cycle.startDate, averageCost: "" });
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
  const basis = useMemo(() => costBasis(account), [account]);
  const overdue = overdueCycles(cycle, today);
  const [open, setOpen] = useState<Record<FoldKey, boolean>>({ flow: false, orders: true, fills: true, close: true, charts: true, ledger: false, settings: false });
  const setFold = (key: FoldKey, value: boolean) => setOpen((prev) => ({ ...prev, [key]: value }));
  const [laterFor, setLaterFor] = useState<number | null>(null);
  function openFold(key: FoldKey) {
    setFold(key, true);
    window.setTimeout(() => document.getElementById(`vr-fold-${key}`)?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
  }
  // 종료 종가: 이번 주차 기간 안의 마지막 종가(일찍 종료하면 그때까지의 마지막 종가)
  const endClose = useMemo(() => [...history.prices].reverse().find((p) => p.date >= cycle.startDate && p.date <= cycle.endDate), [history.prices, cycle.startDate, cycle.endDate]);
  const [fillForm, setFillForm] = useState({ date: clampDate(today, cycle.startDate, cycle.endDate), side: "buy" as FillSide, price: "", quantity: "1" });
  useEffect(() => {
    setRefPrice(""); setFillForm((f) => ({ ...f, date: clampDate(todayLocal(), cycle.startDate, cycle.endDate), price: "", quantity: "1" }));
    setFix((f) => ({ ...f, startDate: cycle.startDate }));
  }, [cycle.index, cycle.startDate, cycle.endDate]);

  // 지난 기록 재구성(0주차 ~ 실제 첫 주차 직전)
  const hasHistory = hasEstimatedHistory(account);
  const realIndex = firstRealIndex(account);
  const first = account.cycles[realIndex];
  const [histForm, setHistForm] = useState<HistoryForm>(() => ({ week0Date: week0DateFor(first.startDate, first.week), principal: "", poolRatio: String(DEFAULT_INITIAL_POOL_RATIO) }));
  useEffect(() => { setHistForm((f) => ({ ...f, week0Date: week0DateFor(first.startDate, first.week) })); }, [first.startDate, first.week]);
  const firstBasis = useMemo(() => costBasis(account, realIndex, ""), [account, realIndex]);
  const principalGuess = estimatePrincipal(firstBasis.cost, first.poolBeforeDeposit, account.settings.deposit, first.week);
  const hist = useMemo((): { preview: CalibratedBacktest | null; error: string } => {
    if (hasHistory || first.week <= 2) return { preview: null, error: "" };
    if (history.status !== "ready") return { preview: null, error: history.status === "error" ? "가격 자료를 불러오지 못해 지난 기록을 만들 수 없습니다." : "" };
    try {
      const principal = histForm.principal.trim() === "" ? undefined : num(histForm.principal);
      return {
        preview: calibrateBacktest(
          { settings: { ...account.settings, deposit: first.deposit }, week0Date: histForm.week0Date, poolRatio: num(histForm.poolRatio), untilWeek: first.week, prices: history.prices },
          { shares: first.shares, poolBeforeDeposit: first.poolBeforeDeposit }, principalGuess ?? first.shares * first.referenceClose, principal),
        error: "",
      };
    } catch (cause) { return { preview: null, error: errorText(cause, "지난 기록을 만들 수 없습니다.") }; }
  }, [hasHistory, history, account.settings, first, histForm, principalGuess]);
  function applyHistory() {
    if (!hist.preview) return;
    setError(""); setMessage("");
    try { onChange(mergeHistory(account, hist.preview.result)); setMessage(`0 ~ ${first.week - 2}주차 기록을 넣었습니다.`); }
    catch (cause) { setError(errorText(cause, "지난 기록을 넣지 못했습니다.")); }
  }
  function clearHistory() {
    if (!window.confirm("재구성한 지난 기록(추정)을 지울까요? 실제로 기록한 주차는 그대로 남습니다.")) return;
    setError(""); onChange(removeEstimatedHistory(account)); setMessage("재구성한 지난 기록을 지웠습니다.");
  }

  const check = useMemo(() => {
    const manual = num(refPrice);
    const isManual = Number.isFinite(manual) && manual > 0;
    // 사이트 가격이 이번 주차 시작 전 것뿐이면, 시작할 때 넣은(또는 직전 주차 종료) 종가가 같은 날이거나 더 최신이다.
    const useStart = !isManual && (!latest || latest.date < cycle.startDate) && cycle.referenceClose > 0;
    const price = isManual ? manual : useStart ? cycle.referenceClose : latest?.close;
    if (price == null || totals.shares === 0) return null;
    const source = isManual ? "입력한 가격" : useStart ? "주차 시작 기준 종가" : `${latest!.date} 종가`;
    return { price, source, ...valuationStatus({ ...cycle, shares: totals.shares }, price), fills: countFills(orders, price) };
  }, [cycle, orders, refPrice, latest, totals.shares]);
  const nextWeek = cycle.week + 2;
  const nextG = gForWeek(account.settings.g, nextWeek);
  const nextLimit = poolLimitForWeek(account.settings.poolLimitPct, nextWeek);
  const daysLeft = daysBetween(today, cycle.endDate);
  const started = today === cycle.startDate;

  const pnl = check && basis.cost != null && basis.cost > 0 ? { value: check.value - basis.cost, pct: (check.value / basis.cost - 1) * 100 } : null;
  const capital = startingCapital(account);
  const invested = capital == null ? null : capital + totalDeposits(account);
  const totalAsset = check ? check.value + totals.pool : null;
  const totalPnl = invested != null && totalAsset != null && invested > 0 ? { value: totalAsset - invested, pct: (totalAsset / invested - 1) * 100 } : null;

  function endWeek() {
    setError(""); setMessage("");
    if (!endClose) { setError(history.status === "loading" ? "종가를 불러오는 중입니다. 잠시 뒤 다시 누르세요." : `${cycle.startDate} ~ ${cycle.endDate} 기간의 종가를 불러오지 못해 종료할 수 없습니다.`); return; }
    try {
      onChange(closeCycle(account, { shares: totals.shares, pool: totals.pool, price: endClose.close }));
      setMessage(`${cycle.week}주차를 종료하고 ${nextWeek}주차를 열었습니다.`);
    } catch (cause) { setError(errorText(cause, "주차를 종료할 수 없습니다.")); }
  }
  function close() {
    if (overdue === 0 && !window.confirm(`아직 ${cycle.endDate} 종료일 전입니다. 지금 ${cycle.week}주차를 종료할까요?`)) return;
    endWeek();
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
    openFold("fills");
  }
  function saveSettings(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try { onChange({ ...account, settings: fromForm(settings) }); setMessage("설정을 저장했습니다. 다음 주차부터 적용됩니다."); }
    catch (cause) { setError(errorText(cause, "설정을 저장할 수 없습니다.")); }
  }
  function saveFix(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      let next = rescheduleCurrentCycle(account, fix.startDate);
      const avg = num(fix.averageCost);
      if (fix.averageCost.trim() !== "") next = setCurrentAverageCost(next, avg);
      onChange(next);
      setFix((f) => ({ ...f, averageCost: "" }));
      setMessage("계좌 정보를 고쳤습니다.");
    } catch (cause) { setError(errorText(cause, "계좌 정보를 고칠 수 없습니다.")); }
  }
  function undo() {
    if (!window.confirm("직전 주차 종료를 취소하고 그 주차를 다시 열까요? 현재 열린 주차는 지워집니다.")) return;
    try { onChange(reopenLastCycle(account)); setMessage("직전 주차 종료를 취소했습니다."); } catch (cause) { setError(errorText(cause, "되돌릴 수 없습니다.")); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(formatOrdersText(account.settings.ticker, cycle, remaining)); setMessage(filled.buys + filled.sells > 0 ? "체결된 줄을 뺀 남은 주문을 복사했습니다." : "주문표를 복사했습니다."); }
    catch { setMessage("복사할 수 없습니다. 화면의 주문표를 직접 확인하세요."); }
  }

  const gap = check ? check.value - cycle.v : null;
  const situation = !check ? null
    : check.zone === "below" ? <>지금 평가금은 목표보다 <b>{money(Math.abs(gap!))} 적고</b> V 최소보다도 낮습니다. <b>매수 구간</b>이라 걸어 둔 매수 주문이 체결되며 평가금을 목표 쪽으로 채웁니다(이 가격이면 주문표 매수 {check.fills.buys}줄까지 체결).</>
    : check.zone === "above" ? <>지금 평가금은 목표보다 <b>{money(Math.abs(gap!))} 많고</b> V 최대보다도 높습니다. <b>매도 구간</b>이라 걸어 둔 매도 주문이 체결되며 수익 일부를 현금(Pool)으로 옮깁니다(이 가격이면 주문표 매도 {check.fills.sells}줄까지 체결).</>
    : <>지금 평가금은 목표와 {money(Math.abs(gap!))} 차이로 <b>V 최소~최대 안</b>에 있습니다. 거래가 생기지 않는 구간이니 걸어 둔 주문을 그대로 두면 됩니다.</>;

  const steps: Array<{ key: string; icon: ReactNode; title: string; text: string; state: StepState; action?: [string, () => void] }> = [
    { key: "deposit", icon: <Wallet size={18} />, title: "적립금 입금", text: `${cycle.startDate}에 ${money(cycle.deposit)} 입금`, state: overdue > 0 ? "done" : started ? "now" : "done" },
    { key: "order", icon: <ListChecks size={18} />, title: "지정가 주문 걸기", text: `매수 ${orders.buys.length}줄 · 매도 ${orders.sells.length}줄, 1주씩`, state: overdue > 0 ? "done" : started ? "now" : "done", action: ["주문표 보기", () => openFold("orders")] },
    { key: "fill", icon: <ClipboardCheck size={18} />, title: "매일 체결 기록", text: totals.count > 0 ? `${totals.count}건 기록 · 보유 ${totals.shares}주` : "체결되면 체결가·수량 입력", state: overdue > 0 ? "done" : started ? "later" : "now", action: ["체결 기록", () => openFold("fills")] },
    { key: "close", icon: <Flag size={18} />, title: "주차 종료", text: overdue > 0 ? "지금 종료할 차례입니다" : `${cycle.endDate} 장 마감 후 "주차 종료" 누르기`, state: overdue > 0 ? "now" : "later", action: ["종료 칸 열기", () => openFold("close")] },
  ];

  return <>
    {overdue > 0 && laterFor !== cycle.index && <OverdueDialog cycle={cycle} overdue={overdue} shares={totals.shares} pool={totals.pool} endClose={endClose}
      onConfirm={endWeek} onLater={() => setLaterFor(cycle.index)} />}

    <section className="vr-panel vr-now" aria-labelledby="vr-now-title">
      <div className="vr-now-head">
        <div>
          <p className="vr-eyebrow">현재 상황</p>
          <h2 id="vr-now-title">{cycle.week}주차 · {cycle.startDate} ~ {cycle.endDate}</h2>
        </div>
        <span className={`vr-dday${overdue > 0 ? " is-due" : ""}`}>{overdue > 0 ? "종료일 지남" : daysLeft === 0 ? "오늘 종료" : `종료까지 ${daysLeft}일`}</span>
      </div>
      {overdue > 0 && <div className="vr-due" role="status">
        <strong>{cycle.week}주차 사이클이 {cycle.endDate}에 끝났습니다.</strong>
        <span>{overdue > 1 ? `오늘까지 ${overdue}개 주차가 지났습니다. 종료할 때마다 다음 주차가 하나씩 열립니다. ` : ""}빠진 체결이 없는지 확인하고 "주차 종료"를 누르면 {nextWeek}주차 V와 주문표가 만들어집니다.</span>
        <button type="button" className="vr-due-action" onClick={() => { setLaterFor(null); openFold("close"); }}>주차 종료하러 가기</button>
      </div>}

      <div className="vr-now-grid">
        <div className="vr-now-v">
          <p className="vr-now-label">V · 이번 2주 목표 평가금</p>
          <p className="vr-now-value">{money(cycle.v, 0)}</p>
          <Help label="V란?"><p>V는 이번 2주 동안 {ticker} 보유분의 평가금(보유 수량 × 가격)이 있어야 할 <b>목표값</b>입니다. 2주마다 적립금과 Pool 일부만큼 올라가며, 평가금이 V에서 ±{cycle.bandPct}% 넘게 벗어날 때만 사고팔아 다시 V 근처로 맞춥니다. 그래서 쌀 때 사고 비쌀 때 파는 기준이 됩니다.</p></Help>
          <div className="vr-invest">
            <span>매입금액 (보유분을 사는 데 쓴 돈)</span>
            {basis.cost != null
              ? <b>{money(basis.cost)} <small>= 평단가 {money(basis.averageCost)} × {basis.shares}주{basis.estimated ? " (추정)" : ""}</small></b>
              : <b className="vr-muted">평단가를 몰라 표시할 수 없습니다 · 아래 "계좌 정보 고치기"에서 입력</b>}
          </div>
        </div>
        <div className="vr-now-state">
          {check
            ? <>
              <p className="vr-now-label">{check.source} {money(check.price)} × {totals.shares}주</p>
              <p className={`vr-now-value vr-zone-text--${check.zone}`}>평가금 {money(check.value, 0)}</p>
              {pnl && <p className="vr-pnl">매입금액 대비 <b className={tone(pnl.value)}>{signedMoney(pnl.value)} ({signedPct(pnl.pct)})</b></p>}
              <p className={`vr-zone vr-zone--${check.zone}`}>{situation}</p>
            </>
            : <p className="vr-zone">{history.status === "loading" ? "최근 종가를 불러오는 중입니다." : "최근 종가를 불러오지 못했습니다. 아래에 가격을 넣어 확인하세요."}</p>}
        </div>
      </div>
      <BandGauge cycle={cycle} value={check?.value ?? null} />
      <dl className="vr-now-stats">
        <div><dt>보유 수량</dt><dd>{totals.shares}주{totals.count > 0 && <small> (시작 {cycle.shares}주)</small>}</dd></div>
        <div><dt>현금 Pool</dt><dd>{money(totals.pool)}{totals.count > 0 && <small> (시작 {money(cycle.pool)})</small>}</dd></div>
        <div><dt>이번 매수에 쓸 수 있는 Pool</dt><dd>{money(cycle.poolCap)} <small>({cycle.poolLimitPct}%)</small></dd></div>
        <div><dt>G · 2주 적립금</dt><dd>{cycle.g} · {money(cycle.deposit)}</dd></div>
        <div><dt>총 투입금 (시작 자본 + 적립금)</dt><dd>{invested == null ? "—" : money(invested)}</dd></div>
        <div><dt>총자산 (평가금 + Pool)</dt><dd>{totalAsset == null ? "—" : money(totalAsset)}</dd></div>
        <div><dt>총손익</dt><dd className={totalPnl ? tone(totalPnl.value) : ""}>{totalPnl ? `${signedMoney(totalPnl.value)} (${signedPct(totalPnl.pct)})` : "—"}</dd></div>
      </dl>
      <details className="vr-inline-fold">
        <summary>V 계산 내역 · 다른 가격으로 확인</summary>
        <p className="vr-hint">{formulaExplain(cycle)}.</p>
        <p className="vr-hint">다음 {nextWeek}주차: G {nextG}, Pool 사용 한도 {nextLimit}%{nextG !== cycle.g || nextLimit !== cycle.poolLimitPct ? " (변경됨)" : ""}. 총 투입금은 이 화면에서 시작한 시점의 매입금액과 현금에 그 뒤 적립금을 더한 값입니다.</p>
        <div className="vr-check">
          <label>다른 가격으로 확인 (선택, USD)<input type="number" min="0" step="any" value={refPrice} placeholder={latest ? String(latest.close) : ""} onChange={(e) => setRefPrice(e.target.value)} /></label>
        </div>
      </details>
    </section>

    <Fold id="vr-fold-flow" title="사용 순서" open={open.flow} onToggle={(v) => setFold("flow", v)} summary="입금 → 주문 → 매일 체결 기록 → 주차 종료 (2주마다 반복)">
      <ol className="vr-flow">
        {steps.map((step) => <li key={step.key} className={`vr-flow-step is-${step.state}`} aria-current={step.state === "now" ? "step" : undefined}>
          <span className="vr-flow-icon">{step.state === "done" ? <Check size={18} /> : step.icon}</span>
          <strong>{step.title}</strong>
          <span className="vr-flow-text">{step.text}</span>
          {step.state === "now" && <em className="vr-flow-badge">지금</em>}
          {step.action && <button type="button" className="vr-flow-action" onClick={step.action[1]}>{step.action[0]}</button>}
        </li>)}
      </ol>
      <Help><p>주차는 자동으로 넘어가지 않습니다. 종료일이 지나면 안내창이 뜨고, 확인을 누르거나 "주차 종료"를 눌러야 다음 주차의 V와 주문표가 만들어집니다.</p></Help>
    </Fold>

    {(message || error) && <p className={error ? "vr-error" : "vr-message"} role={error ? "alert" : "status"}>{error || message}</p>}

    <Fold id="vr-fold-charts" title="가격과 V" open={open.charts} onToggle={(v) => setFold("charts", v)} summary="평가금과 V·V 최소·V 최대, 매수 ▲ · 매도 ▼">
      <Help><p>파란 선은 내 보유분의 평가금(보유 수량 × 종가)이고, V·V 최소·V 최대도 금액입니다. 서로 같은 눈금에 겹치려고 모두 보유 수량으로 나눈 1주 가격으로 그립니다. 그래서 세로축은 1주 가격이고, 라벨은 금액 뒤 괄호에 1주 가격(평가금은 종가)을 씁니다. 평가금 선이 V 최소 아래로 내려가면 매수 주문이, V 최대 위로 올라가면 매도 주문이 체결되는 구간입니다. 체결은 매수 ▲, 매도 ▼ 지점으로 표시합니다. 가격 자료는 최근 약 1년치입니다.</p></Help>
      {history.status === "loading" ? <p className="vr-hint">종가를 불러오는 중입니다.</p>
        : open.charts && <VrPriceBandChart cycles={account.cycles} prices={history.prices} />}
    </Fold>

    <Fold id="vr-fold-orders" title={`${cycle.week}주차 주문표`} open={open.orders} onToggle={(v) => setFold("orders", v)}
      summary={`남은 주문 매수 ${remaining.buys.length}줄${remaining.buys[0] ? ` ${money(remaining.buys[0].price)}부터` : ""} · 매도 ${remaining.sells.length}줄${remaining.sells[0] ? ` ${money(remaining.sells[0].price)}부터` : ""}`}>
      <Help label="주문표 규칙"><p>
        시트 v5.0.4 규칙입니다. 매수 k번째는 V 최소 ÷ (보유 + k − 1), 매도 k번째는 V 최대 ÷ (보유 − k + 1)이며 1주씩 지정가 잔량 주문으로 주차 끝까지 걸어 둡니다.
        매수는 매수 후 Pool이 {money(cycle.poolReserve)}(시작일 Pool × {roundPct(100 - cycle.poolLimitPct)}%) 이상이고 단가가 {money(orders.buyPriceFloor)}(직전 종료 종가 × 60%) 이상인 줄까지 만든 뒤 1줄을 더합니다. 매도는 1주가 남을 때까지 제한 없이 만듭니다.
        시트는 단가를 반올림하지 않으므로, 여기서는 매수가를 센트 단위로 내리고 매도가를 올립니다. 체결되면 "체결" 버튼으로 기록하세요. 주문표는 주차 동안 바뀌지 않고, 기록한 체결 수만큼 위에서부터 "체결됨"으로 표시됩니다. 남은 줄은 그대로 두며, 마지막 줄까지 체결되면 이번 주차에는 더 사거나 팔지 않습니다.
      </p></Help>
      {cycle.shares === 0 && <p className="vr-error">보유 수량이 0주라 주문표를 만들 수 없습니다.</p>}
      <div className="vr-order-grid">
        <OrderTable title="매수" rows={orders.buys} side="buy" filled={filled.buys} onPick={pickOrder} />
        <OrderTable title="매도" rows={orders.sells} side="sell" filled={filled.sells} onPick={pickOrder} />
      </div>
      <button type="button" className="vr-secondary" onClick={() => void copy()}>주문표 복사</button>
    </Fold>

    <Fold id="vr-fold-fills" title="매일 체결 기록" open={open.fills} onToggle={(v) => setFold("fills", v)}
      summary={totals.count > 0 ? `${totals.count}건 · 보유 ${totals.shares}주 · Pool ${money(totals.pool)}` : "기록 없음"}>
      <Help><p>체결된 날마다 체결가와 수량을 입력합니다. 주문표의 "체결" 버튼을 누르면 가격이 채워집니다. 입력한 기록으로 보유 수량·Pool·평단가가 계산되어 위 현재 상황과 주차 종료 칸에 반영됩니다. 수수료·세금은 반영하지 않습니다.</p></Help>
      <form onSubmit={recordFill}>
        <div className="vr-fields vr-fields--fill">
          <label>체결일<input type="date" min={cycle.startDate} max={cycle.endDate} value={fillForm.date} onChange={(e) => setFillForm({ ...fillForm, date: e.target.value })} /></label>
          <label>구분<select value={fillForm.side} onChange={(e) => setFillForm({ ...fillForm, side: e.target.value as FillSide })}><option value="buy">매수</option><option value="sell">매도</option></select></label>
          <label>체결가 (USD)<input type="number" min="0" step="any" value={fillForm.price} onChange={(e) => setFillForm({ ...fillForm, price: e.target.value })} /></label>
          <label>체결 수량 (주)<input type="number" min="1" step="1" value={fillForm.quantity} onChange={(e) => setFillForm({ ...fillForm, quantity: e.target.value })} /></label>
        </div>
        <div className="vr-fill-actions">
          <button className="vr-secondary" type="submit">체결 추가</button>
          {Number.isFinite(num(fillForm.price) * num(fillForm.quantity)) && num(fillForm.price) > 0 && <span className="vr-hint">체결 금액 {money(num(fillForm.price) * num(fillForm.quantity))}</span>}
        </div>
      </form>
      {totals.count === 0 ? <p className="vr-hint">이번 주차에 기록한 체결이 없습니다.</p> : <>
        <div className="vr-table-wrap"><table className="vr-ledger vr-fills">
          <thead><tr><th>체결일</th><th>구분</th><th>체결가</th><th>수량</th><th>금액</th><th><span className="vr-sr">삭제</span></th></tr></thead>
          <tbody>{(cycle.fills ?? []).map((f) => <tr key={f.id}>
            <td>{f.date}</td><td className={`vr-side vr-side--${f.side}`}>{f.side === "buy" ? "매수" : "매도"}</td><td>{money(f.price)}</td><td>{f.quantity}주</td><td>{money(f.price * f.quantity)}</td>
            <td><button type="button" className="vr-mini" aria-label={`${f.date} ${f.side === "buy" ? "매수" : "매도"} ${money(f.price)} 기록 삭제`} onClick={() => deleteFill(f.id)}>삭제</button></td>
          </tr>)}</tbody>
        </table></div>
        <p className="vr-fill-sum">매수 {totals.buyQuantity}주 {money(totals.buyAmount)} · 매도 {totals.sellQuantity}주 {money(totals.sellAmount)} → 보유 {totals.shares}주 · Pool {money(totals.pool)}</p>
      </>}
    </Fold>

    <Fold id="vr-fold-close" title="주차 종료" open={open.close} onToggle={(v) => setFold("close", v)}
      summary={overdue > 0 ? "지금 종료할 차례" : `${cycle.endDate} 장 마감 후 "주차 종료"`}>
      <Help><p>주차는 자동으로 넘어가지 않습니다. {cycle.endDate} 장 마감 후 "주차 종료"를 누르면 체결 기록으로 계산한 잔고와 마지막 종가로 이번 주차를 마치고 다음 주차가 열립니다. 따로 입력할 값은 없습니다. 잊고 지나가면 다음에 이 화면을 열 때 안내창이 뜹니다.</p></Help>
      <dl className="vr-close-values">
        <div><dt>보유 수량</dt><dd>{totals.shares}주</dd></div>
        <div><dt>Pool (다음 적립 전)</dt><dd>{money(totals.pool)}</dd></div>
        <div><dt>종료 종가</dt><dd>{endClose ? `${money(endClose.close)} (${endClose.date})` : "—"}</dd></div>
      </dl>
      <button className="vr-primary" type="button" onClick={close}>주차 종료</button>
      {account.cycles.length > 1 && !account.cycles.at(-2)!.estimated && <button type="button" className="vr-link" onClick={undo}><RotateCcw size={14} /> 직전 주차 종료 취소</button>}
    </Fold>

    <Fold id="vr-fold-ledger" title="지난 기록 (주차 원장)" open={open.ledger} onToggle={(v) => setFold("ledger", v)}
      summary={`${account.cycles.length}개 주차 · 누적 적립 ${money(totalDeposits(account), 0)}`}>
      {!hasHistory && first.week > 2 && <HistoryBuilder preview={hist.preview} error={hist.error} form={histForm} onForm={(patch) => setHistForm((f) => ({ ...f, ...patch }))}
        onApply={applyHistory} first={first} guess={principalGuess} />}
      {hasHistory && <p className="vr-hint">0 ~ {first.week - 2}주차는 일별 종가로 재구성한 <b>추정 기록</b>입니다. <button type="button" className="vr-link vr-danger" onClick={clearHistory}>추정 기록 지우기</button></p>}
      <p className="vr-hint">시작 {account.start.date}{hasHistory ? " (추정)" : ""} · {account.start.kind === "new" ? `0일차 ${account.start.shares}주 × 종가 ${money(account.start.price)} = V0 ${money(account.start.v0)}, Pool ${money(account.start.pool)}` : account.start.kind === "quick" ? `${account.start.shares}주 · 평단가 ${money(account.start.averageCost)} · 직전 종가 ${money(account.start.price)}로 이어받음, 직전 V 대체값 ${money(account.start.v0)}(${account.start.basis === "market" ? "평가금" : "평단가"} 기준)` : `이어받은 직전 V ${money(account.start.v0, 3)}`} · 누적 적립금 {money(totalDeposits(account))}</p>
      <div className="vr-table-wrap"><table className="vr-ledger">
        <thead><tr><th>주차</th><th>시작일</th><th>공식</th><th>G</th><th>V</th><th>V 최소~최대</th><th>시작 수량</th><th>Pool(적립 후)</th><th>체결 기록</th><th>종료 수량</th><th>종료 Pool</th><th>종료 종가</th><th>종료 평가금</th><th>총자산</th></tr></thead>
        <tbody>{[...account.cycles].reverse().map((c) => {
          const value = c.close ? c.close.shares * c.close.price : null;
          return <tr key={c.index} className={c.estimated ? "vr-row-estimated" : undefined}>
            <td>{c.week}{c.close ? "" : " (진행)"}{c.estimated ? " (추정)" : ""}</td><td>{c.startDate}</td><td>{c.formula === "basic" ? "기본" : "실력"}</td><td>{c.g}</td><td>{money(c.v, 3)}</td>
            <td>{money(c.lower)}~{money(c.upper)}</td><td>{c.shares}</td><td>{money(c.pool)}</td><td>{fillSummary(c)}</td><td>{c.close?.shares ?? "—"}</td>
            <td>{money(c.close?.pool)}</td><td>{money(c.close?.price)}</td><td>{money(value)}</td><td>{money(value == null ? null : value + c.close!.pool)}</td>
          </tr>;
        })}</tbody>
      </table></div>
    </Fold>

    <Fold id="vr-fold-settings" title="설정 · 계좌 정보 고치기" open={open.settings} onToggle={(v) => setFold("settings", v)}
      summary={`G ${account.settings.g} · 밴드 ±${account.settings.bandPct}% · 적립금 ${money(account.settings.deposit, 0)} · ${account.settings.formula === "basic" ? "기본 공식" : "실력공식"}`}>
      <h3>계좌 정보 고치기</h3>
      <Help><p>이번 주차 시작일이 다르면 고치세요. 모든 주차 날짜가 같은 일수만큼 옮겨져 2주 간격이 유지됩니다. 평단가는 증권사 앱의 평단가를 넣으면 매입금액·손익 계산에 씁니다.</p></Help>
      <form onSubmit={saveFix}>
        <div className="vr-fields">
          <label>이번 주차 시작일<input type="date" value={fix.startDate} onChange={(e) => setFix({ ...fix, startDate: e.target.value })} /></label>
          <label>이번 주차 시작 시점 평단가 (USD, 선택)<input type="number" min="0" step="any" value={fix.averageCost} placeholder={basis.averageCost == null ? "" : String(basis.averageCost)} onChange={(e) => setFix({ ...fix, averageCost: e.target.value })} /></label>
        </div>
        <button className="vr-secondary" type="submit">계좌 정보 저장</button>
      </form>
      <h3>운용 설정</h3>
      <form onSubmit={saveSettings}>
        <SettingsFields form={settings} onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))} />
        <button className="vr-secondary" type="submit">설정 저장</button>
      </form>
      <button type="button" className="vr-link vr-danger" onClick={onReset}>지우고 새로 시작 (이 브라우저의 VR 기록 삭제)</button>
    </Fold>
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
    if (!window.confirm("지금 계좌 기록(주차·체결·지난 기록)을 모두 지우고 처음 설정 화면으로 돌아갈까요? 되돌릴 수 없으니 필요하면 먼저 아래 \"JSON 백업\"으로 내려받으세요.")) return;
    deleteVrAccount(); setAccount(null); setStorageNote("기록을 지웠습니다. 새로 시작할 값을 입력하세요.");
    window.scrollTo?.({ top: 0, behavior: "smooth" });
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
      <div className="vr-intro"><h1>라오어 VR 적립식</h1><div className="vr-intro-actions"><span className="vr-chip">기록은 이 브라우저에만 저장</span>
        {account && <button type="button" className="vr-secondary vr-restart" onClick={reset}><RotateCcw size={14} /> 지우고 새로 시작</button>}</div></div>
      {storageNote && <p className="vr-message" role="status">{storageNote}</p>}
      {account ? <AccountView account={account} onChange={update} onReset={reset} /> : <SetupPanel onCreate={update} />}
      <details className="vr-fold">
        <summary><span className="vr-fold-title">백업 · 불러오기</span><span className="vr-fold-summary">{account ? `저장된 계좌: ${account.settings.ticker} · ${currentCycle(account).week}주차 진행 중` : "저장된 계좌가 없습니다."}</span><ChevronDown className="vr-fold-icon" size={18} aria-hidden="true" /></summary>
        <div className="vr-fold-body vr-backup">
          <span>기록은 이 브라우저에만 저장됩니다. 다른 기기에서 쓰려면 JSON으로 내려받아 불러오세요.</span>
          <div>
            {account && <button type="button" className="vr-secondary" onClick={download}><Download size={14} /> JSON 백업</button>}
            <label className="vr-secondary vr-upload"><Upload size={14} /> 백업 불러오기<input type="file" accept=".json,application/json" aria-label="VR 백업 불러오기" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
          </div>
        </div>
      </details>
      <details className="vr-fold">
        <summary><span className="vr-fold-title">계산 기준과 한계</span><span className="vr-fold-summary">quantstack 해설 · 구글 시트 v5.0.4</span><ChevronDown className="vr-fold-icon" size={18} aria-hidden="true" /></summary>
        <div className="vr-fold-body"><p className="vr-hint" style={{ marginTop: 0 }}>기본 V 공식은 비공식 해설(quantstack.app/vr), 실력공식·주문표·Pool 한도 감소·G 상향은 구글 시트 "VR 5.0.4 실력공식(글로벌커머스)"의 규칙을 따릅니다. 둘 다 라오어 카페 원문과 대조하지 않았습니다. 주문 전송·체결 확인 기능은 없으며, 계좌 기록은 이 브라우저에만 저장되고 서버로 전송되지 않습니다.</p></div>
      </details>
    </main><SiteFooter />
  </div>;
}
