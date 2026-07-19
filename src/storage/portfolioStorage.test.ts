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
  type LocalAppState,
} from "./portfolioStorage";

function createState(): LocalAppState {
  return {
    portfolio: {
      ...samplePortfolio,
      holdings: samplePortfolio.holdings.map((holding) => ({ ...holding })),
    },
    allocationMode: "target",
    pricePolicy: "previous",
    snapshots: sampleSnapshots.map((snapshot) => ({ ...snapshot })),
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
});
