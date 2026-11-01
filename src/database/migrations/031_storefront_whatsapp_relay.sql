-- 031: storefront → WhatsApp bookings and the masked client ↔ vendor relay.
--
-- A client who taps "Connect on WhatsApp" on a vendor's storefront arrives with
-- a KB-<slug> reference; the draft remembers that vendor so the request goes to
-- them first. Once the vendor accepts, messaging.whatsapp_relay links the two
-- chats: each side writes to Kendibo and the bot passes the words on, with
-- phone numbers and emails hidden, so they only talk through Kendibo.

ALTER TABLE messaging.whatsapp_job_draft ADD COLUMN IF NOT EXISTS preferred_provider_id UUID;

CREATE TABLE IF NOT EXISTS messaging.whatsapp_relay (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  provider_id UUID NOT NULL,
  customer_wa TEXT NOT NULL,
  vendor_wa TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_relay_customer ON messaging.whatsapp_relay (customer_wa, status);
CREATE INDEX IF NOT EXISTS idx_whatsapp_relay_vendor ON messaging.whatsapp_relay (vendor_wa, status);
