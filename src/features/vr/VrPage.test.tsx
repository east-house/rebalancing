import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VrPage from "./VrPage";
import { VR_STORAGE_KEY } from "./vrStorage";

const props = { onOpenReport: vi.fn(), onOpenPortfolio: vi.fn(), onOpenPortfolioReport: vi.fn(), onOpenEtfCompare: vi.fn() };
const fill = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });

beforeEach(() => window.localStorage.removeItem(VR_STORAGE_KEY));
afterEach(cleanup);

// 시트 20주차 상태(실력공식, 적립금 65)로 이어가기
function startExistingSkill() {
  fireEvent.click(screen.getByRole("tab", { name: "운용 중인 계좌 이어가기" }));
  fill("2주 적립금 (USD)", "65");
  fireEvent.click(screen.getByRole("radio", { name: /실력공식/ }));
  fill("이번 사이클 시작일", "2026-11-15");
  fill("이번 사이클 주차 (짝수)", "20");
  fill("직전 사이클 V (USD)", "5492.548");
  fill("직전 사이클 마감 종가 (USD)", "57.68");
  fill("현재 보유 수량 (주)", "75");
  fill("현재 Pool, 적립 전 (USD)", "797.91");
  fireEvent.click(screen.getByRole("button", { name: "계좌 시작" }));
}

describe("VR installment page", () => {
  it("suggests the day-0 split for a new account", () => {
    render(<VrPage {...props} />);
    fill("원금 (USD)", "10000"); fill("기준 가격 (USD)", "50");
    expect(screen.getByText(/제안: 173주 매수/)).toBeTruthy();
  });

  it("continues the sheet account, shows the sheet ladder, closes a cycle and persists", () => {
    render(<VrPage {...props} />);
    startExistingSkill();
    expect(screen.getByRole("heading", { name: /20주차 · 2026-11-15 ~ 2026-11-28/ })).toBeTruthy();
    expect(screen.getAllByText("$5,452.905").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /매수 12줄/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /매도 74줄/ })).toBeTruthy();
    expect(screen.getByText("$61.79")).toBeTruthy();
    expect(screen.getByText("$83.62")).toBeTruthy();

    fill("마감 Pool, 적립 전 (USD)", "862.91"); fill("마감 종가 (USD)", "51.81");
    fireEvent.click(screen.getByRole("button", { name: "사이클 마감" }));
    expect(screen.getByRole("heading", { name: /22주차 · 2026-11-29/ })).toBeTruthy();

    const saved = JSON.parse(window.localStorage.getItem(VR_STORAGE_KEY)!);
    expect(saved.cycles).toHaveLength(2);
    cleanup();
    render(<VrPage {...props} />);
    expect(screen.getByText(/22주차 진행 중/)).toBeTruthy();
  });

  it("shows validation errors without creating an account", () => {
    render(<VrPage {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "계좌 시작" }));
    expect(screen.getByRole("alert").textContent).toContain("0일차");
    expect(window.localStorage.getItem(VR_STORAGE_KEY)).toBeNull();
  });
});
