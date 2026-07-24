import type { ClosePoint } from "./marketData";

export interface MarketHistoryPayload {
  schemaVersion: 1;
  instrument: {
    ticker: string;
    name: string;
    country: "KR" | "US";
    assetType: "STOCK" | "ETF";
    currency: "KRW" | "USD";
  };
  prices: ClosePoint[];
  updatedAt?: string;
}

function isClosePoint(value: unknown): value is ClosePoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<ClosePoint>;
  return (
    typeof point.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
    typeof point.close === "number" &&
    Number.isFinite(point.close) &&
    point.close > 0
  );
}

export function parseMarketHistoryPayload(value: unknown): MarketHistoryPayload {
  if (!value || typeof value !== "object") {
    throw new Error("과거 종가 응답 형식이 올바르지 않습니다.");
  }
  const raw = value as Record<string, unknown>;
  const instrument =
    raw.instrument && typeof raw.instrument === "object"
      ? (raw.instrument as Record<string, unknown>)
      : null;
  const ticker =
    typeof instrument?.ticker === "string"
      ? instrument.ticker.trim().toUpperCase()
      : "";
  const name = typeof instrument?.name === "string" ? instrument.name.trim() : "";
  const country = instrument?.country;
  const assetType = instrument?.assetType;
  const currency = country === "KR" ? "KRW" : country === "US" ? "USD" : null;
  const prices = Array.isArray(raw.prices)
    ? raw.prices
        .filter(isClosePoint)
        .sort((left, right) => left.date.localeCompare(right.date))
    : [];

  if (
    raw.schemaVersion !== 1 ||
    !ticker ||
    !name ||
    (country !== "KR" && country !== "US") ||
    (assetType !== "STOCK" && assetType !== "ETF") ||
    currency === null ||
    prices.length === 0
  ) {
    throw new Error("사용 가능한 과거 종가 데이터가 없습니다.");
  }

  return {
    schemaVersion: 1,
    instrument: { ticker, name, country, assetType, currency },
    prices,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
  };
}
