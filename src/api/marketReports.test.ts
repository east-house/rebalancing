import { describe, expect, it } from "vitest";

import {
  koreaCalendarDate,
  selectReportForKoreaDate,
  type MarketReportIndexItem,
} from "./marketReports";

const reports: MarketReportIndexItem[] = [
  {
    displayDate: "2026-08-17",
    marketDate: "2026-08-14",
    generatedAt: "2026-08-16T00:17:00+09:00",
    state: "상승 확산",
    riskLevel: "낮음",
    topSector: "건강관리 (Health Care)",
    topTheme: "사이버보안",
  },
  {
    displayDate: "2026-08-14",
    marketDate: "2026-08-13",
    generatedAt: "2026-08-14T07:40:00+09:00",
    state: "상승 중 조정",
    riskLevel: "보통",
    topSector: "에너지 (Energy)",
    topTheme: "우주·위성",
  },
];

describe("market report Korea-date selection", () => {
  it("formats the date in Asia/Seoul independently of browser timezone", () => {
    expect(koreaCalendarDate(new Date("2026-08-16T16:00:00Z"))).toBe("2026-08-17");
  });

  it("shows Friday market information on Monday", () => {
    const selected = selectReportForKoreaDate(reports, new Date("2026-08-17T01:00:00Z"));
    expect(selected?.displayDate).toBe("2026-08-17");
    expect(selected?.marketDate).toBe("2026-08-14");
  });

  it("keeps the latest weekday report during the weekend", () => {
    const selected = selectReportForKoreaDate(reports, new Date("2026-08-15T03:00:00Z"));
    expect(selected?.displayDate).toBe("2026-08-14");
  });
});
