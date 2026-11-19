import type { VrAccount, VrCycle, VrSettings } from "./vrModel";

export const VR_STORAGE_KEY = "tm.vr-installment";

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isSettings(value: unknown): value is VrSettings {
  return isObject(value) && typeof value.ticker === "string" && (value.formula === "basic" || value.formula === "skill")
    && ["g", "bandPct", "poolLimitPct", "deposit"].every((key) => isNumber(value[key]));
}

function isFill(value: unknown): boolean {
  return isObject(value) && typeof value.id === "string" && isDate(value.date) && (value.side === "buy" || value.side === "sell")
    && isNumber(value.price) && value.price > 0 && isNumber(value.quantity) && Number.isInteger(value.quantity) && value.quantity > 0;
}

function isCycle(value: unknown): value is VrCycle {
  if (!isObject(value)) return false;
  const numbers = ["index", "week", "g", "bandPct", "poolLimitPct", "previousV", "referenceClose", "previousValuation", "v", "lower", "upper",
    "shares", "poolBeforeDeposit", "deposit", "pool", "poolCap", "poolReserve"];
  if (!numbers.every((key) => isNumber(value[key])) || !isDate(value.startDate) || !isDate(value.endDate)) return false;
  if (value.formula !== "basic" && value.formula !== "skill") return false;
  if (value.fills !== undefined && !(Array.isArray(value.fills) && value.fills.every(isFill))) return false;
  if (value.averageCost !== undefined && !(isNumber(value.averageCost) && value.averageCost > 0)) return false;
  if (value.estimated !== undefined && typeof value.estimated !== "boolean") return false;
  if (value.close === undefined) return true;
  return isObject(value.close) && isNumber(value.close.shares) && isNumber(value.close.pool) && isNumber(value.close.price)
    && (value.close.averageCost === undefined || (isNumber(value.close.averageCost) && value.close.averageCost > 0));
}

function isStart(start: unknown): boolean {
  return isObject(start) && (start.kind === "new" || start.kind === "existing" || start.kind === "quick") && isDate(start.date)
    && isNumber(start.shares) && isNumber(start.pool) && isNumber(start.price) && isNumber(start.v0);
}

/** 저장본·백업 파일을 검증한다. 형식이 맞지 않으면 null. */
export function parseVrAccount(raw: string): VrAccount | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!isObject(value) || value.version !== 2 || !isSettings(value.settings) || !Array.isArray(value.cycles)) return null;
  if (!isStart(value.start)) return null;
  if (value.resumedStart !== undefined && !isStart(value.resumedStart)) return null;
  if (value.cycles.length === 0 || !value.cycles.every(isCycle)) return null;
  // 마감되지 않은 사이클은 마지막 하나뿐이어야 한다.
  if (value.cycles.slice(0, -1).some((cycle) => (cycle as VrCycle).close === undefined)) return null;
  if ((value.cycles.at(-1) as VrCycle).close !== undefined) return null;
  return value as unknown as VrAccount;
}

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function loadVrAccount(): VrAccount | null {
  try {
    const raw = storage()?.getItem(VR_STORAGE_KEY);
    return raw ? parseVrAccount(raw) : null;
  } catch { return null; }
}

export function saveVrAccount(account: VrAccount): boolean {
  try { storage()?.setItem(VR_STORAGE_KEY, JSON.stringify(account)); return Boolean(storage()); } catch { return false; }
}

export function deleteVrAccount(): void {
  try { storage()?.removeItem(VR_STORAGE_KEY); } catch { /* 저장소 접근 불가 */ }
}

export function exportVrAccount(account: VrAccount): string {
  return JSON.stringify(account, null, 2);
}
