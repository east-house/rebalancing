import type { Quote } from "../domain";

export type PricePolicy = "previous" | "today" | "auto";

export interface ClosePoint {
  date: string;
  close: number;
}

export interface MarketDataQuote {
  ticker: string;
  name: string;
  country: "KR" | "US";
  assetType: "STOCK" | "ETF";
  currency: "KRW" | "USD";
  closes: ClosePoint[];
}

export interface MarketDataPayload {
  schemaVersion: 1;
  generatedAt: string;
  expectedShardCount: number;
  availableShards: number[];
  complete: boolean;
  quoteCount: number;
  fx: {
    usdKrw: {
      pair: "USD/KRW";
      currency: "KRW";
      closes: ClosePoint[];
    };
  };
  quotes: MarketDataQuote[];
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

function parseCloses(value: unknown, limit?: number): ClosePoint[] {
  if (!Array.isArray(value)) return [];
  const closes = value
    .filter(isClosePoint)
    .sort((left, right) => left.date.localeCompare(right.date));
  return limit === undefined ? closes : closes.slice(-limit);
}

export function parseMarketDataPayload(value: unknown): MarketDataPayload {
  if (!value || typeof value !== "object") {
    throw new Error("종가 응답 형식이 올바르지 않습니다.");
  }
  const raw = value as Record<string, unknown>;
  const rawFx =
    raw.fx && typeof raw.fx === "object"
      ? (raw.fx as Record<string, unknown>).usdKrw
      : undefined;
  const fxCloses =
    rawFx && typeof rawFx === "object"
      ? parseCloses((rawFx as Record<string, unknown>).closes)
      : [];
  const quotes = Array.isArray(raw.quotes)
    ? raw.quotes.flatMap((value): MarketDataQuote[] => {
        if (!value || typeof value !== "object") return [];
        const quote = value as Record<string, unknown>;
        const ticker =
          typeof quote.ticker === "string" ? quote.ticker.trim().toUpperCase() : "";
        const name = typeof quote.name === "string" ? quote.name.trim() : "";
        const country = quote.country;
        const assetType = quote.assetType;
        const currency = quote.currency;
        const closes = parseCloses(quote.closes, 2);
        if (
          !ticker ||
          !name ||
          (country !== "KR" && country !== "US") ||
          (assetType !== "STOCK" && assetType !== "ETF") ||
          (currency !== "KRW" && currency !== "USD") ||
          (country === "KR" && currency !== "KRW") ||
          (country === "US" && currency !== "USD") ||
          closes.length === 0
        ) {
          return [];
        }
        return [
          {
            ticker,
            name,
            country,
            assetType,
            currency,
            closes,
          },
        ];
      })
    : [];

  if (raw.schemaVersion !== 1 || quotes.length === 0 || fxCloses.length === 0) {
    throw new Error("사용 가능한 종가 또는 환율 데이터가 없습니다.");
  }

  const availableShards = Array.isArray(raw.availableShards)
    ? raw.availableShards.filter(
        (shard): shard is number => Number.isInteger(shard) && shard >= 0,
      )
    : [];
  return {
    schemaVersion: 1,
    generatedAt:
      typeof raw.generatedAt === "string" ? raw.generatedAt : "",
    expectedShardCount:
      typeof raw.expectedShardCount === "number"
        ? raw.expectedShardCount
        : availableShards.length,
    availableShards,
    complete: raw.complete === true,
    quoteCount: quotes.length,
    fx: {
      usdKrw: {
        pair: "USD/KRW",
        currency: "KRW",
        closes: fxCloses,
      },
    },
    quotes,
  };
}

function selectClose(
  closes: readonly ClosePoint[],
  policy: PricePolicy,
): ClosePoint | undefined {
  if (policy === "today" || policy === "auto") return closes.at(-1);
  return closes.length >= 2 ? closes.at(-2) : undefined;
}

export function quotesForPolicy(
  payload: MarketDataPayload,
  policy: PricePolicy,
): Quote[] {
  return payload.quotes.flatMap((item): Quote[] => {
    const native = selectClose(item.closes, policy);
    if (!native) return [];
    const fx = [...payload.fx.usdKrw.closes]
      .reverse()
      .find((point) => point.date <= native.date);
    if (item.currency === "USD" && !fx) return [];
    const fxRate = item.currency === "USD" ? fx?.close : undefined;
    return [
      {
        ticker: item.ticker,
        close: native.close * (fxRate ?? 1),
        asOf: native.date,
        nativeClose: native.close,
        nativeCurrency: item.currency,
        country: item.country,
        fxRate,
      },
    ];
  });
}

export function latestQuoteDate(quotes: readonly Quote[]): string | undefined {
  return quotes.reduce<string | undefined>(
    (latest, quote) => (!latest || quote.asOf > latest ? quote.asOf : latest),
    undefined,
  );
}
