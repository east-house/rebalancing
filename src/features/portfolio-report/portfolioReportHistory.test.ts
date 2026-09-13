import { expect, it } from "vitest";
import { advanceAccount, createAccount } from "./portfolioReportModel";
import { chain } from "./accountTestData";

it("preserves actual historical holdings and equity when later prices and holdings change", () => {
  const reports = chain(); reports[1].candidates.find(item => item.ticker === "A")!.rank = 20;
  reports[2].quotes.A.close = 200;
  const before = advanceAccount(createAccount("2026-08-31", 10000), reports.slice(0, 2));
  const result = advanceAccount(before, [reports[2]]);
  expect(result.days.slice(0, 2)).toEqual(before.days);
  expect(result.days[1].holdings.some(item => item.ticker === "A")).toBe(true);
  expect(result.days[2].holdings.some(item => item.ticker === "A")).toBe(false);
  expect(advanceAccount(result, reports).days).toEqual(result.days);
});
