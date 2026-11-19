/**
 * PostgreSQL schema (Postgres 13+). Idempotent: safe to run on every start.
 *
 * Entities are stored as JSONB documents alongside the columns we filter, join or
 * enforce uniqueness on. The `version` column implements optimistic concurrency.
 * Money is BIGINT FCFA. The ledger is append-only double entry (lines of a journal sum to 0).
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  telegram_id  BIGINT NOT NULL UNIQUE,
  kyc_status   TEXT NOT NULL,
  version      INTEGER NOT NULL,
  data         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_kyc ON users (kyc_status);

CREATE TABLE IF NOT EXISTS riders (
  id           TEXT PRIMARY KEY,
  telegram_id  BIGINT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL,
  on_duty      BOOLEAN NOT NULL,
  version      INTEGER NOT NULL,
  data         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_riders_dispatch ON riders (status, on_duty);
ALTER TABLE riders ADD COLUMN IF NOT EXISTS rider_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_riders_code ON riders (rider_code);

CREATE TABLE IF NOT EXISTS orders (
  id                   TEXT PRIMARY KEY,
  tracking_code        TEXT NOT NULL UNIQUE,
  status               TEXT NOT NULL,
  merchant_id          TEXT NOT NULL REFERENCES users(id),
  first_mile_rider_id  TEXT,
  last_mile_rider_id   TEXT,
  payment_reference    TEXT UNIQUE,
  expires_at           TIMESTAMPTZ,
  has_open_payouts     BOOLEAN NOT NULL DEFAULT FALSE,
  version              INTEGER NOT NULL,
  data                 JSONB NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_first_rider ON orders (first_mile_rider_id);
CREATE INDEX IF NOT EXISTS idx_orders_last_rider ON orders (last_mile_rider_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_open_payouts ON orders (has_open_payouts) WHERE has_open_payouts;

CREATE TABLE IF NOT EXISTS journals (
  key          TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_lines (
  id           BIGSERIAL PRIMARY KEY,
  journal_key  TEXT NOT NULL REFERENCES journals(key),
  account      TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  amount       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_lines (account, ref_id);
CREATE INDEX IF NOT EXISTS idx_ledger_ref ON ledger_lines (ref_id);

CREATE TABLE IF NOT EXISTS processed_events (
  key           TEXT PRIMARY KEY,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS float_topups (
  id         TEXT PRIMARY KEY,
  rider_id   TEXT NOT NULL REFERENCES riders(id),
  reference  TEXT UNIQUE,
  status     TEXT NOT NULL,
  data       JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  mime        TEXT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);
`;
