import type { Portfolio, Snapshot } from "../domain";

export const PORTFOLIO_STORAGE_KEY = "balance.local-portfolio";
export const PORTFOLIO_STORAGE_VERSION = 1;

export type StoredAllocationMode = "current" | "target";
export type StoredPricePolicy = "previous" | "today";

export interface LocalAppState {
  portfolio: Portfolio;
  allocationMode: StoredAllocationMode;
  pricePolicy: StoredPricePolicy;
  snapshots: Snapshot[];
}

interface StorageEnvelope {
  version: typeof PORTFOLIO_STORAGE_VERSION;
  updatedAt: string;
  data: LocalAppState;
}

export type LocalStateSource =
  | "saved"
  | "default"
  | "invalid"
  | "unavailable";

export interface LoadLocalStateResult {
  state: LocalAppState;
  source: LocalStateSource;
}

const MAX_HOLDINGS = 500;
const MAX_SNAPSHOTS = 5_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

function cloneState(state: LocalAppState): LocalAppState {
  return {
    ...state,
    portfolio: {
      ...state.portfolio,
      holdings: state.portfolio.holdings.map((holding) => ({ ...holding })),
    },
    snapshots: state.snapshots.map((snapshot) => ({ ...snapshot })),
  };
}

export function getKstCalendarDate(now = new Date()): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Keeps one total-asset point per KST calendar day. Repeated edits on the same
 * day replace that day's value and values older than one year are discarded.
 */
export function upsertDailySnapshot(
  snapshots: readonly Snapshot[],
  totalValue: number,
  now = new Date(),
): Snapshot[] {
  const today = getKstCalendarDate(now);
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  return [
    ...snapshots
      .filter(
        (snapshot) =>
          snapshot.date >= cutoffDate &&
          snapshot.date <= today &&
          snapshot.date !== today,
      )
      .map((snapshot) => ({ ...snapshot })),
    { date: today, totalValue },
  ].sort((left, right) => left.date.localeCompare(right.date));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_VALUE,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isSafeText(value: unknown, maximumLength: number) {
  return typeof value === "string" && value.length <= maximumLength;
}

function parsePortfolio(value: unknown): Portfolio | null {
  if (!isRecord(value)) return null;
  if (!isFiniteNumber(value.totalAssets)) return null;
  if (!isFiniteNumber(value.targetCashWeight, 0, 100)) return null;
  if (
    !Array.isArray(value.holdings) ||
    value.holdings.length > MAX_HOLDINGS
  ) {
    return null;
  }

  const holdings = value.holdings.map((candidate) => {
    if (!isRecord(candidate)) return null;
    if (!isSafeText(candidate.ticker, 32)) return null;
    if (!isSafeText(candidate.name, 240)) return null;
    if (candidate.assetType !== "ETF" && candidate.assetType !== "STOCK") {
      return null;
    }
    if (!isFiniteNumber(candidate.quantity)) return null;
    if (!Number.isInteger(candidate.quantity)) return null;
    if (!isFiniteNumber(candidate.targetWeight, 0, 100)) return null;

    return {
      ticker: candidate.ticker,
      name: candidate.name,
      assetType: candidate.assetType,
      quantity: candidate.quantity,
      targetWeight: candidate.targetWeight,
    };
  });

  if (holdings.some((holding) => holding === null)) return null;

  return {
    totalAssets: value.totalAssets,
    targetCashWeight: value.targetCashWeight,
    holdings: holdings as Portfolio["holdings"],
  };
}

function parseSnapshots(value: unknown): Snapshot[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_SNAPSHOTS
  ) {
    return null;
  }

  const snapshots = value.map((candidate) => {
    if (!isRecord(candidate)) return null;
    if (
      typeof candidate.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(candidate.date) ||
      Number.isNaN(Date.parse(`${candidate.date}T00:00:00Z`))
    ) {
      return null;
    }
    if (!isFiniteNumber(candidate.totalValue)) return null;

    return {
      date: candidate.date,
      totalValue: candidate.totalValue,
    };
  });

  if (snapshots.some((snapshot) => snapshot === null)) return null;
  return snapshots as Snapshot[];
}

/** Parses only the current, explicitly versioned schema. */
export function parseLocalAppState(raw: string): LocalAppState | null {
  try {
    const envelope: unknown = JSON.parse(raw);
    if (!isRecord(envelope)) return null;
    if (envelope.version !== PORTFOLIO_STORAGE_VERSION) return null;
    if (
      typeof envelope.updatedAt !== "string" ||
      Number.isNaN(Date.parse(envelope.updatedAt))
    ) {
      return null;
    }
    if (!isRecord(envelope.data)) return null;

    const portfolio = parsePortfolio(envelope.data.portfolio);
    const snapshots = parseSnapshots(envelope.data.snapshots);
    const allocationMode = envelope.data.allocationMode;
    const pricePolicy = envelope.data.pricePolicy;

    if (!portfolio || !snapshots) return null;
    if (allocationMode !== "current" && allocationMode !== "target") return null;
    if (pricePolicy !== "previous" && pricePolicy !== "today") return null;

    return {
      portfolio,
      snapshots,
      allocationMode,
      pricePolicy,
    };
  } catch {
    return null;
  }
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadLocalAppState(
  defaults: LocalAppState,
  storage: Storage | null = getBrowserStorage(),
): LoadLocalStateResult {
  if (!storage) {
    return { state: cloneState(defaults), source: "unavailable" };
  }

  try {
    const raw = storage.getItem(PORTFOLIO_STORAGE_KEY);
    if (raw === null) {
      return { state: cloneState(defaults), source: "default" };
    }

    const state = parseLocalAppState(raw);
    return state
      ? { state, source: "saved" }
      : { state: cloneState(defaults), source: "invalid" };
  } catch {
    return { state: cloneState(defaults), source: "unavailable" };
  }
}

export function saveLocalAppState(
  state: LocalAppState,
  storage: Storage | null = getBrowserStorage(),
): boolean {
  if (!storage) return false;

  const envelope: StorageEnvelope = {
    version: PORTFOLIO_STORAGE_VERSION,
    updatedAt: new Date().toISOString(),
    data: cloneState(state),
  };

  try {
    storage.setItem(PORTFOLIO_STORAGE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

export function deleteLocalAppState(
  storage: Storage | null = getBrowserStorage(),
): boolean {
  if (!storage) return false;

  try {
    storage.removeItem(PORTFOLIO_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
