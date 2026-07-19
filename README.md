# Balance

보유 자산, 목표 비중, 총자산 추이를 한 화면에서 확인하는 리밸런싱 대시보드 프로토타입입니다.

## 현재 범위

- 영문 Ticker 검색, 실제 영문 회사·ETF 이름 표시 및 보유수 편집
- 가상 종가 기준 평가금액·현재 비중 계산
- 현금을 포함한 목표 비중 검증
- 정수 주식 기준 매수·매도 리밸런싱 미리보기
- 총자산 한 개 값만 사용하는 반응형 꺾은선 차트
- 브라우저 메모리에서만 동작하며 새로고침 시 초기화

현재 가격과 시계열은 모두 화면 확인용 샘플입니다. 실제 시세 API 호출, 사용자 데이터 저장, 증권사 주문은 포함하지 않습니다.

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

Cloudflare 배포 설정:

- Worker 이름: `rebalancing`
- 정적 자산 디렉터리: `dist`
- 로컬 Workers 실행: `wrangler dev`
- 배포: `wrangler deploy`

외부 시세 API를 연결할 때 API 키는 클라이언트의 `VITE_*` 환경변수에 두지 않고 Cloudflare Worker의 비밀 변수로 관리해야 합니다.
