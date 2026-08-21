import { describe, expect, it } from "vitest";

import { calculateHistoryPerformance } from "./portfolioReportModel";

describe("portfolio report history performance", () => {
  it("calculates elapsed days and a negative return from a selected record", () => {
    const result = calculateHistoryPerformance({
      reportDate: "2026-08-01",
      marketDate: "2026-07-31",
      type: "DAILY",
      summary: "daily check",
      recordedAt: "2026-08-01T00:00:00.000Z",
      equity: 1_000,
    }, 925, "2026-08-17");

    expect(result?.elapsedDays).toBe(16);
    expect(result?.returnRate).toBeCloseTo(-0.075);
  });

  it("does not calculate performance for legacy records without a saved value", () => {
    expect(calculateHistoryPerformance({
      reportDate: "2026-08-01",
      marketDate: "2026-07-31",
      type: "DAILY",
      summary: "legacy",
      recordedAt: "2026-08-01T00:00:00.000Z",
    }, 1_000, "2026-08-17")).toBeNull();
  });
});
