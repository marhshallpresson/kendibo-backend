-- 005_ops.sql — OTP codes (survive restart), media registry, journey status,
-- wallet transactions, failed-job records.
CREATE SCHEMA IF NOT EXISTS media;

CREATE TABLE IF NOT EXISTS identity.otp_code (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL, identity TEXT NOT NULL,
  code TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_lookup ON identity.otp_code (channel, identity);

CREATE TABLE IF NOT EXISTS media.asset (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'quarantined', url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS geo.journey_status (
  job_id TEXT PRIMARY KEY, is_active BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS payment.wallet_txn (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL, kind TEXT NOT NULL,
  amount_kobo BIGINT NOT NULL, ref TEXT NOT NULL UNIQUE,
  booking_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking.failed_job (
  job_id TEXT PRIMARY KEY, code TEXT NOT NULL,
  actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE provider.provider
  ADD COLUMN IF NOT EXISTS bank_code TEXT,
  ADD COLUMN IF NOT EXISTS account_number TEXT,
  ADD COLUMN IF NOT EXISTS account_name TEXT,
  ADD COLUMN IF NOT EXISTS settlement_account_id TEXT;

ALTER TABLE identity.users
  ADD COLUMN IF NOT EXISTS virtual_account_id TEXT,
  ADD COLUMN IF NOT EXISTS virtual_account_name TEXT,
  ADD COLUMN IF NOT EXISTS virtual_bank_name TEXT;
