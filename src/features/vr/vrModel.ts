// 라오어 VR 5.0 적립식 계산 모델.
// 출처(모두 원문이 아닌 2차 자료, 라오어 카페 원문과 대조하지 않았다):
//  - V 공식 "기본": quantstack.app/vr  다음 V = V + Pool/G + 적립금
//  - V 공식 "실력공식", 주문표, Pool 한도 감소, G 상향, 밴드 내림:
//    구글 시트 "dj_VR 5.0.4 by.글로벌커머스_실력공식" (적립식!F10·G9·H9, 주문!C10·F10·J10, Setting!L45·L46)
// Pool은 적립 전 금액(직전 사이클 마감 Pool), 시트의 Week = 사이클 번호 × 2.

export const CYCLE_DAYS = 14;
export const WEEKS_PER_CYCLE = 2;
export const MIN_POOL_LIMIT_PCT = 10;
/** 시트 주문!J10: 매수 단가가 직전 마감 종가 × 60% 이상인 줄까지 생성 */
export const BUY_PRICE_FLOOR_RATIO = 0.6;

export type VFormula = "basic" | "skill";

export const V_FORMULA_LABELS: Record<VFormula, string> = {
  basic: "기본 (quantstack): V + Pool/G + 적립금",
  skill: "실력공식 (시트 v5.0.4): V + Pool/G + (평가금−V)/(2√G) + 적립금",
};

export interface VrSettings {
  ticker: string;
  /** 1~52주차 G. 이후 52주마다 +1 */
  g: number;
  bandPct: number;
  /** 시작 Pool 사용 한도. 26주차부터 26주마다 −5%p, 최저 10% */
  poolLimitPct: number;
  deposit: number;
  formula: VFormula;
}

export const VR_DEFAULT_SETTINGS: VrSettings = {
  ticker: "TQQQ",
  g: 10,
  bandPct: 15,
  poolLimitPct: 75,
  deposit: 250,
  formula: "basic",
};

/** quantstack 거치식 초기 세팅의 G/10 평균 P/V. 적립식 초기 비율은 원 방법론·시트 모두 명시가 없다. */
export const DEFAULT_INITIAL_POOL_RATIO = 0.15;

export interface VrCycleClose {
  shares: number;
  pool: number;
  price: number;
  /** 증권사 기준 마감 평단가(선택). 없으면 체결 기록으로 추정한다. */
  averageCost?: number;
}

export type FillSide = "buy" | "sell";

/** 사이클 중 증권사에서 체결된 거래 1건 */
export interface VrFill {
  id: string;
  date: string;
  side: FillSide;
  price: number;
  quantity: number;
}

export interface VrCycle {
  index: number;
  week: number;
  startDate: string;
  endDate: string;
  formula: VFormula;
  g: number;
  bandPct: number;
  poolLimitPct: number;
  previousV: number;
  /** 직전 사이클 마감 종가 */
  referenceClose: number;
  /** 직전 사이클 마감 평가금 = 시작 보유 수량 × 직전 마감 종가 */
  previousValuation: number;
  v: number;
  lower: number;
  upper: number;
  shares: number;
  poolBeforeDeposit: number;
  deposit: number;
  pool: number;
  poolCap: number;
  poolReserve: number;
  close?: VrCycleClose;
  /** 사이클 중 체결 기록(선택). 없으면 마감 때 입력한 잔고만 쓴다. */
  fills?: VrFill[];
  /** 사용자가 보정한 사이클 시작 평단가(선택) */
  averageCost?: number;
  /** 실제 기록이 아니라 일별 종가로 재구성한 지난 주차 */
  estimated?: boolean;
}

export type VBasis = "cost" | "market";

export interface VrStart {
  kind: "new" | "existing" | "quick";
  date: string;
  shares: number;
  pool: number;
  price: number;
  v0: number;
  /** 간단 이어가기: 평단가와 직전 V 기준 */
  averageCost?: number;
  basis?: VBasis;
}

export interface VrAccount {
  version: 2;
  createdAt: string;
  settings: VrSettings;
  start: VrStart;
  cycles: VrCycle[];
  /** 지난 기록을 재구성하기 전의 시작 정보(재구성을 지우면 되돌린다) */
  resumedStart?: VrStart;
}

export interface OrderRow {
  price: number;
  /** 체결 후 보유 수량 */
  holdings: number;
  /** 체결 후 Pool */
  poolAfter: number;
}

export interface VrOrders {
  buys: OrderRow[];
  sells: OrderRow[];
  buyPriceFloor: number;
}

const EPS = 1e-9;
export const roundTo = (value: number, digits: number) => {
  const factor = 10 ** digits;
  return Math.round(value * factor + Math.sign(value) * EPS) / factor;
};
export const roundCent = (value: number) => roundTo(value, 2);
export const floorCent = (value: number) => Math.floor(value * 100 + EPS) / 100;
export const ceilCent = (value: number) => Math.ceil(value * 100 - EPS) / 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function addDays(date: string, days: number): string {
  if (!DATE_RE.test(date)) throw new Error("날짜는 YYYY-MM-DD 형식이어야 합니다.");
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time)) throw new Error("올바른 날짜를 입력하세요.");
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

function requireFinite(value: number, label: string, { min = 0, integer = false, positive = false } = {}) {
  if (!Number.isFinite(value)) throw new Error(`${label}을(를) 숫자로 입력하세요.`);
  if (positive ? value <= 0 : value < min) throw new Error(`${label}이(가) 허용 범위를 벗어났습니다.`);
  if (integer && !Number.isInteger(value)) throw new Error(`${label}은(는) 정수여야 합니다.`);
}

export function validateSettings(settings: VrSettings): VrSettings {
  const ticker = settings.ticker.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) throw new Error("종목 코드를 확인하세요.");
  requireFinite(settings.g, "G", { positive: true });
  requireFinite(settings.bandPct, "밴드 폭", { positive: true });
  if (settings.bandPct >= 100) throw new Error("밴드 폭은 100% 미만이어야 합니다.");
  requireFinite(settings.poolLimitPct, "Pool 사용 한도", { positive: true });
  if (settings.poolLimitPct > 100) throw new Error("Pool 사용 한도는 100% 이하여야 합니다.");
  requireFinite(settings.deposit, "2주 적립금");
  if (settings.formula !== "basic" && settings.formula !== "skill") throw new Error("V 공식을 선택하세요.");
  return { ...settings, ticker };
}

/** 시트 Setting!L45: G = 기준 G + ROUNDUP(주차/52) − 1 (1~52주차는 기준 G) */
export function gForWeek(baseG: number, week: number): number {
  return baseG + Math.max(0, Math.ceil(week / 52) - 1);
}

/** 시트 Setting!L46: MAX(10%, 기준 − 5% × (ROUNDUP((주차+2)/26) − 1)) */
export function poolLimitForWeek(basePct: number, week: number): number {
  const steps = Math.max(0, Math.ceil((week + 2) / 26) - 1);
  return Math.max(MIN_POOL_LIMIT_PCT, roundTo(basePct - 5 * steps, 6));
}

/**
 * 기본: V + Pool/G + 적립금
 * 실력공식(시트 적립식!F10): V + ROUND(Pool/G,3) + ROUND((평가금−V)/ROUND(2√G,3),3) + 적립금
 */
export function nextV(formula: VFormula, v: number, poolBeforeDeposit: number, g: number, deposit: number, valuation: number): number {
  if (formula === "basic") return roundTo(v + poolBeforeDeposit / g + deposit, 3);
  const divisor = roundTo(2 * Math.sqrt(g), 3);
  return roundTo(v + roundTo(poolBeforeDeposit / g, 3) + roundTo((valuation - v) / divisor, 3) + deposit, 3);
}

export function openCycle(
  index: number,
  startDate: string,
  previousV: number,
  shares: number,
  poolBeforeDeposit: number,
  referenceClose: number,
  settings: VrSettings,
): VrCycle {
  const week = index * WEEKS_PER_CYCLE;
  const g = gForWeek(settings.g, week);
  const poolLimitPct = poolLimitForWeek(settings.poolLimitPct, week);
  const previousValuation = roundCent(shares * referenceClose);
  const v = nextV(settings.formula, previousV, poolBeforeDeposit, g, settings.deposit, previousValuation);
  const pool = roundCent(poolBeforeDeposit + settings.deposit);
  return {
    index,
    week,
    startDate,
    endDate: addDays(startDate, CYCLE_DAYS - 1),
    formula: settings.formula,
    g,
    bandPct: settings.bandPct,
    poolLimitPct,
    previousV,
    referenceClose,
    previousValuation,
    v,
    // 시트 적립식!G9·H9: ROUNDDOWN(V × 0.85, 2), ROUNDDOWN(V × 1.15, 2)
    lower: floorCent(v * (1 - settings.bandPct / 100)),
    upper: floorCent(v * (1 + settings.bandPct / 100)),
    shares,
    poolBeforeDeposit: roundCent(poolBeforeDeposit),
    deposit: settings.deposit,
    pool,
    // 시트 주문!P27·E3: 사용 한도 ROUNDDOWN, 남겨둘 Pool ROUNDUP
    poolCap: floorCent(pool * poolLimitPct / 100),
    poolReserve: ceilCent(pool * (1 - poolLimitPct / 100)),
  };
}

export interface InitialBuySuggestion {
  shares: number;
  cost: number;
  pool: number;
}

/** quantstack 초기 세팅: 매수액 = 원금 / (1 + P/V), 정수 주식 */
export function suggestInitialBuy(principal: number, price: number, poolRatio = DEFAULT_INITIAL_POOL_RATIO): InitialBuySuggestion {
  requireFinite(principal, "원금", { positive: true });
  requireFinite(price, "기준 가격", { positive: true });
  requireFinite(poolRatio, "초기 Pool 비율");
  const shares = Math.floor(principal / (1 + poolRatio) / price + EPS);
  const cost = roundCent(shares * price);
  return { shares, cost, pool: roundCent(principal - cost) };
}

export interface NewAccountInput {
  date: string;
  shares: number;
  /** 0일차(0주차) 마감 종가 */
  close: number;
  pool: number;
}

/** 0주차 매수 후 시작. 시트처럼 V0 = 보유 수량 × 0주차 마감 종가, 첫 사이클(2주차)은 14일 뒤. */
export function createNewAccount(settingsInput: VrSettings, input: NewAccountInput, createdAt = new Date().toISOString()): VrAccount {
  const settings = validateSettings(settingsInput);
  requireFinite(input.shares, "보유 수량", { integer: true, positive: true });
  requireFinite(input.close, "0일차 마감 종가", { positive: true });
  requireFinite(input.pool, "남은 현금(Pool)");
  const v0 = roundCent(input.shares * input.close);
  const start: VrStart = { kind: "new", date: input.date, shares: input.shares, pool: roundCent(input.pool), price: input.close, v0 };
  return {
    version: 2,
    createdAt,
    settings,
    start,
    cycles: [openCycle(1, addDays(input.date, CYCLE_DAYS), v0, input.shares, input.pool, input.close, settings)],
  };
}

export interface ExistingAccountInput {
  cycleStartDate: string;
  /** 시트 Week(짝수) */
  week: number;
  previousV: number;
  shares: number;
  poolBeforeDeposit: number;
  previousClose: number;
  /** 현재 평단가(선택). 매입금액·손익 표시에 쓴다. */
  averageCost?: number;
}

/** 운용 중인 계좌를 이어받는다. 직전 사이클 V·마감 종가와 현재 잔고로 이번 사이클을 연다. */
export function createExistingAccount(settingsInput: VrSettings, input: ExistingAccountInput, createdAt = new Date().toISOString()): VrAccount {
  const settings = validateSettings(settingsInput);
  requireFinite(input.week, "이번 사이클 주차", { integer: true, positive: true });
  if (input.week % WEEKS_PER_CYCLE !== 0) throw new Error("이번 사이클 주차는 짝수(2, 4, 6…)여야 합니다.");
  requireFinite(input.previousV, "직전 사이클 V", { positive: true });
  requireFinite(input.shares, "보유 수량", { integer: true });
  requireFinite(input.poolBeforeDeposit, "현재 Pool");
  requireFinite(input.previousClose, "직전 사이클 마감 종가", { positive: true });
  addDays(input.cycleStartDate, 0);
  const start: VrStart = {
    kind: "existing", date: input.cycleStartDate, shares: input.shares, pool: roundCent(input.poolBeforeDeposit),
    price: input.previousClose, v0: input.previousV,
    ...(input.averageCost != null && Number.isFinite(input.averageCost) && input.averageCost > 0 ? { averageCost: input.averageCost } : {}),
  };
  return {
    version: 2,
    createdAt,
    settings,
    start,
    cycles: [openCycle(input.week / WEEKS_PER_CYCLE, input.cycleStartDate, input.previousV, input.shares, input.poolBeforeDeposit, input.previousClose, settings)],
  };
}

export interface QuickResumeInput {
  cycleStartDate: string;
  /** 현재 주차. 홀수면 다음 짝수 주차 사이클로 본다. */
  week: number;
  shares: number;
  averageCost: number;
  /** 직전 마감 종가 */
  referenceClose: number;
  /** 모르면 0 */
  poolBeforeDeposit: number;
  basis: VBasis;
}

/** 사이클이 시작되는 짝수 주차. 시트 Week는 2씩 증가한다. */
export function cycleWeek(week: number): number {
  return Math.ceil(week / WEEKS_PER_CYCLE) * WEEKS_PER_CYCLE;
}

/**
 * 직전 V를 모를 때 이어가기. 직전 V를 대신하는 값:
 *  cost   = 보유 수량 × 평단가 (매수 원금 기준)
 *  market = 보유 수량 × 직전 마감 종가 (시트 0주차 V0와 같은 평가금 기준)
 * 원 방법론이나 시트에 있는 규칙이 아니라 이 화면의 근사이다.
 */
export function createQuickResumeAccount(settingsInput: VrSettings, input: QuickResumeInput, createdAt = new Date().toISOString()): VrAccount {
  const settings = validateSettings(settingsInput);
  requireFinite(input.week, "현재 주차", { integer: true, positive: true });
  requireFinite(input.shares, "보유 수량", { integer: true, positive: true });
  requireFinite(input.averageCost, "평단가", { positive: true });
  requireFinite(input.referenceClose, "직전 마감 종가", { positive: true });
  requireFinite(input.poolBeforeDeposit, "현재 현금(Pool)");
  if (input.basis !== "cost" && input.basis !== "market") throw new Error("V 시작 기준을 선택하세요.");
  addDays(input.cycleStartDate, 0);
  const previousV = roundCent(input.shares * (input.basis === "cost" ? input.averageCost : input.referenceClose));
  const week = cycleWeek(input.week);
  const start: VrStart = {
    kind: "quick", date: input.cycleStartDate, shares: input.shares, pool: roundCent(input.poolBeforeDeposit),
    price: input.referenceClose, v0: previousV, averageCost: input.averageCost, basis: input.basis,
  };
  return {
    version: 2,
    createdAt,
    settings,
    start,
    cycles: [openCycle(week / WEEKS_PER_CYCLE, input.cycleStartDate, previousV, input.shares, input.poolBeforeDeposit, input.referenceClose, settings)],
  };
}

export function currentCycle(account: VrAccount): VrCycle {
  const cycle = account.cycles.at(-1);
  if (!cycle) throw new Error("열린 사이클이 없습니다.");
  return cycle;
}

/** 사이클을 실제 잔고로 마감하고 현재 설정으로 다음 사이클을 연다. */
export function closeCycle(account: VrAccount, close: VrCycleClose): VrAccount {
  const cycle = currentCycle(account);
  requireFinite(close.shares, "마감 보유 수량", { integer: true });
  requireFinite(close.pool, "마감 Pool");
  requireFinite(close.price, "마감 종가", { positive: true });
  if (close.averageCost != null) requireFinite(close.averageCost, "마감 평단가", { positive: true });
  const settings = validateSettings(account.settings);
  const closed: VrCycle = {
    ...cycle,
    close: { shares: close.shares, pool: roundCent(close.pool), price: close.price, ...(close.averageCost != null ? { averageCost: roundCent(close.averageCost) } : {}) },
  };
  const next = openCycle(cycle.index + 1, addDays(cycle.startDate, CYCLE_DAYS), cycle.v, close.shares, close.pool, close.price, settings);
  return { ...account, cycles: [...account.cycles.slice(0, -1), closed, next] };
}

export interface FillTotals {
  count: number;
  buyQuantity: number;
  buyAmount: number;
  sellQuantity: number;
  sellAmount: number;
  /** 시작 수량 + 매수 − 매도 */
  shares: number;
  /** 시작일 Pool(적립 후) − 매수 금액 + 매도 금액 (수수료·세금 제외) */
  pool: number;
}

export function fillTotals(cycle: VrCycle, until?: string): FillTotals {
  const fills = (cycle.fills ?? []).filter((f) => until == null || f.date <= until);
  const sum = (side: FillSide, pick: (f: VrFill) => number) => fills.filter((f) => f.side === side).reduce((acc, f) => acc + pick(f), 0);
  const buyQuantity = sum("buy", (f) => f.quantity);
  const sellQuantity = sum("sell", (f) => f.quantity);
  const buyAmount = roundCent(sum("buy", (f) => f.price * f.quantity));
  const sellAmount = roundCent(sum("sell", (f) => f.price * f.quantity));
  return { count: fills.length, buyQuantity, buyAmount, sellQuantity, sellAmount, shares: cycle.shares + buyQuantity - sellQuantity, pool: roundCent(cycle.pool - buyAmount + sellAmount) };
}

let fillSeq = 0;

/** 열린 사이클에 체결 1건을 기록한다. */
export function addFill(account: VrAccount, input: Omit<VrFill, "id">): VrAccount {
  const cycle = currentCycle(account);
  if (!DATE_RE.test(input.date)) throw new Error("체결일을 입력하세요.");
  if (input.date < cycle.startDate || input.date > cycle.endDate) throw new Error(`체결일은 이번 사이클 기간(${cycle.startDate} ~ ${cycle.endDate}) 안이어야 합니다.`);
  requireFinite(input.price, "체결가", { positive: true });
  requireFinite(input.quantity, "체결 수량", { positive: true, integer: true });
  if (input.side === "sell" && input.quantity > fillTotals(cycle).shares) throw new Error("매도 수량이 현재 보유 수량보다 많습니다.");
  fillSeq += 1;
  const fill: VrFill = { id: `${Date.now().toString(36)}-${fillSeq}`, date: input.date, side: input.side, price: roundCent(input.price), quantity: input.quantity };
  const fills = [...(cycle.fills ?? []), fill].sort((a, b) => a.date.localeCompare(b.date));
  return { ...account, cycles: [...account.cycles.slice(0, -1), { ...cycle, fills }] };
}

export function removeFill(account: VrAccount, id: string): VrAccount {
  const cycle = currentCycle(account);
  const fills = (cycle.fills ?? []).filter((f) => f.id !== id);
  return { ...account, cycles: [...account.cycles.slice(0, -1), { ...cycle, fills }] };
}

/** 오늘 기준으로 마감이 밀린 사이클 수(0이면 진행 중). */
export function overdueCycles(cycle: VrCycle, today: string): number {
  if (today <= cycle.endDate) return 0;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${cycle.startDate}T00:00:00Z`)) / 86_400_000);
  return Math.floor(days / CYCLE_DAYS);
}

export interface CostBasis {
  /** 평단가. 모르면 null */
  averageCost: number | null;
  shares: number;
  /** 매입금액 = 평단가 × 보유 수량 */
  cost: number | null;
  /** 체결 기록 없이 늘어난 수량을 마감 종가로 샀다고 가정한 적이 있으면 true */
  estimated: boolean;
}

function startAverageCost(account: VrAccount): number | null {
  if (account.start.averageCost != null) return account.start.averageCost;
  return account.start.kind === "new" ? account.start.price : null;
}

/** 사이클 index 시점(until까지의 체결 반영)의 평단가·매입금액. 매수는 평단가를 바꾸고 매도는 평단가를 유지한다. */
export function costBasis(account: VrAccount, index = account.cycles.length - 1, until?: string): CostBasis {
  let avg = startAverageCost(account);
  let estimated = false;
  let shares = account.cycles[0]?.shares ?? 0;
  for (let k = 0; k <= index && k < account.cycles.length; k += 1) {
    const cycle = account.cycles[k];
    if (cycle.averageCost != null) { avg = cycle.averageCost; estimated = false; }
    else if (cycle.estimated) estimated = true;
    shares = cycle.shares;
    let cost = avg == null ? null : avg * shares;
    for (const fill of cycle.fills ?? []) {
      if (k === index && until != null && fill.date > until) continue;
      if (fill.side === "buy") { if (cost != null) cost += fill.price * fill.quantity; shares += fill.quantity; }
      else { if (cost != null && avg != null) cost -= avg * fill.quantity; shares -= fill.quantity; }
      avg = cost != null && shares > 0 ? cost / shares : avg;
    }
    if (k === index || !cycle.close) break;
    if (cycle.close.averageCost != null) { avg = cycle.close.averageCost; estimated = false; }
    else if (cost != null && cycle.close.shares > shares) {
      cost += (cycle.close.shares - shares) * cycle.close.price;
      avg = cost / cycle.close.shares;
      estimated = true;
    }
    shares = cycle.close.shares;
  }
  const average = avg == null ? null : roundCent(avg);
  return { averageCost: average, shares, cost: average == null ? null : roundCent(average * shares), estimated };
}

/** 계좌 시작 시점의 자본(보유분 매입금액 + 적립 전 현금). 평단가를 모르면 null */
export function startingCapital(account: VrAccount): number | null {
  const avg = startAverageCost(account);
  return avg == null ? null : roundCent(account.start.shares * avg + account.start.pool);
}

/** 이번(열린) 사이클의 시작 평단가를 보정한다. */
export function setCurrentAverageCost(account: VrAccount, averageCost: number): VrAccount {
  requireFinite(averageCost, "평단가", { positive: true });
  const cycle = currentCycle(account);
  return { ...account, cycles: [...account.cycles.slice(0, -1), { ...cycle, averageCost: roundCent(averageCost) }] };
}

/** 이번 사이클 시작일을 바꾼다. 2주 간격을 유지하도록 모든 사이클 날짜를 같은 일수만큼 옮긴다. */
export function rescheduleCurrentCycle(account: VrAccount, startDate: string): VrAccount {
  if (!DATE_RE.test(startDate)) throw new Error("시작일을 입력하세요.");
  const cycle = currentCycle(account);
  const delta = Math.round((Date.parse(`${startDate}T00:00:00Z`) - Date.parse(`${cycle.startDate}T00:00:00Z`)) / 86_400_000);
  if (delta === 0) return account;
  if (account.cycles.some((c) => c.estimated)) throw new Error("재구성한 지난 기록이 있으면 시작일을 옮길 수 없습니다. 지난 기록에서 재구성 기록을 먼저 지우세요.");
  const cycles = account.cycles.map((c) => ({ ...c, startDate: addDays(c.startDate, delta), endDate: addDays(c.endDate, delta) }));
  for (const c of cycles) {
    if ((c.fills ?? []).some((f) => f.date < c.startDate || f.date > c.endDate)) throw new Error("옮긴 기간 밖에 있는 체결 기록이 있습니다. 해당 기록을 먼저 지우세요.");
  }
  return { ...account, start: { ...account.start, date: addDays(account.start.date, delta) }, cycles };
}

/** 직전 마감을 취소하고 그 사이클을 다시 연다(입력 실수 정정용). */
/** 실제로 기록한 첫 사이클의 위치(재구성한 지난 기록 다음) */
export function firstRealIndex(account: VrAccount): number {
  const index = account.cycles.findIndex((c) => !c.estimated);
  return index < 0 ? account.cycles.length - 1 : index;
}

export function hasEstimatedHistory(account: VrAccount): boolean {
  return account.cycles.some((c) => c.estimated);
}

/** 재구성한 지난 기록을 지우고 이어받을 때의 상태로 되돌린다. */
export function removeEstimatedHistory(account: VrAccount): VrAccount {
  if (!hasEstimatedHistory(account)) return account;
  const { resumedStart, ...rest } = account;
  return { ...rest, start: resumedStart ?? account.start, cycles: account.cycles.filter((c) => !c.estimated) };
}

export function reopenLastCycle(account: VrAccount): VrAccount {
  if (account.cycles.length < 2) throw new Error("되돌릴 마감 기록이 없습니다.");
  const previous = account.cycles.at(-2)!;
  if (previous.estimated) throw new Error("재구성한 지난 기록은 되돌릴 수 없습니다.");
  const { close: _removed, ...reopened } = previous;
  return { ...account, cycles: [...account.cycles.slice(0, -2), reopened] };
}

export function valuationStatus(cycle: VrCycle, price: number): { value: number; zone: "below" | "inside" | "above" } {
  const value = roundCent(cycle.shares * price);
  return { value, zone: value < cycle.lower ? "below" : value > cycle.upper ? "above" : "inside" };
}

const MAX_BUY_ROWS = 1000;

/**
 * 시트 주문 탭 규칙(1주씩 지정가 잔량 주문):
 *  매수 k번째: V최소 ÷ (보유 + k − 1). 매수 후 Pool ≥ 남겨둘 Pool, 단가 ≥ 직전 마감 종가 × 60%인 줄까지 + 1줄.
 *  매도 k번째: V최대 ÷ (보유 − k + 1). 제한 없이 1주가 남을 때까지.
 * 시트는 단가를 반올림하지 않는다. 여기서는 주문 가능한 센트 단위로 매수는 내림, 매도는 올림한다.
 * 추가 1줄은 Pool이 음수가 되면 만들지 않는다(시트에는 없는 보호 조건).
 */
export function buildOrders(cycle: VrCycle): VrOrders {
  const n = cycle.shares;
  const buyPriceFloor = roundCent(cycle.referenceClose * BUY_PRICE_FLOOR_RATIO);
  if (n <= 0) return { buys: [], sells: [], buyPriceFloor };

  const buys: OrderRow[] = [];
  let pool = cycle.pool;
  for (let k = 1; k <= MAX_BUY_ROWS; k += 1) {
    const price = floorCent(cycle.lower / (n + k - 1));
    if (price <= 0) break;
    const poolAfter = roundCent(pool - price);
    const withinRule = poolAfter >= cycle.poolReserve - EPS && price >= buyPriceFloor - EPS;
    if (!withinRule) {
      if (poolAfter >= -EPS) buys.push({ price, holdings: n + k, poolAfter });
      break;
    }
    buys.push({ price, holdings: n + k, poolAfter });
    pool = poolAfter;
  }

  const sells: OrderRow[] = [];
  pool = cycle.pool;
  for (let k = 1; k < n; k += 1) {
    const price = ceilCent(cycle.upper / (n - k + 1));
    pool = roundCent(pool + price);
    sells.push({ price, holdings: n - k, poolAfter: pool });
  }

  return { buys, sells, buyPriceFloor };
}

export function totalDeposits(account: VrAccount): number {
  return roundCent(account.cycles.reduce((sum, cycle) => sum + cycle.deposit, 0));
}

/** 주문표는 주차 동안 고정이고, 체결은 각 쪽 줄을 위에서부터 1줄(1주)씩 써 버린다. 체결된 줄 수를 센다. */
export function filledRows(orders: VrOrders, cycle: VrCycle): { buys: number; sells: number } {
  const t = fillTotals(cycle);
  return { buys: Math.min(t.buyQuantity, orders.buys.length), sells: Math.min(t.sellQuantity, orders.sells.length) };
}

/** 아직 체결되지 않은 줄만 남긴 주문표 */
export function remainingOrders(orders: VrOrders, cycle: VrCycle): VrOrders {
  const filled = filledRows(orders, cycle);
  return { ...orders, buys: orders.buys.slice(filled.buys), sells: orders.sells.slice(filled.sells) };
}

export function formatOrdersText(ticker: string, cycle: VrCycle, orders: VrOrders): string {
  const lines = [`${ticker} VR ${cycle.week}주차 ${cycle.startDate}~${cycle.endDate} · V $${cycle.v.toFixed(3)} · 지정가 1주씩`];
  lines.push("[매수]");
  if (orders.buys.length === 0) lines.push("없음");
  for (const row of orders.buys) lines.push(`$${row.price.toFixed(2)} 1주 (체결 후 ${row.holdings}주)`);
  lines.push("[매도]");
  if (orders.sells.length === 0) lines.push("없음");
  for (const row of orders.sells) lines.push(`$${row.price.toFixed(2)} 1주 (체결 후 ${row.holdings}주)`);
  return lines.join("\n");
}
