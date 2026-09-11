import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import base from "../../../public/data/trading-test-reports/latest.json";
import type { TradingTestReport } from "../../api/tradingTestReports";
import TradingTestReportPage from "./TradingTestReportPage";

const { loadIndex, loadReport } = vi.hoisted(() => ({ loadIndex: vi.fn(), loadReport: vi.fn() }));
vi.mock("../../api/tradingTestReports", () => ({
  loadTradingTestIndex: loadIndex, loadTradingTestReport: loadReport,
}));
vi.mock("../../components/ReportPublicationStatus", () => ({ default: () => null }));
vi.mock("../../api/useReportRefresh", () => ({ useReportRefresh: () => 0 }));

function fixture(day = "2026-09-11"): TradingTestReport {
  const value = structuredClone(base) as unknown as TradingTestReport;
  value.reportDate = day;
  value.marketDate = "2026-09-10";
  value.generatedAt = "2026-09-10T15:10:00Z";
  value.accounts["IRCS-BBCCI-M-G55"] = value.accounts["IRCS-BBCCI-M"];
  value.completedActions["IRCS-BBCCI-M-G55"] = value.completedActions["IRCS-BBCCI-M"];
  value.nextActions["IRCS-BBCCI-M-G55"] = value.nextActions["IRCS-BBCCI-M"];
  delete (value.accounts as Partial<TradingTestReport["accounts"]>)["IRCS-BBCCI-M"];
  value.accounts["IRCS-BBCCI-M-G55"].positions = [{
    ticker: "AAPL", shares: 10, entryDate: "2026-09-08", entryPrice: 100,
    currentPrice: 110, marketValue: 1100, unrealizedPnl: 100, unrealizedReturn: 0.1, themeBucket: "Technology",
  }];
  return value;
}

function mount() {
  return render(<TradingTestReportPage onOpenReport={vi.fn()} onOpenPortfolio={vi.fn()}
    onOpenPortfolioReport={vi.fn()} onOpenEtfCompare={vi.fn()} />);
}

describe("trading report presentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadIndex.mockResolvedValue({ latestReportDate: "2026-09-11", releaseId: "immutable-release", reports: [
      { reportDate: "2026-09-11", marketDate: "2026-09-10", generatedAt: "current" },
      { reportDate: "2026-09-09", marketDate: "2026-09-08", generatedAt: "older" },
    ] });
    loadReport.mockResolvedValue(fixture());
  });
  afterEach(cleanup);

  it("uses the shared report layout and formats dates without changing stored keys or strategies", async () => {
    const original = fixture();
    const before = JSON.stringify(original);
    loadReport.mockResolvedValue(original);
    const { container } = mount();
    await screen.findByRole("heading", { name: "매매테스트 보고서", level: 1 });
    expect(container.querySelector(".report-topbar")).toBeTruthy();
    expect(container.querySelector(".report-sidebar")).toBeTruthy();
    expect(screen.getByText("2026.09.11 · KOREA VIEW")).toBeTruthy();
    expect(screen.getByText("2026.09.11 00:10 KST")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "2026.09.08" })).toBeTruthy();
    expect(screen.getAllByText("M-G55 검증형").length).toBeGreaterThan(0);
    expect(screen.getAllByText("M-R2 검증형").length).toBeGreaterThan(0);
    expect(loadReport).toHaveBeenCalledWith("2026-09-11", "current", "immutable-release");
    expect(JSON.stringify(original)).toBe(before);
  });

  it("does not show the previous date's report while loading or after an archive failure", async () => {
    let reject!: (error: Error) => void;
    loadReport.mockResolvedValueOnce(fixture()).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    mount();
    await screen.findByRole("heading", { name: "매매테스트 보고서", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: /2026\.09\.09/ }));
    expect(screen.queryByRole("heading", { name: "매매테스트 보고서", level: 1 })).toBeNull();
    expect(loadReport).toHaveBeenLastCalledWith("2026-09-09", "older", "immutable-release");
    await act(async () => reject(new Error("archive unavailable")));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "archive unavailable");
    expect(screen.queryByText("2026.09.11 · KOREA VIEW")).toBeNull();
  });

  it("keeps legacy M/R2 report labels", async () => {
    loadReport.mockResolvedValue({ ...structuredClone(base), reportDate: "2026-09-11" });
    mount();
    expect((await screen.findAllByText("M 기본형(이전)")).length).toBeGreaterThan(0);
    expect(screen.queryByText("M-G55 검증형")).toBeNull();
  });

  it("shows an empty archive state", async () => {
    loadIndex.mockResolvedValue({ reports: [], latestReportDate: "" });
    mount();
    expect(await screen.findByText("표시할 매매테스트 보고서가 아직 없습니다.")).toBeTruthy();
    expect(loadReport).not.toHaveBeenCalled();
  });
});
