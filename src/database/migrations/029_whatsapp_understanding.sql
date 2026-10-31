-- 029: WhatsApp assistant, rebuilt around a deterministic flow with an
-- in-process understanding layer.
--
-- 1. Inbound messages keep their payload until processed, so a turn the API
--    died in the middle of can be retried once by the sweeper.
-- 2. ml.nlu_event: one row per customer text with what the intent model
--    understood and what the router did. Text is redacted before it is stored
--    (no phone numbers, emails, codes or ID numbers) and the WhatsApp id is
--    hashed. Ops label rows in the admin console; the intent model
--    (ml.model name 'wa_intent') retrains on them. Unlabelled rows are deleted
--    after 180 days.

ALTER TABLE messaging.whatsapp_inbound ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE messaging.whatsapp_inbound ADD COLUMN IF NOT EXISTS profile_name TEXT;
ALTER TABLE messaging.whatsapp_inbound ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE messaging.whatsapp_inbound ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE messaging.whatsapp_inbound ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
-- Everything received before this migration has already been handled.
UPDATE messaging.whatsapp_inbound SET processed_at = received_at WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_pending ON messaging.whatsapp_inbound (processed_at, received_at);
CREATE INDEX IF NOT EXISTS idx_whatsapp_inbound_wa ON messaging.whatsapp_inbound (wa_id, received_at);

CREATE TABLE IF NOT EXISTS ml.nlu_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_hash TEXT NOT NULL,
  text_redacted TEXT NOT NULL,
  intent TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  route TEXT NOT NULL,
  step TEXT,
  label TEXT,
  label_source TEXT,
  labelled_by TEXT,
  labelled_at TIMESTAMPTZ,
  model_version INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nlu_event_created ON ml.nlu_event (created_at);
CREATE INDEX IF NOT EXISTS idx_nlu_event_hash ON ml.nlu_event (wa_hash, route, created_at);
CREATE INDEX IF NOT EXISTS idx_nlu_event_label ON ml.nlu_event (label, labelled_at);
