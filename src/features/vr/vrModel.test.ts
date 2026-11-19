import { describe, expect, it } from "vitest";
import {
  VR_DEFAULT_SETTINGS, addDays, addFill, fillTotals, overdueCycles, removeFill, buildOrders, closeCycle, createExistingAccount, createNewAccount, createQuickResumeAccount, gForWeek,
  nextV, openCycle, poolLimitForWeek, reopenLastCycle, suggestInitialBuy, valuationStatus, type VrAccount,
} from "./vrModel";
import { exportVrAccount, parseVrAccount } from "./vrStorage";

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
});
