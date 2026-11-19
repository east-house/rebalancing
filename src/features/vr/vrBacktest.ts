import {
  WEEKS_PER_CYCLE, addDays, addFill, buildOrders, closeCycle, createNewAccount, currentCycle, fillTotals, roundCent,
  suggestInitialBuy, type VrAccount, type VrSettings,
} from "./vrModel";
import type { ReferenceClose } from "./vrPrices";

export interface BacktestInput {
  settings: VrSettings;
  /** 0주차(첫 매수) 날짜 */
  week0Date: string;
  /** 0주차에 넣은 원금 */
  principal: number;
  /** 0주차 Pool 비율 P/V (기본 0.15) */
  poolRatio: number;
  /** 이 주차의 사이클이 열릴 때까지 진행한다 */
  untilWeek: number;
  prices: ReferenceClose[];
}

export interface BacktestResult {
  account: VrAccount;
  /** untilWeek 사이클까지 도달했는지(가격 데이터가 모자라면 false) */
  reached: boolean;
}

/** 현재 주차와 시작일로 0주차 날짜를 구한다(주차 × 7일 전). */
export function week0DateFor(currentStartDate: string, currentWeek: number): string {
  return addDays(currentStartDate, -currentWeek * 7);
}

/**
 * 0주차부터 지정 주차까지 VR 적립식을 일별 종가로 재생한다.
 * 사이클 시작 때 시트 규칙의 주문표(1주씩 지정가)를 걸어 두고, 그날 종가가 매수가 이하이면 매수 줄이,
 * 매도가 이상이면 매도 줄이 지정가로 체결됐다고 본다. 장중 고가·저가가 없으므로 실제보다 체결이 적거나 가격이 다를 수 있다.
 */
export function runBacktest(input: BacktestInput): BacktestResult {
  const prices = [...input.prices].sort((a, b) => a.date.localeCompare(b.date));
  const day0 = [...prices].reverse().find((p) => p.date <= input.week0Date);
  if (!day0) throw new Error(`${input.week0Date} 이전 종가가 없습니다. 가격 자료는 최근 약 1년치입니다.`);
  const buy = suggestInitialBuy(input.principal, day0.close, input.poolRatio);
  if (buy.shares < 1) throw new Error("원금이 0주차 종가보다 작아 1주도 살 수 없습니다.");
  let account = createNewAccount(input.settings, { date: input.week0Date, shares: buy.shares, close: day0.close, pool: buy.pool }, "backtest");

  while (currentCycle(account).week < input.untilWeek) {
    const cycle = currentCycle(account);
    const days = prices.filter((p) => p.date >= cycle.startDate && p.date <= cycle.endDate);
    const lastDate = prices.at(-1)?.date ?? "";
    if (days.length === 0 || lastDate < cycle.endDate) return { account, reached: false };
    const orders = buildOrders(cycle);
    let b = 0;
    let s = 0;
    for (const day of days) {
      while (b < orders.buys.length && day.close <= orders.buys[b].price) {
        account = addFill(account, { date: day.date, side: "buy", price: orders.buys[b].price, quantity: 1 });
        b += 1;
      }
      while (s < orders.sells.length && day.close >= orders.sells[s].price) {
        account = addFill(account, { date: day.date, side: "sell", price: orders.sells[s].price, quantity: 1 });
        s += 1;
      }
    }
    const totals = fillTotals(currentCycle(account));
    account = closeCycle(account, { shares: totals.shares, pool: Math.max(0, totals.pool), price: days[days.length - 1].close });
  }
  return { account, reached: true };
}

/** 지금 잔고로 0주차 원금을 거꾸로 어림한다: 매입금액 + 적립 전 현금 − 그동안의 적립금. */
export function estimatePrincipal(cost: number | null, poolBeforeDeposit: number, deposit: number, currentWeek: number): number | null {
  if (cost == null) return null;
  const deposits = Math.max(0, currentWeek / WEEKS_PER_CYCLE - 1) * deposit;
  const value = roundCent(cost + poolBeforeDeposit - deposits);
  return value > 0 ? value : roundCent(cost);
}

