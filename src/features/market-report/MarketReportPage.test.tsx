import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import reportJson from "../../../public/data/market-reports/2026-08-16.json";
import indexJson from "../../../public/data/market-reports/index.json";
import type { MarketReportBundle, MarketReportIndex } from "../../api/marketReports";
import MarketReportPage from "./MarketReportPage";

const loadMarketReport = vi.fn();
const loadMarketReportIndex = vi.fn();

vi.mock("../../api/marketReports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/marketReports")>();
  return {
    ...actual,
    loadMarketReport: () => loadMarketReport(),
    loadMarketReportIndex: () => loadMarketReportIndex(),
  };
});

describe("시장 리포트 화면", () => {
  beforeEach(() => {
    loadMarketReportIndex.mockResolvedValue(indexJson as MarketReportIndex);
    loadMarketReport.mockResolvedValue(reportJson as unknown as MarketReportBundle);
  });

  it("오늘의 결론과 시장 구조 대시보드를 함께 표시한다", async () => {
    render(<MarketReportPage onBack={vi.fn()} now={new Date("2026-08-17T01:00:00Z")} />);

    expect(await screen.findByRole("heading", { name: "오늘의 결론" })).toBeTruthy();
    expect(screen.getByText("직전 거래일·발표와 비교")).toBeTruthy();
    expect(screen.getAllByLabelText(/^하락 /).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "전체 시장과 위험자산" })).toBeTruthy();
    expect(screen.getByText("지표 읽기")).toBeTruthy();
    expect(screen.getAllByText("과열 상승").length).toBeGreaterThan(0);
    expect(screen.getByAltText(/미국 시장 구조 대시보드/)).toBeTruthy();
    expect(screen.getByText(/기준일 종가가 최근 50거래일 평균보다 높은 종목 비율/)).toBeTruthy();
    expect(screen.getByText(/현재 계산 2026.06.04~2026.08.14 · 502\/503종목 · 원자료 검증 통과/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "시장 구조 대시보드 확대해서 보기" }));
    expect(screen.getByRole("dialog", { name: "시장 구조 대시보드 확대 보기" })).toBeTruthy();
    const expandedImage = screen.getByAltText(/시장 구조 대시보드 확대 이미지/);
    fireEvent.error(expandedImage);
    expect(expandedImage.getAttribute("src")).toBe("/data/market-reports/2026-08-16.png");
    expect(screen.getByRole("heading", { name: "성장·물가·금리·위험선호" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "거시 변화가 가격으로 전달됐는가" })).toBeTruthy();
  });
});
