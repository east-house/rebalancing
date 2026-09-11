# 시작일 지정 검증 구현 및 검증

## 범위

- 미국 거래일 2026-08-31부터 시작일을 선택한다. 현재 검증 완료 자료의 마지막 미국 거래일은 2026-09-10이다.
- 각 시작일마다 G55와 R2에 각각 $21,000의 독립 가상계좌를 생성한다. 첫날 종가로 판단하고 다음 거래일 종가에 체결하는 기존 전략을 그대로 사용한다.
- UI의 `정기 기록`과 `시작일 검증`을 분리했다. 재현 보고서는 당시 실제 실행 기록이 아니다.
- 기존 전략, 정기 원장, 보고서 날짜 변환, 예약 시각은 변경하지 않았다. I1은 구현하거나 활성화하지 않았다.

## 불합격 원인과 조치

1. 목록: 최신 목록이 과거에도 동일했다고 단정할 수 없었다. Wikipedia의 8월 19일 저장본(revision 1370105675)과 9월 4일 저장본 및 해당 구간의 전체 수정 이력을 확인했다. 503개 구성 종목은 동일하다. FERG의 산업 세부 분류 수정은 기존 전략 계산에 사용되지 않는다. 9월 4일 발표된 다음 정기 교체의 효력일은 9월 21일이다.
2. 가격: 보존된 실행 입력에는 전략에 필요한 786개 종목·거래일의 유효 가격이 없었다. 785개는 별도로 보존된 실제 가격 캐시에서 복구했고, FISV 2025-11-12 한 건은 ChartExchange의 실제 OHLCV로 보완했다. 정상 원본 값은 덮어쓰지 않고, 누락된 행 전체만 출처별 우선순위로 보완했다. 보간·전일 가격 복제는 하지 않았다.
3. FISV: Yahoo의 두 응답 서버에서 해당 날짜의 OHLCV가 모두 null인 것을 원시 응답으로 확인했다. 날짜 계산 오류가 아니다. 제공처 내부에서 왜 null을 저장했는지는 확인되지 않았다. 대체 가격은 시가 64.20, 고가 64.86, 저가 63.09, 종가 64.37, 거래량 6,237,996이다. 자동 갱신은 이후 배당·분할 발생 시 이 예외를 재검토하도록 게시를 차단한다.
4. FDXF·HONA·Q: 실제 거래 시작 전 구간은 가격 누락이 아니라 거래 이력이 없는 구간이다. 공식 발표에 근거한 최초 거래일부터 가격을 요구한다. 이 세 종목은 기존 252거래일 이력 조건에 따라 현재 후보에서 제외되는 것을 확인했다. 거래 개시 후 누락은 예외로 허용하지 않는다.

## 검증 결과

- 503개 구성 종목과 20개 프록시/기준 종목, 총 523개를 검사했다.
- 지표 준비 구간을 포함한 2025-08-28~2026-09-10의 260개 미국 거래일에서, 공식 거래 개시 전 구간을 제외한 미해결 가격 누락은 0건이다.
- 시작 가능 거래일 8개, 날짜별 보고서 36개, 전략별 계좌 보고서 72개가 생성됐다.
- 모든 보고서의 자산 합계, 현금과 누적 거래의 일치, 체결 순서, 시작일 초기화, 휴장일 제외를 검증했다.
- 9월 4일 이후 가격을 바꾸어도 그 이전의 계좌·판단·거래 계획이 바뀌지 않는 것을 검증했다.
- Python 95개 테스트, 프런트엔드/Worker 128개 테스트가 통과했다. 프로덕션 빌드도 통과했다.
- 브라우저: 1440/390/320px 및 UTC/서울/뉴욕의 9개 조합에서 시작일 변경, 휴장일 거부, 전략 전환, 정기 기록 복귀 및 레이아웃을 검사했다.
- 실제 외부 재수집 경로도 실행하여 8개 시작일의 보고서 생성과 잔고·체결 순서 검증을 통과했다.

## 자동 갱신과 실패 시 동작

- 새 workflow 파일: `.github/workflows/refresh-trading-replays.yml`
- Actions 표시 이름: `Refresh start-date trading replays`
- 기존 `Publish daily IRCS trading-test report`가 성공하면 별도 실행된다. 기존 예약 시각은 변경하지 않았다.
- 구성 종목 이력을 확인하고 필요한 가격만 재수집한다. 전체 자료와 지표가 통과한 뒤 버전별 JSON과 index를 게시한다. 기존 정기 원장은 건드리지 않는다.
- 자료 누락, 구성 종목 변경, 대체 가격의 기업행사 재검토 필요, 외부 요청 실패 시 새 검증본을 게시하지 않는다. 마지막 정상본과 자료 기준일이 유지된다. 실패 진단 자료는 Actions artifact에 30일 보관한다.
- 구성 종목 변경의 실제 효력일을 아직 자동 재현하는 기능은 없다. 변경이 발견되면 검토가 필요하다. 따라서 앞으로 어떤 외부 변화에도 중단 없이 성공한다고 보장하는 구현은 아니다.

## 재검증 명령

```sh
npm run report:test
npm test
npm run build
uv run --with-requirements requirements-market-report.txt python scripts/verify_trading_replays.py
uv run --with-requirements requirements-market-report.txt python -m market_report_pipeline.refresh_trading_replays
```

## 확인 자료

- 목록 저장본: https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&oldid=1370105675
- 9월 교체 효력일: https://press.spglobal.com/2026-09-04-Bloom-Energy,-Illumina,-and-Everpure-Set-to-Join-S-P-500-Others-to-Join-S-P-100,-S-P-MidCap-400,-and-S-P-SmallCap-600
- FISV 과거 가격: https://chartexchange.com/symbol/nasdaq-fisv/historical/
- FISV 이전 공지: https://www.nasdaqtrader.com/TraderNews.aspx?id=DTN2025-32
- FDXF: https://investor.fedex.com/news-and-events/investor-news/investor-news-details/2026/FedEx-Board-of-Directors-Approves-Spin-off-of-FedEx-Freight/default.aspx
- HONA: https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2026-399
- Q: https://ir.qnityelectronics.com/sec-filings/all-sec-filings/content/0001193125-25-240313/0001193125-25-240313.pdf

입력 파일 SHA-256, 보완 행별 출처, 목록 검증 이력은 각 검증본의 audit에 포함되어 있다. 원시 다운로드 응답은 `action-output/replay-refresh`에 보존한다.
