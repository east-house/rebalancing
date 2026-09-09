import { reportJson as fetchJson } from "./reportTransport";

export interface MarketReportIndexItem {
  publicationStatus?: string;
  displayDate: string;
  marketDate: string;
  generatedAt: string;
  state: string;
  riskLevel: string;
  topSector: string;
  topTheme: string;
}

export interface MarketReportIndex {
  releaseId?: string;
  schemaVersion: number;
  updatedAt: string;
  latestDisplayDate: string;
  reports: MarketReportIndexItem[];
}

export type MarketReportRow = Record<
  string,
  string | number | boolean | null
>;

export interface MarketReportBundle {
  releaseId?: string;
  reconstructed?: boolean;
  schemaVersion: number;
  displayDate: string;
  marketDate: string;
  generatedAt: string;
  purpose: string;
  dashboardImage?: string;
  summary: {
    state: MarketReportRow;
    topSector: MarketReportRow | null;
    weakestSector: MarketReportRow | null;
    topTheme: MarketReportRow | null;
  };
  indices: MarketReportRow[];
  risks: MarketReportRow[];
  sectors: MarketReportRow[];
  themes: MarketReportRow[];
  leaders: MarketReportRow[];
  macro: MarketReportRow[];
  todayEvents: MarketReportRow[];
  upcomingEvents: MarketReportRow[];
  news: MarketReportRow[];
  macroAxes?: MarketReportRow[];
  newsClusters?: MarketReportRow[];
  transmissions?: MarketReportRow[];
  quality: Record<string, unknown>;
}

function assertIndex(value: MarketReportIndex): MarketReportIndex {
  if (![1, 2].includes(value.schemaVersion) || !Array.isArray(value.reports)) {
    throw new Error("지원하지 않는 시장 리포트 목록 형식입니다.");
  }
  return value;
}

function assertBundle(value: MarketReportBundle): MarketReportBundle {
  if (
    ![1, 2].includes(value.schemaVersion)
    || !value.displayDate
    || !value.marketDate
    || !value.summary
  ) {
    throw new Error("지원하지 않는 시장 리포트 형식입니다.");
  }
  return value;
}

export async function loadMarketReportIndex(): Promise<MarketReportIndex> {
  return assertIndex(
    await fetchJson<MarketReportIndex>(
      "/api/market-reports",
      "/data/market-reports/index.json",
    ),
  );
}

export async function loadMarketReport(displayDate: string, releaseId?: string): Promise<MarketReportBundle> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(displayDate)) {
    throw new Error("잘못된 리포트 날짜입니다.");
  }
  return assertBundle(
    await fetchJson<MarketReportBundle>(
      `/api/market-reports/${displayDate}${releaseId ? `?release=${encodeURIComponent(releaseId)}` : ""}`,
      `/data/market-reports/${displayDate}.json`,
    ),
  );
}

export function koreaCalendarDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function selectReportForKoreaDate(
  reports: readonly MarketReportIndexItem[],
  now = new Date(),
): MarketReportIndexItem | undefined {
  return reportsAvailableForKoreaDate(reports, now)[0];
}

function isReportAvailable(report: MarketReportIndexItem, now: Date): boolean {
  if (report.publicationStatus === "published") return true;
  const displayDay = new Date(`${report.displayDate}T12:00:00+09:00`).getUTCDay();
  if (displayDay === 0 || displayDay === 6) return false;
  const releaseTime = Date.parse(`${report.displayDate}T07:30:00+09:00`);
  if (!Number.isFinite(releaseTime) || releaseTime > now.getTime()) return false;

  return true;
}

export function reportsAvailableForKoreaDate(
  reports: readonly MarketReportIndexItem[],
  now = new Date(),
): MarketReportIndexItem[] {
  return [...reports]
    .filter((report) => isReportAvailable(report, now))
    .sort((left, right) => right.displayDate.localeCompare(left.displayDate));
}
