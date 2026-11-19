import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import VrPage from "./VrPage";
import { VR_STORAGE_KEY } from "./vrStorage";

const props = { onOpenReport: vi.fn(), onOpenPortfolio: vi.fn(), onOpenPortfolioReport: vi.fn(), onOpenEtfCompare: vi.fn() };
const fill = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } });

const history = {
  schemaVersion: 1,
  instrument: { ticker: "TQQQ", name: "ProShares UltraPro QQQ", country: "US", assetType: "ETF" },
  prices: [{ date: "2026-11-13", close: 52.5 }, { date: "2026-11-16", close: 51.6399 }, { date: "2026-11-17", close: 50 }],
};
const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify(history), { status: 200 }));

beforeEach(() => { window.localStorage.removeItem(VR_STORAGE_KEY); fetchMock.mockClear(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// 시트 20주차 상태(실력공식, 적립금 65)로 이어가기
function startExistingSkill() {
  fireEvent.click(screen.getByRole("tab", { name: "이어가기 (V를 알 때)" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "새로 시작" }));
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

  it("resumes from week, shares, average cost and deposit with an auto-filled close", async () => {
    render(<VrPage {...props} />);
    fill("2주 적립금 (USD)", "65");
    fill("이번 사이클 시작일", "2026-11-17");
    await waitFor(() => expect((screen.getByLabelText("직전 마감 종가 (USD)") as HTMLInputElement).value).toBe("51.64"));
    expect(screen.getByText("2026-11-16 종가 자동 입력 (수정 가능)")).toBeTruthy();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("api/market-data/history/US/TQQQ");
    fill("현재 주차", "20"); fill("보유 수량 (주)", "75"); fill("평단가 (USD)", "51.81");
    // 직전 V 대체값 75 × 51.81 = 3,885.75 → V = 3,885.75 + 0/10 + 65
    expect(screen.getByText(/20주차 시작 미리보기: 직전 V \$3,885\.75 → V \$3,950\.750/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "계좌 시작" }));
    expect(screen.getByRole("heading", { name: /20주차 · 2026-11-17 ~ 2026-11-30/ })).toBeTruthy();
    expect(screen.getByText(/평단가 \$51\.81 · 직전 종가 \$51\.64로 이어받음/)).toBeTruthy();
  });

  it("keeps a manually entered close and shows validation errors", async () => {
    render(<VrPage {...props} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fill("직전 마감 종가 (USD)", "60");
    fill("이번 사이클 시작일", "2026-11-17");
    expect((screen.getByLabelText("직전 마감 종가 (USD)") as HTMLInputElement).value).toBe("60");
    fireEvent.click(screen.getByRole("button", { name: "계좌 시작" }));
    expect(screen.getByRole("alert").textContent).toContain("현재 주차");
    fireEvent.click(screen.getByRole("tab", { name: "새로 시작" }));
    fireEvent.click(screen.getByRole("button", { name: "계좌 시작" }));
    expect(screen.getByRole("alert").textContent).toContain("0일차");
    expect(window.localStorage.getItem(VR_STORAGE_KEY)).toBeNull();
  });
});
