import type { Portfolio, Snapshot } from "../domain";

export const PORTFOLIO_STORAGE_KEY = "balance.local-portfolio";
export const PORTFOLIO_STORAGE_VERSION = 3;
export const DEFAULT_PORTFOLIO_ID = "portfolio-default";

export type StoredPricePolicy = "auto";

export interface PortfolioWorkspace {
  id: string;
  name: string;
  portfolio: Portfolio;
  snapshots: Snapshot[];
  purchasePlanAmount: number;
}

export interface LocalAppState {
  activePortfolioId: string;
  portfolios: PortfolioWorkspace[];
  pricePolicy: StoredPricePolicy;
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
const MAX_PORTFOLIOS = 20;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const LEGACY_SAMPLE_SNAPSHOTS = new Map<string, number>([
  ["2025-08-01", 76_800_000],
  ["2025-09-01", 79_100_000],
  ["2025-10-01", 78_400_000],
  ["2025-11-01", 82_700_000],
  ["2025-12-01", 84_900_000],
  ["2026-01-01", 86_200_000],
  ["2026-02-01", 85_600_000],
  ["2026-03-01", 90_800_000],
  ["2026-04-01", 92_300_000],
  ["2026-05-01", 95_900_000],
  ["2026-06-01", 97_400_000],
  ["2026-07-17", 100_000_000],
]);

function cloneState(state: LocalAppState): LocalAppState {
  return {
    ...state,
    portfolios: state.portfolios.map((workspace) => ({
      ...workspace,
      portfolio: {
        ...workspace.portfolio,
        holdings: workspace.portfolio.holdings.map((holding) => ({ ...holding })),
      },
      snapshots: workspace.snapshots.map((snapshot) => ({ ...snapshot })),
    })),
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
  return upsertSnapshotForDate(snapshots, totalValue, getKstCalendarDate(now));
}

/** Keeps one value for the actual closing-price date used by the portfolio. */
export function upsertSnapshotForDate(
  snapshots: readonly Snapshot[],
  totalValue: number,
  priceDate: string,
): Snapshot[] {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(priceDate) ||
    Number.isNaN(Date.parse(`${priceDate}T00:00:00Z`))
  ) {
    return snapshots.map((snapshot) => ({ ...snapshot }));
  }

  const cutoff = new Date(`${priceDate}T00:00:00Z`);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  return [
    ...snapshots
      .filter(
        (snapshot) =>
          snapshot.date >= cutoffDate &&
          snapshot.date <= priceDate &&
          snapshot.date !== priceDate,
      )
      .map((snapshot) => ({ ...snapshot })),
    { date: priceDate, totalValue },
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

function isSafeText(value: unknown, maximumLength: number): value is string {
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
    const country =
      candidate.country === "KR" || candidate.country === "US"
        ? candidate.country
        : /^\d{6}$/.test(candidate.ticker)
          ? "KR"
          : "US";
    if (!isFiniteNumber(candidate.quantity)) return null;
    if (!Number.isInteger(candidate.quantity)) return null;
    const averagePrice =
      candidate.averagePrice === undefined ? 0 : candidate.averagePrice;
    if (!isFiniteNumber(averagePrice)) return null;
    if (!isFiniteNumber(candidate.targetWeight, 0, 100)) return null;

    return {
      ticker: candidate.ticker,
      name: candidate.name,
      assetType: candidate.assetType,
      country,
      quantity: candidate.quantity,
      averagePrice,
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

function removeLegacySampleSnapshots(snapshots: Snapshot[]): Snapshot[] {
  const sampleMatchCount = snapshots.filter(
    (snapshot) =>
      LEGACY_SAMPLE_SNAPSHOTS.get(snapshot.date) === snapshot.totalValue,
  ).length;

  if (sampleMatchCount < 3) return snapshots;
  return snapshots.filter(
    (snapshot) =>
      LEGACY_SAMPLE_SNAPSHOTS.get(snapshot.date) !== snapshot.totalValue,
  );
}

function parseWorkspace(value: unknown): PortfolioWorkspace | null {
  if (!isRecord(value)) return null;
  if (
    !isSafeText(value.id, 80) ||
    !/^[A-Za-z0-9_-]+$/.test(value.id) ||
    !isSafeText(value.name, 40)
  ) {
    return null;
  }
  const portfolio = parsePortfolio(value.portfolio);
  const snapshots = parseSnapshots(value.snapshots);
  const purchasePlanAmount =
    value.purchasePlanAmount === undefined ? 0 : value.purchasePlanAmount;
  if (!portfolio || !snapshots || !isFiniteNumber(purchasePlanAmount)) {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    portfolio,
    snapshots,
    purchasePlanAmount,
  };
}

/** Parses the current schema and migrates the preceding browser-only schema. */
export function parseLocalAppState(raw: string): LocalAppState | null {
  try {
    const envelope: unknown = JSON.parse(raw);
    if (!isRecord(envelope)) return null;
    if (
      envelope.version !== 1 &&
      envelope.version !== 2 &&
      envelope.version !== PORTFOLIO_STORAGE_VERSION
    ) {
      return null;
    }
    if (
      typeof envelope.updatedAt !== "string" ||
      Number.isNaN(Date.parse(envelope.updatedAt))
    ) {
      return null;
    }
    if (!isRecord(envelope.data)) return null;

    const storedPricePolicy = envelope.data.pricePolicy;
    if (
      storedPricePolicy !== "auto" &&
      storedPricePolicy !== "previous" &&
      storedPricePolicy !== "today"
    ) {
      return null;
    }

    if (envelope.version === PORTFOLIO_STORAGE_VERSION) {
      if (
        !isSafeText(envelope.data.activePortfolioId, 80) ||
        !Array.isArray(envelope.data.portfolios) ||
        envelope.data.portfolios.length === 0 ||
        envelope.data.portfolios.length > MAX_PORTFOLIOS
      ) {
        return null;
      }
      const activePortfolioId = envelope.data.activePortfolioId;
      const portfolios = envelope.data.portfolios.map(parseWorkspace);
      if (portfolios.some((workspace) => workspace === null)) return null;
      const validPortfolios = portfolios as PortfolioWorkspace[];
      if (
        new Set(validPortfolios.map((workspace) => workspace.id)).size !==
        validPortfolios.length
      ) {
        return null;
      }
      if (
        !validPortfolios.some(
          (workspace) => workspace.id === activePortfolioId,
        )
      ) {
        return null;
      }

      return {
        activePortfolioId,
        portfolios: validPortfolios,
        pricePolicy: "auto",
      };
    }

    const portfolio = parsePortfolio(envelope.data.portfolio);
    const snapshots = parseSnapshots(envelope.data.snapshots);
    if (!portfolio || !snapshots) return null;
    if (
      envelope.version === 1 &&
      envelope.data.allocationMode !== "current" &&
      envelope.data.allocationMode !== "target"
    ) {
      return null;
    }

    return {
      activePortfolioId: DEFAULT_PORTFOLIO_ID,
      portfolios: [
        {
          id: DEFAULT_PORTFOLIO_ID,
          name: "나의 포트폴리오",
          portfolio,
          snapshots:
            envelope.version === 1
              ? removeLegacySampleSnapshots(snapshots)
              : snapshots,
          purchasePlanAmount: 0,
        },
      ],
      pricePolicy: "auto",
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
