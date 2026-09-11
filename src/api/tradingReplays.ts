import type { TradingTestReport } from "./tradingTestReports";

export interface ReplayIndex {
  schemaVersion: number;
  releaseId: string;
  lastMarketDate: string;
  starts: string[];
}

export interface ReplayBundle {
  schemaVersion: number;
  startDate: string;
  firstSignalSession: string;
  lastMarketDate: string;
  audit: { status: string; indicatorValidation: string; warmupStart: string; symbolCount: number; missingBars: unknown[] };
  reports: TradingTestReport[];
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-cache", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`재현 보고서 조회 실패 (${response.status})`);
  return response.json() as Promise<T>;
}

export async function loadReplayIndex(): Promise<ReplayIndex> {
  const value = await getJson<ReplayIndex>("/data/trading-replays/index.json");
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{20}$/.test(value.releaseId)
      || !Array.isArray(value.starts) || !value.starts.length
      || !value.starts.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && s <= value.lastMarketDate)) {
    throw new Error("검증된 시작일 목록이 없습니다.");
  }
  return value;
}

export async function loadReplay(index: ReplayIndex, start: string): Promise<ReplayBundle> {
  if (!index.starts.includes(start) || !/^[a-f0-9]{20}$/.test(index.releaseId)) throw new Error("지원하지 않는 시작일입니다.");
  const value = await getJson<ReplayBundle>(`/data/trading-replays/${index.releaseId}/${start}.json`);
  if (value.schemaVersion !== 1 || value.startDate !== start || value.lastMarketDate !== index.lastMarketDate
      || value.audit?.status !== "passed" || value.audit.indicatorValidation !== "passed"
      || value.audit.missingBars.length || !value.reports?.length
      || value.reports[0].marketDate !== value.firstSignalSession
      || value.reports[value.reports.length - 1].marketDate !== value.lastMarketDate
      || value.reports.some((r) => r.marketDate < start || r.marketDate > value.lastMarketDate)) {
    throw new Error("재현 보고서의 기간 또는 검증 결과가 일치하지 않습니다.");
  }
  return value;
}
