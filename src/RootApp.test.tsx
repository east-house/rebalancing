import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RootApp from "./RootApp";

vi.mock("./App", () => ({
  default: ({
    onOpenResearch,
    onOpenReport,
  }: {
    onOpenResearch: () => void;
    onOpenReport: () => void;
  }) => (
    <main>
      <h1>Portfolio</h1>
      <button type="button" onClick={onOpenReport}>Open report</button>
      <button type="button" onClick={onOpenResearch}>Open research</button>
    </main>
  ),
}));

vi.mock("./features/market-report/MarketReportPage", () => ({
  default: ({ onBack }: { onBack: () => void }) => (
    <main>
      <h1>Market report</h1>
      <button type="button" onClick={onBack}>Back</button>
    </main>
  ),
}));

vi.mock("./features/etf-research/EtfResearchLab", () => ({
  default: ({ onBack }: { onBack: () => void }) => (
    <main>
      <h1>ETF research</h1>
      <button type="button" onClick={onBack}>Back</button>
    </main>
  ),
}));

describe("RootApp routes", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("renders the report when opened directly at /report", () => {
    window.history.replaceState({}, "", "/report");

    render(<RootApp />);

    expect(screen.getByRole("heading", { name: "Market report" })).toBeTruthy();
  });

  it("updates the URL while moving between the portfolio and report", () => {
    render(<RootApp />);

    fireEvent.click(screen.getByRole("button", { name: "Open report" }));
    expect(window.location.pathname).toBe("/report");

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { name: "Portfolio" })).toBeTruthy();
  });

  it("follows browser history changes", () => {
    render(<RootApp />);

    act(() => {
      window.history.pushState({}, "", "/report");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.getByRole("heading", { name: "Market report" })).toBeTruthy();
  });
});
