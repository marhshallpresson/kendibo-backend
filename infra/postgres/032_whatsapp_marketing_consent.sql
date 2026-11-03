CREATE TABLE IF NOT EXISTS messaging.whatsapp_marketing_consent (
  wa_id TEXT PRIMARY KEY,
  opted_in BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
