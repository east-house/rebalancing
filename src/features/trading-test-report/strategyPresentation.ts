import type { TradingTestReport } from "../../api/tradingTestReports";

const LEGACY_DEFINITIONS: Record<string, { label: string; description: string }> = {
  "IRCS-BBCCI-M-G55": { label: "M-G55 검증형", description: "M 조건에 종목 CCI−CCI Signal 55.003489 이상을 추가합니다." },
  "IRCS-BBCCI-M-R2": { label: "M-R2 검증형", description: "M 조건에 IVV CCI 상승과 목표여유 2%를 추가합니다." },
  "IRCS-BBCCI-M": { label: "M 기본형(이전)", description: "교체 전 M 기본형의 보존 기록입니다." },
};

export function strategyPresentation(report: TradingTestReport, id: string) {
  return report.strategyDefinitions?.[id] ?? LEGACY_DEFINITIONS[id] ?? { label: id, description: "" };
}

export function assetWeight(amount: number, equity: number): string {
  return Number.isFinite(amount) && Number.isFinite(equity) && equity > 0
    ? `${(amount / equity * 100).toFixed(2)}%` : "—";
}
