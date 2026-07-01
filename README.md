# auto-trading

Toss Securities Open API 기반 페이퍼 트레이딩 / 자동매매 플랫폼.
전략을 백테스트·페이퍼로 검증 → 성과 기준 통과 시 실거래로 승격하는 **전략 운영 플랫폼**.

- 설계: [`PLAN.md`](./PLAN.md)
- API 스펙(실측 확정): [`docs/toss-api-spec.md`](./docs/toss-api-spec.md)

## 파이프라인

```
전략 작성 → 백테스트 → 페이퍼 트레이딩 → 성과 검증 → (수동 승인) → 실거래
```

핵심 원칙: 토스 API 호출은 `TossApiClient` 하나로 격리하고, 그 위에 `Broker` 인터페이스로
`PaperBroker` / `LiveBroker`를 분리 — 같은 전략을 페이퍼에서 검증한 뒤 실거래로 무수정 승격.

## 스택
- **Node + TypeScript** (strict; `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- **Fastify** REST API + 대시보드
- 상태: in-memory + **파일 영속**(단일 프로세스). 멀티프로세스는 async DB 리팩터 필요(아래 한계).

## 모듈
| 영역 | 모듈 |
|---|---|
| API 격리 | `toss/TossApiClient` · `TokenManager` · `http` |
| 시세 | `market/MarketDataWorker`(배치 폴링) · `MarketCalendar` · `PriceSource` |
| 브로커 | `broker/PaperBroker`(평균단가·슬리피지·레스팅LIMIT·멱등·halt) · `LiveBroker`(기본 비활성) · `Broker` |
| 전략 | `strategy/StrategyEngine` · `ThresholdStrategy` · `MovingAverageCrossStrategy` · `StrategyRegistry` |
| 리스크 | `risk/RiskManager`(사전거래 게이트) · `TradeTracker`(일일/연속 손실 halt, 라운드트립) |
| 주문 | `order/OrderManager`(단일 choke point) · `ReconciliationService`(부팅 정합) |
| 성과·승급 | `performance/PerformanceAnalyzer` · `EquityRecorder` · `SnapshotScheduler` · `PerformanceService` · `strategy/PromotionGate`(§7) |
| 백테스트 | `backtest/BacktestEngine`(next-bar 체결) |
| 앱 | `app/TradingSystem`(파사드) · `HaltSwitch`+`HaltStore`(내구 킬스위치) · `api/server` · `persistence/*` |

## 보안 (필독)
- `client_secret`은 `.env`에만. **커밋 금지, 채팅 붙여넣기 금지.** `.env`/`*-state.json`/`halt-state.json`은 gitignore.
- 토큰/시크릿은 로그·파일에 안 찍음. 대시보드는 API 값 HTML 이스케이프(XSS 방지).
- API는 `127.0.0.1` 바인드, mutation은 `API_TOKEN`(설정 시) 필요. 운영은 인증 프록시 뒤에 둘 것.

## 빠른 시작
```bash
cp .env.example .env          # client_id / client_secret 채우기
npm install
npm run probe                 # live API 검증 (읽기 전용, 주문 안 넣음)
npm run typecheck && npm test # 101 tests
npm run dev                   # 페이퍼 파이프라인 + API(:3000) + 대시보드(/)
```
환경변수: `PORT`, `API_TOKEN`, `HALT_FILE`, `STATE_FILE`.

## 안전장치 (PLAN §11)
PAPER/LIVE 분리 · LIVE 수동 승인(§7 승급 게이트, fail-closed) · 전략별 최대투자금·종목 비중 ·
일일 최대손실 + 연속손실 자동 halt(미실현 포함) · 미체결 시 추가주문 금지 · API 오류 시 중단 ·
재시작 시 미체결 재조회 · **내구 긴급정지 버튼**(원자적 파일, 크래시에도 유지).

## 현재 상태
단일 프로세스 기준 **기능 완성** — 백테스트/페이퍼/리스크 halt/reconciliation/승급 게이트/
내구 킬스위치/내구 상태/REST API/대시보드. LiveBroker는 기본 비활성(실거래 승인 시에만).

## 알려진 한계 / 다음
- **멀티프로세스 영속**: 현재 파일 기반(단일 writer). 진짜 Postgres는 `OrderRepository`를 async로
  전환하는 대형 리팩터 필요.
- market-calendar 세션시간 필드/tz, LIVE 활성화 절차, US 금액주문(`orderAmount`)/`timeInForce` 직렬화는
  실계좌 검증 후. 코드에 `⚠️`로 표기.
