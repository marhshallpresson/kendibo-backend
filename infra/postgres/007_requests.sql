-- 007_requests.sql — provider bank-change cooling, ledger periods, on-demand service requests.
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS bank_changed_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ledger.period (
  period TEXT PRIMARY KEY, locked BOOLEAN NOT NULL DEFAULT FALSE
);

-- On-demand requests: user states a need -> match -> broadcast -> accept -> booking.
CREATE TABLE IF NOT EXISTS booking.service_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  service_id TEXT REFERENCES catalog.service(id),
  title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
  urgency TEXT NOT NULL DEFAULT 'this_week',
  address_id UUID REFERENCES property.address(id),
  lat DOUBLE PRECISION, lng DOUBLE PRECISION,
  contact_name TEXT, contact_phone TEXT, contact_email TEXT, notes TEXT,
  sms_updates BOOLEAN NOT NULL DEFAULT TRUE,
  scheduled_date DATE, time_window TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED',
  booking_id UUID REFERENCES booking.booking(id),
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS booking.request_offer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES booking.service_request(id),
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  quoted_kobo BIGINT, eta_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'offered',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, provider_id)
);
