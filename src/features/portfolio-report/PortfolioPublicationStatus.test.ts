import { expect, it } from "vitest";
import { portfolioPublicationSummary } from "./PortfolioPublicationStatus";

it("shows Monday 19 KST as pending on the preceding Sunday", () => {
  expect(portfolioPublicationSummary({ serverTime: "2026-09-13T12:00:00Z", jobs: {} })).toEqual({ target: "2026-09-14", text: "19:00 생성 예정" });
});
it("does not infer publication from elapsed scheduled time", () => {
  const status = { serverTime: "2026-09-14T10:01:00Z", jobs: {} };
  expect(portfolioPublicationSummary(status).text).toContain("확인되지 않았습니다");
  expect(portfolioPublicationSummary({ ...status, jobs: { "2026-09-14": { status: "running" } } }).text).toContain("생성 중");
  expect(portfolioPublicationSummary({ ...status, jobs: { "2026-09-14": { status: "failed" } } }).text).toContain("실패");
  expect(portfolioPublicationSummary({ ...status, jobs: { "2026-09-14": { status: "published" } } }).text).toBe("생성·게시 완료");
});
