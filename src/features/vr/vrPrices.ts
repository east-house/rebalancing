import { parseMarketHistoryPayload } from "../../api/marketHistory";

export interface ReferenceClose {
  date: string;
  close: number;
}

/** 브라우저 기준 오늘 날짜(YYYY-MM-DD) */
export function todayLocal(now = new Date()): string {
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

/** 사이트 가격 API(R2, 최근 1년 종가)에서 기준일 이전 마지막 종가를 찾는다. */
export async function fetchCloseBefore(ticker: string, beforeDate: string, fetcher: typeof fetch = fetch): Promise<ReferenceClose> {
  const response = await fetcher(`${import.meta.env.BASE_URL}api/market-data/history/US/${encodeURIComponent(ticker)}`);
  if (!response.ok) throw new Error(`${ticker} 종가를 불러오지 못했습니다.`);
  const payload = parseMarketHistoryPayload(await response.json());
  const point = [...payload.prices].reverse().find((p) => p.date < beforeDate);
  if (!point) throw new Error(`${beforeDate} 이전 ${ticker} 종가가 없습니다.`);
  return { date: point.date, close: Math.round(point.close * 100) / 100 };
}
