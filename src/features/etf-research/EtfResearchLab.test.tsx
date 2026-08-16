import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import analysisJson from "../../../public/data/etf-research-analysis.json";
import manifestJson from "../../../public/data/etf-research-manifest.json";
import returnsJson from "../../../public/data/etf-research-returns.json";
import type { EtfAnalysisBundle, EtfResearchManifest, EtfReturnsBundle } from "../../domain";
import EtfResearchLab from "./EtfResearchLab";

const loadEtfResearch = vi.fn();
const loadEtfReturns = vi.fn();

vi.mock("../../api/etfResearch", () => ({
  loadEtfResearch: () => loadEtfResearch(),
  loadEtfReturns: () => loadEtfReturns(),
}));

describe("ETF 연구소 화면", () => {
  beforeEach(() => {
    loadEtfResearch.mockResolvedValue({
      manifest: manifestJson as EtfResearchManifest,
      analysis: analysisJson as EtfAnalysisBundle,
    });
    loadEtfReturns.mockResolvedValue(returnsJson as EtfReturnsBundle);
  });

  it("스냅샷을 불러와 50개 관리형 ETF와 세 기능을 표시한다", async () => {
    render(<EtfResearchLab onOpenPortfolio={vi.fn()} onOpenPortfolioReport={vi.fn()} onOpenEtfCompare={vi.fn()} />);
    expect(await screen.findByText("KODEX 200")).toBeTruthy();
    expect(screen.getByText("50개")).toBeTruthy();
    expect(screen.getByRole("button", { name: /3\. ETF 분석/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /4\. 포트폴리오 생성/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /5\. 위험·백테스트/ })).toBeTruthy();
  });

  it("균형 프리셋에서 포트폴리오 후보 3개를 만든다", async () => {
    const user = userEvent.setup();
    render(<EtfResearchLab onOpenPortfolio={vi.fn()} onOpenPortfolioReport={vi.fn()} onOpenEtfCompare={vi.fn()} />);
    await screen.findByText("KODEX 200");
    await user.click(screen.getByRole("button", { name: /4\. 포트폴리오 생성/ }));
    await user.click(screen.getByRole("button", { name: "조건으로 3개 후보 만들기" }));
    expect(screen.getByText("균형 후보")).toBeTruthy();
    expect(screen.getByText("저비용 후보")).toBeTruthy();
    expect(screen.getByText("저중복 후보")).toBeTruthy();
  });
});
