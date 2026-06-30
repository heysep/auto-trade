-- PLAN §7 schema, PostgreSQL dialect.
-- BIGSERIAL (vs MySQL AUTO_INCREMENT), TIMESTAMPTZ (vs DATETIME), JSONB (vs JSON).
-- Money/qty as NUMERIC for exact decimal (no float). KR qty integral, US fractional.

BEGIN;

CREATE TABLE strategies (
  id               BIGSERIAL PRIMARY KEY,
  name             VARCHAR(100) NOT NULL,
  code             VARCHAR(100) NOT NULL,
  status           VARCHAR(30)  NOT NULL,            -- DRAFT/BACKTESTING/PAPER_TESTING/APPROVED/LIVE/PAUSED/REJECTED
  capital          NUMERIC(18,4) NOT NULL,
  max_position_pct NUMERIC(5,2),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE watch_symbols (
  id          BIGSERIAL PRIMARY KEY,
  strategy_id BIGINT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  symbol      VARCHAR(30) NOT NULL,
  market      VARCHAR(20) NOT NULL,                  -- KR / US (calendar key)
  name        VARCHAR(100),
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_watch_strategy ON watch_symbols(strategy_id) WHERE is_active;

CREATE TABLE strategy_signals (
  id          BIGSERIAL PRIMARY KEY,
  strategy_id BIGINT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  symbol      VARCHAR(30) NOT NULL,
  action      VARCHAR(10) NOT NULL,                  -- BUY / SELL
  price       NUMERIC(18,4) NOT NULL,
  reason      TEXT,
  confidence  NUMERIC(5,2),
  mode        VARCHAR(20) NOT NULL,                  -- PAPER / LIVE
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_signals_strategy ON strategy_signals(strategy_id, created_at DESC);

CREATE TABLE orders (
  id              BIGSERIAL PRIMARY KEY,
  strategy_id     BIGINT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  symbol          VARCHAR(30) NOT NULL,
  currency        VARCHAR(3) NOT NULL,              -- KRW / USD; tax treatment depends on it
  side            VARCHAR(10) NOT NULL,              -- BUY / SELL
  order_type      VARCHAR(20) NOT NULL,             -- LIMIT / MARKET
  quantity        NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  price           NUMERIC(18,4),                    -- limit price; null for market
  status          VARCHAR(30) NOT NULL,             -- Toss enum (PENDING/PARTIAL_FILLED/FILLED/...)
  mode            VARCHAR(20) NOT NULL,             -- PAPER / LIVE
  broker_order_id VARCHAR(100),
  idempotency_key VARCHAR(100) NOT NULL,            -- == Toss clientOrderId
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_orders_idem UNIQUE (idempotency_key)
);
CREATE INDEX idx_orders_strategy ON orders(strategy_id, created_at DESC);
CREATE INDEX idx_orders_open ON orders(status) WHERE status IN ('PENDING','PARTIAL_FILLED');

-- Fills split from orders (partial fills, exact avg-price math).
CREATE TABLE fills (
  id        BIGSERIAL PRIMARY KEY,
  order_id  BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  quantity  NUMERIC(18,6) NOT NULL,
  price     NUMERIC(18,4) NOT NULL,
  fee       NUMERIC(18,4) NOT NULL DEFAULT 0,
  tax       NUMERIC(18,4) NOT NULL DEFAULT 0,
  filled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fills_order ON fills(order_id);

-- Position is source of truth: NO volatile mark-to-market columns here.
-- current_price / unrealized_pnl are computed at read time from live quotes.
CREATE TABLE positions (
  id           BIGSERIAL PRIMARY KEY,
  strategy_id  BIGINT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  symbol       VARCHAR(30) NOT NULL,
  currency     VARCHAR(3) NOT NULL,                 -- avoid re-deriving tax currency from market
  mode         VARCHAR(20) NOT NULL,
  quantity     NUMERIC(18,6) NOT NULL CHECK (quantity >= 0),   -- no shorting (defense-in-depth)
  avg_price    NUMERIC(18,4) NOT NULL CHECK (avg_price >= 0),  -- average-cost basis (incl. buy fees)
  realized_pnl NUMERIC(18,4) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_positions UNIQUE (strategy_id, symbol, mode)
);

-- Daily NAV snapshots -> equity curve for MDD/drawdown (point-in-time aggregates can't yield MDD).
CREATE TABLE equity_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  strategy_id   BIGINT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  mode          VARCHAR(20) NOT NULL,
  nav           NUMERIC(18,4) NOT NULL,             -- cash + position market value
  cash          NUMERIC(18,4) NOT NULL,
  snapshot_date DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_equity UNIQUE (strategy_id, mode, snapshot_date)
);

-- Cached/display aggregates; source of computation is equity_snapshots + fills.
CREATE TABLE strategy_performance (
  id            BIGSERIAL PRIMARY KEY,
  strategy_id   BIGINT NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  mode          VARCHAR(20) NOT NULL,
  total_return  NUMERIC(10,4),
  max_drawdown  NUMERIC(10,4),
  win_rate      NUMERIC(10,4),
  profit_factor NUMERIC(10,4),
  trade_count   INT NOT NULL DEFAULT 0,
  measured_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_logs (
  id          BIGSERIAL PRIMARY KEY,
  event_type  VARCHAR(50) NOT NULL,
  strategy_id BIGINT,
  symbol      VARCHAR(30),
  message     TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_type_time ON event_logs(event_type, created_at DESC);

COMMIT;
