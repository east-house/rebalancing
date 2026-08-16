import { describe, expect, it } from "vitest";

import {
  koreaCalendarDate,
  reportsAvailableForKoreaDate,
  selectReportForKoreaDate,
  type MarketReportIndexItem,
} from "./marketReports";

const reports: MarketReportIndexItem[] = [
  {
    displayDate: "2026-08-17",
    marketDate: "2026-08-14",
    generatedAt: "2026-08-17T07:40:00+09:00",
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

  it("keeps today's report hidden before the 07:30 Korean release time", () => {
    const selected = selectReportForKoreaDate(reports, new Date("2026-08-16T21:00:00Z"));
    expect(selected?.displayDate).toBe("2026-08-14");
  });

  it("does not select a future-dated report", () => {
    const selected = selectReportForKoreaDate(reports, new Date("2026-08-15T03:00:00Z"));
    expect(selected?.displayDate).toBe("2026-08-14");
  });

  it("hides future dates from the report archive", () => {
    const available = reportsAvailableForKoreaDate(
      reports,
      new Date("2026-08-15T03:00:00Z"),
    );
    expect(available.map((report) => report.displayDate)).toEqual(["2026-08-14"]);
  });

  it("returns no report when the index contains only future dates", () => {
    const selected = selectReportForKoreaDate(
      reports.slice(0, 1),
      new Date("2026-08-15T03:00:00Z"),
    );
    expect(selected).toBeUndefined();
  });

  it("rejects a report generated before its display date", () => {
    const premature = [{
      ...reports[0],
      generatedAt: "2026-08-16T02:52:46+09:00",
    }];
    expect(selectReportForKoreaDate(premature, new Date("2026-08-17T01:00:00Z")))
      .toBeUndefined();
  });
});
