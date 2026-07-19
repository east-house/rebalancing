import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import {
  getKstCalendarDate,
  parseLocalAppState,
  PORTFOLIO_STORAGE_KEY,
} from "./storage/portfolioStorage";

const marketDataPayload = {
  schemaVersion: 1,
  generatedAt: "2026-07-20T07:30:00Z",
  expectedShardCount: 8,
  availableShards: [0, 1, 2, 3, 4, 5, 6, 7],
  complete: true,
  quoteCount: 4,
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
  quotes: ([
    ["VOO", "Vanguard S&P 500 ETF", 490, 500, "ETF"],
    ["QQQ", "Invesco QQQ Trust", 480, 490, "ETF"],
    ["GOOG", "Alphabet Inc. Class C", 180, 190, "STOCK"],
    ["AAPL", "Apple Inc.", 320, 325, "STOCK"],
  ] as const).map(([ticker, name, previous, today, assetType]) => ({
    ticker,
    name,
    country: "US",
    assetType,
    currency: "USD",
    closes: [
      { date: "2026-07-16", close: previous },
      { date: "2026-07-17", close: today },
    ],
  })),
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
  });

  it("searches by ticker and selects the matching instrument", async () => {
    render(<App />);
    await screen.findByText("R2 종가");

    const firstTicker = screen.getByLabelText("1번째 종목 검색");
    fireEvent.change(firstTicker, { target: { value: "aapl" } });
    fireEvent.keyDown(firstTicker, { key: "Enter" });

    expect(screen.getByDisplayValue("AAPL")).toBeTruthy();
    expect(screen.getAllByText("Apple Inc.").length).toBeGreaterThan(0);
  });

  it("adds another holding row", async () => {
    render(<App />);
    await screen.findByText("R2 종가");

    fireEvent.click(screen.getByRole("button", { name: "종목 추가" }));

    expect(screen.getAllByLabelText(/번째 종목 검색/)).toHaveLength(4);
  });

  it("calculates and displays a rebalance preview", async () => {
    render(<App />);

    const calculateButton = screen.getByRole("button", {
      name: /리밸런싱 계산/,
    });
    await waitFor(() =>
      expect(calculateButton).not.toHaveProperty("disabled", true),
    );

    fireEvent.click(calculateButton);

    expect(
      screen.getByRole("heading", { name: "리밸런싱 미리보기" }),
    ).toBeTruthy();
    expect(screen.getByText("예상 잔여 현금")).toBeTruthy();
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
      screen.getByRole("button", { name: /리밸런싱 계산/ }),
    ).toHaveProperty("disabled", true);
  });

  it("restores portfolio input from this browser only", async () => {
    const firstRender = render(<App />);
    await screen.findByText("R2 종가");
    const totalAssetsInput = screen.getByRole("spinbutton", {
      name: "현재 총자산",
    });
    fireEvent.change(totalAssetsInput, { target: { value: "123000000" } });
    const storedState = parseLocalAppState(
      localStorage.getItem(PORTFOLIO_STORAGE_KEY) ?? "",
    );
    expect(
      storedState?.snapshots.find(
        (snapshot) => snapshot.date === getKstCalendarDate(),
      )?.totalValue,
    ).toBe(123000000);
    firstRender.unmount();

    render(<App />);
    await screen.findByText("R2 종가");

    expect(
      screen.getByRole("spinbutton", { name: "현재 총자산" }),
    ).toHaveProperty("value", "123000000");
    expect(
      screen.getByText("이 기기에 저장된 자산 정보를 복구했습니다."),
    ).toBeTruthy();
  });

  it("deletes saved data and resets the screen after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    await screen.findByText("R2 종가");

    fireEvent.change(screen.getByRole("spinbutton", { name: "현재 총자산" }), {
      target: { value: "123000000" },
    });
    expect(localStorage.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "내 데이터 삭제" }));

    expect(
      screen.getByRole("spinbutton", { name: "현재 총자산" }),
    ).toHaveProperty("value", "100000000");
    expect(
      screen.getByText(
        "이 기기에 저장된 자산 정보를 삭제하고 샘플 상태로 초기화했습니다.",
      ),
    ).toBeTruthy();
  });
});
