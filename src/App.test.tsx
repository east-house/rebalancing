import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import App from "./App";

describe("App", () => {
  it("renders the sample portfolio dashboard", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "보유 자산" })).toBeTruthy();
    expect(screen.getAllByText("₩100,000,000").length).toBeGreaterThan(0);
    expect(screen.getByText("샘플 데이터")).toBeTruthy();
    expect(screen.getByDisplayValue("GOOG")).toBeTruthy();
    expect(screen.getAllByText("Alphabet Inc. Class C").length).toBeGreaterThan(0);
  });

  it("normalizes ticker search to English uppercase and shows the instrument name", () => {
    render(<App />);

    const firstTicker = screen.getByLabelText("1번째 종목 ticker");
    fireEvent.change(firstTicker, { target: { value: "aapl한글12" } });

    expect(screen.getByDisplayValue("AAPL")).toBeTruthy();
    expect(screen.getAllByText("Apple Inc.").length).toBeGreaterThan(0);
  });

  it("adds another holding row", () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "종목 추가" }));

    expect(screen.getAllByLabelText(/번째 종목 ticker/)).toHaveLength(4);
  });

  it("calculates and displays a rebalance preview", () => {
    render(<App />);

    const calculateButton = screen.getByRole("button", {
      name: /리밸런싱 계산/,
    });
    expect(calculateButton).not.toHaveProperty("disabled", true);

    fireEvent.click(calculateButton);

    expect(
      screen.getByRole("heading", { name: "리밸런싱 미리보기" }),
    ).toBeTruthy();
    expect(screen.getByText("예상 잔여 현금")).toBeTruthy();
  });

  it("blocks rebalancing when target weights do not add up to 100%", () => {
    render(<App />);

    const targetInputs = screen.getAllByLabelText(/목표 비중/);
    fireEvent.change(targetInputs[0], { target: { value: "20" } });

    expect(screen.getByText("15%를 더 배분해 주세요.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /리밸런싱 계산/ }),
    ).toHaveProperty("disabled", true);
  });
});
