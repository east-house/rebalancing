import { describe, expect, it } from "vitest";
import {
  VR_DEFAULT_SETTINGS, addDays, buildOrders, closeCycle, createExistingAccount, createNewAccount, gForWeek,
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
});
