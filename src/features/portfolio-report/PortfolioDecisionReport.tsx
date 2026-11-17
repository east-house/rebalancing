import { useEffect, useState } from "react";
import { loadPortfolioReport } from "../../api/portfolioReport";
import { CORE_ETF, SIGNAL_CORE, isCashEtf, isCore, type AccountDay, type SelectionDetail } from "./portfolioReportModel";
import { DEFAULT_CASH, type StrategyId } from "./portfolioStrategies";

const pct0 = (value: number) => `${Math.round(value * 1000) / 10}%`;
function StrategyRules({ strategy, cashReserve }: { strategy: StrategyId; cashReserve: number }) {
  const changed = Math.abs(cashReserve - DEFAULT_CASH[strategy]) > 1e-9;
  const ceiling = Math.max(0, 0.8 - cashReserve);
  if (strategy === "i2") return <details><summary>I2는 어떤 규칙으로 종목과 비중을 정하나요?</summary>
    <ol>
      <li>종목은 I1과 똑같이 고릅니다(아래 I1 점수·유지순위 10위·섹터당 2개·상관 0.80 제한). I1이 고른 개별 종목과 시장 코어를 그대로 사용합니다.</li>
      <li>시장 코어(S&amp;P 500 ETF)는 항상 20%입니다. 계좌에서는 IVV 대신 SPYM을 보유하고, 켈리 계산에는 IVV 수익률을 씁니다. 개별 종목 비중은 최근 252거래일 일간 수익률(평균의 절반을 덜어내고 왕복 비용을 차감)로 로그 성장률을 최대화하는 켈리 비중을 구한 뒤 절반만 투자합니다(하프 켈리).</li>
      <li>켈리 비중은 종목당 0~40%, 합계 80% 이하로 제한하고 절반만 쓰므로 기존 설계는 종목당 최대 20%, 개별 종목 합계 최대 40%, 계획 현금 40%입니다.</li>
      <li><strong>현금 비중 설정이 기존 설계의 계획 현금 40%를 대신합니다.</strong> 이 계좌: {changed ? `현금 비중 ${pct0(cashReserve)} 설정 (기본 40%)` : "현금 비중 40% (기본 설계)"} → 개별 종목 합계 한도 {pct0(ceiling)}, 종목당 최대 {pct0(ceiling / 2)}. 하프 켈리 비중에 {(ceiling / 0.4).toFixed(2)}배를 곱해 종목 간 비율은 그대로 둡니다. 켈리 비중이 한도보다 작거나 1주를 살 수 없으면 실제 현금은 설정보다 많습니다.</li>
      <li>관측이 126일 미만이거나 개별 종목이 1개뿐이면 켈리 계산 대신 개별 종목 한도({pct0(ceiling)})를 균등 배분합니다. 연구 코드는 SLSQP, 이 화면은 같은 문제를 투영 경사법으로 풉니다.</li>
      <li>최초 투자와 매월 첫 한국 평일 보고서에서 종목·비중을 다시 정하고, 다음 미국 거래일 종가에 정수 주식으로 체결합니다. 목표와 차이가 3%p 미만인 기존 종목은 거래하지 않으며 편도 비용 0.10%를 차감합니다.</li>
    </ol>
    <p>연구 백테스트(검증 기간 2023-12-29~2026-10-09)는 편도 0.25%·2%p 밴드·$21,000 기준이라 이 계좌와 거래·수익률이 완전히 같지는 않습니다.</p>
  </details>;
  if (strategy === "c1") return <details><summary>C1은 어떤 규칙으로 종목과 비중을 정하나요?</summary>
    <ol>
      <li>종목과 비중은 I2와 같습니다. I1이 고른 종목에 최근 252거래일 수익률로 하프 켈리 비중을 구하고, S&amp;P 500 ETF(SPYM) 20%를 고정합니다.</li>
      <li>I2가 현금으로 두는 몫을 1~3개월 미국 국채 ETF(BIL)로 보유합니다. 이 계좌: {changed ? `현금 몫 ${pct0(cashReserve)} 설정 (기본 40%)` : "현금 몫 40% (기본 설계)"} → 개별 종목 합계 한도 {pct0(ceiling)}, 종목당 최대 {pct0(ceiling / 2)}. 하프 켈리가 한도보다 적게 고른 몫도 BIL로 보유합니다. 1주 단위로 남는 금액만 현금입니다.</li>
      <li>최초 투자와 매월 첫 한국 평일 보고서에서 종목·비중을 다시 정합니다. 다음 미국 거래일 종가에 정수 주식으로 체결합니다. 목표와의 차이가 3%p 미만인 종목(BIL 포함)은 거래하지 않고, 편도 비용 0.10%를 차감합니다.</li>
      <li>BIL도 가격이 움직입니다. 배당 지급일마다 가격이 약 0.4% 내려가고 배당으로 보전됩니다. 연구 기간 배당 포함 최대 낙폭은 −0.08%였습니다.</li>
    </ol>
    <p>연구 결과(I2 대비, $21,000·편도 0.25%·2%p 밴드):</p>
    <ul>
      <li>2021-08-31~2023-12-29: CAGR 8.54%(I2 7.44%), MDD −11.33%(−11.59%)</li>
      <li>2023-12-29~2026-10-09: CAGR 32.38%(30.17%), MDD −15.20%(−15.65%), 샤프 1.52(1.42)</li>
      <li>신호 후 1~3거래일 늦게 체결해도 CAGR·칼마·샤프·소르티노는 I2보다 높았습니다. MDD·하방 편차·베타는 I2와 사실상 같았습니다(차이 ±0.5%p).</li>
      <li>개선은 국채 이자에서 나오므로 금리가 내려가면 줄어듭니다.</li>
    </ul>
  </details>;
  return null;
}

export default function PortfolioDecisionReport({ days, releaseId, strategy = "i1", cashReserve = DEFAULT_CASH[strategy] }: { days: AccountDay[]; releaseId?: string; strategy?: StrategyId; cashReserve?: number }) {
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
          const row = report.candidates.find(candidate => candidate.ticker === (item.ticker === CORE_ETF ? SIGNAL_CORE : item.ticker));
          return row ? [{ ticker: item.ticker, rank: row.rank, score: row.score, baseScore: row.base_score,
            themeScore: row.theme_strength, sector: row.sector, theme: row.themes,
            reason: isCore(row.ticker) ? "시장 코어: S&P 500 ETF(SPYM, IVV 대체) 우선 편입" : "저장된 주문의 선정 종목 · 해당 보고서 점수 참고" }] : [];
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
    {!!rows.length && <div className="portfolio-report-table-wrap"><table><thead><tr><th>목표 종목</th><th>선정 순위</th><th>기본 / 테마 / 종합 점수</th><th>분산 분류</th><th>목표 비중</th><th>선정 이유</th></tr></thead><tbody>{rows.map(row => <tr key={row.ticker}><td><strong>{row.ticker}</strong></td><td>{isCashEtf(row.ticker) ? "—" : `${row.rank}위`}</td><td>{isCashEtf(row.ticker) ? "현금 대체" : isCore(row.ticker) ? "코어 우선순위 부여" : `${(row.baseScore * 100).toFixed(1)} / ${(row.themeScore * 100).toFixed(1)} / ${(row.score * 100).toFixed(1)}`}</td><td>{row.sector}<small>{row.theme}</small></td><td>{row.weight !== undefined ? `${(row.weight * 100).toFixed(1)}%` : `${(100 / rows.length).toFixed(1)}% (동일)`}</td><td>{row.reason}</td></tr>)}</tbody></table></div>}
    <StrategyRules strategy={strategy} cashReserve={cashReserve} />
    <details><summary>{strategy === "i1" ? "i1은 어떤 규칙으로 종목을 고르고 매매하나요?" : "참고: I1 점수와 종목 선정 규칙"}</summary>
      <ol>
        <li>S&P 500 수집 명단에서 가격 $10 이상, 최근 63거래일 평균 거래대금 $2,500만 이상, 연환산 변동성 80% 이하인 종목 중 거래대금 상위 200개를 평가합니다.</li>
        <li>기본 점수는 12개월·6개월 모멘텀(최근 1개월 제외), 200일선 대비 추세, 낮은 변동성을 각각 50%·25%·15%·10% 반영합니다. 최종 점수는 기본 85% + 테마 강도 15%입니다.</li>
        <li>테마는 과거 126일 시장 대비 초과수익률의 상관으로 연결합니다(최소 60개 관측, 테마 상관 0.30 이상·섹터 0.20 이상). 테마 강도는 시장 대비 5·20·60일 성과와 50일선 상회 여부를 반영합니다. 미분류 테마는 중립 점수 50점입니다.</li>
        <li>S&amp;P 500 ETF를 코어로 우선 편입하고(보고서 순위는 IVV 기준, 계좌는 1주 가격이 낮은 SPYM으로 보유) 최대 5종목을 동일비중으로 구성합니다. 기존 목표 종목은 유지순위 10위 이내에서 우선 검토하며, 섹터당 최대 2개·종목 간 절대상관 0.80 이하 제한을 적용합니다. 5개를 채우지 못하면 통과 종목끼리 동일비중입니다.</li>
        <li>최초 투자와 매월 첫 한국 평일 보고서에서 종목을 판단합니다. 월간 주문은 지정된 미국 거래일 종가에서 기존 종목별 목표비중 차이를 검사해 3%p 미만이면 수량을 유지합니다. 교체 대상은 매도하고 새 종목은 매수합니다.</li>
        <li>매도 후 매수 순서로 1주 단위만 거래하고 편도 비용 0.10%를 차감합니다. 배정금액이나 현금이 부족하면 매수하지 않습니다. 손절·추적손절·시장 약세에 따른 자동 현금 전환은 사용하지 않습니다.</li>
      </ol>
      <p>원본 연구는 소수점 매매를 사용하지만 이 보고서는 사용자가 요청한 정수 매매를 적용합니다. 가격 자료와 기업행동 처리 범위도 달라 원본 백테스트와 거래·수익률이 완전히 같지는 않습니다. 한국 월초 보고서의 월간 판단은 직전 미국 월말 종가를 사용하며, 계좌 최초 시작은 선택한 시작 보고일을 따릅니다.</p>
    </details>
  </section>;
}
