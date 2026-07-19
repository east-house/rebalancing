# Balance

보유 자산, 목표 비중, 총자산 추이를 한 화면에서 확인하는 리밸런싱 대시보드 프로토타입입니다.

## 현재 범위

- 한국·미국 주식 및 ETF 15,938개의 정적 종목 목록 검색
- 한글 종목명·영문 회사명·한국 6자리 종목코드·미국 Ticker 검색
- Ticker와 실제 회사·ETF 이름 표시 및 보유수 편집
- R2 수집 종가 기준 평가금액·현재 비중 계산
- 현금을 포함한 목표 비중 검증
- 정수 주식 기준 매수·매도 리밸런싱 미리보기
- 총자산 한 개 값만 사용하는 반응형 꺾은선 차트
- 보유정보와 총자산 시계열을 같은 브라우저 프로필의 로컬 저장소에 보관
- 국내 전체와 미국 지정 100종목의 최근 1년 종가를 R2에 증분 수집하는 GitHub Actions
- R2 최신 종가를 같은 출처의 Worker API로 전달하고 브라우저에서 원화 평가

GitHub Actions가 만든 R2 종가 묶음을 Worker API가 그대로 전달합니다. 한국
종목은 원화 종가, 미국 종목은 같은 수집 작업의 USD/KRW 종가로 환산합니다.
증권사 주문 실행 기능은 포함하지 않습니다.

## 사용자 데이터 보관

보유 종목, 보유 수량, 목표 비중, 총자산, 가격 기준과 총자산 시계열은
`balance.local-portfolio` 키 하나로 브라우저 `localStorage`에만 저장합니다.
앱 코드는 이 정보를 서버, R2 또는 외부 시세 제공자에게 전송하지 않습니다.
브라우저가 전체 공개 종가 묶음을 내려받은 뒤 보유 종목과의 매칭을 기기 안에서
수행하므로 종가 API 요청에도 Ticker, 수량, 목표 비중이 포함되지 않습니다.

- 같은 배포 주소와 같은 브라우저 프로필로 재방문하면 저장값을 복구합니다.
- 총자산 이력은 KST 날짜별 한 건으로 기록하고 같은 날 수정은 덮어씁니다.
- 최근 1년만 유지하며 화면의 `내 데이터 삭제`로 해당 키만 지울 수 있습니다.
- 다른 브라우저, 브라우저 프로필, 기기와는 자동 동기화하지 않습니다.
- 시크릿 창 종료, 사이트 데이터 삭제, 브라우저 제거 시 정보가 사라질 수 있습니다.
- 같은 기기와 브라우저 프로필을 공유하는 사람이나 확장 프로그램으로부터
  암호학적으로 격리하는 기능은 아닙니다.

공유 기기에서는 별도 OS·브라우저 프로필과 기기 잠금을 사용해야 합니다.
브라우저 데이터 삭제에도 견디는 장기 보관이 필요하면 추후 사용자 암호 기반
암호화 백업 내보내기·가져오기 기능을 추가할 수 있습니다.

## 활성 종가 수집

전체 검색 목록은 `public/data/instruments.json`에 그대로 유지합니다. 실제 종가를
수집할 대상은 `config/active-close-prices.json`에서 관리합니다. 현재 설정은
카탈로그에 있는 한국 주식 2,822개와 한국 ETF 1,146개 전부, 시가총액 기준일
스냅샷의 미국 주식 50개, `SOXL`·`TQQQ`·`QLD`를 포함한 미국 ETF 50개로
총 4,068개를 선택합니다.

새 종목은 R2에 이력이 없으면 최근 1년을 최초 수집합니다. 기존 종목은 마지막
가격 이후 구간과 확인되지 않은 짧은 누락 구간만 요청하고, 중복 날짜를 병합한 뒤
최근 1년을 초과한 가격은 제거합니다. 종목별 압축 파일은
`market-data/history/{country}/{ticker}.json.gz`에 저장합니다.

각 샤드는 화면용 최근 두 종가를
`market-data/latest/quotes/shards/{index}.json.gz`에 저장합니다. 수집 작업이
끝나면 집계 작업이 8개 샤드와 최근 두 USD/KRW 종가를 합쳐 Worker API가 읽는
`market-data/latest/quotes/all.json.gz` 한 개를 갱신합니다. 특정 종목 수집이
일시 실패하면 해당 샤드의 이전 정상 종가를 유지합니다.

평일 16:30 KST에 전체 목록을 8개 샤드로 나누고 최대 2개 샤드만 동시에
실행합니다. 각 샤드는 508~509개를 담당하며 요청 간 지연, 재시도, 연속 오류
차단 장치를 적용합니다. 한국 그룹은 `selection: "all"`, 미국 그룹은
`selection: "explicit"` 목록을 사용합니다. 설정을 변경한 뒤 다음 명령으로
검증합니다.

공개 저장소에서 60일 동안 저장소 활동이 없으면 GitHub가 예약 워크플로를
자동 비활성화할 수 있습니다. 이 경우 Actions 화면에서 워크플로를 다시
활성화하거나 저장소에 정상적인 유지보수 커밋을 추가해야 합니다. 수동 실행을
위한 `workflow_dispatch`도 열어 두었습니다.

```bash
python -m unittest \
  scripts/test_collect_close_prices.py \
  scripts/test_aggregate_latest_quotes.py
```

## 종목 검색 데이터

배포 파일인 `public/data/instruments.json`에는 다음 정적 목록이 들어 있습니다.

- 한국 주식 2,822개, 한국 ETF 1,146개
- 미국 주식 6,421개, 미국 ETF 5,549개
- 합계 15,938개

브라우저가 이 JSON을 한 번 내려받은 뒤 모든 검색을 사용자 기기에서 처리합니다. 검색어를 입력할 때마다 Worker나 외부 API를 호출하지 않습니다. 종목 목록은 시세 데이터가 아니므로 가격은 포함하지 않습니다.

목록을 최신 상태로 다시 만들려면 다음 명령을 실행한 뒤 변경된 JSON을 커밋합니다.

```bash
npm run catalog:update
```

생성 스크립트는 한국거래소 목록을 제공하는 FinanceDataReader의 `KRX`, `ETF/KR` 목록과 Nasdaq Trader의 Nasdaq-listed/Other-listed 심볼 디렉터리를 사용합니다. 상장·상장폐지에 따라 목록은 달라지므로 필요할 때 위 명령으로 갱신해야 합니다. 공개 서비스나 상업 서비스에 사용할 때는 각 거래소의 데이터 이용·재배포 조건도 별도로 확인해야 합니다.

FinanceDataReader는 목록을 갱신할 때 개발 환경에서만 실행됩니다. `npm run build`와 배포된 Cloudflare Worker에서는 Python이나 FinanceDataReader를 실행하지 않고, 저장소에 커밋된 `public/data/instruments.json`만 정적 자산으로 복사합니다. 목록을 갱신했다면 이 JSON도 반드시 커밋해야 합니다.

## 로컬 실행

```bash
npm install
npm run dev
```

`npm run dev`는 먼저 Vite 프로덕션 빌드를 생성한 뒤 Wrangler의 로컬 Workers 런타임으로 `dist`를 제공합니다. 빠른 UI 수정 중 Vite 개발 서버가 필요하면 `npm run dev:vite`를 사용할 수 있습니다.

## 검증과 빌드

```bash
npm run typecheck
npm test
npm run build
npm run deploy:check
```

## Cloudflare 배포

이 프로젝트는 [wrangler.jsonc](./wrangler.jsonc)의 Workers Static Assets 설정을 사용합니다. 존재하지 않는 경로는 SPA 진입점인 `index.html`로 연결되고
`/api/*`만 Worker 코드를 먼저 실행합니다.

Action의 `R2_BUCKET_NAME`과 동일한 기존 버킷을 Worker의 `MARKET_DATA`에
바인딩해야 합니다. 버킷 이름은 비밀값이 아니므로 아래 항목은
`wrangler.jsonc`에 커밋하고, S3 호환 Access Key는 계속 GitHub Actions
Secrets에만 둡니다.

```json
{
  "r2_buckets": [
    {
      "binding": "MARKET_DATA",
      "bucket_name": "closeprice"
    }
  ]
}
```

```bash
npm run deploy
```

`npm run deploy`는 Vite 빌드 후 `wrangler deploy`를 실행합니다. 빌드와 Wrangler 설정만 확인하고 업로드하지 않으려면 `npm run deploy:check`를 사용합니다.

Cloudflare Workers Builds의 Git 연동 설정은 다음 조합을 권장합니다.

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

또는 Build command를 비워 두고 Deploy command를 `npm run deploy`로 설정할 수 있습니다. `dist`는 Git에 올리지 않으므로 Build command 없이 `npx wrangler deploy`만 실행하면 새 빌드 환경에서 `dist`를 찾지 못합니다.

Cloudflare 배포 설정:

- Worker 이름: `rebalancing`
- 정적 자산 디렉터리: `dist`
- Worker API: `GET /api/market-data/latest`
- R2 객체: `market-data/latest/quotes/all.json.gz`
- 로컬 Workers 실행: `wrangler dev`
- 배포: `wrangler deploy`

Worker API는 요청마다 종목별 R2 파일을 읽지 않고 압축된 통합 객체 한 개만
전달하며 Cloudflare Cache API를 사용합니다. 일반 정적 파일 요청은 Worker
스크립트를 거치지 않습니다.
