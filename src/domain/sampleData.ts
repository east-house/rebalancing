import type { Portfolio, Snapshot } from "./types";

export const samplePortfolio: Portfolio = {
  totalAssets: 100_000_000,
  targetCashWeight: 10,
  holdings: [
    {
      ticker: "VOO",
      name: "Vanguard S&P 500 ETF",
      assetType: "ETF",
      country: "US",
      quantity: 50,
      averagePrice: 400,
      targetWeight: 35,
    },
    {
      ticker: "QQQ",
      name: "Invesco QQQ Trust",
      assetType: "ETF",
      country: "US",
      quantity: 40,
      averagePrice: 400,
      targetWeight: 30,
    },
    {
      ticker: "GOOG",
      name: "Alphabet Inc. Class C",
      assetType: "STOCK",
      country: "US",
      quantity: 90,
      averagePrice: 150,
      targetWeight: 25,
    },
  ],
};

export const sampleSnapshots: Snapshot[] = [
  { date: "2025-08-01", totalValue: 76_800_000 },
  { date: "2025-09-01", totalValue: 79_100_000 },
  { date: "2025-10-01", totalValue: 78_400_000 },
  { date: "2025-11-01", totalValue: 82_700_000 },
  { date: "2025-12-01", totalValue: 84_900_000 },
  { date: "2026-01-01", totalValue: 86_200_000 },
  { date: "2026-02-01", totalValue: 85_600_000 },
  { date: "2026-03-01", totalValue: 90_800_000 },
  { date: "2026-04-01", totalValue: 92_300_000 },
  { date: "2026-05-01", totalValue: 95_900_000 },
  { date: "2026-06-01", totalValue: 97_400_000 },
  { date: "2026-07-17", totalValue: 100_000_000 },
];
