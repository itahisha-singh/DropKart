-- DropKart schema (Phase 1). Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL,
  price_minor   BIGINT      NOT NULL CHECK (price_minor >= 0),   -- money as integer minor units (paise/cents)
  currency      CHAR(3)     NOT NULL,
  stock         INTEGER     NOT NULL CHECK (stock >= 0),         -- DB-level guard: stock can never go negative
  max_per_order INTEGER     NOT NULL DEFAULT 2 CHECK (max_per_order > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID        NOT NULL REFERENCES products(id),
  user_id         TEXT        NOT NULL,
  quantity        INTEGER     NOT NULL CHECK (quantity > 0),
  amount_minor    BIGINT      NOT NULL CHECK (amount_minor >= 0),
  currency        CHAR(3)     NOT NULL,
  status          TEXT        NOT NULL CHECK (status IN ('RESERVED', 'PAID', 'EXPIRED', 'CANCELLED')),
  hold_expires_at TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live (reserved or paid) order per user per product: stops hoarding by a single account.
DROP INDEX IF EXISTS orders_one_live_per_user;
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_live_per_user
  ON orders (product_id, user_id) WHERE status IN ('RESERVED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAID');

-- Makes the expiry sweeper cheap: it only looks at reserved orders, ordered by deadline.
DROP INDEX IF EXISTS orders_hold_expiry_idx;
CREATE INDEX IF NOT EXISTS orders_hold_expiry_idx
  ON orders (hold_expires_at) WHERE status IN ('RESERVED', 'PAYMENT_PENDING', 'PAYMENT_FAILED');

-- Append-only audit trail of every state change.
CREATE TABLE IF NOT EXISTS order_events (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID        NOT NULL REFERENCES orders(id),
  from_status TEXT,
  to_status   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: the same (scope, key) can only ever produce one stored response.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope           TEXT        NOT NULL,
  key             TEXT        NOT NULL,
  request_hash    TEXT        NOT NULL,
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

-- Phase 2: payment attempts, signed webhook deduplication, and double-entry ledger.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('RESERVED', 'PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'));

CREATE TABLE IF NOT EXISTS payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  provider_payment_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REFUNDED')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
  currency CHAR(3) NOT NULL,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_attempts_order_idx ON payment_attempts(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS provider_webhook_events (
  provider_event_id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  journal_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES orders(id),
  payment_attempt_id UUID REFERENCES payment_attempts(id),
  account TEXT NOT NULL,
  currency CHAR(3) NOT NULL,
  debit_minor BIGINT NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor BIGINT NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0))
);
CREATE INDEX IF NOT EXISTS ledger_entries_order_idx ON ledger_entries(order_id);
CREATE INDEX IF NOT EXISTS ledger_entries_journal_idx ON ledger_entries(journal_id);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  mismatch_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reconciliation_discrepancies (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES reconciliation_runs(id),
  order_id UUID REFERENCES orders(id),
  discrepancy_type TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
