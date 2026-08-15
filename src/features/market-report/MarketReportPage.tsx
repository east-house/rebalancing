import { type SyntheticEvent, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  CalendarDays,
  ChevronRight,
  CircleCheck,
  Clock3,
  ExternalLink,
  Maximize2,
  Minus,
  Newspaper,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";

import {
  loadMarketReport,
  loadMarketReportIndex,
  selectReportForKoreaDate,
  type MarketReportBundle,
  type MarketReportIndex,
  type MarketReportRow,
} from "../../api/marketReports";
import "./marketReportPage.css";

interface MarketReportPageProps {
  onBack: () => void;
}

const CHART_PHASES = [
  { name: "하락 추세", description: "장기선 아래·단기선 약세" },
  { name: "기반 형성", description: "장기선 아래에서 방향 탐색" },
  { name: "반등 시도", description: "200일선 위로 복귀 시도" },
  { name: "상승 전환", description: "중·장기선이 회복되는 구간" },
  { name: "돌파 초기", description: "55일 고점 부근의 초기 돌파" },
  { name: "추세 진행", description: "20·50·200일선 정배열" },
  { name: "상승 중 눌림", description: "정배열 안에서 단기 조정" },
  { name: "과열 상승", description: "이격 과다 또는 RSI 75 이상" },
] as const;

function number(row: MarketReportRow | null | undefined, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(row: MarketReportRow | null | undefined, key: string, fallback = "—"): string {
  const value = row?.[key];
  return typeof value === "string" && value ? value : fallback;
}

function pct(value: number | null, digits = 1): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function plainPct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function fixed(value: number | null, digits = 2): string {
  return value === null ? "—" : value.toFixed(digits);
}

function DirectionalChange({
  value,
  unit = "",
  digits = 2,
  multiplier = 1,
}: {
  value: number | null;
  unit?: string;
  digits?: number;
  multiplier?: number;
}) {
  if (value === null) {
    return <span className="directional-change is-flat" aria-label="변화 자료 없음"><Minus size={13} />—</span>;
  }
  const displayed = value * multiplier;
  const direction = displayed > 0 ? "up" : displayed < 0 ? "down" : "flat";
  const label = direction === "up" ? "상승" : direction === "down" ? "하락" : "변화 없음";
  const Icon = direction === "up" ? ArrowUp : direction === "down" ? ArrowDown : Minus;
  return (
    <span className={`directional-change is-${direction}`} aria-label={`${label} ${Math.abs(displayed).toFixed(digits)}${unit}`}>
      <Icon size={13} />
      {Math.abs(displayed).toFixed(digits)}{unit}
    </span>
  );
}

function rankMovement(value: number | null): string {
  if (value === null) return "직전 순위 자료 없음";
  if (value === 0) return "직전 순위 유지";
  return `직전보다 ${Math.abs(value).toFixed(0)}계단 ${value > 0 ? "상승" : "하락"}`;
}

function koreanDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return "—";
  const [year, month, day] = value.slice(0, 10).split("-");
  return `${year}.${month}.${day}`;
}

function useStaticDashboardFallback(
  event: SyntheticEvent<HTMLImageElement>,
  displayDate: string,
) {
  const image = event.currentTarget;
  const fallback = `/data/market-reports/${displayDate}.png`;
  if (image.dataset.fallback !== "true") {
    image.dataset.fallback = "true";
    image.src = fallback;
  } else {
    image.hidden = true;
  }
}

function phaseClass(phase: string): string {
  if (phase.includes("과열") || phase.includes("하락")) return "is-caution";
  if (phase.includes("돌파") || phase.includes("진행") || phase.includes("전환")) {
    return "is-positive";
  }
  return "";
}

function toneClass(tone: string): string {
  if (tone.includes("positive") || tone.includes("완화") || tone.includes("선호")) {
    return "is-positive";
  }
  if (tone.includes("caution") || tone.includes("둔화") || tone.includes("위험")) {
    return "is-caution";
  }
  return "";
}

function EmptyRow({ columns, children }: { columns: number; children: string }) {
  return (
    <tr>
      <td className="report-empty" colSpan={columns}>{children}</td>
    </tr>
  );
}

export default function MarketReportPage({ onBack }: MarketReportPageProps) {
  const [index, setIndex] = useState<MarketReportIndex | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [report, setReport] = useState<MarketReportBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dashboardExpanded, setDashboardExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    loadMarketReportIndex()
      .then((value) => {
        if (!active) return;
        const initial = selectReportForKoreaDate(value.reports);
        setIndex(value);
        setSelectedDate(initial?.displayDate ?? value.latestDisplayDate);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "리포트 목록을 불러오지 못했습니다.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedDate) return;
    let active = true;
    setLoading(true);
    setError("");
    loadMarketReport(selectedDate)
      .then((value) => {
        if (active) setReport(value);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : "리포트를 불러오지 못했습니다.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [selectedDate]);

  useEffect(() => {
    if (!dashboardExpanded) return;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDashboardExpanded(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [dashboardExpanded]);

  const selectedMeta = useMemo(
    () => index?.reports.find((item) => item.displayDate === selectedDate),
    [index, selectedDate],
  );

  const state = report?.summary.state;
  const topSector = report?.summary.topSector;
  const weakestSector = report?.summary.weakestSector;
  const topTheme = report?.summary.topTheme;
  const tenYearRate = report?.macro.find((row) => text(row, "series") === "DGS10");
  const headlineCpi = report?.macro.find((row) => text(row, "series") === "CPIAUCSL");
  const eventSummary = report?.todayEvents.length
    ? report.todayEvents.slice(0, 2).map((row) => text(row, "event")).join(" · ")
    : "정기 발표 없음";
  const breadthAuditValue = report?.quality.ma50_breadth;
  const breadthAudit = breadthAuditValue && typeof breadthAuditValue === "object" && !Array.isArray(breadthAuditValue)
    ? breadthAuditValue as Record<string, unknown>
    : null;
  const breadthWindowStart = typeof breadthAudit?.window_start === "string" ? breadthAudit.window_start : "";
  const breadthWindowEnd = typeof breadthAudit?.window_end === "string" ? breadthAudit.window_end : "";
  const breadthEligible = typeof breadthAudit?.eligible_count === "number" ? breadthAudit.eligible_count : null;
  const breadthUniverse = typeof breadthAudit?.universe_count === "number" ? breadthAudit.universe_count : null;
  const breadthVerified = breadthAudit?.passed === true;

  return (
    <div className="market-report-shell">
      <header className="report-topbar">
        <button type="button" className="report-back" onClick={onBack}>
          <ArrowLeft size={16} /> 포트폴리오
        </button>
        <div className="report-brand">
          <Newspaper size={18} />
          <div><strong>시장 리포트</strong><span>US MARKET INTELLIGENCE</span></div>
        </div>
        <span className="report-status"><ShieldCheck size={14} /> 자동매매 없음</span>
      </header>

      <div className="market-report-layout">
        <aside className="report-sidebar" aria-label="날짜별 시장 리포트">
          <div className="report-sidebar__head">
            <span>REPORT ARCHIVE</span>
            <strong>날짜별 리포트</strong>
            <p>한국 평일에 확인하는 전 거래일 정보</p>
          </div>
          <nav>
            {index?.reports.map((item) => (
              <button
                key={item.displayDate}
                type="button"
                className={item.displayDate === selectedDate ? "is-active" : ""}
                aria-current={item.displayDate === selectedDate ? "page" : undefined}
                onClick={() => setSelectedDate(item.displayDate)}
              >
                <CalendarDays size={15} />
                <span>
                  <strong>{koreanDate(item.displayDate)}</strong>
                  <small>미국장 {koreanDate(item.marketDate)}</small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </nav>
        </aside>

        <main className="market-report-main">
          {loading && !report ? <div className="report-state-card">시장 리포트를 불러오는 중입니다.</div> : null}
          {error ? <div className="report-state-card is-error">{error}</div> : null}
          {report ? (
            <>
              <section className="report-hero">
                <div>
                  <span className="report-eyebrow">{koreanDate(report.displayDate)} · KOREA VIEW</span>
                  <h1>전 거래일의 시장을<br />한 흐름으로 읽습니다.</h1>
                  <p>{text(state, "interpretation")}</p>
                </div>
                <dl className="report-date-card">
                  <div><dt>화면 기준일</dt><dd>{koreanDate(report.displayDate)}</dd></div>
                  <div><dt>미국 거래일</dt><dd>{koreanDate(report.marketDate)}</dd></div>
                  <div><dt>시장 상태</dt><dd>{text(state, "state")}</dd></div>
                  <div><dt>위험 수준</dt><dd>{text(state, "risk_level")}</dd></div>
                </dl>
              </section>

              <section className="report-conclusion">
                <div className="report-conclusion__copy">
                  <div className="report-section-label"><Sparkles size={16} /><span>TODAY&apos;S VIEW</span></div>
                  <h2>오늘의 결론</h2>
                  <p className="report-conclusion__lead">수치의 나열보다 오늘 확인해야 할 시장의 구조를 먼저 요약합니다.</p>
                  <ul>
                    <li><CircleCheck size={16} /><span>전체 시장은 <strong>{text(state, "state")}</strong>, 위험 수준은 <strong>{text(state, "risk_level")}</strong>입니다. {text(state, "interpretation")}</span></li>
                    <li><CircleCheck size={16} /><span>상승 종목 {plainPct(number(state, "breadth_positive_1d"))}, 50일선 상회 {plainPct(number(state, "breadth_above_ma50"))}, 200일선 상회 {plainPct(number(state, "breadth_above_ma200"))}입니다.</span></li>
                    <li><CircleCheck size={16} /><span>가장 강한 섹터는 <strong>{text(topSector, "sector_display", text(topSector, "sector"))}</strong>, 20일 상대수익률 {pct(number(topSector, "relative_20d"))}, 대장주는 {text(topSector, "leader")}입니다.</span></li>
                    <li><CircleCheck size={16} /><span>가장 강한 테마는 <strong>{text(topTheme, "theme")}</strong>, 20일 상대수익률 {pct(number(topTheme, "relative_20d"))}, 대장주는 {text(topTheme, "leader")}입니다.</span></li>
                    <li><CircleCheck size={16} /><span>가장 약한 섹터는 <strong>{text(weakestSector, "sector_display", text(weakestSector, "sector"))}</strong>, 20일 상대수익률은 {pct(number(weakestSector, "relative_20d"))}입니다.</span></li>
                    <li><CircleCheck size={16} /><span>당일 공식 경제일정은 <strong>{eventSummary}</strong>입니다. 뉴스 해석은 원문과 실제 가격 반응을 함께 확인해야 합니다.</span></li>
                  </ul>
                  <section className="report-change-summary" aria-labelledby="report-change-summary-title">
                    <div className="report-change-summary__head">
                      <span>WHAT CHANGED</span>
                      <strong id="report-change-summary-title">직전 거래일·발표와 비교</strong>
                    </div>
                    <div className="report-change-summary__grid">
                      <article>
                        <span>S&amp;P 500</span>
                        <DirectionalChange value={number(state, "sp500_return_1d")} unit="%" digits={1} multiplier={100} />
                        <small>전일 종가 대비</small>
                      </article>
                      <article>
                        <span>미국 10년물 금리</span>
                        <DirectionalChange value={number(tenYearRate, "change")} unit="%p" />
                        <small>직전 관측치 대비</small>
                      </article>
                      <article>
                        <span>CPI 전년비</span>
                        <DirectionalChange value={number(headlineCpi, "change")} unit="%p" />
                        <small>직전 발표 대비</small>
                      </article>
                      <article>
                        <span>1위 섹터 점수</span>
                        <DirectionalChange value={number(topSector, "score_change_1d")} unit="점" digits={1} />
                        <small>{text(topSector, "sector_display", text(topSector, "sector"))} · {rankMovement(number(topSector, "rank_change_1d"))}</small>
                      </article>
                      <article>
                        <span>1위 테마 점수</span>
                        <DirectionalChange value={number(topTheme, "score_change_1d")} unit="점" digits={1} />
                        <small>{text(topTheme, "theme")} · {rankMovement(number(topTheme, "rank_change_1d"))}</small>
                      </article>
                    </div>
                  </section>
                </div>
                <figure className="report-dashboard-figure">
                  <button
                    type="button"
                    className="report-dashboard-trigger"
                    aria-label="시장 구조 대시보드 확대해서 보기"
                    aria-haspopup="dialog"
                    onClick={() => setDashboardExpanded(true)}
                  >
                    <img
                      key={report.displayDate}
                      src={report.dashboardImage ?? `/api/market-reports/${report.displayDate}/dashboard`}
                      alt={`${koreanDate(report.displayDate)} 미국 시장 구조 대시보드`}
                      onError={(event) => useStaticDashboardFallback(event, report.displayDate)}
                    />
                    <span><Maximize2 size={14} /> 눌러서 확대</span>
                  </button>
                  <figcaption>네 그래프는 위치별로 아래처럼 읽습니다.</figcaption>
                  <div className="report-dashboard-guide" aria-label="시장 구조 그래프 읽는 법">
                    <article><strong>왼쪽 위 · 주요 지수</strong><span>S&amp;P 500의 최근 60거래일에 모든 지수 날짜를 맞춘 누적 등락률입니다. 값이 없는 날짜는 앞뒤 선을 연결하지 않습니다.</span></article>
                    <article><strong>오른쪽 위 · 섹터</strong><span>S&amp;P 500보다 최근 한 달간 얼마나 더 오르거나 덜 올랐는지 비교합니다.</span></article>
                    <article><strong>왼쪽 아래 · 테마</strong><span>테마 ETF의 최근 한 달 성과를 S&amp;P 500과 비교합니다.</span></article>
                    <article>
                      <strong>오른쪽 아래 · 상승 참여도</strong>
                      <span>기준일 종가가 최근 50거래일 평균보다 높은 종목 비율입니다. 50% 점선보다 높으면 과반 종목이 참여한 상태입니다.</span>
                      {breadthWindowStart && breadthWindowEnd ? (
                        <small className="report-dashboard-guide__audit">
                          현재 계산 {koreanDate(breadthWindowStart)}~{koreanDate(breadthWindowEnd)} · {breadthEligible ?? "—"}/{breadthUniverse ?? "—"}종목 · 원자료 검증 {breadthVerified ? "통과" : "확인 필요"}
                        </small>
                      ) : null}
                    </article>
                  </div>
                </figure>
              </section>

              {dashboardExpanded ? (
                <div
                  className="report-image-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="시장 구조 대시보드 확대 보기"
                  onClick={() => setDashboardExpanded(false)}
                >
                  <div className="report-image-modal__content" onClick={(event) => event.stopPropagation()}>
                    <div className="report-image-modal__head">
                      <div><strong>오늘의 시장 구조</strong><span>{koreanDate(report.displayDate)}</span></div>
                      <button type="button" aria-label="확대 화면 닫기" onClick={() => setDashboardExpanded(false)}><X size={20} /></button>
                    </div>
                    <img
                      key={report.displayDate}
                      src={report.dashboardImage ?? `/api/market-reports/${report.displayDate}/dashboard`}
                      alt={`${koreanDate(report.displayDate)} 미국 시장 구조 대시보드 확대 이미지`}
                      onError={(event) => useStaticDashboardFallback(event, report.displayDate)}
                    />
                  </div>
                </div>
              ) : null}

              <div className="report-notice">
                <Clock3 size={16} />
                <span>월요일 화면은 직전 금요일 미국장 정보를 사용합니다. 토·일은 새 날짜를 만들지 않으며 마지막 평일 리포트를 유지합니다.</span>
              </div>

              <section className="report-kpis" aria-label="시장 핵심 지표">
                <article><span>S&amp;P 500 · 20일</span><strong>{pct(number(state, "sp500_return_20d"))}</strong><small>1일 {pct(number(state, "sp500_return_1d"))}</small></article>
                <article><span>50일선 상회 종목</span><strong>{plainPct(number(state, "breadth_above_ma50"))}</strong><small>200일선 {plainPct(number(state, "breadth_above_ma200"))}</small></article>
                <article><span>강한 섹터</span><strong>{text(topSector, "sector_display", text(topSector, "sector"))}</strong><small>{text(topSector, "leader")}</small></article>
                <article><span>강한 테마</span><strong>{text(topTheme, "theme")}</strong><small>{text(topTheme, "leader")}</small></article>
              </section>

              {report.macroAxes?.length ? (
                <section className="report-section">
                  <div className="report-section__head"><div><span>MACRO REGIME</span><h2>성장·물가·금리·위험선호</h2><p className="report-section-help">성장과 위험선호가 개선되고 금리·물가 부담이 낮아지면 주식에 우호적입니다. 상태와 근거가 같은 방향인지 확인하세요.</p></div><Activity size={19} /></div>
                  <div className="report-axis-grid">
                    {report.macroAxes.map((row) => (
                      <article className={toneClass(text(row, "tone"))} key={text(row, "axis")}>
                        <div><span>{text(row, "axis")}</span><strong>{text(row, "status")}</strong></div>
                        <p>{text(row, "evidence")}</p>
                        <small>{text(row, "market_read")}</small>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {report.transmissions?.length ? (
                <section className="report-section">
                  <div className="report-section__head"><div><span>TRANSMISSION</span><h2>거시 변화가 가격으로 전달됐는가</h2><p className="report-section-help">‘변화’ 뒤에 예상한 시장 반응과 실제 반응이 일치할수록 신호가 강합니다. 어긋나면 뉴스보다 가격을 우선해 보세요.</p></div><TrendingUp size={19} /></div>
                  <div className="report-transmission-grid">
                    {report.transmissions.map((row) => (
                      <article key={text(row, "driver")}>
                        <div><span>{text(row, "driver")}</span><b>{text(row, "confirmation")}</b></div>
                        <strong>{text(row, "change")}</strong>
                        <p>{text(row, "expected")}</p>
                        <small>{text(row, "observed")}</small>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="report-section">
                <div className="report-section__head report-section__head--market">
                  <div>
                    <span>MARKET</span>
                    <h2>전체 시장과 위험자산</h2>
                    <ol className="chart-phase-inline" aria-label="차트 단계: 약세에서 과열 순서">
                      {CHART_PHASES.map((phase) => <li key={phase.name} title={phase.description}>{phase.name}</li>)}
                    </ol>
                    <p className="chart-phase-inline__note">왼쪽은 약세·기반, 오른쪽은 상승·과열에 가깝습니다. 실제 가격은 단계를 건너뛰거나 되돌아갈 수 있습니다.</p>
                  </div>
                  <BarChart3 size={19} />
                </div>
                <div className="market-reading-guide">
                  <div><strong>지표 읽기</strong><p><b>1일</b>은 오늘 방향, <b>20일</b>은 약 한 달의 추세, <b>200일선 괴리</b>는 장기 추세와의 거리입니다. 괴리가 +면 장기선 위, −면 아래입니다.</p></div>
                  <div><strong>판단하기</strong><p>주가지수와 HYG가 오르고 VIX가 내리면 위험선호로 봅니다. 반대로 주가지수가 약하고 VIX가 오르거나 지표들이 엇갈리면 추격 매수보다 경계를 우선합니다.</p></div>
                </div>
                <div className="report-table-wrap">
                  <table>
                    <thead><tr><th>지수·자산</th><th>티커</th><th>1일</th><th>20일</th><th>200일선 괴리</th><th>차트 단계</th></tr></thead>
                    <tbody>{[...(report.indices ?? []), ...(report.risks ?? [])].map((row) => <tr key={`${text(row, "category")}-${text(row, "ticker")}`}><td>{text(row, "name")}</td><td>{text(row, "ticker")}</td><td>{pct(number(row, "return_1d"))}</td><td>{pct(number(row, "return_20d"))}</td><td>{pct(number(row, "ma200_gap"))}</td><td><span className={`phase-pill ${phaseClass(text(row, "chart_phase"))}`}>{text(row, "chart_phase")}</span></td></tr>)}</tbody>
                  </table>
                </div>
              </section>

              <div className="report-two-column">
                <section className="report-section">
                  <div className="report-section__head"><div><span>SECTORS</span><h2>섹터 리더십</h2><p className="report-section-help">시장보다 20일 상대수익률이 높고 대장주도 함께 오르면 섹터 상승의 힘이 넓다고 판단합니다.</p></div><TrendingUp size={19} /></div>
                  <div className="report-rank-list">{report.sectors.map((row) => <article key={text(row, "sector")}><b>{fixed(number(row, "rank"), 0)}</b><div><strong>{text(row, "sector_display", text(row, "sector"))}</strong><span>{text(row, "leader")}</span></div><div className="rank-metric"><strong>{fixed(number(row, "sector_score"), 1)}</strong><span>20일 상대 {pct(number(row, "relative_20d"))}</span></div></article>)}</div>
                </section>
                <section className="report-section">
                  <div className="report-section__head"><div><span>THEMES</span><h2>테마 리더십</h2><p className="report-section-help">테마 점수와 20일 상대수익률이 높고 대장주가 강할수록 단기 주도 테마로 해석합니다.</p></div><TrendingUp size={19} /></div>
                  <div className="report-rank-list">{report.themes.map((row) => <article key={text(row, "theme")}><b>{fixed(number(row, "rank"), 0)}</b><div><strong>{text(row, "theme")} <small>{text(row, "proxy")}</small></strong><span>{text(row, "leader")}</span></div><div className="rank-metric"><strong>{fixed(number(row, "theme_score"), 1)}</strong><span>20일 상대 {pct(number(row, "relative_20d"))}</span></div></article>)}</div>
                </section>
              </div>

              <section className="report-section">
                <div className="report-section__head"><div><span>LEADERS</span><h2>대장주와 차트 위치</h2><p className="report-section-help">20일·60일 수익률이 모두 +이고 차트 단계도 상승권이면 리더십이 유지되는 것으로 봅니다. 위험 메모는 추격 전 확인할 조건입니다.</p></div><TrendingUp size={19} /></div>
                <div className="report-table-wrap"><table><thead><tr><th>구분</th><th>그룹</th><th>회사명(티커)</th><th>20일</th><th>60일</th><th>단계</th><th>확인할 위험</th></tr></thead><tbody>{report.leaders.map((row) => <tr key={`${text(row, "scope")}-${text(row, "group")}`}><td>{text(row, "scope") === "sector" ? "섹터" : "테마"}</td><td>{text(row, "group_display", text(row, "group"))}</td><td><strong>{text(row, "company_ticker")}</strong></td><td>{pct(number(row, "return_20d"))}</td><td>{pct(number(row, "return_60d"))}</td><td><span className={`phase-pill ${phaseClass(text(row, "chart_phase"))}`}>{text(row, "chart_phase")}</span></td><td>{text(row, "risk_note")}</td></tr>)}</tbody></table></div>
              </section>

              <section className="report-section">
                <div className="report-section__head"><div><span>MACRO</span><h2>금리·물가·경기 지표</h2><p className="report-section-help">최신값보다 직전 변화와 해석을 함께 보세요. 금리·달러 상승은 성장주 부담, 경기 개선은 경기민감주에 우호적인 경우가 많습니다.</p></div><BarChart3 size={19} /></div>
                <div className="report-table-wrap"><table><thead><tr><th>지표</th><th>최신값</th><th>직전 변화</th><th>관측일</th><th>의미</th></tr></thead><tbody>{report.macro.map((row) => <tr key={text(row, "series")}><td>{text(row, "indicator")}</td><td>{fixed(number(row, "value"))}{text(row, "unit", "")}</td><td><DirectionalChange value={number(row, "change")} unit={text(row, "unit", "") === "%" ? "%p" : text(row, "unit", "")} /></td><td>{koreanDate(text(row, "observation_date"))}</td><td>{text(row, "interpretation")}</td></tr>)}</tbody></table></div>
              </section>

              <section className="report-section">
                <div className="report-section__head"><div><span>CALENDAR</span><h2>공식 경제 발표 일정</h2><p className="report-section-help">발표 전후에는 변동성이 커질 수 있습니다. 일정은 방향 예측보다 신규 진입·주문 시점을 조절하는 데 사용하세요.</p></div><CalendarDays size={19} /></div>
                <div className="report-table-wrap"><table><thead><tr><th>구분</th><th>미 동부시간</th><th>발표</th><th>해석 기준</th></tr></thead><tbody>{report.todayEvents.map((row) => <tr key={`today-${text(row, "event")}`}><td>해당 거래일</td><td>{text(row, "event_time").replace("T", " ").slice(0, 16)}</td><td>{text(row, "event")}</td><td>{text(row, "interpretation")}</td></tr>)}{report.upcomingEvents.map((row) => <tr key={`next-${text(row, "event_time")}-${text(row, "event")}`}><td>예정</td><td>{text(row, "event_time").replace("T", " ").slice(0, 16)}</td><td>{text(row, "event")}</td><td>{text(row, "interpretation")}</td></tr>)}{report.todayEvents.length + report.upcomingEvents.length === 0 ? <EmptyRow columns={4}>수집된 공식 일정이 없습니다.</EmptyRow> : null}</tbody></table></div>
              </section>

              <section className="report-section">
                <div className="report-section__head"><div><span>NEWS</span><h2>주요 뉴스와 가격 확인</h2><p className="report-section-help">좋은 뉴스에도 가격이 오르지 않으면 신호가 약하고, 나쁜 뉴스에도 버티면 수급이 강할 수 있습니다. 제목보다 가격 확인을 우선하세요.</p></div><Newspaper size={19} /></div>
                <div className="report-news-list">
                  {(report.newsClusters?.length ? report.newsClusters : report.news).map((row) => (
                    <article key={text(row, "url")}>
                      <div><span>{text(row, "topic")}</span><small>{text(row, "sources", text(row, "source"))}</small></div>
                      <a href={text(row, "url", "#")} target="_blank" rel="noreferrer"><strong>{text(row, "headline", text(row, "title"))}</strong><ExternalLink size={14} /></a>
                      <p>{text(row, "tone")}; {text(row, "interpretation")}</p>
                      {text(row, "price_confirmation", "") ? <small className="report-price-check">{text(row, "price_confirmation", "")}</small> : null}
                    </article>
                  ))}
                </div>
              </section>

              <footer className="report-footer">이 화면은 시장 판단 자료이며 매수·매도 주문이나 포트폴리오 비중을 자동으로 결정하지 않습니다. 표시 기준 {selectedMeta ? koreanDate(selectedMeta.displayDate) : koreanDate(report.displayDate)}.</footer>
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
