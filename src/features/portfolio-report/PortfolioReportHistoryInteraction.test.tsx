import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ACCOUNT_KEY, advanceAccount, createAccount } from "./portfolioReportModel";
import { chain } from "./accountTestData";
import PortfolioReportPage from "./PortfolioReportPage";
vi.mock("../../api/portfolioReport", () => ({ loadPortfolioReportIndex: vi.fn(async () => ({ reports: [] })), loadPortfolioReport: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); });
it("views the saved historical account rather than pricing today's holdings backwards", async () => {
  const reports = chain(); reports[1].candidates.find(item => item.ticker === "A")!.rank = 20;
  const account = advanceAccount(createAccount("2026-08-31", 10000), reports);
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  render(<PortfolioReportPage onOpenReport={() => {}} onOpenPortfolio={() => {}} onOpenPortfolioReport={() => {}} onOpenEtfCompare={() => {}} />);
  fireEvent.change(await screen.findByLabelText("계좌 조회일"), { target: { value: "2026-08-31" } });
  expect(screen.getByText(/아직 체결된 보유 종목이 없습니다/)).toBeTruthy();
  expect(screen.getByText("체결 내역이 없습니다.")).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(ACCOUNT_KEY)!).trades).toEqual(account.trades);
});
