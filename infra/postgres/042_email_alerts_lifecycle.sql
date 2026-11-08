-- 042: admin alert recipients (DB, not env), admin alert de-duplication,
-- email-marketing consent on identity.users, and the lifecycle send log.
-- Additive only.

-- Who receives admin alerts. Owner rule: recipients live in the database and
-- are changed from the admin console (PUT /v1/admin/settings/alert-emails).
INSERT INTO configuration.platform_setting (key, value) VALUES
  ('admin.alert_emails', '["admin@kendibo.ng", "alerts@kendibo.ng"]')
ON CONFLICT (key) DO NOTHING;

-- One row per alert ever sent; dedupe_key makes "first time online",
-- "first price listed" and "unserved request X" fire exactly once.
CREATE TABLE IF NOT EXISTS notification.admin_alert_log (
  dedupe_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  recipients INT NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Email marketing consent (NDPA 2023 / GDPR: opt-in, default off, provable).
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS email_marketing_consent BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS email_marketing_consent_at TIMESTAMPTZ;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS email_marketing_consent_source TEXT;
-- Set by the one-click unsubscribe link: also stops non-essential lifecycle
-- tips. Receipts and security mail are unaffected.
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS email_unsubscribed_at TIMESTAMPTZ;

-- Lifecycle/marketing send log: one row per user + template + period, so the
-- hourly sweeper is idempotent across restarts and overlapping runs.
CREATE TABLE IF NOT EXISTS notification.email_send_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  template TEXT NOT NULL,
  period TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lifecycle',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, template, period)
);
CREATE INDEX IF NOT EXISTS email_send_log_user_kind ON notification.email_send_log (user_id, kind, sent_at);
