import { afterEach, describe, expect, it, vi } from "vitest";
import { loadReplay, loadReplayIndex, type ReplayIndex } from "./tradingReplays";

const index: ReplayIndex = { schemaVersion: 1, releaseId: "abcdef0123456789abcd", lastMarketDate: "2026-09-10", starts: ["2026-08-31"] };
afterEach(() => vi.unstubAllGlobals());
describe("replay data boundaries", () => {
  it("rejects unsupported dates before fetching", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(loadReplay(index, "../../state")).rejects.toThrow("지원하지 않는");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects missing or invalid catalogs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...index, starts: [] }))));
    await expect(loadReplayIndex()).rejects.toThrow("목록");
  });
  it("rejects unaudited or mismatched bundles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ startDate: "2026-08-31", schemaVersion: 1, lastMarketDate: "2026-09-10", audit: { status: "failed" } }))));
    await expect(loadReplay(index, "2026-08-31")).rejects.toThrow("검증 결과");
  });
});
