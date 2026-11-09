-- 043: invoices / receipts to clients, and the schedule-update send log.
-- Receipt when a payment succeeds (money held until the job is confirmed);
-- final invoice at settlement. Numbers are sequential per year
-- (KND-2026-000123) and there is at most one invoice of each kind per booking.
CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE IF NOT EXISTS billing.invoice_counter (
  year INT PRIMARY KEY,
  last_no INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS billing.invoice (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT NOT NULL UNIQUE,
  booking_id UUID NOT NULL,
  user_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('receipt', 'final')),
  amount_kobo BIGINT NOT NULL DEFAULT 0,
  payment_reference TEXT,
  data JSONB NOT NULL DEFAULT '{}',
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  wa_sent_at TIMESTAMPTZ,
  email_sent_at TIMESTAMPTZ,
  UNIQUE (booking_id, kind)
);
CREATE INDEX IF NOT EXISTS invoice_user_idx ON billing.invoice (user_id, issued_at);

-- One row per (booking, update kind) we have sent: pro assigned, day-before
-- summary, provider evening reminder, reschedule notices. Makes every update
-- idempotent across sweeps and retries.
CREATE TABLE IF NOT EXISTS booking.update_log (
  booking_id UUID NOT NULL,
  kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, kind)
);

-- A new time proposed by the pro waits for the customer to accept it.
CREATE TABLE IF NOT EXISTS booking.schedule_change (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL,
  from_at TIMESTAMPTZ,
  to_at TIMESTAMPTZ NOT NULL,
  to_window TEXT,
  proposed_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedule_change_booking_idx ON booking.schedule_change (booking_id, status);

ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS time_window TEXT;
