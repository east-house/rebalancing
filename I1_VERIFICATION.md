# I1 적용 검증 — 2026-09-13

## 결론

현재 루트 `cloud_pages`의 코드로 운영한다. `stock_strategy/stock_rank_prediction`
폴더는 원본 대조에만 사용하며 운영 Actions·Worker·브라우저 계좌는 이를 실행하지 않는다.
점수와 종목 선정은 동일 입력 비교를 통과했다. 매매에서 발견한 종목별 비중 검사
차이를 수정했다. 다만 원본 연구와 모든 날짜·가격·거래 결과가 같다는 의미는 아니다.

## 실행 경로와 push의 의미

1. main push → GitHub의 `verify-report-integrity.yml`에서 Python·프런트엔드 테스트와
   빌드를 UTC / Asia/Seoul / America/New_York로 검증한다.
2. 연결된 Cloudflare Workers Builds → `npm run build` → `wrangler.jsonc`의
   `worker/index.js`와 `dist`를 배포한다. Worker는 `MARKET_DATA` R2 binding으로
   게시 manifest와 버전 고정 보고서를 제공한다.
3. 데이터 생성은 push 이벤트가 아니라 `daily-market-report.yml`의 기존 예약 또는
   수동 실행으로 수행한다. `daily_reports.generate_morning` → 이 루트의 가격 수집 →
   `us_daily_portfolio_report.build_device_payload` → 시장 보고서와 함께 R2에 게시한다.
4. 브라우저는 보고서를 받아 `portfolioReportModel.advanceAccount`로 개인 가상계좌를
   갱신한다. 실제 증권사 주문은 없으며 사이트를 열 때 새 보고서를 순서대로 반영한다.

현재 연결된 저장소의 main push는 위 배포를 사용한다. 새 저장소에 폴더만 push하는
경우에는 Cloudflare 연결·R2 binding·Actions의 R2 자격증명이 별도로 필요하다.
예약 시각은 실행·게시 완료 시각의 보장이 아니다. push 자체는 기존 R2 보고서를
재생성하거나 사용자의 과거 체결 기록을 다시 쓰지 않는다.

수동 I1 명령은 `npm run portfolio-report:i1`이다. 기존 `report:publish-r2`와 동일한
현재 운영 경로이며 시장 보고서도 함께 게시한다. 혼동하기 쉬운
`portfolio-report:update`는 과거 v3 연구 내보내기 명령이다. 원본 폴더를 참조하며
날짜 규칙도 다르므로 이 명령의 동작은 이번 작업에서 바꾸지 않았다. 자동 운영은
이 오래된 명령을 호출하지 않는다.

## 원본 대조와 수정

원본 파일: `src/us_long_only_research.py`, `src/us_strategy_improvement_research.py`,
`src/us_institutional_hybrid_research.py`. 대조 스크립트는 원본 함수의 AST를 그대로
실행해 동일 합성 가격·구성종목 입력으로 비교한다. 7개 기준일의 점수·순위·테마·섹터,
28개 유지 종목 조합의 선정 결과가 일치했다. 이는 입력이 같은 경우의 비교이며
실제 시장 자료 수집·월말 날짜 선택까지 동일하다고 주장하지 않는다.

```powershell
uv run --with-requirements requirements-market-report.txt python -m scripts.verify_i1_source_parity --original-root C:/Users/lee/Documents/workplace/stock_strategy/stock_rank_prediction
```

출력 `action-output/i1-source-parity.json`에는 대조한 원본 SHA-256도 보관한다.

발견한 매매 차이: 이전 계좌 엔진은 판단일에 전체 비중 차이를 검사하고, 한 종목이라도
조건에 걸리면 전체 수량을 재조정했다. 원본은 월간 주문의 **체결 종가**에서 기존 종목별
비중 차이를 검사한다. 수정 후 3%p 미만인 기존 목표 종목은 그대로 두며, 교체 종목은
매도·신규 매수한다. 원본처럼 목표 수량을 먼저 계산하고 거래비용을 포함한 현금 한도를
적용한다. 매도 먼저, 수량 증감 오름차순·동률 티커순으로 실행하되 수량은 정수다.

## 의도된 차이와 미지원 범위

- 원본은 소수점 3자리 매매, 현재 계좌는 사용자 요청대로 정수 매매다. 잔여 현금과
  실제 종목 비중·성과가 달라진다. IVV가 목표에 있어도 배정금액으로 1주를 못 사면
  미보유일 수 있다.
- 원본은 미국 월말 신호, 현재는 기존의 매월 첫 한국 평일 보고서에서 판단한다.
  예를 들어 월말이 미국 금요일이면 그 종가는 현재 규칙에서 다음 화요일 보고서에
  들어갈 수 있어 월요일 점검 입력과 달라진다. 프로젝트의 날짜 보호 지침에 따라
  이번 작업에서 월간 날짜 선택·휴장일·게시 스케줄을 수정하지 않았다.
- 원본은 raw close의 $10 필터, point-in-time membership 및 기업행동 처리가 있다.
  현재는 수집한 S&P 500 스냅샷과 보고서의 조정종가를 사용한다. 분할·합병·상장폐지
  정산을 실제 증권사처럼 처리하는 원장은 아니다. 현금배당도 별도 입금으로 기록하지
  않는다. 조정종가를 이용한 가상계좌이므로 실제 체결가·배당 현금과 일치하지 않는다.
- 현재 매수원가에는 매수비용을 포함하고 실현손익에는 매도비용을 반영한다. 원본
  거래별 realized_pnl은 매수비용을 원가에 포함하지 않아 항목별 표시가 다르다.
- 저장된 과거 체결은 보존한다. 수정된 매매 방식으로 처음부터 비교하려면 기존 계좌를
  보관한 뒤 같은 시작일·투자금으로 새 계좌를 만든다. 자동 재작성은 하지 않는다.

## 보고서 설명과 검증 결과

새 기록은 일별 판단 이유, 판단 보고일, 목표 종목별 순위·점수·섹터·테마·선정 이유를
보존한다. 기존 기록은 기존 체결·대기 주문을 설명하고, 당시 상세 판단 기록이 없다는
사실과 다시 조회한 점수의 한계를 표시한다. 미래 종가로 과거 선정 근거를 만들지 않는다.

- Python 파이프라인 116개 테스트 통과.
- 프런트엔드/Worker 136개 테스트 통과(종목별 비중 검사 등 신규 3개 포함).
- 실제 게시 보고서 20개 × 시작금액 4종 = 시작일별 80개 사례 통과.
  정수 수량, 현금 음수 방지, 총손익 항등식, 중복 체결 방지, 나눠 갱신한 결과의 일치를 검사.
- $2,819 / 8월 17일 시작 예제는 9월 11일 보고서까지 4건 최초 매수,
  총자산 $2,776.08, 총손익 -$42.92. 최신 보고일은 월간 점검일이 아니고 대기 주문도
  없어 거래하지 않는다. 이는 검증용 새 계좌 결과이며 사용자 저장 계좌를 읽은 결과가 아니다.
- 320 / 390 / 768 / 1024 / 1440px 렌더링에서 본문 가로 넘침 없음.

실제 자료 재검증: `node --experimental-strip-types scripts/verify_portfolio_account.mjs`.
