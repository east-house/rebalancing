import type { AssetType } from "./types";

export const KIWOOM_GENERAL_FEE_POLICY = {
  krOnlineCommissionRate: 0.00015,
  krStockSellTaxRate: 0.002,
  usOnlineCommissionRate: 0.0025,
  usEcnFeePerShareUsd: 0.003,
  usSecFeeRate: 0.0000206,
  usSecFeeMinimumUsd: 0.01,
} as const;

export interface TradeFeeInput {
  country: "KR" | "US";
  assetType: AssetType;
  action: "BUY" | "SELL";
  grossValue: number;
  quantity?: number;
  /** USD 0.003 expressed in the same currency as grossValue. */
  usEcnFeePerShare?: number;
  /** USD 0.01 expressed in the same currency as grossValue. */
  usSecFeeMinimum?: number;
}

export interface TradeFeeBreakdown {
  commission: number;
  exchangeFee: number;
  sellLevy: number;
  total: number;
}

/**
 * Estimates standard Kiwoom online trading costs. Promotional rates, NXT,
 * per-fill rounding, and product-specific withholding taxes are not included.
 */
export function calculateKiwoomTradeFee({
  country,
  assetType,
  action,
  grossValue,
  quantity = 0,
  usEcnFeePerShare = KIWOOM_GENERAL_FEE_POLICY.usEcnFeePerShareUsd,
  usSecFeeMinimum = KIWOOM_GENERAL_FEE_POLICY.usSecFeeMinimumUsd,
}: TradeFeeInput): TradeFeeBreakdown {
  if (!Number.isFinite(grossValue) || grossValue <= 0) {
    return { commission: 0, exchangeFee: 0, sellLevy: 0, total: 0 };
  }

  if (country === "KR") {
    const commission =
      grossValue * KIWOOM_GENERAL_FEE_POLICY.krOnlineCommissionRate;
    const sellLevy =
      action === "SELL" && assetType === "STOCK"
        ? grossValue * KIWOOM_GENERAL_FEE_POLICY.krStockSellTaxRate
        : 0;
    return {
      commission,
      exchangeFee: 0,
      sellLevy,
      total: commission + sellLevy,
    };
  }

  const commission =
    grossValue * KIWOOM_GENERAL_FEE_POLICY.usOnlineCommissionRate;
  const exchangeFee =
    Number.isFinite(quantity) && quantity > 0
      ? quantity * usEcnFeePerShare
      : 0;
  const sellLevy =
    action === "SELL"
      ? Math.max(
          usSecFeeMinimum,
          grossValue * KIWOOM_GENERAL_FEE_POLICY.usSecFeeRate,
        )
      : 0;
  return {
    commission,
    exchangeFee,
    sellLevy,
    total: commission + exchangeFee + sellLevy,
  };
}

export function kiwoomFeeRateLabel(
  country: "KR" | "US",
  assetType: AssetType,
): string {
  if (country === "US") {
    return "매수·매도 0.25% + 주당 $0.003 · 매도 SEC 0.00206%";
  }
  if (assetType === "ETF") return "매수·매도 각 0.015%";
  return "매수 0.015% · 매도 0.215%";
}
