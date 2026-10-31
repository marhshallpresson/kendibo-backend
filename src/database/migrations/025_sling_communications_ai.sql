-- 025: Sling (HelloSling / SlingAfrica) Omnichannel Communications,
-- Event-Driven Automations, AI-Assisted CTA Retainers & Bulk Campaigns.
-- Applied by scripts/migrate.ts (prod) and registered in packages/database/local.ts (pg-mem dev).

CREATE SCHEMA IF NOT EXISTS notification;

-- Extend notification.notification with rich payload + CTA + read state
ALTER TABLE notification.notification ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE notification.notification ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE notification.notification ADD COLUMN IF NOT EXISTS cta_label TEXT;
ALTER TABLE notification.notification ADD COLUMN IF NOT EXISTS cta_url TEXT;
ALTER TABLE notification.notification ADD COLUMN IF NOT EXISTS route TEXT;
ALTER TABLE notification.notification ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'transactional';
ALTER TABLE notification.notification ADD COLUMN IF NOT EXISTS ai_assisted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notification.notification ADD COLUMN IF NOT EXISTS read BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notification.notification ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE notification.notification ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Per-user omnichannel & category preferences + Sling contact linkage
CREATE TABLE IF NOT EXISTS notification.user_preference (
  user_id TEXT PRIMARY KEY,
  order_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  chat_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  maint_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  promo_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cashback_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  push_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sms_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  whatsapp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rcs_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  tips_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  preferred_channel TEXT NOT NULL DEFAULT 'whatsapp',
  sling_contact_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Omnichannel delivery ledger (correlates internal reference <-> Sling message_id)
CREATE TABLE IF NOT EXISTS notification.delivery_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  sling_message_id TEXT,
  user_id TEXT,
  recipient TEXT NOT NULL,
  channel TEXT NOT NULL,
  msg_type TEXT NOT NULL DEFAULT 'transactional',
  template TEXT NOT NULL DEFAULT 'generic',
  campaign_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  provider TEXT NOT NULL DEFAULT 'sling',
  credit_used INTEGER NOT NULL DEFAULT 1,
  error_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_delivery_user ON notification.delivery_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_delivery_sling_msg ON notification.delivery_log (sling_message_id);

-- Bulk Promotional, Operational Alert & AI-Assisted CTA Campaigns
CREATE TABLE IF NOT EXISTS notification.campaign (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'bulk_promotional',
  channels JSONB NOT NULL DEFAULT '["sms","whatsapp","push"]',
  target_segment TEXT NOT NULL DEFAULT 'all_customers',
  sling_group_id TEXT,
  message_body TEXT NOT NULL,
  subject TEXT,
  cta_label TEXT,
  cta_url TEXT,
  rcs_payload JSONB NOT NULL DEFAULT '{}',
  ai_assisted BOOLEAN NOT NULL DEFAULT FALSE,
  ai_prompt TEXT,
  scheduled_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft',
  sling_campaign_id TEXT,
  stats JSONB NOT NULL DEFAULT '{"targeted":0,"sent":0,"delivered":0,"failed":0}',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Event-Driven Workflow Automation Rules
CREATE TABLE IF NOT EXISTS notification.automation_rule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_event TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  delay_seconds INTEGER NOT NULL DEFAULT 0,
  channels JSONB NOT NULL DEFAULT '["push","whatsapp","sms"]',
  template TEXT NOT NULL,
  ai_personalize BOOLEAN NOT NULL DEFAULT TRUE,
  sling_form_id TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI-Assisted Customer Retainer & Preventive Maintenance Schedules
CREATE TABLE IF NOT EXISTS notification.retainer_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  property_id TEXT,
  service_id TEXT NOT NULL DEFAULT 'home_cleaning',
  service_name TEXT NOT NULL DEFAULT 'Preventive Home Maintenance',
  cadence TEXT NOT NULL DEFAULT 'monthly',
  channels JSONB NOT NULL DEFAULT '["whatsapp","push","sms"]',
  ai_assisted BOOLEAN NOT NULL DEFAULT TRUE,
  custom_goal TEXT,
  last_cta_label TEXT,
  last_cta_url TEXT,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_run_at TIMESTAMPTZ,
  run_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_retainer_user ON notification.retainer_schedule (user_id, status);
CREATE INDEX IF NOT EXISTS idx_notif_retainer_due ON notification.retainer_schedule (status, next_run_at);

-- Default automation rules seeded for operational & AI retainer workflows
INSERT INTO notification.automation_rule (trigger_event, name, delay_seconds, channels, template, ai_personalize, active) VALUES
  ('auth.otp', 'Instant OTP Verification (Sling SMS + WhatsApp + Truecaller)', 0, '["sms","whatsapp"]', 'otp', FALSE, TRUE),
  ('user.welcome', 'Omnichannel Welcome & Sling Form Enrollment', 0, '["whatsapp","sms","email","push"]', 'welcome', TRUE, TRUE),
  ('booking.confirmed', 'Booking Confirmed Operational Alert', 0, '["push","whatsapp","sms","email"]', 'booking_confirmed', TRUE, TRUE),
  ('provider.assigned', 'Provider Assigned & Verified Alert', 0, '["push","whatsapp","sms"]', 'provider_assigned', FALSE, TRUE),
  ('provider.en_route', 'Provider En-Route Live Tracking Alert', 0, '["push","whatsapp","rcs"]', 'provider_en_route', FALSE, TRUE),
  ('provider.arrived', 'Provider Arrived at Property Gate Alert', 0, '["push","whatsapp","sms"]', 'provider_arrived', FALSE, TRUE),
  ('quote.ready', 'Inspection Quote Ready with AI CTA Deep-Link', 0, '["push","whatsapp","rcs","sms"]', 'quote_ready', TRUE, TRUE),
  ('payment.success', 'Escrow Payment Confirmed & Receipt', 0, '["push","whatsapp","email"]', 'payment_confirmed', FALSE, TRUE),
  ('payout.sent', 'Provider Instant Payout Disbursed', 0, '["push","whatsapp","sms","email"]', 'payout_sent', FALSE, TRUE),
  ('warranty.expiring', 'Warranty Expiration & Preventive Checkup CTA', 0, '["whatsapp","push","sms"]', 'warranty_expiring', TRUE, TRUE),
  ('retainer.due', 'AI-Assisted Smart Home Retainer & Win-Back CTA', 0, '["whatsapp","push","rcs","sms"]', 'ai_retainer_cta', TRUE, TRUE)
ON CONFLICT (trigger_event) DO NOTHING;
