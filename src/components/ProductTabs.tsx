import { BarChart3, BriefcaseBusiness, FlaskConical, GitCompareArrows, Newspaper } from "lucide-react";

import "./productTabs.css";

export type ProductTab = "report" | "trading-test-report" | "portfolio" | "portfolio-report" | "etf-compare";

interface ProductTabsProps {
  current?: ProductTab;
  onOpenReport: () => void;
  onOpenPortfolio: () => void;
  onOpenPortfolioReport: () => void;
  onOpenTradingTestReport?: () => void;
  onOpenEtfCompare: () => void;
}

const TABS = [
  { key: "report", label: "리포트", icon: Newspaper },
  { key: "trading-test-report", label: "매매테스트 보고서", icon: FlaskConical },
  { key: "portfolio", label: "포트폴리오 관리", icon: BriefcaseBusiness },
  { key: "portfolio-report", label: "포트폴리오 보고서", icon: BarChart3 },
  { key: "etf-compare", label: "ETF비교", icon: GitCompareArrows },
] as const;

export default function ProductTabs({
  current,
  onOpenReport,
  onOpenPortfolio,
  onOpenPortfolioReport,
  onOpenTradingTestReport,
  onOpenEtfCompare,
}: ProductTabsProps) {
  const handlers: Record<ProductTab, () => void> = {
    report: onOpenReport,
    "trading-test-report": onOpenTradingTestReport ?? (() => undefined),
    portfolio: onOpenPortfolio,
    "portfolio-report": onOpenPortfolioReport,
    "etf-compare": onOpenEtfCompare,
  };

  return (
    <nav className="product-tabs" aria-label="주요 서비스">
      {TABS.map(({ key, label, icon: Icon }) => (
        <button
          className={current === key ? "is-active" : ""}
          type="button"
          aria-current={current === key ? "page" : undefined}
          onClick={handlers[key]}
          key={key}
        >
          <Icon size={14} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
