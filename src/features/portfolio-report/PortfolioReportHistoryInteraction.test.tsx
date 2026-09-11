import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import reportJson from "../../../public/data/portfolio-reports/latest.json";
import type { PortfolioReportPayload } from "../../api/portfolioReport";
import PortfolioReportPage from "./PortfolioReportPage";

vi.mock("../../api/portfolioReport", () => ({
  loadPortfolioReportIndex: vi.fn(() => Promise.resolve({ reports: [] })),
  loadPortfolioReport: vi.fn(() => Promise.resolve({ ...reportJson, stale_preview: false } as PortfolioReportPayload)),
}));

const navigation = {
  onOpenReport: vi.fn(),
  onOpenPortfolio: vi.fn(),
  onOpenPortfolioReport: vi.fn(),
  onOpenEtfCompare: vi.fn(),
};

describe("portfolio report record performance interaction", () => {
  beforeEach(() => localStorage.clear());

  it("shows elapsed days and return direction after saving and selecting a record", async () => {
    render(<PortfolioReportPage {...navigation} />);

    fireEvent.click(await screen.findByRole("button", { name: "초기 리포트 저장" }));

    const performance = await screen.findByLabelText("선택 기록 성과");
    expect(performance.textContent).toContain("0일 경과");
    expect(performance.textContent).toContain("변동 없음");
  });

  it("keeps all saved records selectable beyond the previous eight-record limit", async () => {
    const view = render(<PortfolioReportPage {...navigation} />);
    fireEvent.click(await screen.findByRole("button", { name: "초기 리포트 저장" }));
    const key = "stock_strategy.us_portfolio.device.v1";
    const state = JSON.parse(localStorage.getItem(key)!);
    const initial = state.history[0];
    state.history = Array.from({ length: 12 }, (_, i) => ({
      ...initial, type: "APPLY", summary: `record-${i}`,
      recordedAt: `2026-08-01T00:${String(i).padStart(2, "0")}:00Z`,
    }));
    view.unmount();
    localStorage.setItem(key, JSON.stringify(state));
    render(<PortfolioReportPage {...navigation} />);
    for (let i = 0; i < 12; i++) {
      expect(await screen.findByRole("button", { name: new RegExp(`record-${i}$`) })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: /record-0$/ }));
    expect(screen.getByLabelText("선택 기록 성과")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(key)!).history.slice(0, 12)).toEqual(state.history);
  });
});
