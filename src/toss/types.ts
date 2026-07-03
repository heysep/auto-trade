// Types mirrored from docs/toss-api-spec.md. ⚠️ fields marked TODO are
// unconfirmed until the live probe / openapi.json is reconciled.

export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET';
export type TimeInForce = 'DAY' | 'CLS';

// Order status enum (confirmed from OpenAPI). OPEN/CLOSED is the query grouping.
export type OrderStatus =
  | 'PENDING' | 'PARTIAL_FILLED' | 'PENDING_CANCEL' | 'PENDING_REPLACE'   // OPEN
  | 'FILLED' | 'CANCELED' | 'REJECTED' | 'REPLACED'                       // CLOSED
  | 'CANCEL_REJECTED' | 'REPLACE_REJECTED';                               // CLOSED

export const OPEN_STATUSES: OrderStatus[] = [
  'PENDING', 'PARTIAL_FILLED', 'PENDING_CANCEL', 'PENDING_REPLACE',
];

// POST /api/v1/orders body. Numeric values are strings in the Toss API.
// quantity (KR + US) XOR orderAmount (US MARKET only).
export interface OrderCreateRequest {
  clientOrderId?: string;   // -> maps to our orders.idempotency_key
  symbol: string;           // KR 6-digit / US ticker
  side: OrderSide;
  orderType: OrderType;
  quantity?: string;
  orderAmount?: string;     // US MARKET only
  price?: string;           // required for LIMIT
  timeInForce?: TimeInForce;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;   // 'Bearer'
  expires_in: number;   // seconds — use this, do not hardcode
  // no refresh_token: re-issue via client_credentials
}

export interface PriceQuote {
  symbol: string;
  price: number;
  // TODO: confirm field names from live probe (changeRate, prevClose, …)
  raw: unknown;
}

// GET /api/v1/prices unwraps to a bare array (the `{result}` envelope is stripped).
export interface TossPriceItem {
  symbol: string;
  lastPrice: string;
  currency?: string;
  timestamp?: string;
}

// --- Order responses (confirmed via openapi.json; all numbers are strings) ---

export interface TossOrderCreateResponse {
  orderId: string;
  clientOrderId?: string;        // echoes our idempotency key; NOT present in the list endpoint
}

export interface TossExecution {
  filledQuantity?: string;
  averageFilledPrice?: string;
  filledAmount?: string;
  commission?: string;
  tax?: string;
  filledAt?: string;            // ISO 8601
  settlementDate?: string;
}

export interface TossOrder {
  orderId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  timeInForce?: TimeInForce;
  status: OrderStatus;
  price?: string;
  quantity?: string;
  orderAmount?: string;
  currency?: string;
  orderedAt?: string;
  canceledAt?: string | null;
  execution?: TossExecution;
}

export interface TossOrdersList {
  orders: TossOrder[];
  nextCursor?: string | null;
  hasNext?: boolean;
}

// --- Symbol catalog (GET /api/v1/stocks) ---
// Confirmed via openapi.json 2026-07. `symbols` query param REQUIRED (comma-separated).

export interface TossStock {
  symbol: string;
  name: string;
  market: string;
  englishName?: string;
  currency?: string;
  /** Total shares outstanding (number of issued shares). Parsed from the API string field. */
  sharesOutstanding?: number;
  /** KRX sector classification (Korean label, e.g. '반도체', '자동차'). */
  sector?: string;
}

// --- Candle chart (GET /api/v1/candles) ---
// Confirmed via openapi.json 2026-07. interval enum: '1m' | '1d'. Numbers are strings.

export interface TossCandle {
  timestamp: string;    // ISO 8601, e.g. "2026-03-25T09:00:00+09:00"
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume?: string;
}

// Paged response wrapper from GET /api/v1/candles (our request() unwraps {result} envelope).
export interface TossCandlePage {
  candles: TossCandle[];
  nextBefore?: string | null;
}

// Normalised, UI-facing candle. time = epoch SECONDS (for lightweight-charts).
export interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// --- Account and Holdings (GET /api/v1/accounts, GET /api/v1/holdings) ---
// All numeric fields are strings in the Toss API (confirmed via live probe 2026-06-30).

export interface TossAccount {
  accountSeq: number;
}

/** KRW/USD pair used in holdings summary fields. Both values are strings. */
export interface TossHoldingsMoney {
  krw: string;
  usd: string;
}

/** Individual holding item returned inside holdings.items[]. */
export interface TossHoldingsItem {
  symbol: string;
  name: string;
  marketCountry: string;
  currency: string;
  quantity: string;
  lastPrice: string;
  averagePurchasePrice: string;
  marketValue: string;
  profitLoss: string;
  cost: string;
}

/** Unwrapped response from GET /api/v1/holdings (result envelope stripped by unwrap()). */
export interface TossHoldings {
  totalPurchaseAmount: TossHoldingsMoney;
  marketValue: TossHoldingsMoney;
  profitLoss: TossHoldingsMoney;
  dailyProfitLoss: TossHoldingsMoney;
  items: TossHoldingsItem[];
}

// --- Market calendar (regular/pre/after sessions are startTime/endTime ISO pairs) ---

export interface TossSession { startTime: string; endTime: string; }

export interface TossMarketCalendar {
  today: {
    date: string;
    integrated: {
      preMarket?: TossSession | null;
      regularMarket?: TossSession | null;
      afterMarket?: TossSession | null;
    };
  };
}
