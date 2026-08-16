import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import reportJson from "../../../public/data/portfolio-reports/latest.json";
import type { PortfolioReportPayload } from "../../api/portfolioReport";
import PortfolioReportPage from "./PortfolioReportPage";

vi.mock("../../api/portfolioReport", () => ({
  loadPortfolioReport: vi.fn(() => Promise.resolve(reportJson as PortfolioReportPayload)),
}));

const navigation = {
  onOpenPortfolio: vi.fn(),
  onOpenPortfolioReport: vi.fn(),
  onOpenEtfCompare: vi.fn(),
};

describe("포트폴리오 보고서 화면", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("shows the three product tabs and creates a device-local initial report", async () => {
    render(<PortfolioReportPage {...navigation} />);

    expect(await screen.findByRole("heading", { name: "초기 포트폴리오 매수안" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "포트폴리오 관리" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "포트폴리오 보고서" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "ETF비교" })).toBeTruthy();
    expect(screen.getAllByText("매수")).toHaveLength(5);

    fireEvent.click(screen.getByRole("button", { name: "초기 리포트 저장" }));

    expect(await screen.findByRole("heading", { name: "오늘 확인할 행동" })).toBeTruthy();
    expect(localStorage.getItem("stock_strategy.us_portfolio.device.v1")).toContain("positions");
    expect(screen.getByText(/실제 증권사 잔고가 아니라/)).toBeTruthy();
  });
});
