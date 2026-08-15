export type EtfAssetClass =
  | "KR_EQUITY"
  | "GLOBAL_EQUITY"
  | "EMERGING_EQUITY"
  | "BOND"
  | "CASH"
  | "GOLD"
  | "REIT";

export type EtfStructure =
  | "physical"
  | "synthetic"
  | "futures"
  | "active"
  | "mixed";

export type EtfDataGrade = "A" | "B" | "C";
export type EtfUsage = "GENERATOR_ELIGIBLE" | "ANALYSIS_ONLY" | "SEARCH_ONLY";
export type HedgeType = "hedged" | "unhedged" | "mixed" | "not-applicable";
export type ReturnMode = "price" | "adjusted-price" | "total-return";

export interface EtfHolding {
  key: string;
  name: string;
  weightPercent: number;
  country?: string;
  sector?: string;
}

export interface EtfResearchMetrics {
  latestPrice: number | null;
  nav: number | null;
  navDeviationPercent: number | null;
  marketCapKrw: number | null;
  averageTradingValue20dKrw: number | null;
  return1yPercent: number | null;
  volatility1yPercent: number | null;
  downsideVolatility1yPercent: number | null;
  maxDrawdown3yPercent: number | null;
  priceHistoryDays: number;
}

export interface EtfResearchSource {
  name: string;
  url: string;
  retrievedAt: string;
}

export interface EtfResearchProfile {
  ticker: string;
  name: string;
  issuer: string | null;
  assetClass: EtfAssetClass;
  assetClassLabel: string;
  strategyKey: string;
  strategyLabel: string;
  benchmarkName: string | null;
  structure: EtfStructure;
  hedgeType: HedgeType;
  expenseRatioPercent: number | null;
  listingDate: string | null;
  priceAsOf: string | null;
  holdingsAsOf: string | null;
  holdingsCoveragePercent: number;
  holdings: EtfHolding[];
  metrics: EtfResearchMetrics;
  dataGrade: EtfDataGrade;
  usage: EtfUsage;
  exclusionReasons: string[];
  sources: EtfResearchSource[];
}

export interface EtfAnalysisBundle {
  schemaVersion: 1;
  dataVersion: string;
  generatedAt: string;
  profiles: EtfResearchProfile[];
}

export interface EtfReturnPoint {
  date: string;
  close: number;
}

export interface EtfReturnSeries {
  ticker: string;
  name: string;
  returnMode: ReturnMode;
  distributionIncluded: boolean;
  source: string;
  points: EtfReturnPoint[];
}

export interface EtfReturnsBundle {
  schemaVersion: 1;
  dataVersion: string;
  generatedAt: string;
  series: EtfReturnSeries[];
}

export interface EtfResearchManifest {
  schemaVersion: 1;
  dataVersion: string;
  generatedAt: string;
  priceAsOf: string | null;
  holdingsAsOf: string | null;
  etfCount: number;
  generatorEligibleCount: number;
  totalReturnCount: number;
  analysisPath: string;
  returnsPath: string;
}

export interface EtfSleeve {
  id: string;
  label: string;
  strategyKey: string;
  targetWeightPercent: number;
}

export interface FixedStockExposure {
  name: string;
  weightPercent: number;
}

export interface PortfolioGeneratorConfig {
  sleeves: EtfSleeve[];
  investmentAmountKrw: number;
  maxEtfs: number;
  maxEtfWeightPercent: number;
  maxPairOverlapPercent: number;
  minimumTradingValue20dKrw: number;
  maximumExpenseRatioPercent: number | null;
  hedgePreference: "any" | "hedged" | "unhedged";
  fixedStocks: FixedStockExposure[];
}

export interface EtfQualityScore {
  ticker: string;
  total: number;
  dataCompleteness: number;
  parts: {
    liquidity: number | null;
    cost: number | null;
    navStability: number | null;
    scaleAndAge: number | null;
    dataQuality: number;
  };
}

export interface PortfolioCandidateItem {
  ticker: string;
  name: string;
  sleeveId: string;
  sleeveLabel: string;
  targetWeightPercent: number;
  qualityScore: number;
  expectedQuantity: number | null;
  expectedAmountKrw: number | null;
  reasons: string[];
}

export type PortfolioCandidateKind = "balanced" | "low-cost" | "low-overlap";

export interface PortfolioCandidate {
  kind: PortfolioCandidateKind;
  label: string;
  score: number;
  items: PortfolioCandidateItem[];
  weightedExpenseRatioPercent: number | null;
  weightedOverlapPercent: number | null;
  overlapConfidence: "exact" | "partial" | "exposure-only";
  dataReliabilityScore: number;
  remainingCashKrw: number | null;
  topCompanyExposures: Array<{ name: string; weightPercent: number }>;
  warnings: string[];
}

export interface PortfolioGenerationResult {
  candidates: PortfolioCandidate[];
  evaluatedCombinationCount: number;
  rejectedCombinationCount: number;
  errors: string[];
  exclusions: Array<{ ticker: string; reason: string }>;
}

export type RebalanceFrequency = "none" | "quarterly" | "annual";

export interface BacktestOptions {
  initialValue: number;
  rebalanceFrequency: RebalanceFrequency;
  transactionCostBps: number;
  riskFreeRatePercent: number;
}

export interface BacktestMetrics {
  cumulativeReturnPercent: number;
  annualizedReturnPercent: number;
  annualizedVolatilityPercent: number;
  maximumDrawdownPercent: number;
  downsideVolatilityPercent: number;
  sharpeRatio: number | null;
  sortinoRatio: number | null;
  worstMonthPercent: number | null;
  startDate: string;
  endDate: string;
  tradingDays: number;
  rebalanceCount: number;
  totalTurnoverPercent: number;
}

export interface BacktestResult {
  frequency: RebalanceFrequency;
  returnMode: ReturnMode | "mixed";
  distributionIncluded: boolean;
  curve: Array<{ date: string; totalValue: number }>;
  metrics: BacktestMetrics;
  warnings: string[];
}
