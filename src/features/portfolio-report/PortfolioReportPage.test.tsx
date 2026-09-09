import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import reportJson from "../../../public/data/portfolio-reports/latest.json";
import type { PortfolioReportPayload } from "../../api/portfolioReport";
import PortfolioReportPage from "./PortfolioReportPage";

vi.mock("../../api/portfolioReport", () => ({
  loadPortfolioReportIndex: vi.fn(() => Promise.resolve({ reports: [{ reportDate: "2026-08-17", marketDate: "2026-08-14" }] })),
  loadPortfolioReport: vi.fn(() => Promise.resolve({ ...reportJson, stale_preview: false } as PortfolioReportPayload)),
}));

const navigation = {
  onOpenReport: vi.fn(),
  onOpenPortfolio: vi.fn(),
  onOpenPortfolioReport: vi.fn(),
  onOpenEtfCompare: vi.fn(),
};

describe("포트폴리오 보고서 화면", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("shows the four product tabs and creates a device-local initial report", async () => {
    render(<PortfolioReportPage {...navigation} />);

    expect(await screen.findByRole("heading", { name: "초기 포트폴리오 매수안" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "리포트" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "포트폴리오 관리" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "포트폴리오 보고서" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "ETF비교" })).toBeTruthy();
    expect(screen.getAllByText("매수")).toHaveLength(5);

    fireEvent.click(screen.getByRole("button", { name: "리포트" }));
    expect(navigation.onOpenReport).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "초기 리포트 저장" }));

    expect(await screen.findByRole("heading", { name: "오늘 확인할 행동" })).toBeTruthy();
    expect(localStorage.getItem("stock_strategy.us_portfolio.device.v1")).toContain("positions");
    expect(screen.getByText(/실제 증권사 잔고가 아니라/)).toBeTruthy();
  });

  it("does not write device history while an archived report is selected", async () => {
    render(<PortfolioReportPage {...navigation} />);
    fireEvent.click(await screen.findByRole("button", { name: "초기 리포트 저장" }));
    await screen.findByRole("heading", { name: "오늘 확인할 행동" });
    const before = localStorage.getItem("stock_strategy.us_portfolio.device.v1");
    fireEvent.change(await screen.findByRole("combobox", { name: "보고서 날짜" }), { target: { value: "2026-08-17" } });
    await screen.findByText("과거 보고서 조회 · 계좌 기록에 반영하지 않습니다.");
    fireEvent.click(screen.getByRole("button", { name: "매수·매도 제안을 모델 기록에 반영" }));
    expect(localStorage.getItem("stock_strategy.us_portfolio.device.v1")).toBe(before);
  });

  it("blocks an older latest response from changing newer device records after reload", async () => {
    const view = render(<PortfolioReportPage {...navigation} />);
    fireEvent.click(await screen.findByRole("button", { name: "초기 리포트 저장" }));
    await screen.findByRole("heading", { name: "오늘 확인할 행동" });
    const key = "stock_strategy.us_portfolio.device.v1";
    const state = JSON.parse(localStorage.getItem(key)!);
    state.history.push({ ...state.history[0], reportDate: "2099-01-01", recordedAt: "2099-01-01T00:00:00Z" });
    view.unmount();
    const before = JSON.stringify(state);
    localStorage.setItem(key, before);
    render(<PortfolioReportPage {...navigation} />);
    const button = await screen.findByRole("button", { name: "매수·매도 제안을 모델 기록에 반영" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(localStorage.getItem(key)).toBe(before);
  });
});
