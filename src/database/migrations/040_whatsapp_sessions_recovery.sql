-- 040: WhatsApp session mode + account recovery.
-- Every service request gets a short human tag (AC-4821) so a customer with
-- several open requests can say which one they mean; the active one is kept per user.
ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS session_tag TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS service_request_session_tag_uq ON booking.service_request (session_tag);

CREATE TABLE IF NOT EXISTS messaging.whatsapp_active_session (
  user_id UUID PRIMARY KEY,
  session_tag TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lost or changed number: a 6-digit code emailed to the old account moves this
-- WhatsApp number onto it. Only a hash of the code is stored.
CREATE TABLE IF NOT EXISTS messaging.whatsapp_recovery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id TEXT NOT NULL,
  target_user_id UUID,
  code_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'sent',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_recovery_wa_idx ON messaging.whatsapp_recovery (wa_id, created_at);
