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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

const nowText = () => document.querySelector(".vr-now")!.textContent!;

describe("VR installment page", () => {
  it("suggests the day-0 split for a new account", () => {
    render(<VrPage {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "새로 시작" }));
    fill("원금 (USD)", "10000"); fill("기준 가격 (USD)", "50");
    expect(screen.getByText(/제안: 173주 매수/)).toBeTruthy();
  });

  it("continues the sheet account, shows the current situation, chart and ladder, ends a week and persists", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<VrPage {...props} />);
    startExistingSkill();
    expect(screen.getByRole("heading", { name: /20주차 · 2026-11-15 ~ 2026-11-28/ })).toBeTruthy();
    expect(screen.getAllByText("$5,452.905").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /매수 12줄/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /매도 74줄/ })).toBeTruthy();
    expect(screen.getByText("$61.79")).toBeTruthy();
    expect(screen.getByText("$83.62")).toBeTruthy();
    // 현재 상황 카드: 최근 종가 50 × 75주 = 3,750 < V 최소 → 매수 구간, 12줄 모두 체결되는 가격
    await waitFor(() => expect(nowText()).toContain("2026-11-17 종가 $50.00 × 75주"));
    expect(nowText()).toContain("평가금 $3,750");
    expect(nowText()).toContain("매수 구간");
    expect(nowText()).toContain("주문표 매수 12줄까지 체결");
    expect(nowText()).toContain("목표값");
    expect(nowText()).toContain("평단가를 몰라 표시할 수 없습니다");
    fill("다른 가격으로 확인 (선택, USD)", "90");
    expect(nowText()).toContain("입력한 가격 $90.00 × 75주");
    expect(nowText()).toContain("매도 구간");
    // 그래프는 기본으로 펼쳐져 있고, 종가 위에 목표가·최소가·최대가를 겹친다
    expect(await screen.findByRole("img", { name: "종가와 목표가·최소가·최대가, 20주차부터 20주차까지" })).toBeTruthy();
    // 사용 순서만 접혀 있고 나머지는 펼쳐져 있다
    const folds = [...document.querySelectorAll<HTMLDetailsElement>("details.vr-fold")];
    expect(folds.filter((d) => !d.open).map((d) => d.querySelector(".vr-fold-title")!.textContent)).toEqual(["사용 순서"]);
    // 가격 자료가 0주차(2026-06-28)까지 없으면 백테스트가 안내를 띄운다
    expect((screen.getByLabelText("0주차 날짜") as HTMLInputElement).value).toBe("2026-06-28");
    expect(screen.getByText(/2026-06-28 이전 종가가 없습니다/)).toBeTruthy();
    // 번호 없는 제목, 현재 상황이 먼저
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
    expect(h2[0]).toMatch(/^20주차 · /);
    expect(h2.some((t) => /^\d{2} /.test(t))).toBe(false);

    fill("종료 Pool, 적립 전 (USD)", "862.91"); fill("종료 종가 (USD)", "51.81");
    fireEvent.click(screen.getByRole("button", { name: "주차 종료" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /22주차 · 2026-11-29/ })).toBeTruthy();
    const saved = JSON.parse(window.localStorage.getItem(VR_STORAGE_KEY)!);
    expect(saved.cycles).toHaveLength(2);
    cleanup();
    render(<VrPage {...props} />);
    expect(screen.getByText(/22주차 진행 중/)).toBeTruthy();
  });

  it("resumes from week, shares and average cost, then shows invested amount and profit", async () => {
    render(<VrPage {...props} />);
    fill("2주 적립금 (USD)", "65");
    fill("이번 주차 시작일", "2026-11-17");
    await waitFor(() => expect((screen.getByLabelText("직전 마감 종가 (USD)") as HTMLInputElement).value).toBe("51.64"));
    expect(screen.getByText("2026-11-16 종가 자동 입력 (수정 가능)")).toBeTruthy();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("api/market-data/history/US/TQQQ");
    fill("현재 주차", "20"); fill("보유 수량 (주)", "75"); fill("평단가 (USD)", "51.81");
    // 직전 V 대체값 75 × 51.81 = 3,885.75 → V = 3,885.75 + 0/10 + 65
    expect(screen.getByText(/20주차 시작 미리보기: 직전 V \$3,885\.75 → V \$3,950\.750/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "계좌 시작" }));
    expect(screen.getByRole("heading", { name: /20주차 · 2026-11-17 ~ 2026-11-30/ })).toBeTruthy();
    expect(screen.getByText(/평단가 \$51\.81 · 직전 종가 \$51\.64로 이어받음/)).toBeTruthy();
    // 매입금액 75 × 51.81 = 3,885.75, 평가금 75 × 50 = 3,750 → −135.75 (−3.5%)
    expect(nowText()).toContain("$3,885.75 = 평단가 $51.81 × 75주");
    await waitFor(() => expect(nowText()).toContain("매입금액 대비 −$135.75 (−3.5%)"));
    // 총 투입금 3,885.75 + 적립 65 = 3,950.75, 총자산 3,750 + Pool 65 = 3,815
    expect(nowText()).toContain("$3,950.75");
    expect(nowText()).toContain("$3,815.00");
    expect(nowText()).toContain("−$135.75 (−3.4%)");

    // 이번 주차 시작일을 11-15로 고치면 기간이 옮겨진다
    fill("이번 주차 시작일", "2026-11-15");
    fireEvent.click(screen.getByRole("button", { name: "계좌 정보 저장" }));
    expect(screen.getByRole("heading", { name: /20주차 · 2026-11-15 ~ 2026-11-28/ })).toBeTruthy();
  });

  it("keeps a manually entered close and shows validation errors", async () => {
    render(<VrPage {...props} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fill("직전 마감 종가 (USD)", "60");
    fill("이번 주차 시작일", "2026-11-17");
    expect((screen.getByLabelText("직전 마감 종가 (USD)") as HTMLInputElement).value).toBe("60");
    fireEvent.click(screen.getByRole("button", { name: "계좌 시작" }));
    expect(screen.getByRole("alert").textContent).toContain("현재 주차");
    fireEvent.click(screen.getByRole("tab", { name: "새로 시작" }));
    fireEvent.click(screen.getByRole("button", { name: "계좌 시작" }));
    expect(screen.getByRole("alert").textContent).toContain("0일차");
    expect(window.localStorage.getItem(VR_STORAGE_KEY)).toBeNull();
  });

  it("records daily fills and ends an overdue week from the form after choosing later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T12:00:00"));
    try {
      render(<VrPage {...props} />);
      startExistingSkill();
      expect(screen.getByRole("alertdialog", { name: "20주차가 끝났습니다" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "나중에" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(screen.getByText("20주차 사이클이 2026-11-28에 끝났습니다.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "매수 1번 $61.79 체결 기록" }));
      expect((screen.getByLabelText("체결가 (USD)") as HTMLInputElement).value).toBe("61.79");
      fill("체결일", "2026-11-16");
      expect(screen.getByText("체결 금액 $61.79")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "체결 추가" }));
      // 75주 · Pool 862.91 → 매수 1주 61.79 후 76주 · 801.12
      expect(screen.getByText(/매수 1주 \$61\.79 · 매도 0주 \$0\.00 → 보유 76주 · Pool \$801\.12/)).toBeTruthy();
      expect((screen.getByLabelText("종료 보유 수량 (주)") as HTMLInputElement).value).toBe("76");
      expect((screen.getByLabelText("종료 Pool, 적립 전 (USD)") as HTMLInputElement).value).toBe("801.12");
      await waitFor(() => expect((screen.getByLabelText("종료 종가 (USD)") as HTMLInputElement).value).toBe("50"));
      fireEvent.click(screen.getByRole("button", { name: "주차 종료" }));
      expect(screen.getByRole("heading", { name: /22주차 · 2026-11-29/ })).toBeTruthy();
      expect(screen.queryByRole("alertdialog")).toBeNull();
      const saved = JSON.parse(window.localStorage.getItem(VR_STORAGE_KEY)!);
      expect(saved.cycles[0].fills).toHaveLength(1);
      expect(saved.cycles[0].close).toEqual({ shares: 76, pool: 801.12, price: 50 });
    } finally { vi.useRealTimers(); }
  });

  it("ends an overdue week with one confirm in the dialog", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-30T12:00:00"));
    try {
      render(<VrPage {...props} />);
      startExistingSkill();
      const dialog = screen.getByRole("alertdialog", { name: "20주차가 끝났습니다" });
      await waitFor(() => expect(dialog.textContent).toContain("$50.00 (2026-11-17)"));
      fireEvent.click(screen.getByRole("button", { name: "확인" }));
      expect(screen.getByRole("heading", { name: /22주차 · 2026-11-29 ~ 2026-12-12/ })).toBeTruthy();
      expect(screen.queryByRole("alertdialog")).toBeNull();
      const saved = JSON.parse(window.localStorage.getItem(VR_STORAGE_KEY)!);
      expect(saved.cycles[0].close).toEqual({ shares: 75, pool: 862.91, price: 50 });
    } finally { vi.useRealTimers(); }
  });
});
