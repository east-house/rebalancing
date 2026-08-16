import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RootApp from "./RootApp";

vi.mock("./App", () => ({
  default: ({
    onOpenPortfolioReport,
    onOpenEtfCompare,
  }: {
    onOpenPortfolioReport: () => void;
    onOpenEtfCompare: () => void;
  }) => (
    <main>
      <h1>Portfolio</h1>
      <button type="button" onClick={onOpenPortfolioReport}>Open portfolio report</button>
      <button type="button" onClick={onOpenEtfCompare}>Open research</button>
    </main>
  ),
}));

vi.mock("./features/market-report/MarketReportPage", () => ({
  default: ({ onOpenPortfolio }: { onOpenPortfolio: () => void }) => (
    <main>
      <h1>Market report</h1>
      <button type="button" onClick={onOpenPortfolio}>Open portfolio</button>
    </main>
  ),
}));

vi.mock("./features/etf-research/EtfResearchLab", () => ({
  default: ({ onOpenPortfolio }: { onOpenPortfolio: () => void }) => (
    <main>
      <h1>ETF research</h1>
      <button type="button" onClick={onOpenPortfolio}>Back</button>
    </main>
  ),
}));

vi.mock("./features/portfolio-report/PortfolioReportPage", () => ({
  default: ({ onOpenPortfolio }: { onOpenPortfolio: () => void }) => (
    <main>
      <h1>Portfolio report</h1>
      <button type="button" onClick={onOpenPortfolio}>Back to portfolio</button>
    </main>
  ),
}));

vi.mock("./features/site-info/SiteInfoPage", () => ({
  default: ({ kind }: { kind: string }) => <main><h1>Info: {kind}</h1></main>,
}));

describe("RootApp routes", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("renders the existing market report at the root URL", () => {
    render(<RootApp />);

    expect(screen.getByRole("heading", { name: "Market report" })).toBeTruthy();
  });

  it("moves between the report and portfolio at /rebalancing", () => {
    render(<RootApp />);

    fireEvent.click(screen.getByRole("button", { name: "Open portfolio" }));
    expect(window.location.pathname).toBe("/rebalancing");
    expect(screen.getByRole("heading", { name: "Portfolio" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open portfolio report" }));
    expect(window.location.pathname).toBe("/portfolio-report");
    expect(screen.getByRole("heading", { name: "Portfolio report" })).toBeTruthy();
  });

  it("opens the integrated portfolio report at its own URL", () => {
    window.history.replaceState({}, "", "/portfolio-report");

    render(<RootApp />);

    expect(screen.getByRole("heading", { name: "Portfolio report" })).toBeTruthy();
    expect(document.title).toBe("TM Reports — 포트폴리오 보고서");
  });

  it("follows browser history changes", () => {
    render(<RootApp />);

    act(() => {
      window.history.pushState({}, "", "/rebalancing");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("heading", { name: "Portfolio" })).toBeTruthy();

    act(() => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("heading", { name: "Market report" })).toBeTruthy();
  });

  it("keeps the previous /report URL working", () => {
    window.history.replaceState({}, "", "/report");

    render(<RootApp />);

    expect(screen.getByRole("heading", { name: "Market report" })).toBeTruthy();
  });

  it("renders the public policy pages at stable URLs", () => {
    window.history.replaceState({}, "", "/privacy");

    render(<RootApp />);

    expect(screen.getByRole("heading", { name: "Info: privacy" })).toBeTruthy();
    expect(document.title).toBe("개인정보처리방침 — TM Reports");
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href"))
      .toBe("https://tm-reports.com/privacy");
  });
});
