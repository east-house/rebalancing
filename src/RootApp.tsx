import { useState } from "react";

import App from "./App";
import EtfResearchLab from "./features/etf-research/EtfResearchLab";
import MarketReportPage from "./features/market-report/MarketReportPage";

export default function RootApp() {
  const [screen, setScreen] = useState<"portfolio" | "research" | "report">("portfolio");
  if (screen === "research") return <EtfResearchLab onBack={() => setScreen("portfolio")} />;
  if (screen === "report") return <MarketReportPage onBack={() => setScreen("portfolio")} />;
  return (
    <App
      onOpenResearch={() => setScreen("research")}
      onOpenReport={() => setScreen("report")}
    />
  );
}
