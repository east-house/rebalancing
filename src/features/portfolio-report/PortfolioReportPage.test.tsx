import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadPortfolioCashQuote, loadPortfolioCoreQuote, loadPortfolioReport, loadPortfolioReportIndex, loadPortfolioStrategyInputs } from "../../api/portfolioReport";
import { ACCOUNT_KEY, LEGACY_KEY } from "./portfolioReportModel";
import { chain } from "./accountTestData";
import PortfolioReportPage from "./PortfolioReportPage";
vi.mock("../../api/portfolioReport", () => ({ loadPortfolioReport: vi.fn(), loadPortfolioReportIndex: vi.fn(), loadPortfolioCoreQuote: vi.fn(),
  loadPortfolioCashQuote: vi.fn(), loadPortfolioStrategyInputs: vi.fn() }));
const navigation = { onOpenReport: vi.fn(), onOpenPortfolio: vi.fn(), onOpenPortfolioReport: vi.fn(), onOpenEtfCompare: vi.fn() };
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  const reports = chain();
  vi.mocked(loadPortfolioReportIndex).mockResolvedValue({ reports: reports.map(item => ({ reportDate: item.report_date_kst, marketDate: item.signal_market_date })) });
  vi.mocked(loadPortfolioReport).mockImplementation(async day => reports.find(item => item.report_date_kst === day)!);
  vi.mocked(loadPortfolioCoreQuote).mockImplementation(async day => {
    const report = reports.find(item => item.report_date_kst === day)!;
    return { schema_version: 1, report_date_kst: day, signal_market_date: report.signal_market_date, ticker: "SPYM", name: "SPDR Portfolio S&P 500 ETF", proxy_for: "IVV", close: 60 };
  });
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
  expect(saved.holdings.map((item: { ticker: string }) => item.ticker)).toContain("SPYM");
  expect(saved.holdings.map((item: { ticker: string }) => item.ticker)).not.toContain("IVV");
});
it("stops with a clear message instead of trading when the SPYM close is not published", async () => {
  vi.mocked(loadPortfolioCoreQuote).mockRejectedValue(new Error("404"));
  render(<PortfolioReportPage {...navigation} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "이 금액으로 계좌 시작" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "이 금액으로 계좌 시작" }));
  expect((await screen.findByRole("alert")).textContent).toContain("SPYM");
  expect(localStorage.getItem(ACCOUNT_KEY)).toBeNull();
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
it("starts an account with the chosen start date and cash share", async () => {
  render(<PortfolioReportPage {...navigation} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "이 금액으로 계좌 시작" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("시작 보고일"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("초기 투자금(USD)"), { target: { value: "10000" } });
  fireEvent.change(screen.getByLabelText("현금 비중"), { target: { value: "0.2" } });
  fireEvent.click(screen.getByRole("button", { name: "이 금액으로 계좌 시작" }));
  expect(await screen.findByLabelText("계좌 손익 요약")).toBeTruthy();
  const saved = JSON.parse(localStorage.getItem(ACCOUNT_KEY)!);
  expect(saved.startDate).toBe("2026-09-01"); expect(saved.cashReserve).toBe(0.2);
  expect(screen.getAllByText(/현금 비중 20.0% 설정 \(기본 0.0%\)/).length).toBeGreaterThan(0);
});
it("defaults the cash share to each strategy's design (I2/C1 40%, I1 0%)", async () => {
  render(<PortfolioReportPage {...navigation} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "이 금액으로 계좌 시작" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("현금 비중") as HTMLSelectElement).value).toBe("0");
  fireEvent.click(screen.getByRole("button", { name: /^I2/ }));
  expect((screen.getByLabelText("현금 비중") as HTMLSelectElement).value).toBe("0.4");
  expect(screen.getByRole("option", { name: "40% (기본 설계)" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^C1/ }));
  expect((screen.getByLabelText("현금 비중") as HTMLSelectElement).value).toBe("0.4");
  fireEvent.click(screen.getByRole("button", { name: /^I1/ }));
  expect((screen.getByLabelText("현금 비중") as HTMLSelectElement).value).toBe("0");
});
it("starts a C1 account that holds the cash share in BIL", async () => {
  const reports = chain();
  const series = (seed: number, drift: number) => Array.from({ length: 252 }, (_, t) => drift + 0.01 * Math.sin(seed * 7 + t * 1.3));
  vi.mocked(loadPortfolioStrategyInputs).mockImplementation(async day => {
    const report = reports.find(item => item.report_date_kst === day)!;
    return { schema_version: 1, report_date_kst: day, signal_market_date: report.signal_market_date, tickers: {},
      returns: { IVV: series(1, 0.0004), A: series(2, 0.003), B: series(3, 0.002), C: series(4, 0.001), D: series(5, 0.0015) },
      i2: { ivv_weight: 0.2, stock_cap_each_full_kelly: 0.4, stock_budget_full_kelly: 0.8, kelly_fraction: 0.5, lookback: 252, min_observations: 126, fee_daily: 0.0002 },
      s1: { ivv_weight: 0.2, stock_budget: 0.8, positions: 3, pool_size: 20, hold_order_rank: 5, max_names_per_gics_sector: 1, pool_price_weight: 0.2, price_margin: 0.9, ordering: "mom_12_1", ordering_source: "test" } };
  });
  vi.mocked(loadPortfolioCashQuote).mockImplementation(async day => {
    const report = reports.find(item => item.report_date_kst === day)!;
    return { schema_version: 1, report_date_kst: day, signal_market_date: report.signal_market_date, ticker: "BIL", name: "SPDR Bloomberg 1-3 Month T-Bill ETF", proxy_for: "cash", close: 91 };
  });
  render(<PortfolioReportPage {...navigation} />);
  await waitFor(() => expect((screen.getByRole("button", { name: "이 금액으로 계좌 시작" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: /^C1/ }));
  fireEvent.change(screen.getByLabelText("초기 투자금(USD)"), { target: { value: "10000" } });
  fireEvent.click(screen.getByRole("button", { name: "이 금액으로 계좌 시작" }));
  expect(await screen.findByLabelText("계좌 손익 요약")).toBeTruthy();
  const saved = JSON.parse(localStorage.getItem(`${ACCOUNT_KEY}.c1`)!);
  expect(saved.strategy).toBe("c1"); expect(saved.cashReserve).toBe(0.4);
  expect(saved.holdings.map((item: { ticker: string }) => item.ticker)).toContain("BIL");
  expect(screen.getByText("단기국채 ETF (BIL)")).toBeTruthy();
  expect(screen.getAllByText("현금 대체(단기국채 ETF)").length).toBeGreaterThan(0);
});
