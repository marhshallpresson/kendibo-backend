-- 030: WhatsApp message templates + Facebook Login.
--
-- messaging.whatsapp_template mirrors the review status Meta reports for the
-- templates in modules/whatsapp/templates.ts (sync from the Template API and
-- the message_template_* webhooks). A template is only sent when APPROVED.
--
-- identity.users.facebook_sub is the app-scoped Facebook user id from
-- Facebook Login. identity.facebook_deletion records data-deletion requests
-- Meta sends (the confirmation code shown to the person); only a hash of the
-- Facebook id is kept.

CREATE TABLE IF NOT EXISTS messaging.whatsapp_template (
  name TEXT NOT NULL,
  language TEXT NOT NULL,
  meta_id TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'NOT_SUBMITTED',
  quality TEXT,
  reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (name, language)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_template_meta ON messaging.whatsapp_template (meta_id);

ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS facebook_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_facebook_sub ON identity.users (facebook_sub);

CREATE TABLE IF NOT EXISTS identity.facebook_deletion (
  code TEXT PRIMARY KEY,
  facebook_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
