-- Kendibo core schemas: identity, booking, payment, ledger, dispatch, provider, geo, messaging, audit, configuration.
-- Conventions: UUID PKs, timestamptz, UTC storage, kobo BIGINT CHECK>0, currency CHECK='NGN'.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS booking;
CREATE SCHEMA IF NOT EXISTS payment;
CREATE SCHEMA IF NOT EXISTS ledger;
CREATE SCHEMA IF NOT EXISTS dispatch;
CREATE SCHEMA IF NOT EXISTS geo;

CREATE TABLE IF NOT EXISTS identity.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT UNIQUE, email TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS identity.refresh_token (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  device_id TEXT NOT NULL, token_hash TEXT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS booking.booking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL, service_id TEXT NOT NULL, address_id UUID,
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  price_kobo BIGINT NOT NULL CHECK (price_kobo > 0),
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  price_snapshot JSONB NOT NULL, scheduled_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS booking.job_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL,
  actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment.payment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL, psp TEXT NOT NULL CHECK (psp IN ('bachs','flutterwave')),
  reference TEXT NOT NULL UNIQUE, charge_id TEXT,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment.webhook_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  psp TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
  raw JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ledger.account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger.journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE, period TEXT NOT NULL,
  reverses TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ledger.entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id UUID NOT NULL REFERENCES ledger.journal(id),
  account_code TEXT NOT NULL, debit_kobo BIGINT NOT NULL DEFAULT 0, credit_kobo BIGINT NOT NULL DEFAULT 0,
  CHECK (debit_kobo >= 0 AND credit_kobo >= 0),
  CHECK ((debit_kobo > 0 AND credit_kobo = 0) OR (credit_kobo > 0 AND debit_kobo = 0))
);
CREATE TABLE IF NOT EXISTS dispatch.assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL, provider_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'offered', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, provider_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_accepted_per_job ON dispatch.assignment (job_id) WHERE status = 'accepted';
CREATE TABLE IF NOT EXISTS geo.provider_location (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS outbox_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
