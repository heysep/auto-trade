> **구현 현황 (2026-07 기준):** 이 계획서의 핵심은 대부분 구현됨 — 백테스트 · 페이퍼 브로커 ·
> 리스크 halt(일일/연속/미실현) · reconciliation · 승급 게이트(§7, 실 메트릭·fail-closed) ·
> 내구 킬스위치 · 내구 상태(재시작 안전) · REST API + 대시보드 · 2전략. LiveBroker는 기본 비활성.
> 단일 프로세스 기준 기능 완성(101 tests). 남은 대형 항목: 멀티프로세스용 async DB repo.
> 실행/구조는 [`README.md`](./README.md), API 실측 스펙은 [`docs/toss-api-spec.md`](./docs/toss-api-spec.md).

# 토스증권 Open API 기반 페이퍼 트레이딩 / 자동매매 시스템 개발 계획서 v2

> v1 초안 대비 변경점: API 스펙 검증 단계 신설(Phase 0), Broker 추상화 명시, DB 스키마
> 재설계(평가값 분리·equity curve·idempotency 제약), 체결 모델 현실화, 부팅 reconciliation,
> 시장별 캘린더, 토큰 수명 관리. 변경 사유는 각 절 머리에 `변경 사유:`로 표기.

---

## 1. 프로젝트 개요

토스증권 Open API를 활용해 투자 전략을 검증하고, 검증된 전략을 실거래로 전환하는 로컬 기반 트레이딩 시스템.

```
전략 작성 → 백테스트 → 페이퍼 트레이딩 → 성과 검증 → 실거래 승인 → 자동매매 실행 → 성과 모니터링
```

**설계 원칙**
1. 토스 API 직접 호출은 `TossApiClient` 하나로 격리. 그 위에 `PaperBroker` / `LiveBroker`를 `Broker` 인터페이스로 분리.
2. 전략 로직은 구체 Broker가 아니라 `Broker` 인터페이스에만 의존 → 같은 전략을 페이퍼에서 검증 후 실거래로 무수정 승격.
3. 실제 계좌 자산(토스 기준)과 내부 전략별 포지션(DB 기준)을 분리 관리.

---

## 2. Phase 0 — API 스펙 검증 (✅ 완료 → `docs/toss-api-spec.md`)

> 전체 설계가 토스 주문 API의 실재·인증·제약에 종속 → 코드 전에 스펙 확정. **완료.**
> 상세는 `docs/toss-api-spec.md`. 요약:

- ✅ Open API 실재. Base URL `https://openapi.tossinvest.com`. REST/JSON. KRX+US 통합.
- ✅ 주문 API 제공: 생성 `POST /api/v1/orders`, 조회 `GET`, 수정 `POST …/{id}/modify`, **취소 `POST …/{id}/cancel`(DELETE 아님)**. LIMIT/MARKET.
- ✅ 인증 OAuth2 client_credentials, `POST /oauth2/token`, Bearer. **refresh_token 없음 → 재발급. `expires_in` 응답값 사용(하드코딩 금지).**
- ✅ 주문 바디에 `clientOrderId` → `idempotency_key`로 직매핑(중복주문 네이티브 방지).
- ✅ 주문 상태 enum 10종(PENDING/PARTIAL_FILLED/FILLED/CANCELED/REJECTED/REPLACED/PENDING_CANCEL/PENDING_REPLACE/CANCEL_REJECTED/REPLACE_REJECTED), OPEN/CLOSED 그룹.
- ✅ **WebSocket 미제공 → REST 폴링(~1s) 확정.** WebSocket 분기 코드 불필요.
- ✅ **샌드박스 없음 → LiveBroker는 실계좌 최소수량 테스트.** Reconciliation·안전장치 우선.
- ✅ 소수점/금액주문(`orderAmount`)은 **US만**. KR은 정수 `quantity`. → 주문 빌더 KR/US 분기.
- ⚠️ 미확정(발급 후 확정): 경로 prefix `/v1` vs `/api/v1`, rate limit 수치, 토큰 실제 수명, 시세 다중조회 파라미터.

---

## 3. 시스템 목표 (단계별)

### 3.1 1차
로컬에서 토스 API 연결 → 종목 현재가 조회 → 페이퍼 주문 생성.
인증 / 현재가 조회 / 전략 실행 / 가상 매수·매도 / 가상 포지션 계산 / 대시보드 표시.

### 3.2 2차
다중 전략 등록, 전략별 페이퍼 성과 확인.
전략 등록 / 대상 종목·자본금 설정 / 거래 기록 / 수익률·MDD·승률·Profit Factor 계산.

### 3.3 3차
성과 기준 통과 전략만 실거래 전환.
`PAPER_TESTING → APPROVED → LIVE` (LIVE 전환은 항상 수동 승인).

---

## 4. 아키텍처 / 모듈

```
StrategyEngine
  └─ (Signal) → RiskManager → OrderManager
                                 ├─ Broker (interface)
                                 │     ├─ PaperBroker
                                 │     └─ LiveBroker → TossApiClient
                                 ├─ PositionManager
                                 ├─ PerformanceAnalyzer
                                 └─ EventLogger
MarketDataWorker → (PRICE_TICK) → StrategyEngine
ReconciliationService (부팅 시) → LiveBroker / DB
```

### 4.1 Broker 인터페이스 (핵심 추상화)

> 변경 사유: 페이퍼→실거래 무수정 승격의 계약 지점. 명시적으로 인터페이스 고정.

```ts
interface Broker {
  placeOrder(req: OrderRequest): Promise<OrderResult>;   // idempotencyKey 포함
  cancelOrder(brokerOrderId: string): Promise<void>;
  getOpenOrders(): Promise<Order[]>;                      // reconciliation용
  getFills(orderId: string): Promise<Fill[]>;            // 부분체결 포함
}
```
- `PaperBroker`: 내부 DB에 가상 체결 기록. 토스 호출 없음.
- `LiveBroker`: `TossApiClient` 위임. 기본 비활성, 전략 승인 시에만 활성.

---

## 5. 핵심 모듈 설계

### 5.1 TossApiClient
토스 API 직접 통신 격리 계층.
- `getAccessToken()` — 토큰 발급 + **만료 전 자동 refresh**(아래 5.7).
- `getCurrentPrices(symbols)` / `getAccount()` / `getPositions()`
- `placeOrder(order)` / `getOrder(orderId)` / `cancelOrder(orderId)` / `getOpenOrders()`
- API 오류 처리 / rate limit 백오프 / 재시도.

### 5.2 MarketDataWorker
시세 상시 수집. cron 아님 — 서버 안에서 계속 사는 worker.

> 변경 사유: `marketOpen` 단일 플래그 → 시장별 캘린더. polling 지연 한계 명시.

```
loop:
  for market in active_markets:
    if calendar.isOpen(market, now):
      prices = tossApiClient.getCurrentPrices(symbols_of(market))
      publish PRICE_TICK(market, prices)
  sleep 1~5s
```
- 시장별(KRX/US) 장시간·휴장일 캘린더 적용.
- **지연 한계**: polling 1~5s → 손절/익절은 틱 단위 지연 발생, 인트라바 급변 누락 가능.
  저빈도 전략 전용. HFT 불가 — 문서·UI에 명시.
- WebSocket 제공·안정 시 이벤트 기반으로 교체(인터페이스 동일 유지).

### 5.3 StrategyEngine
PRICE_TICK 수신 → 전략별 판단 → Signal 생성 → RiskManager로 전달.
예시 전략: 이동평균 골든크로스, 배당주 저가 매수 등.

### 5.4 PaperBroker
가상 체결 기록.

> 변경 사유: 현재가 그대로 체결하면 과도하게 낙관적 → paper↔live 성과 갭. 체결 모델 현실화.

- 체결가 = 기준가 ± **slippage**(설정 bps) , 매수는 +, 매도는 −.
- 가능 시 호가 스프레드 반영(ask로 매수 / bid로 매도).
- **부분 체결** 모델(유동성 한도) 옵션.
- 수수료 + 세금(거래세·농특세 등) 반영.
- 전략별 평균단가·보유수량·실현손익 계산.

### 5.5 LiveBroker
토스 API 실제 주문. 기본 비활성, 승인 전략만.
실제 매수·매도 / 주문 결과 저장 / 체결 상태 확인 / 실패·미체결 관리.

### 5.6 RiskManager
신호 → 주문 전 리스크 검사.
- 전략 상태 LIVE 확인 / 전략별 최대 투자금 / 종목별 최대 비중 / 일일 최대 손실.
- 미체결 주문 존재 시 추가 주문 금지.
- 연속 손실 N회 시 자동 정지.
- 계좌 실제 잔고 vs 내부 포지션 정합 확인.

### 5.7 TokenManager (신설)
> 변경 사유: v1엔 토큰 수명 관리 부재. 평문 DB 저장 금지.
- 토스는 **refresh_token 없음** → 갱신 = `client_credentials`로 재발급.
- access token 보관은 OS keychain 또는 암호화 저장(평문 DB 금지). client_secret도 동일.
- `expires_in` 응답값 기준, 만료 N초 전 선제 재발급. 동시성 재발급 단일화(락).

### 5.8 ReconciliationService (신설)
> 변경 사유: 안전장치 #9를 실제 동작으로. 부팅 시 정합 안 맞추면 중복·유실.
- 부팅 시 `LiveBroker.getOpenOrders()` 조회 → DB orders와 `idempotency_key`/`broker_order_id`로 매칭.
- 누락 체결 보정, 고아 주문 정리, 진행 중 주문 상태 동기화 후 worker 재개.

### 5.9 PerformanceAnalyzer
> 변경 사유: MDD·낙폭은 시점 집계로 못 뽑음 → equity curve 필요.
- 입력: 일별 NAV 스냅샷(8.7 `equity_snapshots`) + 체결 기록.
- 지표: 총/연환산 수익률, **MDD(equity curve 기반)**, 승률, Profit Factor, 평균 손익비, 거래 횟수, 평균 보유기간, 일별 손익.

---

## 6. 전략 상태 관리

```ts
type StrategyStatus =
  | "DRAFT" | "BACKTESTING" | "PAPER_TESTING"
  | "APPROVED" | "LIVE" | "PAUSED" | "REJECTED";
```
흐름: `DRAFT → BACKTESTING → PAPER_TESTING → APPROVED → LIVE` (+ PAUSED/REJECTED 분기).

**실거래 전환 조건 예시** (변경 사유: 표본 빈약 → 거래 횟수 상향)
- 페이퍼 최소 30일 이상
- 거래 횟수 **50회 이상** (v1의 20회는 통계적으로 빈약)
- 총 수익률 5% 이상 / MDD −10% 이내 / 승률 50% 이상 / Profit Factor 1.3 이상
- 일일 최대 손실 규칙 위반 0회
- 승인은 자동 금지 — 대시보드에서 **사용자 수동 승인**.

---

## 7. DB 설계 (재설계)

> 핵심 변경: ① positions에서 휘발성 평가값 제거 ② equity_snapshots 신설(MDD용)
> ③ orders.idempotency_key UNIQUE ④ fills 분리(부분체결).

### 7.1 strategies
```sql
CREATE TABLE strategies (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(100) NOT NULL,
  status VARCHAR(30) NOT NULL,
  capital DECIMAL(18,4) NOT NULL,        -- 전략 배정 자본금
  max_position_pct DECIMAL(5,2),         -- 종목별 최대 비중(%)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 7.2 watch_symbols
```sql
CREATE TABLE watch_symbols (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  strategy_id BIGINT NOT NULL,
  symbol VARCHAR(30) NOT NULL,
  market VARCHAR(20) NOT NULL,           -- KRX / US 등, 캘린더 분기 키
  name VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 7.3 strategy_signals
```sql
CREATE TABLE strategy_signals (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  strategy_id BIGINT NOT NULL,
  symbol VARCHAR(30) NOT NULL,
  action VARCHAR(10) NOT NULL,           -- BUY / SELL
  price DECIMAL(18,4) NOT NULL,
  reason TEXT,
  confidence DECIMAL(5,2),
  mode VARCHAR(20) NOT NULL,             -- PAPER / LIVE
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 7.4 orders
> 변경: `idempotency_key` UNIQUE 제약 추가(중복주문 방지의 실효 조건).
```sql
CREATE TABLE orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  strategy_id BIGINT NOT NULL,
  symbol VARCHAR(30) NOT NULL,
  side VARCHAR(10) NOT NULL,             -- BUY / SELL
  order_type VARCHAR(20) NOT NULL,       -- LIMIT / MARKET
  quantity DECIMAL(18,6) NOT NULL,       -- KR 주식은 정수, 해외 소수점 대비 DECIMAL 유지
  price DECIMAL(18,4),
  status VARCHAR(30) NOT NULL,           -- NEW/SUBMITTED/PARTIAL/FILLED/CANCELED/REJECTED
  mode VARCHAR(20) NOT NULL,
  broker_order_id VARCHAR(100),
  idempotency_key VARCHAR(100) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_idem (idempotency_key)
);
```

### 7.5 fills (신설)
> 변경 사유: 부분 체결·평균단가 정확 계산 위해 주문과 체결 분리.
```sql
CREATE TABLE fills (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT NOT NULL,
  quantity DECIMAL(18,6) NOT NULL,
  price DECIMAL(18,4) NOT NULL,
  fee DECIMAL(18,4) DEFAULT 0,
  tax DECIMAL(18,4) DEFAULT 0,
  filled_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 7.6 positions
> 변경: `current_price`/`unrealized_pnl` 제거. 평가값은 조회 시 현재가로 계산(휘발성 값을
> source-of-truth 행에 덮어쓰지 않음 → stale·쓰기 churn 방지).
```sql
CREATE TABLE positions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  strategy_id BIGINT NOT NULL,
  symbol VARCHAR(30) NOT NULL,
  mode VARCHAR(20) NOT NULL,
  quantity DECIMAL(18,6) NOT NULL,
  avg_price DECIMAL(18,4) NOT NULL,
  realized_pnl DECIMAL(18,4) DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pos (strategy_id, symbol, mode)
);
-- 평가금액·미실현손익 = API current_price로 런타임 계산.
```

### 7.7 equity_snapshots (신설)
> 변경 사유: MDD·낙폭 계산은 equity curve 필요. 시점 집계 테이블만으론 불가.
```sql
CREATE TABLE equity_snapshots (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  strategy_id BIGINT NOT NULL,
  mode VARCHAR(20) NOT NULL,
  nav DECIMAL(18,4) NOT NULL,            -- 일별 평가자산(현금+포지션)
  cash DECIMAL(18,4) NOT NULL,
  snapshot_date DATE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_snap (strategy_id, mode, snapshot_date)
);
```

### 7.8 strategy_performance
시점 집계(캐시/표시용). 원천 계산은 `equity_snapshots` + `fills`.
```sql
CREATE TABLE strategy_performance (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  strategy_id BIGINT NOT NULL,
  mode VARCHAR(20) NOT NULL,
  total_return DECIMAL(10,4),
  max_drawdown DECIMAL(10,4),
  win_rate DECIMAL(10,4),
  profit_factor DECIMAL(10,4),
  trade_count INT DEFAULT 0,
  measured_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 7.9 event_logs
```sql
CREATE TABLE event_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  strategy_id BIGINT,
  symbol VARCHAR(30),
  message TEXT,
  payload JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 8. API 설계

### 8.1 전략
```
GET/POST /api/strategies   GET/PATCH /api/strategies/:id
PATCH /api/strategies/:id/status
POST /api/strategies/:id/start-paper | /stop-paper | /approve-live | /start-live | /stop-live
```
### 8.2 시세
```
GET /api/market/price/:symbol
GET /api/market/prices?symbols=AAPL,MSFT
GET/POST /api/market/watch-symbols   DELETE /api/market/watch-symbols/:id
```
### 8.3 주문
```
GET /api/orders   GET /api/orders/:id
POST /api/orders/paper   POST /api/orders/live   POST /api/orders/:id/cancel
```
### 8.4 포지션
```
GET /api/positions   GET /api/positions/:strategyId
GET /api/account/positions   GET /api/account/balance
```
### 8.5 성과
```
GET /api/performance/:strategyId   GET /api/performance/:strategyId/daily
```

---

## 9. 화면 구성
- **전략 목록**: 전략명/상태/모드/대상종목/총수익률/MDD/승률/거래횟수/LIVE 가능 여부.
- **전략 상세**: 설명/대상종목/상태/최근 신호·주문/현재 포지션/성과 차트/전환조건 충족 여부.
- **페이퍼 트레이딩**: 가상 보유·평균단가·수익률·주문내역·실현/평가 손익.
- **실거래 모니터링**: 실제 보유·주문·미체결·당일손익·전략별 실거래 성과/**긴급 정지 버튼**.
- **로그**: 시세/전략실행/신호/주문요청/주문실패/리스크 차단/API 오류.

---

## 10. 개발 일정

| 단계 | 내용 | 산출물 |
|---|---|---|
| **0** | API 스펙 검증 | `docs/toss-api-spec.md` |
| 1 | 토스 API 연결: 인증·현재가·계좌 | TossApiClient, TokenManager |
| 2 | MarketDataWorker + StrategyEngine + PaperBroker | 페이퍼 매매 동작 |
| 3 | 성과 계산: equity_snapshots, PerformanceAnalyzer | MDD/승률/PF 대시보드 |
| 4 | RiskManager + 상태머신 + 승인 플로우 | PAPER→APPROVED |
| 5 | LiveBroker + ReconciliationService + 안전장치 | 실거래(샌드박스 우선) |
| 6 | 운영: EventLogger, 자동 중지, 감사 로그, 긴급 정지 | 운영 체크리스트 |

---

## 11. 실거래 안전장치
1. PAPER/LIVE 완전 분리  2. LIVE 전환 수동 승인  3. 전략별 최대 투자금 제한
4. 종목별 최대 비중 제한  5. 일일 최대 손실 제한  6. 연속 손실 자동 정지
7. 미체결 존재 시 추가 주문 금지  8. API 오류 시 실거래 중단
9. 서버 재시작 시 미체결 재조회(ReconciliationService)  10. 긴급 전체 정지 버튼

---

## 12. cron 사용 기준
- **금지**: 실시간 매수/매도 판단, 손절·익절 실행, 체결 추적, 중복 주문 방지 → 상시 worker.
- **허용**: 장 시작 전 초기화, 장 마감 후 성과 계산(equity 스냅샷 기록), 일별 리포트.

---

## 13. 최종 목표
토스 API 기반 시세 조회 / 전략별 페이퍼 트레이딩 / 성과 검증 / 검증 전략의 실거래 전환 /
자동 주문 실행 / 주문·체결·미체결 관리 / 포지션·수익률 모니터링 / 전략별 리스크 관리 / 긴급 정지.

단순 자동매매가 아니라 **전략을 쌓고 검증한 뒤 안전하게 실거래로 넘기는 전략 운영 플랫폼.**
핵심 격리: 토스 API 호출은 `TossApiClient` 하나, 그 위 `Broker` 인터페이스로 `PaperBroker`/`LiveBroker` 분리.
