import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Download, RotateCcw, Scale, Upload } from "lucide-react";
import ProductTabs from "../../components/ProductTabs";
import SiteFooter from "../../components/SiteFooter";
import {
  DEFAULT_INITIAL_POOL_RATIO, VR_DEFAULT_SETTINGS, V_FORMULA_LABELS, buildOrders, closeCycle, createExistingAccount,
  createNewAccount, currentCycle, formatOrdersText, gForWeek, poolLimitForWeek, reopenLastCycle, suggestInitialBuy,
  totalDeposits, validateSettings, valuationStatus, type OrderRow, type VFormula, type VrAccount, type VrCycle, type VrSettings,
} from "./vrModel";
import { deleteVrAccount, exportVrAccount, loadVrAccount, parseVrAccount, saveVrAccount } from "./vrStorage";
import "./vr.css";

interface Props {
  onOpenReport: () => void; onOpenPortfolio: () => void; onOpenPortfolioReport: () => void;
  onOpenTradingTestReport?: () => void; onOpenSoxlLoc?: () => void; onOpenVr?: () => void; onOpenEtfCompare: () => void;
}

const money = (value: number | null | undefined, digits = 2) => value == null ? "—" : `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const num = (value: string) => value.trim() === "" ? Number.NaN : Number(value);
const errorText = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

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

function SetupPanel({ onCreate }: { onCreate: (account: VrAccount) => void }) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [settings, setSettings] = useState<SettingsForm>(toForm(VR_DEFAULT_SETTINGS));
  const [plan, setPlan] = useState({ principal: "", refPrice: "", ratio: String(DEFAULT_INITIAL_POOL_RATIO) });
  const [fill, setFill] = useState({ date: "", shares: "", close: "", pool: "" });
  const [existing, setExisting] = useState({ cycleStartDate: "", week: "2", previousV: "", shares: "", poolBeforeDeposit: "", previousClose: "" });
  const [error, setError] = useState("");

  const suggestion = useMemo(() => {
    try { return suggestInitialBuy(num(plan.principal), num(plan.refPrice), num(plan.ratio)); } catch { return null; }
  }, [plan]);

  function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      const s = fromForm(settings);
      if (mode === "new") {
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
      <button type="button" role="tab" aria-selected={mode === "new"} className={mode === "new" ? "is-active" : ""} onClick={() => setMode("new")}>새로 시작</button>
      <button type="button" role="tab" aria-selected={mode === "existing"} className={mode === "existing" ? "is-active" : ""} onClick={() => setMode("existing")}>운용 중인 계좌 이어가기</button>
    </div>
    <form onSubmit={submit}>
      <h3>운용 설정</h3>
      <p className="vr-hint">기본값: 기준 G 10, 밴드 ±15%, 시작 Pool 사용 한도 75%. G는 52주마다 1씩 오르고, Pool 한도는 26주차부터 26주마다 5%p 내려 최저 10%가 됩니다(시트 v5.0.4 규칙). 설정은 나중에 바꿀 수 있고 다음 사이클부터 적용됩니다.</p>
      <SettingsFields form={settings} onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))} />
      {mode === "new" ? <>
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

function OrderTable({ title, rows, side }: { title: string; rows: OrderRow[]; side: "buy" | "sell" }) {
  return <div className={`vr-orders vr-orders--${side}`}>
    <h3>{title} <small>{rows.length}줄</small></h3>
    {rows.length === 0 ? <p className="vr-hint">주문 없음</p> : <div className="vr-orders-scroll"><table>
      <thead><tr><th>순번</th><th>지정가</th><th>수량</th><th>체결 후 보유</th><th>체결 후 Pool</th></tr></thead>
      <tbody>{rows.map((row, i) => <tr key={row.holdings}><td>{i + 1}</td><td>{money(row.price)}</td><td>1주</td><td>{row.holdings}주</td><td>{money(row.poolAfter)}</td></tr>)}</tbody>
    </table></div>}
  </div>;
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
  useEffect(() => { setCloseForm({ shares: String(cycle.shares), pool: "", price: "" }); setRefPrice(""); }, [cycle.index, cycle.shares]);

  const status = useMemo(() => {
    const price = num(refPrice);
    return Number.isFinite(price) && price > 0 ? valuationStatus(cycle, price) : null;
  }, [cycle, refPrice]);
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
    <section className="vr-panel" aria-labelledby="vr-cycle-title">
      <h2 id="vr-cycle-title">02 <span>{cycle.week}주차 · {cycle.startDate} ~ {cycle.endDate}</span></h2>
      <dl className="vr-stats">
        <div><dt>V (목표 평가금)</dt><dd>{money(cycle.v, 3)}</dd></div>
        <div><dt>V 최소 / 최대</dt><dd>{money(cycle.lower)} / {money(cycle.upper)}</dd></div>
        <div><dt>보유 수량</dt><dd>{cycle.shares}주</dd></div>
        <div><dt>시작일 Pool (적립 후)</dt><dd>{money(cycle.pool)}</dd></div>
        <div><dt>Pool 사용 한도</dt><dd>{money(cycle.poolCap)} <small>({cycle.poolLimitPct}%)</small></dd></div>
        <div><dt>G · 적립금</dt><dd>{cycle.g} · {money(cycle.deposit)}</dd></div>
      </dl>
      <p className="vr-hint">{formulaExplain(cycle)}. 적립금 {money(cycle.deposit)}을 계좌에 입금해야 시작일 Pool이 맞습니다.</p>
      <p className="vr-hint">다음 {nextWeek}주차: G {nextG}, Pool 사용 한도 {nextLimit}%{nextG !== cycle.g || nextLimit !== cycle.poolLimitPct ? " (변경됨)" : ""}.</p>
      <div className="vr-check">
        <label>현재가로 밴드 위치 확인 (USD)<input type="number" min="0" step="any" value={refPrice} onChange={(e) => setRefPrice(e.target.value)} /></label>
        {status && <p className={`vr-zone vr-zone--${status.zone}`}>평가금 {money(status.value)} · {status.zone === "below" ? "V 최소 아래: 매수 구간" : status.zone === "above" ? "V 최대 위: 매도 구간" : "밴드 안: 거래 없음"}</p>}
      </div>
    </section>

    <section className="vr-panel" aria-labelledby="vr-orders-title">
      <h2 id="vr-orders-title">03 <span>{cycle.week}주차 예약 주문표 · 지정가 1주씩</span></h2>
      <p className="vr-hint">
        시트 v5.0.4 규칙입니다. 매수 k번째는 V 최소 ÷ (보유 + k − 1), 매도 k번째는 V 최대 ÷ (보유 − k + 1)이며 1주씩 지정가 잔량 주문으로 사이클 끝까지 걸어 둡니다.
        매수는 매수 후 Pool이 {money(cycle.poolReserve)}(시작일 Pool × {roundPct(100 - cycle.poolLimitPct)}%) 이상이고 단가가 {money(orders.buyPriceFloor)}(직전 마감 종가 × 60%) 이상인 줄까지 만든 뒤 1줄을 더합니다. 매도는 1주가 남을 때까지 제한 없이 만듭니다.
        시트는 단가를 반올림하지 않으므로, 여기서는 매수가를 센트 단위로 내리고 매도가를 올립니다.
      </p>
      {cycle.shares === 0 && <p className="vr-error">보유 수량이 0주라 주문표를 만들 수 없습니다.</p>}
      <div className="vr-order-grid">
        <OrderTable title="매수" rows={orders.buys} side="buy" />
        <OrderTable title="매도" rows={orders.sells} side="sell" />
      </div>
      <button type="button" className="vr-secondary" onClick={() => void copy()}>주문표 복사</button>
    </section>

    <section className="vr-panel" aria-labelledby="vr-close-title">
      <h2 id="vr-close-title">04 <span>사이클 마감 · 다음 사이클 열기</span></h2>
      <p className="vr-hint">{cycle.endDate} 이전 마지막 거래일 장 마감 후 증권사의 실제 잔고를 입력합니다. Pool은 다음 적립금을 넣기 전 현금입니다.</p>
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
      <h2 id="vr-ledger-title">05 <span>사이클 원장</span></h2>
      <p className="vr-hint">시작 {account.start.date} · {account.start.kind === "new" ? `0일차 ${account.start.shares}주 × 종가 ${money(account.start.price)} = V0 ${money(account.start.v0)}, Pool ${money(account.start.pool)}` : `이어받은 직전 V ${money(account.start.v0, 3)}`} · 누적 적립금 {money(totalDeposits(account))}</p>
      <div className="vr-table-wrap"><table className="vr-ledger">
        <thead><tr><th>주차</th><th>시작일</th><th>공식</th><th>G</th><th>V</th><th>V 최소~최대</th><th>시작 수량</th><th>Pool(적립 후)</th><th>마감 수량</th><th>마감 Pool</th><th>마감 종가</th><th>마감 평가금</th><th>총자산</th></tr></thead>
        <tbody>{[...account.cycles].reverse().map((c) => {
          const value = c.close ? c.close.shares * c.close.price : null;
          return <tr key={c.index}>
            <td>{c.week}{c.close ? "" : " (진행)"}</td><td>{c.startDate}</td><td>{c.formula === "basic" ? "기본" : "실력"}</td><td>{c.g}</td><td>{money(c.v, 3)}</td>
            <td>{money(c.lower)}~{money(c.upper)}</td><td>{c.shares}</td><td>{money(c.pool)}</td><td>{c.close?.shares ?? "—"}</td>
            <td>{money(c.close?.pool)}</td><td>{money(c.close?.price)}</td><td>{money(value)}</td><td>{money(value == null ? null : value + c.close!.pool)}</td>
          </tr>;
        })}</tbody>
      </table></div>
    </section>

    <section className="vr-panel" aria-labelledby="vr-settings-title">
      <h2 id="vr-settings-title">06 <span>설정 변경</span></h2>
      <form onSubmit={saveSettings}>
        <SettingsFields form={settings} onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))} />
        <button className="vr-secondary" type="submit">설정 저장</button>
      </form>
      <button type="button" className="vr-link vr-danger" onClick={onReset}>이 브라우저의 VR 기록 삭제</button>
    </section>
  </>;
}

const roundPct = (value: number) => Math.round(value * 100) / 100;

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
