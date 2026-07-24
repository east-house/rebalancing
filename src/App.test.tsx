import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import {
  parseLocalAppState,
  PORTFOLIO_STORAGE_KEY,
  PORTFOLIO_STORAGE_VERSION,
} from "./storage/portfolioStorage";

const marketDataPayload = {
  schemaVersion: 1,
  generatedAt: "2026-07-20T07:30:00Z",
  expectedShardCount: 8,
  availableShards: [0, 1, 2, 3, 4, 5, 6, 7],
  complete: true,
  quoteCount: 5,
  fx: {
    usdKrw: {
      pair: "USD/KRW",
      currency: "KRW",
      closes: [
        { date: "2026-07-16", close: 1380 },
        { date: "2026-07-17", close: 1390 },
      ],
    },
  },
  quotes: [
    ...([
      ["VOO", "Vanguard S&P 500 ETF", 490, 500, "ETF"],
      ["QQQ", "Invesco QQQ Trust", 480, 490, "ETF"],
      ["GOOG", "Alphabet Inc. Class C", 180, 190, "STOCK"],
      ["AAPL", "Apple Inc.", 320, 325, "STOCK"],
    ] as const).map(([ticker, name, previous, today, assetType]) => ({
      ticker,
      name,
      country: "US" as const,
      assetType,
      currency: "USD" as const,
      closes: [
        { date: "2026-07-16", close: previous },
        { date: "2026-07-17", close: today },
      ],
    })),
    {
      ticker: "005930",
      name: "삼성전자",
      country: "KR" as const,
      assetType: "STOCK" as const,
      currency: "KRW" as const,
      closes: [
        { date: "2026-07-16", close: 90_000 },
        { date: "2026-07-17", close: 91_000 },
      ],
    },
  ],
};

describe("App", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/market-data/latest")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => marketDataPayload,
          } as Response);
        }
        if (url.includes("/api/market-data/history/")) {
          const ticker = decodeURIComponent(url.split("/").at(-1) ?? "");
          const quote = marketDataPayload.quotes.find(
            (candidate) => candidate.ticker === ticker,
          );
          return Promise.resolve({
            ok: Boolean(quote),
            status: quote ? 200 : 404,
            json: async () => ({
              schemaVersion: 1,
              instrument: quote
                ? {
                    ticker: quote.ticker,
                    name: quote.name,
                    country: quote.country,
                    assetType: quote.assetType,
                  }
                : {},
              prices: quote?.closes ?? [],
            }),
          } as Response);
        }
        return new Promise<Response>(() => undefined);
      }),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("renders the portfolio dashboard with R2 prices", async () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "보유 자산" })).toBeTruthy();
    expect(screen.getAllByText("₩100,000,000").length).toBeGreaterThan(0);
    expect(await screen.findByText("R2 종가")).toBeTruthy();
    expect(screen.getByDisplayValue("GOOG")).toBeTruthy();
    expect(screen.getAllByText("Alphabet Inc. Class C").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("region", { name: "현재 총자산" }).textContent,
    ).toContain("₩116,958,000");
    expect(screen.getByText("$20,000.00")).toBeTruthy();
    expect(screen.getByText("+24.4%")).toBeTruthy();
    expect(screen.getByText("당일 종가 우선")).toBeTruthy();
    expect(screen.getAllByText("$500.00").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "현재 비중" })).toBeNull();
    expect(
      await screen.findByText(/현재 보유수량과 현금을 고정해 R2 과거 종가/),
    ).toBeTruthy();
  });

  it("searches by ticker and selects the matching instrument", async () => {
    render(<App />);
    await screen.findByText("R2 종가");

    const firstTicker = screen.getByLabelText("1번째 종목 검색");
    await act(async () => {
      fireEvent.change(firstTicker, { target: { value: "aapl" } });
      fireEvent.keyDown(firstTicker, { key: "Enter" });
      await Promise.resolve();
    });

    expect(screen.getByDisplayValue("AAPL")).toBeTruthy();
    expect(screen.getAllByText("Apple Inc.").length).toBeGreaterThan(0);
  });

  it("adds another holding row", async () => {
    render(<App />);
    await screen.findByText("R2 종가");

    fireEvent.click(screen.getByRole("button", { name: "종목 추가" }));

    expect(screen.getAllByLabelText(/번째 종목 검색/)).toHaveLength(4);
  });

  it("shows Korean holding names instead of stock codes in the allocation", async () => {
    localStorage.setItem(
      PORTFOLIO_STORAGE_KEY,
      JSON.stringify({
        version: PORTFOLIO_STORAGE_VERSION,
        updatedAt: new Date().toISOString(),
        data: {
          portfolio: {
            totalAssets: 10_000_000,
            targetCashWeight: 65,
            holdings: [
              {
                ticker: "005930",
                name: "삼성전자",
                country: "KR",
                assetType: "STOCK",
                quantity: 10,
                averagePrice: 80_000,
                targetWeight: 35,
              },
            ],
          },
          pricePolicy: "auto",
          snapshots: [],
        },
      }),
    );

    render(<App />);
    await screen.findByText("R2 종가");

    const legend = screen.getByRole("list", { name: "현재 자산 구성 범례" });
    expect(within(legend).getByText("삼성전자")).toBeTruthy();
    expect(within(legend).queryByText("005930")).toBeNull();
  });

  it("stores an average purchase price and shows the native-price return", async () => {
    render(<App />);
    await screen.findByText("R2 종가");

    fireEvent.change(screen.getByLabelText("VOO 평균 매수가"), {
      target: { value: "450" },
    });

    expect(screen.getByText("+10.6%")).toBeTruthy();
    expect(
      parseLocalAppState(localStorage.getItem(PORTFOLIO_STORAGE_KEY) ?? "")
        ?.portfolio.holdings[0].averagePrice,
    ).toBe(450);
  });

  it("automatically applies Kiwoom buy and estimated sell costs", async () => {
    render(<App />);
    await screen.findByText("R2 종가");

    expect(screen.getByText("$113.32")).toBeTruthy();
    expect(
      screen.getAllByText(
        "매수·매도 0.25% + 주당 $0.003 · 매도 SEC 0.00206%",
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByLabelText("VOO 누적 수수료")).toBeNull();
  });

  it("does not turn purchase fees into negative available cash", async () => {
    render(<App />);
    await screen.findByText("R2 종가");

    fireEvent.change(screen.getByRole("spinbutton", { name: "총 투자금" }), {
      target: { value: "68805000" },
    });

    const cashStat = screen.getByText("가용 현금").parentElement;
    expect(cashStat).not.toBeNull();
    expect(within(cashStat as HTMLElement).getByText("₩0")).toBeTruthy();
    expect(screen.queryByText(/자동 매수수수료 합계가/)).toBeNull();
  });

  it("requires average prices before using investment cash for rebalancing", async () => {
    render(<App />);
    await screen.findByText("R2 종가");

    fireEvent.change(screen.getByLabelText("VOO 평균 매수가"), {
      target: { value: "" },
    });

    expect(screen.getByText("VOO의 평단가를 입력해 주세요.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /매수·매도 수량 계산/ }),
    ).toHaveProperty("disabled", true);
  });

  it("calculates and displays a rebalance preview", async () => {
    render(<App />);

    const calculateButton = screen.getByRole("button", {
      name: /매수·매도 수량 계산/,
    });
    await waitFor(() =>
      expect(calculateButton).not.toHaveProperty("disabled", true),
    );

    fireEvent.click(calculateButton);

    expect(
      screen.getByRole("heading", { name: "리밸런싱 미리보기" }),
    ).toBeTruthy();
    expect(screen.getByText("예상 잔여 현금")).toBeTruthy();
    expect(screen.getByText("매수 8주")).toBeTruthy();
    expect(screen.getByText("매수 11주")).toBeTruthy();
    expect(screen.getByText("매수 20주")).toBeTruthy();
    expect(screen.getByText(/거래비용 .* 반영/)).toBeTruthy();
  });

  it("fetches the public quote bundle without sending portfolio inputs", async () => {
    render(<App />);

    await screen.findByText("R2 종가");
    const calls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    const marketCall = calls.find((url) =>
      url.includes("/api/market-data/latest"),
    );

    expect(marketCall).toBe("/api/market-data/latest");
    expect(marketCall).not.toContain("GOOG");
    expect(marketCall).not.toContain("quantity");
  });

  it("blocks rebalancing when target weights do not add up to 100%", async () => {
    render(<App />);
    await screen.findByText("R2 종가");

    const targetInputs = screen.getAllByLabelText(/목표 비중/);
    fireEvent.change(targetInputs[0], { target: { value: "20" } });

    expect(screen.getByText("15%를 더 배분해 주세요.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /매수·매도 수량 계산/ }),
    ).toHaveProperty("disabled", true);
  });

  it("restores portfolio input from this browser only", async () => {
    const firstRender = render(<App />);
    await screen.findByText("R2 종가");
    const investmentInput = screen.getByRole("spinbutton", {
      name: "총 투자금",
    });
    fireEvent.change(investmentInput, { target: { value: "123000000" } });
    await waitFor(() => {
      const storedState = parseLocalAppState(
        localStorage.getItem(PORTFOLIO_STORAGE_KEY) ?? "",
      );
      expect(
        storedState?.snapshots.find(
          (snapshot) => snapshot.date === "2026-07-17",
        )?.totalValue,
      ).toBe(139958000);
    });
    firstRender.unmount();

    render(<App />);
    await screen.findByText("R2 종가");

    expect(
      screen.getByRole("spinbutton", { name: "총 투자금" }),
    ).toHaveProperty("value", "123000000");
    expect(
      screen.getByText("이 기기에 저장된 자산 정보를 복구했습니다."),
    ).toBeTruthy();
  });

  it("deletes saved data and resets the screen after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await screen.findByText("R2 종가");

    fireEvent.change(screen.getByRole("spinbutton", { name: "총 투자금" }), {
      target: { value: "123000000" },
    });
    expect(localStorage.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "내 데이터 삭제" }));

    expect(
      screen.getByRole("spinbutton", { name: "총 투자금" }),
    ).toHaveProperty("value", "100000000");
    expect(
      screen.getByText(
        "이 기기에 저장된 자산 정보를 삭제하고 샘플 상태로 초기화했습니다.",
      ),
    ).toBeTruthy();
  });
});
