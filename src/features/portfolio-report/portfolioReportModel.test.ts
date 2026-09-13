import { describe, expect, it } from "vitest";
import { advanceAccount, createAccount, selectNames } from "./portfolioReportModel";
import { chain, fixture } from "./accountTestData";

describe("integer I1 account ledger", () => {
  it("waits for the proposed execution close and never uses the signal close as a fill", () => {
    const reports = chain(); reports[1].quotes.A.close = 125;
    const initial = advanceAccount(createAccount("2026-08-31", 10000), [reports[0]]);
    expect(initial.trades).toHaveLength(0); expect(initial.cash).toBe(10000);
    const filled = advanceAccount(initial, [reports[1]]);
    const trade = filled.trades.find(item => item.ticker === "A")!;
    expect(trade.price).toBe(125); expect(trade.executionDate).toBe("2026-08-31");
    expect(trade.signalDate).toBe("2026-08-28");
    expect(filled.holdings.every(item => Number.isInteger(item.shares))).toBe(true);
    expect(filled.cash).toBeGreaterThanOrEqual(0);
  });
  it("keeps uninvestable allocations in cash with no fractional shares", () => {
    const result = advanceAccount(createAccount("2026-08-31", 100), chain());
    expect(result.holdings).toHaveLength(0); expect(result.cash).toBe(100);
  });
  it("executes monthly replacements, credits sale proceeds and realizes net profit", () => {
    const reports = chain();
    reports[1].candidates.find(item => item.ticker === "A")!.rank = 20;
    reports[2].quotes.A.close = 150;
    const result = advanceAccount(createAccount("2026-08-31", 10000), reports);
    const sold = result.trades.find(item => item.ticker === "A" && item.side === "SELL")!;
    expect(sold.executionDate).toBe("2026-09-01");
    // 20 shares: sale proceeds 3,000 - 3 fee - 2,002 cost including buy fee.
    expect(sold.shares).toBe(20); expect(sold.realizedPnl).toBeCloseTo(995);
    expect(result.holdings.some(item => item.ticker === "A")).toBe(false);
    expect(result.holdings.some(item => item.ticker === "Z")).toBe(true);
    const day = result.days.at(-1)!;
    expect(day.realizedPnl + day.unrealizedPnl).toBeCloseTo(day.totalPnl, 8);
    expect(day.cash + day.holdings.reduce((sum, item) => sum + item.value, 0)).toBeCloseTo(day.equity);
  });
  it("updates average cost when adding shares and retains the original buy date", () => {
    const reports = chain(); reports[1].quotes.A.close = 200; reports[2].quotes.A.close = 100;
    reports[1].policy.drift_threshold = 0;
    const result = advanceAccount(createAccount("2026-08-31", 10000), reports);
    const a = result.holdings.find(item => item.ticker === "A")!;
    expect(a.shares).toBeGreaterThan(9); expect(a.cost / a.shares).toBeLessThan(200.2);
    expect(a.firstBuyDate).toBe("2026-08-31"); expect(a.lastBuyDate).toBe("2026-09-01");
  });
  it("retains eligible names and enforces absolute correlation and sector limits", () => {
    const report = fixture(); report.candidates.find(item => item.ticker === "A")!.rank = 8;
    report.selection_correlations!.B.A = -0.9;
    const names = selectNames(report, ["IVV", "A"]);
    expect(names.slice(0, 2).map(item => item.ticker)).toEqual(["IVV", "A"]);
    expect(names.some(item => item.ticker === "B")).toBe(false);
  });
  it("is idempotent and catches up identically after missed visits", () => {
    const reports = chain(); const first = advanceAccount(createAccount("2026-08-31", 10000), reports);
    expect(advanceAccount(first, reports)).toEqual(first);
    const part = advanceAccount(createAccount("2026-08-31", 10000), reports.slice(0, 1));
    const next = advanceAccount(part, reports);
    expect(next.trades).toEqual(first.trades); expect(next.days).toEqual(first.days);
  });
  it("blocks missing reports and missing execution prices without mutating the saved account", () => {
    const reports = chain(), account = advanceAccount(createAccount("2026-08-31", 10000), [reports[0]]);
    expect(() => advanceAccount(account, [reports[2]])).toThrow("보고서가 빠져");
    delete reports[1].quotes.A;
    expect(() => advanceAccount(account, [reports[1]])).toThrow("종가 누락");
    expect(account.trades).toHaveLength(0); expect(account.cash).toBe(10000);
  });
  it("keeps a holiday order pending until its actual US execution session", () => {
    const reports = [fixture("2026-09-07", "2026-09-04", "2026-09-08"), fixture("2026-09-08", "2026-09-04", "2026-09-08"), fixture("2026-09-09", "2026-09-08")];
    const account = advanceAccount(createAccount("2026-09-07", 10000), reports);
    expect(account.days[0].trades).toHaveLength(0); expect(account.days[1].trades).toHaveLength(0);
    expect(account.days[2].trades).toHaveLength(5);
    expect(account.trades.every(item => item.executionDate === "2026-09-08")).toBe(true);
  });
  it("checks drift per stock at execution, including price moves after the monthly signal", () => {
    const reports = chain();
    reports[2].quotes.A.close = 200;
    const result = advanceAccount(createAccount("2026-08-31", 10000), reports);
    const monthly = result.days[2].trades;
    expect(monthly.some(item => item.ticker === "A" && item.side === "SELL")).toBe(true);
    // Other names now also exceed 3pp underweight and may be topped up.
    expect(result.days[1].pending).not.toBeNull();
    expect(result.days[1].selectionDetails?.find(item => item.ticker === "A")?.reason).toContain("유지순위");
  });
  it("does not rebalance an in-band holding when another name must be replaced", () => {
    const reports = chain();
    reports[1].candidates.find(item => item.ticker === "A")!.rank = 20;
    reports[2].quotes.B.close = 105;
    const result = advanceAccount(createAccount("2026-08-31", 10000), reports);
    expect(result.days[2].trades.some(item => item.ticker === "B")).toBe(false);
    expect(result.days[2].explanation?.some(text => text.includes("B: 체결 종가"))).toBe(true);
  });
  it("explains zero fills and ordinary hold days separately", () => {
    const reports = [...chain(), fixture("2026-09-03", "2026-09-02")];
    const result = advanceAccount(createAccount("2026-08-31", 10000), reports);
    expect(result.days[2].trades).toHaveLength(0);
    expect(result.days[2].explanation?.join(" ")).toContain("체결 수량이 없어");
    expect(result.days[3].explanation?.join(" ")).toContain("월간 종목 점검일이 아니고");
  });
});
