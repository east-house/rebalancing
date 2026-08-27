import { afterEach, describe, expect, it, vi } from "vitest";

import { loadTradingTestIndex, loadTradingTestReport } from "./tradingTestReports";

describe("trading-test report API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads the dated archive index", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-08-27T10:00:00Z",
      latestReportDate: "2026-08-27",
      reports: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(loadTradingTestIndex()).resolves.toMatchObject({ latestReportDate: "2026-08-27" });
  });

  it("rejects an invalid date before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadTradingTestReport("bad-date")).rejects.toThrow("잘못된");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
