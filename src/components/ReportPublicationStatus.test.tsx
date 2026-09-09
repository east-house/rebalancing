import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReportPublicationStatus from "./ReportPublicationStatus";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Publication and recovery status", () => {
  it("shows a successful daily report and unresolved historical recovery separately", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      dailyStartDate: "2026-09-09", recoveryDates: ["2026-08-18", "2026-09-03"],
      jobs: { "2026-08-18": { status: "failed" }, "2026-09-03": { status: "published" }, "2026-09-09": { status: "published" } },
    }) }));
    render(<ReportPublicationStatus product="market-reports" />);
    expect(await screen.findByText("2026-09-09 게시 완료")).toBeTruthy();
    expect(screen.getByText("과거 기록 복구 미완료: 2026-08-18")).toBeTruthy();
    expect(screen.queryByText(/일일 보고서 미완료/)).toBeNull();
  });

  it("never disguises a daily failure as a historical problem", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      dailyStartDate: "2026-09-09", recoveryDates: ["2026-08-18"],
      jobs: { "2026-08-18": { status: "failed" }, "2026-09-10": { status: "failed" }, "2026-09-11": { status: "published" } },
    }) }));
    render(<ReportPublicationStatus product="market-reports" />);
    expect(await screen.findByText("일일 보고서 미완료: 2026-09-10")).toBeTruthy();
    expect(screen.getByText("과거 기록 복구 미완료: 2026-08-18")).toBeTruthy();
  });
});
