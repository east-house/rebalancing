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

  it("versions a repaired dated report with its index generation time", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      reportDate: "2026-08-28",
      marketDate: "2026-08-27",
      accounts: {},
      nextActions: {},
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await loadTradingTestReport("2026-08-28", "2026-08-28T12:20:16Z");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trading-test-reports/2026-08-28?v=2026-08-28T12%3A20%3A16Z",
      expect.any(Object),
    );
  });
});
