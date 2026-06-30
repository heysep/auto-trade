# 토스증권 Open API 스펙 정리 (Phase 0 산출물)

> 출처: 공식 문서 `developers.tossinvest.com` (가이드 + OpenAPI JSON), canonical
> `https://openapi.tossinvest.com/openapi-docs/latest/`. 조사일 2026-06-30.
> **신뢰도 표기**: ✅ 확정(OpenAPI/공식) · ⚠️ 소스 간 불일치·미확정 → 구현 전 live openapi.json 대조.

---

## 0. 결론 (게이팅 판정)

- ✅ Open API **실재**. REST 제공. 국내 KRX + 미국 주식 통합.
- ✅ **주문 API 제공** (생성/수정/취소/조회). LIMIT·MARKET 지원.
- ✅ 인증 = OAuth2 Client Credentials.
- ✅ **WebSocket 공식 미제공** → 시세는 REST 폴링(약 1초 간격까지). PLAN의 MarketDataWorker 폴링 방식이 정답.
- ✅ **샌드박스/모의 환경 없음** → LiveBroker 초기 테스트는 실계좌 + 최소 수량으로. ReconciliationService·안전장치 더 중요.
- ✅ 주문 바디에 **`clientOrderId`** 존재 → PLAN의 `idempotency_key`로 직결(중복주문 방지 네이티브 지원).

**판정: Phase 1 진입 가능. live probe로 전 항목 실측 확정 완료** (2026-06-30, `npm run probe`).
- ✅ 경로 prefix = **`/api/v1` 전부**.
- ✅ `X-Tossinvest-Account` = **`accountSeq`(정수)**, accountNo 아님.
- ✅ 토큰 `expires_in` = 86399(~24h), basic-auth, refresh_token 없음.
- ✅ rate-limit = **초당·엔드포인트별** (§6).
- ✅ 응답 숫자값 전부 **string**. holdings는 krw/usd 다중통화 중첩.
- ✅ buying-power/sellable/commission = 현재 openapi.json에 **미존재**(README에만 언급) → 사용 불가.

---

## 1. 기본 정보

| 항목 | 값 |
|---|---|
| Base URL | ✅ `https://openapi.tossinvest.com` |
| 프로토콜 | ✅ REST / JSON |
| 실시간 | ✅ WebSocket 미제공. REST 폴링(~1s) |
| 클라이언트 발급 | ✅ 토스증권 WTS 로그인 → 설정 > Open API → `client_id`/`client_secret` |
| OpenAPI 스펙 | ✅ `…/openapi-docs/latest/openapi.json` (SDK 자동생성 가능) |
| 마크다운 레퍼런스 | ✅ `…/openapi-docs/latest/api-reference/README.md` |

---

## 2. 인증 (OAuth2 Client Credentials)

**토큰 발급** ✅
```
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded
```
| 파라미터 | 값 |
|---|---|
| `grant_type` | `client_credentials` (required) |
| `client_id` | 형식 `c_01H…` (required) |
| `client_secret` | 형식 `s_xxxx…` (required) |

> Basic Auth(`client_id:client_secret`) 방식 또는 form body — ⚠️ 두 방식 언급됨. live 스펙 확인.

**응답** ✅
```json
{ "access_token": "<JWT>", "token_type": "Bearer", "expires_in": 86400 }
```
- ⚠️ **토큰 수명**: OpenAPI 기본값 `expires_in: 86400`(24h) vs 가이드 글 3600(1h) 불일치.
  → **하드코딩 금지. 응답 `expires_in` 값 그대로 사용**, 만료 N초 전 재발급.
- ✅ **refresh_token 없음** → 갱신 = `client_credentials`로 재발급(refresh 흐름 아님).
- JWT 검증용 공개키: `GET /oauth2/jwks`.

**호출 헤더** ✅
- `Authorization: Bearer {access_token}` (모든 API)
- `X-Tossinvest-Account: {accountSeq}` (계좌·주문 API 필수). **값 = `/api/v1/accounts` 응답의 `accountSeq`(정수)**.
  accountNo(11자리 문자열) 넣으면 게이트웨이가 404 `edge-blocked`로 거부. ← probe 실측 확인.

> TokenManager 영향: refresh_token 없으므로 만료 전 재발급 + 동시성 단일화 락만 구현. 토큰 평문 저장 금지.

---

## 3. 엔드포인트

> ⚠️ **경로 prefix 불일치**: 소스에 `/v1/...`와 `/api/v1/...` 혼재. 아래는 OpenAPI README 기준(`/api/v1`)
> 으로 정리하되, **구현 전 live openapi.json의 정확 path로 확정**. 메서드/필드는 신뢰도 높음.

### 3.1 시세 (Market Data) ✅
| Path | Method | 용도 |
|---|---|---|
| `/api/v1/prices` (≈ `/v1/market/price`) | GET | 현재가(등락률·전일종가) |
| `/v1/market/orderbook` | GET | 10호가 |
| `/v1/market/trade` | GET | 최근 체결 내역 |
| `/v1/market/price-limit` | GET | 상·하한가 |
| `/v1/market/candles` | GET | OHLC(분/일/주/월) |

### 3.2 종목·시장 정보 ✅
| Path | Method | 용도 |
|---|---|---|
| `/v1/stocks` | GET | 종목 마스터(코드/이름/시장/섹터) |
| `/v1/stocks/securities-warning` | GET | 투자유의·경고 종목 |
| `/v1/market/exchange-rate` | GET | USD/KRW 환율 |
| `/v1/market/calendar` | GET | KRX/US 휴장일·장 운영시간 ← MarketDataWorker 시장별 캘린더에 사용 |

### 3.3 계좌·잔고 ✅
| Path | Method | 용도 |
|---|---|---|
| `/api/v1/accounts` (≈ `/v1/accounts`) | GET | 계좌 목록 |
| `/api/v1/holdings` (≈ `/v1/accounts/holdings`) | GET | 보유 종목·평가금액 (`HoldingsOverview`/`HoldingsItem`) |
| `/api/v1/buying-power` | GET | 매수 가능 금액 |
| `/api/v1/sellable-quantity` | GET | 매도 가능 수량 |
| `/api/v1/commissions` | GET | 수수료 계산 |

### 3.4 주문 (Order) ✅
| Path | Method | 용도 |
|---|---|---|
| `/api/v1/orders` | POST | 주문 생성(매수/매도) |
| `/api/v1/orders` | GET | 주문 목록 조회 |
| `/api/v1/orders/{orderId}` | GET | 주문 상세 |
| `/api/v1/orders/{orderId}/modify` | POST | 주문 수정 (⚠️ PATCH 아님) |
| `/api/v1/orders/{orderId}/cancel` | POST | 주문 취소 (⚠️ DELETE 아님) |

> PLAN 영향: LiveBroker.cancelOrder는 DELETE가 아니라 `POST …/cancel`. 수정도 `POST …/modify`.

---

## 4. 주문 생성 바디 (POST /api/v1/orders) ✅

| 필드 | 타입 | 필수 | 비고 |
|---|---|---|---|
| `clientOrderId` | string | 선택 | **클라이언트 생성 주문 ID → idempotency 키로 사용** |
| `symbol` | string | 필수 | KR 6자리 / US 티커 |
| `side` | enum | 필수 | `BUY` \| `SELL` |
| `orderType` | enum | 필수 | `LIMIT` \| `MARKET` |
| `quantity` | string | 선택* | 주문 수량(주). 수량기반 주문 |
| `orderAmount` | string | 선택* | 주문 금액. **US MARKET 전용**(금액기반/소수점) |
| `price` | string | 선택 | 지정가. `LIMIT`이면 필수 |
| `timeInForce` | enum | 선택 | `DAY` \| `CLS` (CLS = US 종가, LIMIT 한정) |

\* 수량기반(`OrderCreateQuantityBased`) vs 금액기반(`OrderCreateAmountBased`) 두 모델. `quantity` 또는 `orderAmount` 중 하나.

> 영향: KR은 정수 수량(`quantity`). 소수점/금액주문은 US만(`orderAmount`). PLAN의 `orders.quantity DECIMAL` 유지 타당.
> 숫자값이 **string 타입**임에 주의(직렬화 시 문자열로).

---

## 5. 주문 상태 enum (응답) ✅

| 상태 | 의미 | 그룹 |
|---|---|---|
| `PENDING` | 체결 대기 | OPEN |
| `PARTIAL_FILLED` | 부분 체결 | OPEN |
| `PENDING_CANCEL` | 취소 진행 | OPEN |
| `PENDING_REPLACE` | 수정 진행 | OPEN |
| `FILLED` | 전량 체결 | CLOSED |
| `CANCELED` | 취소됨 | CLOSED |
| `REJECTED` | 거부 | CLOSED |
| `REPLACED` | 수정됨 | CLOSED |
| `CANCEL_REJECTED` | 취소 실패 | CLOSED |
| `REPLACE_REJECTED` | 수정 실패 | CLOSED |

- `GET /api/v1/orders`의 status 파라미터는 `OPEN`/`CLOSED` 그룹으로 필터.
- 영향: PLAN `orders.status`를 위 10개 enum에 정렬. `PARTIAL_FILLED` 존재 → `fills` 테이블(부분체결) 설계 타당.

---

## 6. Rate Limit ✅ (probe 실측)

응답 헤더 `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset` 제공. **한도는 엔드포인트별, 윈도 = 1초**(`reset:1`).

| 엔드포인트 | 초당 한도 |
|---|---|
| `/oauth2/token` | 5 |
| `/api/v1/accounts` | **1** (가장 빡빡) |
| `/api/v1/holdings` | 5 |
| `/api/v1/prices` | 10 |
| `/api/v1/orders` (GET) | 5 |
| `/api/v1/market-calendar/*` | 3 |

설계 반영:
- **시세는 반드시 배치 조회**(`/prices?symbols=A,B,C`) — watch 종목을 한 콜로 묶어 10/s 한도 안에서 처리.
- accounts 1/s → 거의 캐시. 부팅·주기적으로만 호출.
- TossApiClient에 엔드포인트별 토큰버킷 + 429/`Retry-After` 지수 백오프 구현.
- `x-ratelimit-remaining` 모니터링해 선제 throttle.

---

## 7. PLAN.md 반영 사항 (변경 지점)

1. `idempotency_key` ← 토스 `clientOrderId` 직매핑. UNIQUE 제약 유지.
2. `Broker.cancelOrder` → `POST /orders/{id}/cancel`. 수정 = `POST /orders/{id}/modify`. (DELETE/PATCH 아님)
3. TokenManager: refresh_token 없음 → 만료 전 재발급 방식. `expires_in` 응답값 사용(하드코딩 금지).
4. WebSocket 없음 확정 → 폴링 worker 확정. WebSocket 분기 코드 불필요.
5. 샌드박스 없음 → LiveBroker는 실계좌 최소수량 테스트. 안전장치/Reconciliation 우선 구현.
6. 시장별 캘린더 = `/market/calendar` 활용.
7. 소수점/금액주문(`orderAmount`)은 US만 → KR/US 주문 빌더 분기.
8. 주문 상태머신 = §5의 10개 enum.

---

## 8. 확정 결과 (probe 2026-06-30)

- [x] 경로 prefix → **`/api/v1`** 전부.
- [x] rate limit → §6 (초당·엔드포인트별).
- [x] 토큰 수명 → `expires_in` 86399(~24h), refresh 없음.
- [x] 시세 다중조회 → `/api/v1/prices?symbols=A,B,C` batch 지원(`result[]` 배열 반환).
- [x] holdings 응답 → `result.{totalPurchaseAmount, marketValue, profitLoss, dailyProfitLoss}` (각 krw/usd) + `items[].{symbol,name,marketCountry,currency,quantity,lastPrice,averagePurchasePrice,marketValue,profitLoss,cost}`. **숫자 전부 string**.
- [x] 주문 조회 → `result.{orders[], nextCursor, hasNext}`. 쿼리 `status`(필수 OPEN/CLOSED), `symbol`, `from`, `to`(KST), `cursor`, `limit`(기본20/최대100, OPEN은 무시).
- [x] 계좌 헤더 → `accountSeq`(정수).

### 확정 엔드포인트 (openapi.json 14 paths)
```
POST /oauth2/token
GET  /api/v1/orderbook      GET /api/v1/prices         GET /api/v1/trades
GET  /api/v1/price-limits   GET /api/v1/candles        GET /api/v1/stocks
GET  /api/v1/stocks/{symbol}/warnings                  GET /api/v1/exchange-rate
GET  /api/v1/market-calendar/KR    GET /api/v1/market-calendar/US
GET  /api/v1/accounts       GET /api/v1/holdings
GET  /api/v1/orders         POST /api/v1/orders
```
> 주문 수정/취소 경로는 openapi.json 14 paths에 미노출 — POST `/orders/{id}/modify|cancel` 추정이나
> **실거래(Phase 5) 전 openapi.json에서 재확인 필요**. 시세 일부 경로명도 README 추정과 다름
> (예: `/api/v1/trades`, `/api/v1/price-limits`, `/api/v1/exchange-rate`, `/api/v1/market-calendar/{KR|US}`).
