import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MarketReportBundle, MarketReportIndex } from "../../api/marketReports";
import MarketReportPage from "./MarketReportPage";

const reportJson: MarketReportBundle = {
  schemaVersion: 2,
  displayDate: "2026-08-17",
  marketDate: "2026-08-14",
  generatedAt: "2026-08-17T07:40:00+09:00",
  purpose: "market intelligence only; no portfolio or orders",
  dashboardImage: "/api/market-reports/2026-08-17/dashboard",
  summary: {
    state: {
      state: "상승 확산",
      risk_level: "낮음",
      interpretation: "상승이 다수 종목으로 확산되고 있습니다.",
      sp500_return_1d: -0.0017,
      sp500_return_20d: 0.044,
      breadth_positive_1d: 0.507,
      breadth_above_ma50: 0.703,
      breadth_above_ma200: 0.745,
    },
    topSector: {
      sector: "Health Care",
      sector_display: "건강관리 (Health Care)",
      leader: "LLY",
      relative_20d: 0.017,
      score_change_1d: -1.2,
      rank_change_1d: 0,
    },
    weakestSector: {
      sector: "Utilities",
      sector_display: "유틸리티 (Utilities)",
      relative_20d: -0.067,
    },
    topTheme: {
      theme: "사이버보안",
      leader: "CRWD",
      relative_20d: 0.034,
      score_change_1d: 1.5,
      rank_change_1d: 1,
    },
  },
  indices: [{
    category: "주가지수",
    name: "S&P 500",
    ticker: "^GSPC",
    return_1d: -0.0017,
    return_20d: 0.044,
    ma200_gap: 0.1,
    chart_phase: "과열 상승",
  }],
  risks: [],
  sectors: [{
    sector: "Health Care",
    sector_display: "건강관리 (Health Care)",
    leader: "LLY",
    rank: 1,
    sector_score: 80.9,
    relative_20d: 0.017,
  }],
  themes: [{
    theme: "사이버보안",
    proxy: "CIBR",
    leader: "CRWD",
    rank: 1,
    theme_score: 78.8,
    relative_20d: 0.034,
  }],
  leaders: [],
  macro: [
    { series: "DGS10", indicator: "미국 10년물", value: 4.1, change: -0.05, unit: "%", observation_date: "2026-08-14", interpretation: "장기금리 하락" },
    { series: "CPIAUCSL", indicator: "CPI", value: 3, change: -0.1, unit: "%", observation_date: "2026-08-14", interpretation: "물가 변화" },
  ],
  todayEvents: [],
  upcomingEvents: [],
  news: [],
  macroAxes: [{ axis: "금리", status: "완화 방향", tone: "positive", evidence: "10년물 -0.05%p", market_read: "금리 민감 자산의 반응 확인" }],
  newsClusters: [],
  transmissions: [{
    driver: "장기금리",
    confirmation: "미확인",
    change: "미 10년물 직전 변화 -0.05%p",
    expected: "하락 시 성장주·부동산 우호",
    observed: "정보기술·부동산 평균 1일 상대 0.0%",
  }],
  quality: {
    ma50_breadth: {
      window_start: "2026-06-04",
      window_end: "2026-08-14",
      eligible_count: 502,
      universe_count: 503,
      passed: true,
    },
  },
};

const indexJson: MarketReportIndex = {
  schemaVersion: 2,
  updatedAt: "2026-08-17T07:40:00+09:00",
  latestDisplayDate: "2026-08-17",
  reports: [{
    displayDate: "2026-08-17",
    marketDate: "2026-08-14",
    generatedAt: "2026-08-17T07:40:00+09:00",
    state: "상승 확산",
    riskLevel: "낮음",
    topSector: "건강관리 (Health Care)",
    topTheme: "사이버보안",
  }],
};

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
    loadMarketReportIndex.mockResolvedValue(indexJson);
    loadMarketReport.mockResolvedValue(reportJson);
  });

  it("오늘의 결론과 시장 구조 대시보드를 함께 표시한다", async () => {
    render(<MarketReportPage onOpenPortfolio={vi.fn()} onOpenPortfolioReport={vi.fn()} onOpenEtfCompare={vi.fn()} now={new Date("2026-08-17T01:00:00Z")} />);

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
    expect(expandedImage.getAttribute("src")).toBe("/data/market-reports/2026-08-17.png");
    expect(screen.getByRole("heading", { name: "성장·물가·금리·위험선호" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "거시 변화의 가격 반영" })).toBeTruthy();
    expect(screen.getByText("가격 반응 미약")).toBeTruthy();
    expect(screen.getByText("일반적 예상")).toBeTruthy();
    expect(screen.getByText("실제 가격")).toBeTruthy();
    expect(screen.queryByText("화면 기준일")).toBeNull();
    expect(screen.queryByText("미국 거래일")).toBeNull();
    expect(screen.getByRole("button", { name: "포트폴리오 관리" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "포트폴리오 보고서" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ETF비교" })).toBeTruthy();
  });
});
