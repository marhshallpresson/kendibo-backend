-- 041: Job evidence (photos, videos, voice notes, documents) from WhatsApp and the apps.
-- One row per file attached to a request and/or booking. Parties can add but
-- never delete; admins can hide a row with a reason (audited) and it is kept.
-- A row with neither request_id nor booking_id is "pending": a customer sent it
-- before they had an open request, and it is attached when their next request
-- is created.
CREATE SCHEMA IF NOT EXISTS media;
CREATE TABLE IF NOT EXISTS media.evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID,
  booking_id UUID,
  uploader_user_id UUID NOT NULL,
  uploader_role TEXT NOT NULL CHECK (uploader_role IN ('customer', 'provider', 'admin')),
  stage TEXT NOT NULL CHECK (stage IN ('request', 'before', 'during', 'after', 'dispute')),
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'document')),
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  caption TEXT,
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'whatsapp')),
  wa_message_id TEXT UNIQUE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at TIMESTAMPTZ,
  hidden_by UUID,
  hidden_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS evidence_booking_idx ON media.evidence (booking_id);
CREATE INDEX IF NOT EXISTS evidence_request_idx ON media.evidence (request_id);
CREATE INDEX IF NOT EXISTS evidence_uploader_idx ON media.evidence (uploader_user_id);
