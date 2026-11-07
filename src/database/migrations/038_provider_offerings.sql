-- 038: provider price lists. Providers set their own prices; customers book a
-- listed service directly with that provider. Kendibo keeps the trade's
-- commission (category rule) from the listed price; the provider gets the rest.
CREATE TABLE IF NOT EXISTS provider.offering (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_kobo BIGINT NOT NULL CHECK (price_kobo > 0),
  price_unit TEXT NOT NULL DEFAULT 'job' CHECK (price_unit IN ('job', 'hour', 'visit', 'item')),
  duration_minutes INT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offering_provider_idx ON provider.offering (provider_id);
ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS offering_id UUID;
