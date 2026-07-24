import { beforeEach, describe, expect, it } from "vitest";

import { samplePortfolio, sampleSnapshots } from "../domain";
import {
  deleteLocalAppState,
  loadLocalAppState,
  parseLocalAppState,
  PORTFOLIO_STORAGE_KEY,
  PORTFOLIO_STORAGE_VERSION,
  saveLocalAppState,
  upsertDailySnapshot,
  upsertSnapshotForDate,
  type LocalAppState,
} from "./portfolioStorage";

function createState(): LocalAppState {
  return {
    portfolio: {
      ...samplePortfolio,
      holdings: samplePortfolio.holdings.map((holding) => ({ ...holding })),
    },
    pricePolicy: "auto",
    snapshots: [{ date: "2026-07-24", totalValue: 123_000_000 }],
  };
}

describe("portfolioStorage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the current schema through localStorage", () => {
    const state = createState();

    expect(saveLocalAppState(state, localStorage)).toBe(true);
    const loaded = loadLocalAppState(createState(), localStorage);

    expect(loaded.source).toBe("saved");
    expect(loaded.state).toEqual(state);
    expect(
      JSON.parse(localStorage.getItem(PORTFOLIO_STORAGE_KEY) ?? "{}").version,
    ).toBe(PORTFOLIO_STORAGE_VERSION);
  });

  it("migrates saved holdings that predate purchase details", () => {
    const state = createState();
    const legacyHoldings = state.portfolio.holdings.map(
      ({
        averagePrice: _averagePrice,
        country: _country,
        ...holding
      }) => holding,
    );
    const raw = JSON.stringify({
      version: PORTFOLIO_STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      data: {
        ...state,
        portfolio: { ...state.portfolio, holdings: legacyHoldings },
      },
    });

    const parsed = parseLocalAppState(raw);

    expect(parsed?.portfolio.holdings[0]).toMatchObject({
      country: "US",
      averagePrice: 0,
    });
  });

  it("migrates the former manual price policy to automatic selection", () => {
    const state = createState();
    const raw = JSON.stringify({
      version: PORTFOLIO_STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      data: { ...state, pricePolicy: "previous" },
    });

    expect(parseLocalAppState(raw)?.pricePolicy).toBe("auto");
  });

  it("removes prototype chart points while preserving real history from v1", () => {
    const state = createState();
    const realSnapshot = { date: "2026-07-24", totalValue: 123_000_000 };
    const raw = JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      data: {
        ...state,
        allocationMode: "target",
        snapshots: [...sampleSnapshots, realSnapshot],
      },
    });

    expect(parseLocalAppState(raw)?.snapshots).toEqual([realSnapshot]);
  });

  it("accepts an empty chart history for a new device", () => {
    const state = { ...createState(), snapshots: [] };

    expect(saveLocalAppState(state, localStorage)).toBe(true);
    expect(loadLocalAppState(createState(), localStorage).state.snapshots).toEqual(
      [],
    );
  });

  it("falls back safely when JSON is corrupt or fields are invalid", () => {
    const defaults = createState();
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, "{broken");

    expect(loadLocalAppState(defaults, localStorage)).toEqual({
      state: defaults,
      source: "invalid",
    });

    const invalidEnvelope = JSON.stringify({
      version: PORTFOLIO_STORAGE_VERSION,
      updatedAt: new Date().toISOString(),
      data: {
        ...defaults,
        portfolio: {
          ...defaults.portfolio,
          holdings: [{ ...defaults.portfolio.holdings[0], quantity: -1 }],
        },
      },
    });
    expect(parseLocalAppState(invalidEnvelope)).toBeNull();
  });

  it("rejects unknown schema versions without throwing", () => {
    const state = createState();
    const futureEnvelope = JSON.stringify({
      version: PORTFOLIO_STORAGE_VERSION + 1,
      updatedAt: new Date().toISOString(),
      data: state,
    });

    expect(parseLocalAppState(futureEnvelope)).toBeNull();
  });

  it("deletes only the portfolio storage key", () => {
    localStorage.setItem(PORTFOLIO_STORAGE_KEY, "portfolio");
    localStorage.setItem("unrelated", "keep");

    expect(deleteLocalAppState(localStorage)).toBe(true);
    expect(localStorage.getItem(PORTFOLIO_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("unrelated")).toBe("keep");
  });

  it("upserts one KST snapshot per day and keeps only the latest year", () => {
    const snapshots = [
      { date: "2025-07-19", totalValue: 80_000_000 },
      { date: "2026-07-19", totalValue: 99_000_000 },
      { date: "2026-07-20", totalValue: 100_000_000 },
    ];
    const now = new Date("2026-07-20T03:00:00Z");

    const updated = upsertDailySnapshot(snapshots, 123_000_000, now);

    expect(updated).toEqual([
      { date: "2026-07-19", totalValue: 99_000_000 },
      { date: "2026-07-20", totalValue: 123_000_000 },
    ]);
  });

  it("uses the Asia/Seoul calendar date at the UTC day boundary", () => {
    const updated = upsertDailySnapshot(
      [{ date: "2026-07-19", totalValue: 100 }],
      200,
      new Date("2026-07-19T15:01:00Z"),
    );

    expect(updated.at(-1)).toEqual({
      date: "2026-07-20",
      totalValue: 200,
    });
  });

  it("stores the valuation under its R2 closing-price date", () => {
    const updated = upsertSnapshotForDate(
      [{ date: "2026-07-23", totalValue: 100 }],
      200,
      "2026-07-24",
    );

    expect(updated).toEqual([
      { date: "2026-07-23", totalValue: 100 },
      { date: "2026-07-24", totalValue: 200 },
    ]);
  });
});
