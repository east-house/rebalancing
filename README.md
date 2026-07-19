# Balance

보유 자산, 목표 비중, 총자산 추이를 한 화면에서 확인하는 리밸런싱 대시보드 프로토타입입니다.

## 현재 범위

- 한국·미국 주식 및 ETF 15,938개의 정적 종목 목록 검색
- 한글 종목명·영문 회사명·한국 6자리 종목코드·미국 Ticker 검색
- Ticker와 실제 회사·ETF 이름 표시 및 보유수 편집
- 가상 종가 기준 평가금액·현재 비중 계산
- 현금을 포함한 목표 비중 검증
- 정수 주식 기준 매수·매도 리밸런싱 미리보기
- 총자산 한 개 값만 사용하는 반응형 꺾은선 차트
- 브라우저 메모리에서만 동작하며 새로고침 시 초기화

현재 가격과 시계열은 모두 화면 확인용 샘플입니다. 실제 시세 API 호출, 사용자 데이터 저장, 증권사 주문은 포함하지 않습니다.

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

이 프로젝트는 [wrangler.jsonc](./wrangler.jsonc)의 Workers Static Assets 설정을 사용합니다. 존재하지 않는 경로는 SPA 진입점인 `index.html`로 연결됩니다.

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
- 로컬 Workers 실행: `wrangler dev`
- 배포: `wrangler deploy`

외부 시세 API를 연결할 때 API 키는 클라이언트의 `VITE_*` 환경변수에 두지 않고 Cloudflare Worker의 비밀 변수로 관리해야 합니다.
