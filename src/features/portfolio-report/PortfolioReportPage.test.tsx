import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadPortfolioReport, loadPortfolioReportIndex } from "../../api/portfolioReport";
import { ACCOUNT_KEY, LEGACY_KEY } from "./portfolioReportModel";
import { chain } from "./accountTestData";
import PortfolioReportPage from "./PortfolioReportPage";
vi.mock("../../api/portfolioReport", () => ({ loadPortfolioReport: vi.fn(), loadPortfolioReportIndex: vi.fn() }));
const navigation = { onOpenReport: vi.fn(), onOpenPortfolio: vi.fn(), onOpenPortfolioReport: vi.fn(), onOpenEtfCompare: vi.fn() };
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  const reports = chain();
  vi.mocked(loadPortfolioReportIndex).mockResolvedValue({ reports: reports.map(item => ({ reportDate: item.report_date_kst, marketDate: item.signal_market_date })) });
  vi.mocked(loadPortfolioReport).mockImplementation(async day => reports.find(item => item.report_date_kst === day)!);
});
afterEach(cleanup);
it("starts an integer account and shows cash, P&L, buy dates and the trade ledger", async () => {
  render(<PortfolioReportPage {...navigation} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "이 금액으로 계좌 시작" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.change(screen.getByLabelText("초기 투자금(USD)"), { target: { value: "10000" } });
  fireEvent.click(screen.getByRole("button", { name: "이 금액으로 계좌 시작" }));
  expect(await screen.findByLabelText("계좌 손익 요약")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "보유 종목과 수익" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "매수·매도 내역" })).toBeTruthy();
  const saved = JSON.parse(localStorage.getItem(ACCOUNT_KEY)!);
  expect(saved.days).toHaveLength(3); expect(saved.holdings.every((item: { shares: number }) => Number.isInteger(item.shares))).toBe(true);
  expect(saved.trades[0].executionDate).toBe("2026-08-31");
});
it("preserves old records and requires a new integer account instead of inventing fills", async () => {
  localStorage.setItem(LEGACY_KEY, JSON.stringify({ positions: [{ shares: 1.234 }] }));
  render(<PortfolioReportPage {...navigation} />);
  expect(await screen.findByRole("button", { name: "이전 기록 다운로드" })).toBeTruthy();
  expect(localStorage.getItem(LEGACY_KEY)).toContain("1.234");
  expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
});
it("does not save a partially updated account when a required report fails", async () => {
  vi.mocked(loadPortfolioReport).mockRejectedValue(new Error("missing report"));
  render(<PortfolioReportPage {...navigation} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "이 금액으로 계좌 시작" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "이 금액으로 계좌 시작" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "missing report");
  expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
});
