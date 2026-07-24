import type {
  Holding,
  Portfolio,
  PortfolioSummary,
  PurchasePlan,
  Quote,
  RebalanceAction,
  RebalancePreview,
  TargetWeightValidation,
} from "./types";
import { calculateKiwoomTradeFee } from "./fees";

const TARGET_WEIGHT_TOTAL = 100;
const TARGET_WEIGHT_TOLERANCE = 0.01;

export function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function estimatedBuyCost(
  holding: Holding,
  quote: Quote,
  quantity: number,
): { grossValue: number; estimatedFee: number; totalCost: number } {
  const grossValue = quantity * quote.close;
  const estimatedFee = calculateKiwoomTradeFee({
    country: holding.country,
    assetType: holding.assetType,
    action: "BUY",
    grossValue,
    quantity,
    usEcnFeePerShare:
      holding.country === "US" ? 0.003 * (quote.fxRate ?? 1) : undefined,
  }).total;
  return { grossValue, estimatedFee, totalCost: grossValue + estimatedFee };
}

function affordableQuantity(
  holding: Holding,
  quote: Quote,
  allocatedAmount: number,
): number {
  let low = 0;
  let high = Math.floor(allocatedAmount / quote.close);

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimatedBuyCost(holding, quote, middle).totalCost <= allocatedAmount) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
}

/**
 * Allocates a new investment amount by the configured target weights and
 * returns affordable whole-share buy quantities including estimated buy fees.
 */
export function calculatePurchasePlan(
  portfolio: Portfolio,
  quotes: readonly Quote[],
  investmentAmount: number,
): PurchasePlan {
  assertValidPortfolio(portfolio);
  assertFiniteNonNegative(investmentAmount, "investmentAmount");
  const targetValidation = validateTargetWeights(portfolio);
  if (!targetValidation.valid) {
    throw new Error(targetValidation.errors.join(" "));
  }

  const quoteMap = createQuoteMap(quotes);
  const items = portfolio.holdings.map((holding) => {
    const quote = quoteFor(quoteMap, holding);
    const allocatedAmount =
      investmentAmount * (holding.targetWeight / TARGET_WEIGHT_TOTAL);
    const quantity = affordableQuantity(holding, quote, allocatedAmount);
    const costs = estimatedBuyCost(holding, quote, quantity);
    return {
      ticker: normalizeTicker(holding.ticker),
      name: holding.name,
      targetWeight: holding.targetWeight,
      allocatedAmount,
      quantity,
      ...costs,
    };
  });
  const totalPurchaseValue = items.reduce(
    (total, item) => total + item.grossValue,
    0,
  );
  const estimatedFees = items.reduce(
    (total, item) => total + item.estimatedFee,
    0,
  );

  return {
    investmentAmount,
    targetCashAmount:
      investmentAmount * (portfolio.targetCashWeight / TARGET_WEIGHT_TOTAL),
    totalPurchaseValue,
    estimatedFees,
    remainingCash: investmentAmount - totalPurchaseValue - estimatedFees,
    items,
  };
}

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite, non-negative number.`);
  }
}

function assertValidPortfolio(portfolio: Portfolio): void {
  assertFiniteNonNegative(portfolio.totalAssets, "totalAssets");

  const seenTickers = new Set<string>();
  for (const holding of portfolio.holdings) {
    const ticker = normalizeTicker(holding.ticker);
    if (!ticker) {
      throw new Error("Holding ticker is required.");
    }
    if (seenTickers.has(ticker)) {
      throw new Error(`Duplicate holding ticker: ${ticker}`);
    }
    seenTickers.add(ticker);

    assertFiniteNonNegative(holding.quantity, `${ticker} quantity`);
    if (!Number.isInteger(holding.quantity)) {
      throw new Error(`${ticker} quantity must be an integer.`);
    }
    assertFiniteNonNegative(holding.averagePrice, `${ticker} averagePrice`);
  }
}

function createQuoteMap(quotes: readonly Quote[]): Map<string, Quote> {
  const quoteMap = new Map<string, Quote>();

  for (const quote of quotes) {
    const ticker = normalizeTicker(quote.ticker);
    if (!ticker) {
      throw new Error("Quote ticker is required.");
    }
    if (quoteMap.has(ticker)) {
      throw new Error(`Duplicate quote ticker: ${ticker}`);
    }
    if (!Number.isFinite(quote.close) || quote.close <= 0) {
      throw new Error(`${ticker} close must be a finite number greater than zero.`);
    }
    quoteMap.set(ticker, { ...quote, ticker });
  }

  return quoteMap;
}

function quoteFor(
  quoteMap: ReadonlyMap<string, Quote>,
  holding: Holding,
): Quote {
  const ticker = normalizeTicker(holding.ticker);
  const quote = quoteMap.get(ticker);
  if (!quote) {
    throw new Error(`Missing quote for ticker: ${ticker}`);
  }
  return quote;
}

function percentage(value: number, total: number): number {
  return total === 0 ? 0 : (value / total) * 100;
}

/**
 * Values a portfolio against supplied closing prices. `cash` is the remainder
 * of the user-declared total assets after the holdings have been valued.
 */
export function calculatePortfolio(
  portfolio: Portfolio,
  quotes: readonly Quote[],
): PortfolioSummary {
  assertValidPortfolio(portfolio);
  const quoteMap = createQuoteMap(quotes);

  const holdings = portfolio.holdings.map((holding) => {
    const quote = quoteFor(quoteMap, holding);
    const marketValue = holding.quantity * quote.close;

    return {
      holding: { ...holding, ticker: normalizeTicker(holding.ticker) },
      quote,
      marketValue,
      weight: percentage(marketValue, portfolio.totalAssets),
    };
  });

  const investedValue = holdings.reduce(
    (total, holding) => total + holding.marketValue,
    0,
  );
  const cash = portfolio.totalAssets - investedValue;

  return {
    totalValue: portfolio.totalAssets,
    investedValue,
    cash,
    cashWeight: percentage(cash, portfolio.totalAssets),
    holdings,
  };
}

/**
 * Checks that all target allocations, including cash, add up to exactly 100%
 * within a small tolerance suitable for decimal percentage inputs.
 */
export function validateTargetWeights(
  portfolio: Portfolio,
): TargetWeightValidation {
  const errors: string[] = [];
  const weights = [
    { label: "Cash", value: portfolio.targetCashWeight },
    ...portfolio.holdings.map((holding) => ({
      label: normalizeTicker(holding.ticker) || "Holding",
      value: holding.targetWeight,
    })),
  ];

  for (const weight of weights) {
    if (!Number.isFinite(weight.value)) {
      errors.push(`${weight.label} target weight must be a finite number.`);
    } else if (weight.value < 0 || weight.value > TARGET_WEIGHT_TOTAL) {
      errors.push(`${weight.label} target weight must be between 0 and 100.`);
    }
  }

  const totalWeight = weights.reduce(
    (total, weight) =>
      total + (Number.isFinite(weight.value) ? weight.value : 0),
    0,
  );
  const difference = TARGET_WEIGHT_TOTAL - totalWeight;

  if (Math.abs(difference) > TARGET_WEIGHT_TOLERANCE) {
    errors.push("Target weights, including cash, must add up to 100.");
  }

  return {
    valid: errors.length === 0,
    totalWeight,
    difference,
    errors,
  };
}

function actionFor(quantityDelta: number): RebalanceAction {
  if (quantityDelta > 0) return "BUY";
  if (quantityDelta < 0) return "SELL";
  return "HOLD";
}

/**
 * Creates a whole-share rebalance preview. Target quantities are rounded down
 * so purchases never exceed their target allocation. Standard Kiwoom online
 * commissions and applicable sell levies are deducted from projected cash.
 */
export function calculateRebalancePreview(
  portfolio: Portfolio,
  quotes: readonly Quote[],
): RebalancePreview {
  assertValidPortfolio(portfolio);
  const targetValidation = validateTargetWeights(portfolio);
  if (!targetValidation.valid) {
    throw new Error(targetValidation.errors.join(" "));
  }

  const current = calculatePortfolio(portfolio, quotes);

  const items = current.holdings.map(
    ({ holding, quote, marketValue, weight }) => {
      const targetAllocation =
        portfolio.totalAssets * (holding.targetWeight / TARGET_WEIGHT_TOTAL);
      const targetQuantity = Math.floor(targetAllocation / quote.close);
      const quantityDelta = targetQuantity - holding.quantity;
      const targetValue = targetQuantity * quote.close;
      const estimatedTradeValue = Math.abs(quantityDelta) * quote.close;
      const action = actionFor(quantityDelta);
      const estimatedTradeFee = calculateKiwoomTradeFee({
        country: holding.country,
        assetType: holding.assetType,
        action: action === "SELL" ? "SELL" : "BUY",
        grossValue: action === "HOLD" ? 0 : estimatedTradeValue,
        quantity: Math.abs(quantityDelta),
        usEcnFeePerShare:
          holding.country === "US" ? 0.003 * (quote.fxRate ?? 1) : undefined,
        usSecFeeMinimum:
          holding.country === "US" ? 0.01 * (quote.fxRate ?? 1) : undefined,
      }).total;

      return {
        ticker: holding.ticker,
        name: holding.name,
        assetType: holding.assetType,
        price: quote.close,
        currentQuantity: holding.quantity,
        targetQuantity,
        quantityDelta,
        action,
        currentValue: marketValue,
        targetValue,
        estimatedTradeValue,
        estimatedTradeFee,
        currentWeight: weight,
        targetWeight: holding.targetWeight,
        projectedWeight: percentage(targetValue, portfolio.totalAssets),
      };
    },
  );

  const projectedInvestedValue = items.reduce(
    (total, item) => total + item.targetValue,
    0,
  );
  const projectedTransactionFees = items.reduce(
    (total, item) => total + item.estimatedTradeFee,
    0,
  );
  const projectedCash =
    portfolio.totalAssets - projectedInvestedValue - projectedTransactionFees;

  return {
    totalAssets: portfolio.totalAssets,
    currentInvestedValue: current.investedValue,
    currentCash: current.cash,
    targetCashWeight: portfolio.targetCashWeight,
    projectedInvestedValue,
    projectedTransactionFees,
    projectedCash,
    projectedCashWeight: percentage(projectedCash, portfolio.totalAssets),
    items,
  };
}
