import { useEffect, useState } from "react";

import App from "./App";
import EtfResearchLab from "./features/etf-research/EtfResearchLab";
import MarketReportPage from "./features/market-report/MarketReportPage";
import PortfolioReportPage from "./features/portfolio-report/PortfolioReportPage";
import SiteInfoPage, { type SiteInfoKind } from "./features/site-info/SiteInfoPage";

type Screen = "portfolio" | "portfolioReport" | "research" | "report" | SiteInfoKind;

const SCREEN_PATHS: Record<Screen, string> = {
  portfolio: "/rebalancing",
  portfolioReport: "/portfolio-report",
  research: "/etf-research",
  report: "/",
  about: "/about",
  privacy: "/privacy",
  terms: "/terms",
  contact: "/contact",
};

const SCREEN_META: Record<Screen, { title: string; description: string }> = {
  report: {
    title: "TM Reports — 미국 시장 리포트",
    description: "미국 시장의 흐름, 위험자산, 섹터·테마 리더십과 경제 일정을 한눈에 확인합니다.",
  },
  portfolio: {
    title: "TM Reports — 포트폴리오 관리",
    description: "보유 자산을 한눈에 확인하고 목표 비중에 맞춰 리밸런싱을 계산합니다.",
  },
  portfolioReport: {
    title: "TM Reports — 포트폴리오 보고서",
    description: "미국 5종목 모델의 매수·매도와 월간 리밸런싱 점검 결과를 확인합니다.",
  },
  research: {
    title: "TM Reports — ETF비교",
    description: "국내 상장 ETF의 비용, 성과, 위험과 구성 중복도를 비교합니다.",
  },
  about: {
    title: "사이트 소개 — TM Reports",
    description: "TM Reports의 시장 분석 방식, 콘텐츠 작성 원칙과 운영 목적을 안내합니다.",
  },
  privacy: {
    title: "개인정보처리방침 — TM Reports",
    description: "TM Reports의 브라우저 저장 정보, 접속 정보와 광고 쿠키 처리 방침입니다.",
  },
  terms: {
    title: "이용약관·투자 유의사항 — TM Reports",
    description: "TM Reports의 이용 조건과 금융정보 및 계산 결과의 한계를 안내합니다.",
  },
  contact: {
    title: "문의 — TM Reports",
    description: "TM Reports의 오류 정정, 개인정보, 저작권과 광고 관련 문의 안내입니다.",
  },
};

function screenFromPath(pathname: string): Screen {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPath === SCREEN_PATHS.report || normalizedPath === "/report") return "report";
  if (normalizedPath === SCREEN_PATHS.portfolio) return "portfolio";
  if (normalizedPath === SCREEN_PATHS.portfolioReport) return "portfolioReport";
  if (normalizedPath === SCREEN_PATHS.research) return "research";
  if (normalizedPath === SCREEN_PATHS.about) return "about";
  if (normalizedPath === SCREEN_PATHS.privacy) return "privacy";
  if (normalizedPath === SCREEN_PATHS.terms) return "terms";
  if (normalizedPath === SCREEN_PATHS.contact) return "contact";
  return "report";
}

function ensureMeta(attribute: "name" | "property", value: string): HTMLMetaElement {
  const existing = document.querySelector<HTMLMetaElement>(`meta[${attribute}="${value}"]`);
  if (existing) return existing;
  const meta = document.createElement("meta");
  meta.setAttribute(attribute, value);
  document.head.append(meta);
  return meta;
}

function ensureCanonical(): HTMLLinkElement {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "canonical";
  document.head.append(link);
  return link;
}

export default function RootApp() {
  const [screen, setScreen] = useState<Screen>(() => screenFromPath(window.location.pathname));

  useEffect(() => {
    const handlePopState = () => setScreen(screenFromPath(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const description = ensureMeta("name", "description");
    const canonical = ensureCanonical();
    const ogTitle = ensureMeta("property", "og:title");
    const ogDescription = ensureMeta("property", "og:description");
    const ogUrl = ensureMeta("property", "og:url");
    const meta = SCREEN_META[screen];
    const canonicalPath = screen === "report" ? "/" : SCREEN_PATHS[screen];
    const canonicalUrl = `https://tm-reports.com${canonicalPath}`;

    document.title = meta.title;
    description?.setAttribute("content", meta.description);
    canonical?.setAttribute("href", canonicalUrl);
    ogTitle?.setAttribute("content", meta.title);
    ogDescription?.setAttribute("content", meta.description);
    ogUrl?.setAttribute("content", canonicalUrl);
  }, [screen]);

  const navigate = (nextScreen: Screen) => {
    const nextPath = SCREEN_PATHS[nextScreen];
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setScreen(nextScreen);
  };

  const productNavigation = {
    onOpenReport: () => navigate("report"),
    onOpenPortfolio: () => navigate("portfolio"),
    onOpenPortfolioReport: () => navigate("portfolioReport"),
    onOpenEtfCompare: () => navigate("research"),
  };

  if (screen === "research") return <EtfResearchLab {...productNavigation} />;
  if (screen === "portfolioReport") return <PortfolioReportPage {...productNavigation} />;
  if (screen === "about" || screen === "privacy" || screen === "terms" || screen === "contact") {
    return <SiteInfoPage kind={screen} />;
  }
  if (screen === "report") {
    return <MarketReportPage {...productNavigation} />;
  }
  return (
    <App
      {...productNavigation}
    />
  );
}
