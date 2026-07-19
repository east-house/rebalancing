import { describe, expect, it } from "vitest";

import type { Instrument } from "../types/instrument";
import { searchInstruments } from "./InstrumentSearch";

const INSTRUMENTS: Instrument[] = [
  {
    ticker: "379810",
    name: "KODEX 미국나스닥100",
    market: "KRX",
    country: "KR",
    assetType: "ETF",
  },
  {
    ticker: "005930",
    name: "삼성전자",
    market: "KOSPI",
    country: "KR",
    assetType: "STOCK",
  },
  {
    ticker: "GOOG",
    name: "Alphabet Inc Class C Capital Stock",
    market: "NASDAQ Global Select",
    country: "US",
    assetType: "STOCK",
  },
];

describe("searchInstruments", () => {
  it("finds a Korean ETF by a name query with spaces", () => {
    expect(searchInstruments(INSTRUMENTS, "KODEX 미국 나스닥")[0]).toMatchObject({
      ticker: "379810",
      name: "KODEX 미국나스닥100",
    });
  });

  it("finds instruments by ticker or company name", () => {
    expect(searchInstruments(INSTRUMENTS, "goog")[0]?.ticker).toBe("GOOG");
    expect(searchInstruments(INSTRUMENTS, "alphabet")[0]?.ticker).toBe("GOOG");
  });
});
