import { useEffect, useState } from "react";

import App from "./App";
import EtfResearchLab from "./features/etf-research/EtfResearchLab";
import MarketReportPage from "./features/market-report/MarketReportPage";

type Screen = "portfolio" | "research" | "report";

const SCREEN_PATHS: Record<Screen, string> = {
  portfolio: "/",
  research: "/etf-research",
  report: "/report",
};

function screenFromPath(pathname: string): Screen {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPath === SCREEN_PATHS.report) return "report";
  if (normalizedPath === SCREEN_PATHS.research) return "research";
  return "portfolio";
}

export default function RootApp() {
  const [screen, setScreen] = useState<Screen>(() => screenFromPath(window.location.pathname));

  useEffect(() => {
    const handlePopState = () => setScreen(screenFromPath(window.location.pathname));
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = (nextScreen: Screen) => {
    const nextPath = SCREEN_PATHS[nextScreen];
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setScreen(nextScreen);
  };

  if (screen === "research") return <EtfResearchLab onBack={() => navigate("portfolio")} />;
  if (screen === "report") return <MarketReportPage onBack={() => navigate("portfolio")} />;
  return (
    <App
      onOpenResearch={() => navigate("research")}
      onOpenReport={() => navigate("report")}
    />
  );
}
