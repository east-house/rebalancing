export type AssetType = "ETF" | "STOCK";

export interface Holding {
  ticker: string;
  name: string;
  assetType: AssetType;
  country: "KR" | "US";
  quantity: number;
  /** Average purchase price per share in the instrument's native currency. */
  averagePrice: number;
  /** Percentage from 0 to 100. */
  targetWeight: number;
}

export interface Quote {
  ticker: string;
  /** Close converted to KRW for portfolio calculations. */
  close: number;
  /** ISO-8601 calendar date for the close. */
  asOf: string;
  nativeClose?: number;
  nativeCurrency?: "KRW" | "USD";
  country?: "KR" | "US";
  /** USD/KRW rate used when nativeCurrency is USD. */
  fxRate?: number;
}

export interface Portfolio {
  /** App state stores investment principal; valuation previews receive current assets. */
  totalAssets: number;
  /** Percentage from 0 to 100. */
  targetCashWeight: number;
  holdings: Holding[];
}

export interface Snapshot {
  date: string;
  totalValue: number;
}

export interface HoldingValuation {
  holding: Holding;
  quote: Quote;
  marketValue: number;
  /** Current percentage of total assets. */
  weight: number;
}

export interface PortfolioSummary {
  totalValue: number;
  investedValue: number;
  cash: number;
  cashWeight: number;
  holdings: HoldingValuation[];
}

export interface TargetWeightValidation {
  valid: boolean;
  totalWeight: number;
  difference: number;
  errors: string[];
}

export type RebalanceAction = "BUY" | "SELL" | "HOLD";

export interface RebalanceItem {
  ticker: string;
  name: string;
  assetType: AssetType;
  price: number;
  currentQuantity: number;
  targetQuantity: number;
  quantityDelta: number;
  action: RebalanceAction;
  currentValue: number;
  targetValue: number;
  estimatedTradeValue: number;
  estimatedTradeFee: number;
  currentWeight: number;
  targetWeight: number;
  projectedWeight: number;
}

export interface RebalancePreview {
  totalAssets: number;
  currentInvestedValue: number;
  currentCash: number;
  targetCashWeight: number;
  projectedInvestedValue: number;
  projectedTransactionFees: number;
  projectedCash: number;
  projectedCashWeight: number;
  items: RebalanceItem[];
}
