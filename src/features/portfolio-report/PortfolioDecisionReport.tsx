import { useEffect, useState } from "react";
import { loadPortfolioReport } from "../../api/portfolioReport";
import type { AccountDay, SelectionDetail } from "./portfolioReportModel";

export default function PortfolioDecisionReport({ days, releaseId }: { days: AccountDay[]; releaseId?: string }) {
  const day = days.at(-1)!;
  const lastOrder = [...days].reverse().find(item => item.pending)?.pending;
  const sourceDate = day.selectionReportDate ?? lastOrder?.reportDate;
  const [fallback, setFallback] = useState<{ date: string; rows: SelectionDetail[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setFallback(null); setError("");
    if (!day.selectionDetails && sourceDate && lastOrder) {
      loadPortfolioReport(sourceDate, releaseId).then(report => {
        if (!active) return;
        setFallback({ date: sourceDate, rows: lastOrder.names.flatMap(item => {
          const row = report.candidates.find(candidate => candidate.ticker === item.ticker);
          return row ? [{ ticker: row.ticker, rank: row.rank, score: row.score, baseScore: row.base_score,
            themeScore: row.theme_strength, sector: row.sector, theme: row.themes,
            reason: row.ticker === "IVV" ? "시장 코어: IVV 우선 편입" : "저장된 주문의 선정 종목 · 해당 보고서 점수 참고" }] : [];
        }) });
      }).catch(() => { if (active) setError("선정 근거 보고서를 불러오지 못했습니다. 저장된 체결 기록은 그대로 유지됩니다."); });
    }
    return () => { active = false; };
  }, [sourceDate, releaseId, day.selectionDetails]);
  const previous = days.at(-2);
  const historicalExplanation = day.trades.length ? [`미국 ${day.marketDate} 종가로 ${day.trades.length}건 체결했습니다. 사유: ${[...new Set(day.trades.map(item => item.reason))].join(" · ")}.`]
    : previous?.pending?.executionDate === day.marketDate ? ["예약 주문을 처리했지만 체결 수량은 0주였습니다. 기존 기록에는 종목별 미체결 사유가 저장돼 있지 않습니다."]
    : day.pending ? [`금일 체결 없음: 미국 ${day.pending.executionDate} 종가에 처리할 주문이 대기 중입니다.`]
    : ["금일 거래 없음: 저장된 기록에 새 체결이나 대기 주문이 없습니다. 월간 점검 외에는 일별 순위 변화만으로 매매하지 않습니다."];
  const rows = day.selectionDetails ?? (fallback && fallback.date === sourceDate ? fallback.rows : []);
  return <section className="portfolio-report-card account-decision">
    <h2>오늘의 운용 판단과 선정 근거</h2>
    <p><strong>{day.reportDate} 보고서 · 미국 {day.marketDate} 종가 기준</strong></p>
    <ul>{(day.explanation ?? historicalExplanation).map((text, i) => <li key={i}>{text}</li>)}</ul>
    {!day.explanation && <p>이 날짜는 상세 판단 기록을 추가하기 전에 저장된 계좌입니다. 기존 체결은 재계산하지 않으며 아래 점수는 선정 보고서를 다시 조회한 참고 정보입니다.</p>}
    {sourceDate && <p>최근 기록된 선정 판단: {sourceDate} 보고서. 아래는 해당 판단의 목표 종목이며, 실제 보유 수량은 ‘보유 종목과 수익’에서 확인할 수 있습니다.</p>}
    {error && <p role="status">{error}</p>}
    {!!rows.length && <div className="portfolio-report-table-wrap"><table><thead><tr><th>목표 종목</th><th>선정 순위</th><th>기본 / 테마 / 종합 점수</th><th>분산 분류</th><th>선정 이유</th></tr></thead><tbody>{rows.map(row => <tr key={row.ticker}><td><strong>{row.ticker}</strong></td><td>{row.rank}위</td><td>{row.ticker === "IVV" ? "코어 우선순위 부여" : `${(row.baseScore * 100).toFixed(1)} / ${(row.themeScore * 100).toFixed(1)} / ${(row.score * 100).toFixed(1)}`}</td><td>{row.sector}<small>{row.theme}</small></td><td>{row.reason}</td></tr>)}</tbody></table></div>}
    <details><summary>i1은 어떤 규칙으로 종목을 고르고 매매하나요?</summary>
      <ol>
        <li>S&P 500 수집 명단에서 가격 $10 이상, 최근 63거래일 평균 거래대금 $2,500만 이상, 연환산 변동성 80% 이하인 종목 중 거래대금 상위 200개를 평가합니다.</li>
        <li>기본 점수는 12개월·6개월 모멘텀(최근 1개월 제외), 200일선 대비 추세, 낮은 변동성을 각각 50%·25%·15%·10% 반영합니다. 최종 점수는 기본 85% + 테마 강도 15%입니다.</li>
        <li>테마는 과거 126일 시장 대비 초과수익률의 상관으로 연결합니다(최소 60개 관측, 테마 상관 0.30 이상·섹터 0.20 이상). 테마 강도는 시장 대비 5·20·60일 성과와 50일선 상회 여부를 반영합니다. 미분류 테마는 중립 점수 50점입니다.</li>
        <li>IVV를 코어로 우선 편입하고 최대 5종목을 동일비중으로 구성합니다. 기존 목표 종목은 유지순위 10위 이내에서 우선 검토하며, 섹터당 최대 2개·종목 간 절대상관 0.80 이하 제한을 적용합니다. 5개를 채우지 못하면 통과 종목끼리 동일비중입니다.</li>
        <li>최초 투자와 매월 첫 한국 평일 보고서에서 종목을 판단합니다. 월간 주문은 지정된 미국 거래일 종가에서 기존 종목별 목표비중 차이를 검사해 3%p 미만이면 수량을 유지합니다. 교체 대상은 매도하고 새 종목은 매수합니다.</li>
        <li>매도 후 매수 순서로 1주 단위만 거래하고 편도 비용 0.10%를 차감합니다. 배정금액이나 현금이 부족하면 매수하지 않습니다. 손절·추적손절·시장 약세에 따른 자동 현금 전환은 사용하지 않습니다.</li>
      </ol>
      <p>원본 연구와의 차이: 원본은 미국 월말 신호·소수점 매매를 사용합니다. 이 보고서는 기존 한국 보고일 규칙과 사용자가 요청한 정수 매매를 적용하므로 원본 백테스트와 거래·수익률이 완전히 같지는 않습니다.</p>
    </details>
  </section>;
}
