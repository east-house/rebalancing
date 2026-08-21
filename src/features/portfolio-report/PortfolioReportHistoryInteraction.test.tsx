import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import reportJson from "../../../public/data/portfolio-reports/latest.json";
import type { PortfolioReportPayload } from "../../api/portfolioReport";
import PortfolioReportPage from "./PortfolioReportPage";

vi.mock("../../api/portfolioReport", () => ({
  loadPortfolioReport: vi.fn(() => Promise.resolve(reportJson as PortfolioReportPayload)),
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
});
