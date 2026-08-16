export interface MarketReportIndexItem {
  displayDate: string;
  marketDate: string;
  generatedAt: string;
  state: string;
  riskLevel: string;
  topSector: string;
  topTheme: string;
}

export interface MarketReportIndex {
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

async function fetchJson<T>(primary: string, fallback: string): Promise<T> {
  const paths = [primary, fallback];
  let lastError: unknown;
  for (const path of paths) {
    try {
      const response = await fetch(path, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error("JSON 응답이 아닙니다.");
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("리포트 데이터를 불러오지 못했습니다.");
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

export async function loadMarketReport(displayDate: string): Promise<MarketReportBundle> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(displayDate)) {
    throw new Error("잘못된 리포트 날짜입니다.");
  }
  return assertBundle(
    await fetchJson<MarketReportBundle>(
      `/api/market-reports/${displayDate}`,
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
  const displayDay = new Date(`${report.displayDate}T12:00:00+09:00`).getUTCDay();
  if (displayDay === 0 || displayDay === 6) return false;
  const releaseTime = Date.parse(`${report.displayDate}T07:30:00+09:00`);
  if (!Number.isFinite(releaseTime) || releaseTime > now.getTime()) return false;

  const normalizedGeneratedAt = report.generatedAt.includes("T")
    ? report.generatedAt
    : report.generatedAt.replace(" ", "T");
  const generatedAt = new Date(normalizedGeneratedAt);
  if (!Number.isNaN(generatedAt.getTime())) {
    const generatedDate = koreaCalendarDate(generatedAt);
    if (generatedDate < report.displayDate) return false;
  }
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
