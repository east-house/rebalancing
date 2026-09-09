import { useEffect, useState } from "react";
import { useReportRefresh } from "../api/useReportRefresh";

interface PublicationStatus {
  jobs: Record<string, { status: string; checkedAt: string }>;
  dailyStartDate?: string | null;
  recoveryDates?: string[];
}

export default function ReportPublicationStatus({ product }: { product: "market-reports" | "trading-test-reports" }) {
  const refresh = useReportRefresh();
  const [status, setStatus] = useState<PublicationStatus | null>(null);
  useEffect(() => {
    let active = true;
    fetch(`/api/${product}/status`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        return await response.json() as PublicationStatus;
      })
      .then((value) => { if (active && value.jobs) setStatus(value); })
      .catch(() => {});
    return () => { active = false; };
  }, [product, refresh]);
  const dates = Object.keys(status?.jobs ?? {}).sort().reverse();
  const dailyDates = dates.filter((day) => !status?.dailyStartDate || day >= status.dailyStartDate);
  const failed = dailyDates.filter((day) => status?.jobs[day].status === "failed");
  const recovery = (status?.recoveryDates ?? []).filter((day) => !["published", "no-new-session"].includes(status?.jobs[day]?.status ?? ""));
  if (!dates.length) return null;
  const latestDate = dailyDates[0];
  const latest = status!.jobs[latestDate];
  return <div role="status">
    <p>{failed.length ? `일일 보고서 미완료: ${failed.join(", ")}` : latest ? `${latestDate} ${latest.status === "no-new-session" ? "확인 완료 · 신규 미국 거래일 없음" : "게시 완료"}` : "일일 게시 대기"}</p>
    {recovery.length > 0 && <p>과거 기록 복구 미완료: {recovery.join(", ")}</p>}
  </div>;
}
