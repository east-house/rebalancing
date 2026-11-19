import { describe, expect, it } from "vitest";
import {
  VR_DEFAULT_SETTINGS, addDays, addFill, costBasis, fillTotals, overdueCycles, removeFill, rescheduleCurrentCycle, setCurrentAverageCost, startingCapital, buildOrders, closeCycle, createExistingAccount, createNewAccount, createQuickResumeAccount, gForWeek,
  nextV, openCycle, poolLimitForWeek, reopenLastCycle, suggestInitialBuy, valuationStatus, type VrAccount,
} from "./vrModel";
import { exportVrAccount, parseVrAccount } from "./vrStorage";
import { calibrateBacktest, estimatePrincipal, mergeHistory, runBacktest, week0DateFor } from "./vrBacktest";
import { firstRealIndex, hasEstimatedHistory, removeEstimatedHistory } from "./vrModel";

const basic = { ...VR_DEFAULT_SETTINGS };

// 시트 "dj_VR 5.0.4 실력공식" 적립식 탭 (2026-06-28 시작, 적립금 65): 주차별 마감 (수량, 마감 Pool, 마감 종가)
const SHEET_CLOSES: Array<[number, number, number]> = [
  [63, 1005, 64], [63, 1070, 74.47], [63, 1135, 71.17], [63, 1200, 72.37], [63, 1265, 72.64],
  [63, 1330, 81.01], [63, 1395, 68.21], [63, 1460, 62.01], [75, 797.91, 57.68],
];
// 적립식!F10~F19 (2~20주차 V)
const SHEET_V = [5011.89, 5022.467, 5142.158, 5216.556, 5297.644, 5375.101, 5530.181, 5539.748, 5492.548, 5452.905];

function sheetAccount(): VrAccount {
  let account = createNewAccount({ ...basic, deposit: 65, formula: "skill" }, { date: "2026-06-28", shares: 63, close: 77.03, pool: 940 }, "t");
  for (const [shares, pool, price] of SHEET_CLOSES) account = closeCycle(account, { shares, pool, price });
  return account;
}

describe("VR V formulas", () => {
  it("reproduces the quantstack basic example", () => {
    // V 9000, Pool 1000, G 10, 적립 250 → 9350
    expect(nextV("basic", 9000, 1000, 10, 250, 0)).toBe(9350);
  });

  it("reproduces the sheet's 실력공식 V for weeks 2–20", () => {
    const account = sheetAccount();
    expect(account.start.v0).toBe(4852.89);
    expect(account.cycles.map((c) => c.v)).toEqual(SHEET_V);
    const current = account.cycles.at(-1)!;
    expect(current).toMatchObject({ week: 20, startDate: "2026-11-15", endDate: "2026-11-28", lower: 4634.96, upper: 6270.84, pool: 862.91, shares: 75 });
    // 2주차 밴드: 적립식!G10·H10
    expect(account.cycles[0]).toMatchObject({ week: 2, lower: 4260.1, upper: 5763.67 });
  });

  it("keeps the deviation term out of the basic formula", () => {
    expect(nextV("basic", 5011.89, 1005, 10, 65, 4032)).toBe(5177.39);
    expect(nextV("skill", 5011.89, 1005, 10, 65, 4032)).toBe(5022.467);
  });
});

describe("sheet schedules", () => {
  it("raises G every 52 weeks", () => {
    expect([2, 52, 54, 104, 106].map((w) => gForWeek(10, w))).toEqual([10, 10, 11, 11, 12]);
  });

  it("lowers the pool limit by 5%p every 26 weeks from week 26, floor 10%", () => {
    expect([2, 22, 24, 26, 50, 52, 78, 400].map((w) => poolLimitForWeek(75, w))).toEqual([75, 75, 75, 70, 70, 65, 60, 10]);
  });

  it("applies the scheduled G and limit when cycles open", () => {
    const c26 = openCycle(13, "2026-01-04", 1000, 10, 100, 100, basic);
    expect(c26).toMatchObject({ week: 26, g: 10, poolLimitPct: 70 });
    const c54 = openCycle(27, "2026-01-04", 1000, 10, 100, 100, basic);
    expect(c54).toMatchObject({ week: 54, g: 11, poolLimitPct: 65 });
  });
});

describe("sheet order table", () => {
  it("matches the sheet's week-20 buy/sell ladders (주문 탭)", () => {
    const cycle = sheetAccount().cycles.at(-1)!;
    expect(cycle.poolCap).toBe(647.18); // 주문!P27
    expect(cycle.poolReserve).toBe(215.73); // 주문!E3
    const orders = buildOrders(cycle);
    expect(orders.buyPriceFloor).toBe(34.61);
    expect(orders.buys).toHaveLength(12); // 11줄 + 수량 1 추가 1줄
    expect(orders.buys[0]).toMatchObject({ price: 61.79, holdings: 76 }); // 4634.96 / 75
    expect(orders.buys[1].price).toBe(60.98); // 4634.96 / 76
    expect(orders.buys.at(-1)!.price).toBe(53.89); // 4634.96 / 86
    expect(orders.buys[10].poolAfter).toBeGreaterThanOrEqual(215.73);
    expect(orders.buys[11].poolAfter).toBeLessThan(215.73);
    expect(orders.sells).toHaveLength(74);
    expect(orders.sells[0]).toMatchObject({ price: 83.62, holdings: 74 }); // 6270.84 / 75
    expect(orders.sells.at(-1)).toMatchObject({ price: 3135.42, holdings: 1 }); // 6270.84 / 2
  });

  it("stops buys at 60% of the last close and never overdraws the pool", () => {
    const cycle = openCycle(1, "2026-01-04", 10_000, 100, 100_000, 200, { ...basic, deposit: 0 });
    const orders = buildOrders(cycle);
    expect(orders.buyPriceFloor).toBe(120);
    expect(orders.buys.at(-2)!.price).toBeGreaterThanOrEqual(120);
    const poorCycle = openCycle(1, "2026-01-04", 10_000, 100, 0, 100, { ...basic, deposit: 0 });
    expect(buildOrders(poorCycle).buys).toEqual([]);
  });

  it("returns no ladder for zero shares", () => {
    expect(buildOrders(openCycle(1, "2026-01-04", 1000, 0, 0, 10, basic))).toMatchObject({ buys: [], sells: [] });
  });
});

describe("account lifecycle", () => {
  it("suggests the quantstack initial split", () => {
    expect(suggestInitialBuy(10_000, 50, 0.15)).toEqual({ shares: 173, cost: 8650, pool: 1350 });
  });

  it("chains basic cycles from actual balances and can reopen the last close", () => {
    const account = createNewAccount(basic, { date: "2026-01-04", shares: 100, close: 50, pool: 750 }, "t");
    expect(account.cycles[0]).toMatchObject({ index: 1, week: 2, startDate: "2026-01-18", v: 5325, pool: 1000, poolCap: 750 });
    const next = closeCycle(account, { shares: 100, pool: 1000, price: 55 });
    expect(next.cycles[1]).toMatchObject({ week: 4, startDate: "2026-02-01", previousV: 5325, v: 5675, pool: 1250, referenceClose: 55 });
    expect(reopenLastCycle(next).cycles).toHaveLength(1);
  });

  it("continues an existing account from week, previous V and previous close", () => {
    const account = createExistingAccount({ ...basic, deposit: 65, formula: "skill" }, {
      cycleStartDate: "2026-11-15", week: 20, previousV: 5492.548, shares: 75, poolBeforeDeposit: 797.91, previousClose: 57.68,
    }, "t");
    expect(account.cycles[0]).toMatchObject({ index: 10, week: 20, v: 5452.905, lower: 4634.96, upper: 6270.84 });
    expect(() => createExistingAccount(basic, { cycleStartDate: "2026-11-15", week: 3, previousV: 1, shares: 1, poolBeforeDeposit: 0, previousClose: 1 })).toThrow("짝수");
  });

  it("resumes from shares and average cost when the previous V is unknown", () => {
    const input = { cycleStartDate: "2026-11-15", week: 20, shares: 75, averageCost: 51.81, referenceClose: 57.68, poolBeforeDeposit: 0 };
    const cost = createQuickResumeAccount({ ...basic, deposit: 65 }, { ...input, basis: "cost" }, "t");
    expect(cost.start).toMatchObject({ kind: "quick", v0: 3885.75, averageCost: 51.81, basis: "cost" });
    expect(cost.cycles[0]).toMatchObject({ index: 10, week: 20, previousV: 3885.75, v: 3950.75, pool: 65, poolCap: 48.75 });
    const market = createQuickResumeAccount({ ...basic, deposit: 65 }, { ...input, basis: "market" }, "t");
    expect(market.cycles[0]).toMatchObject({ previousV: 4326, v: 4391 });
    // 홀수 주차는 다음 짝수 주차 사이클
    expect(createQuickResumeAccount(basic, { ...input, week: 19, basis: "cost" }, "t").cycles[0].week).toBe(20);
    expect(() => createQuickResumeAccount(basic, { ...input, averageCost: 0, basis: "cost" })).toThrow("평단가");
    expect(parseVrAccount(exportVrAccount(cost))).toEqual(cost);
  });

  it("applies settings changes from the next cycle only", () => {
    const account = createNewAccount(basic, { date: "2026-01-04", shares: 100, close: 50, pool: 750 }, "t");
    const changed = { ...account, settings: { ...account.settings, formula: "skill" as const, deposit: 0 } };
    expect(changed.cycles[0].formula).toBe("basic");
    const next = closeCycle(changed, { shares: 100, pool: 1100, price: 50 });
    expect(next.cycles[1]).toMatchObject({ formula: "skill", deposit: 0 });
  });

  it("checks the band position and rejects invalid input", () => {
    const cycle = openCycle(1, "2026-01-04", 10_000, 100, 0, 100, { ...basic, deposit: 0 });
    expect(valuationStatus(cycle, 84)).toEqual({ value: 8400, zone: "below" });
    expect(() => createNewAccount({ ...basic, g: 0 }, { date: "2026-01-04", shares: 1, close: 1, pool: 0 })).toThrow("G");
    expect(() => addDays("2026/01/04", 1)).toThrow();
  });

  it("round-trips through the backup format and rejects malformed data", () => {
    const account = sheetAccount();
    expect(parseVrAccount(exportVrAccount(account))).toEqual(account);
    expect(parseVrAccount("{")).toBeNull();
    expect(parseVrAccount(JSON.stringify({ ...account, version: 1 }))).toBeNull();
    const openTwice = { ...account, cycles: account.cycles.map(({ close: _c, ...cycle }) => cycle) };
    expect(parseVrAccount(JSON.stringify(openTwice))).toBeNull();
  });

  it("records fills, derives the close balance and keeps fills through close, undo and backup", () => {
    let account = sheetAccount();
    const cycle = account.cycles.at(-1)!;
    const day = (n: number) => addDays(cycle.startDate, n);
    account = addFill(account, { date: day(1), side: "buy", price: 61.79, quantity: 1 });
    account = addFill(account, { date: day(2), side: "buy", price: 61.01, quantity: 2 });
    account = addFill(account, { date: day(3), side: "sell", price: 70, quantity: 1 });
    // 시작 75주 · Pool 862.91 → 매수 3주 183.81, 매도 1주 70
    expect(fillTotals(account.cycles.at(-1)!)).toEqual({ count: 3, buyQuantity: 3, buyAmount: 183.81, sellQuantity: 1, sellAmount: 70, shares: 77, pool: 749.1 });
    expect(fillTotals(account.cycles.at(-1)!, day(1)).shares).toBe(76);
    expect(() => addFill(account, { date: day(-1), side: "buy", price: 60, quantity: 1 })).toThrow(/사이클 기간/);
    expect(() => addFill(account, { date: day(4), side: "sell", price: 70, quantity: 78 })).toThrow(/보유 수량/);
    expect(() => addFill(account, { date: day(4), side: "buy", price: 60, quantity: 1.5 })).toThrow(/정수/);
    const sellId = account.cycles.at(-1)!.fills![2].id;
    expect(fillTotals(removeFill(account, sellId).cycles.at(-1)!).shares).toBe(78);

    const closed = closeCycle(account, { shares: 77, pool: 749.1, price: 60 });
    expect(closed.cycles.at(-2)!.fills).toHaveLength(3);
    expect(closed.cycles.at(-1)!.fills).toBeUndefined();
    expect(reopenLastCycle(closed).cycles.at(-1)!.fills).toHaveLength(3);
    expect(parseVrAccount(exportVrAccount(closed))).toEqual(closed);
    const broken = { ...closed, cycles: closed.cycles.map((c, i) => i === closed.cycles.length - 2 ? { ...c, fills: [{ id: "x", date: day(1), side: "buy", price: -1, quantity: 1 }] } : c) };
    expect(parseVrAccount(JSON.stringify(broken))).toBeNull();
  });

  it("counts overdue cycles from the cycle start", () => {
    const cycle = sheetAccount().cycles.at(-1)!;
    expect(overdueCycles(cycle, cycle.endDate)).toBe(0);
    expect(overdueCycles(cycle, addDays(cycle.endDate, 1))).toBe(1);
    expect(overdueCycles(cycle, addDays(cycle.startDate, 28))).toBe(2);
  });

  it("tracks the average cost and invested amount through fills, closes and corrections", () => {
    let account = createQuickResumeAccount(basic, { cycleStartDate: "2026-11-15", week: 20, shares: 75, averageCost: 51.81, referenceClose: 51.64, poolBeforeDeposit: 0, basis: "cost" });
    expect(costBasis(account)).toEqual({ averageCost: 51.81, shares: 75, cost: 3885.75, estimated: false });
    expect(startingCapital(account)).toBe(3885.75);
    account = addFill(account, { date: "2026-11-16", side: "buy", price: 50, quantity: 1 });
    account = addFill(account, { date: "2026-11-17", side: "sell", price: 60, quantity: 1 });
    // 매수: (3,885.75 + 50) / 76 = 51.786 → 매도는 평단가를 바꾸지 않는다
    expect(costBasis(account, 0, "2026-11-16")).toMatchObject({ averageCost: 51.79, shares: 76 });
    expect(costBasis(account)).toMatchObject({ averageCost: 51.79, shares: 75, cost: 3884.25 });
    // 기록 없이 2주 늘었으면 종료 종가로 샀다고 추정한다: (3,883.96 + 2 × 55) / 77 = 51.87
    const closed = closeCycle(account, { shares: 77, pool: 0, price: 55 });
    expect(costBasis(closed)).toMatchObject({ averageCost: 51.87, shares: 77, estimated: true });
    // 증권사 평단가를 넣으면 그 값을 쓴다
    expect(costBasis(closeCycle(account, { shares: 77, pool: 0, price: 55, averageCost: 52 }))).toMatchObject({ averageCost: 52, cost: 4004, estimated: false });
    expect(costBasis(setCurrentAverageCost(closed, 53))).toMatchObject({ averageCost: 53, estimated: false });
    expect(costBasis(createExistingAccount(basic, { cycleStartDate: "2026-11-15", week: 20, previousV: 4000, shares: 75, poolBeforeDeposit: 0, previousClose: 50 })).averageCost).toBeNull();
  });

  it("moves the current cycle start date and keeps fills inside the period", () => {
    let account = createQuickResumeAccount(basic, { cycleStartDate: "2026-11-17", week: 20, shares: 75, averageCost: 51.81, referenceClose: 51.64, poolBeforeDeposit: 0, basis: "cost" });
    const moved = rescheduleCurrentCycle(account, "2026-11-15");
    expect(moved.cycles[0]).toMatchObject({ startDate: "2026-11-15", endDate: "2026-11-28" });
    expect(moved.start.date).toBe("2026-11-15");
    account = addFill(account, { date: "2026-11-29", side: "buy", price: 50, quantity: 1 });
    expect(() => rescheduleCurrentCycle(account, "2026-11-15")).toThrow(/체결 기록/);
  });

  it("replays weeks 0 to N from daily closes with the sheet ladder", () => {
    // 2026-01-04(일)부터 매일 종가: 50에서 30일 동안 내려 35까지, 그 뒤 올라 60까지
    const prices = Array.from({ length: 120 }, (_, i) => ({ date: addDays("2026-01-04", i), close: Math.round((i < 30 ? 50 - i * 0.5 : 35 + (i - 30) * 0.3) * 100) / 100 }));
    expect(week0DateFor("2026-03-01", 8)).toBe("2026-01-04");
    const { account, reached } = runBacktest({ settings: basic, week0Date: "2026-01-04", principal: 10000, poolRatio: 0.15, untilWeek: 16, prices });
    expect(reached).toBe(true);
    expect(account.start).toMatchObject({ shares: 173, price: 50, pool: 1350 });
    expect(account.cycles.map((c) => c.week)).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(account.cycles.at(-1)!.close).toBeUndefined();
    for (let i = 0; i < account.cycles.length - 1; i += 1) {
      const c = account.cycles[i];
      const t = fillTotals(c);
      expect(c.close).toMatchObject({ shares: t.shares, pool: Math.max(0, t.pool) });
      expect(account.cycles[i + 1].shares).toBe(t.shares);
      for (const f of c.fills ?? []) expect(f.date >= c.startDate && f.date <= c.endDate).toBe(true);
    }
    // 내려가는 구간에는 매수, 올라가는 구간에는 매도가 생긴다
    expect(account.cycles.some((c) => fillTotals(c).buyQuantity > 0)).toBe(true);
    expect(account.cycles.some((c) => fillTotals(c).sellQuantity > 0)).toBe(true);
    // 가격 자료가 모자라면 멈춘다
    expect(runBacktest({ settings: basic, week0Date: "2026-01-04", principal: 10000, poolRatio: 0.15, untilWeek: 40, prices }).reached).toBe(false);
    expect(() => runBacktest({ settings: basic, week0Date: "2025-01-01", principal: 10000, poolRatio: 0.15, untilWeek: 8, prices })).toThrow(/이전 종가가 없습니다/);
    // 원금 어림: 매입금액 3,885.75 + 현금 100 − 적립금 250 × 9
    expect(estimatePrincipal(3885.75, 100, 250, 20)).toBe(1735.75);
  });
  it("fills the missing weeks 0..N-2 of a resumed account so they lead to the real current balance", () => {
    const prices = Array.from({ length: 120 }, (_, i) => ({ date: addDays("2026-01-04", i), close: Math.round((i < 30 ? 50 - i * 0.5 : 35 + (i - 30) * 0.3) * 100) / 100 }));
    const ref = prices.find((p) => p.date === "2026-04-25")!.close;
    const resumed = createQuickResumeAccount(basic, { cycleStartDate: "2026-04-26", week: 16, shares: 230, averageCost: 45, referenceClose: ref, poolBeforeDeposit: 300, basis: "cost" });
    const real = resumed.cycles[0];
    const input = { settings: basic, week0Date: week0DateFor(real.startDate, real.week), poolRatio: 0.15, untilWeek: 16, prices };
    expect(input.week0Date).toBe("2026-01-04");
    const calibrated = calibrateBacktest(input, { shares: 230, poolBeforeDeposit: 300 }, 10000);
    expect(calibrated.calibrated).toBe(true);
    expect(calibrated.result.reached).toBe(true);
    expect(calibrated.result.account.cycles.at(-1)!.shares).toBe(230);

    const merged = mergeHistory(resumed, calibrated.result);
    expect(merged.cycles.map((c) => c.week)).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    expect(merged.cycles.slice(0, -1).every((c) => c.estimated)).toBe(true);
    expect(firstRealIndex(merged)).toBe(7);
    // 실제 16주차는 그대로, 14주차 종료는 실제 시작 잔고로 이어 붙인다
    expect(merged.cycles[7]).toMatchObject({ v: real.v, shares: 230, poolBeforeDeposit: 300, averageCost: 45 });
    expect(merged.cycles[6].close).toEqual({ shares: 230, pool: 300, price: ref });
    expect(merged.start).toMatchObject({ kind: "new", date: "2026-01-04" });
    expect(merged.resumedStart).toEqual(resumed.start);
    expect(costBasis(merged)).toMatchObject({ averageCost: 45, shares: 230, estimated: false });
    expect(() => reopenLastCycle(merged)).toThrow(/재구성/);
    expect(() => rescheduleCurrentCycle(merged, "2026-04-19")).toThrow(/재구성/);
    expect(parseVrAccount(exportVrAccount(merged))).toEqual(merged);
    // 지우면 이어받을 때 상태로 돌아간다(평단가 고정만 남음)
    const cleared = removeEstimatedHistory(merged);
    expect(hasEstimatedHistory(cleared)).toBe(false);
    expect(cleared.start).toEqual(resumed.start);
    expect(cleared.cycles).toEqual([{ ...real, averageCost: 45 }]);
    // 원금을 직접 주면 그 값으로 한 번만 재생한다
    expect(calibrateBacktest(input, { shares: 230, poolBeforeDeposit: 300 }, 10000, 9000)).toMatchObject({ principal: 9000, calibrated: false });
  });
});
