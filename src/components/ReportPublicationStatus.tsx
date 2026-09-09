import { useEffect, useState } from "react";
import { useReportRefresh } from "../api/useReportRefresh";

interface PublicationStatus {
  jobs: Record<string, { status: string; checkedAt: string }>;
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
  const failed = dates.filter((day) => status?.jobs[day].status === "failed");
  if (!dates.length) return null;
  const latest = status!.jobs[dates[0]];
  return <p role="status">{failed.length ? `미완료 보고일: ${failed.join(", ")}` : `${dates[0]} ${latest.status === "no-new-session" ? "확인 완료 · 신규 미국 거래일 없음" : "게시 완료"}`}</p>;
}
