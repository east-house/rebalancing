import { useEffect, useState } from "react";
import { useReportRefresh } from "../../api/useReportRefresh";

interface Job { status: string; checkedAt?: string; generatedAt?: string; context?: { scheduledFor?: string; marketSessionDate?: string; dataCutoffAt?: string; executionSessionDate?: string; executionCloseAt?: string }; }
interface Status { jobs: Record<string, Job>; serverTime: string; }
const localTime = (value?: string) => value ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "기록 없음";

export function portfolioPublicationSummary(status: Status): { target: string; text: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(status.serverTime));
  let target = ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
  if (target < "2026-09-14") target = "2026-09-14";
  const date = new Date(`${target}T00:00:00Z`);
  while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + 1);
  target = date.toISOString().slice(0, 10);
  const job = status.jobs[target];
  const text = job?.status === "published" ? "생성·게시 완료" : job?.status === "running" ? "생성 중 · 아직 게시되지 않았습니다" : job?.status === "failed" ? "생성 실패 · 후속 실행에서 재시도합니다" : new Date(status.serverTime) < new Date(`${target}T19:00:00+09:00`) ? "19:00 생성 예정" : "19:00 예정 시각 경과 · 게시 완료가 확인되지 않았습니다";
  return { target, text };
}

export default function PortfolioPublicationStatus({ reportDate, generatedAt }: { reportDate?: string; generatedAt?: string }) {
  const refresh = useReportRefresh();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    fetch("/api/portfolio-reports/status", { cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("status unavailable");
      const value = await response.json();
      if (!value.jobs || !value.serverTime) throw new Error("invalid status");
      if (active) { setStatus(value); setError(false); }
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [refresh]);
  const summary = status ? portfolioPublicationSummary(status) : null;
  const job = reportDate ? status?.jobs[reportDate] : undefined;
  return <section className="portfolio-report-card account-publication" aria-label="포트폴리오 생성 상태">
    <h2>보고서 생성과 다음 행동</h2>
    <p><strong>{summary ? `${summary.target} · ${summary.text}` : "한국 평일 19:00 생성 예정 · 상태 확인 중"}</strong></p>
    {error && <p role="status">현재 생성 상태를 확인할 수 없습니다. 이전 조회 결과를 생성 성공으로 간주하지 마세요.</p>}
    <p>9월 14일부터 한국시간 19:00에 생성을 시작하며, 미완료 보고서는 19:30·20:00에 재확인합니다. 실제 시작·완료 시각은 실행 지연과 자료 수집 상황에 따라 달라질 수 있습니다.</p>
    {reportDate && <p>조회 보고서 {reportDate} · 실제 생성 {localTime(job?.generatedAt ?? generatedAt)} · 게시 확인 {localTime(job?.status === "published" ? job.checkedAt : undefined)} (한국시간)</p>}
    {job?.context && <p>사용 자료: 미국 {job.context.marketSessionDate} 종가 · 자료 마감 {localTime(job.context.dataCutoffAt)}. 주문 발생 시 미국 {job.context.executionSessionDate ?? "다음 지정 거래일"} 종가 체결 예정{job.context.executionCloseAt ? ` (${localTime(job.context.executionCloseAt)} 한국시간)` : ""}.</p>}
    <p>오늘: 완료된 미국 종가로 평가하고 선정·유지 이유와 대기 주문을 기록합니다. 다음 보고서: 지정 체결일 종가가 확인되면 실제 가상 체결 수량·비용·손익을 기록하고, 미확인 또는 휴장이면 대기 상태를 유지합니다. 미국장 개장 직후 매수하는 방식은 아닙니다.</p>
    <p>생성·게시 이력은 서버에, 개인 계좌의 예정 행동과 체결 이력은 이 브라우저에 저장됩니다. 새 보고서를 열거나 새로고침하면 계좌 기록을 순서대로 갱신합니다.</p>
  </section>;
}
