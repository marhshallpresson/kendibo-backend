-- 036: WhatsApp onboarding (email confirmed by link before it is attached;
-- welcome message sent once) and job security (start code read out at the door,
-- two-sided completion).
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS email_pending TEXT;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS welcome_sent_at TIMESTAMPTZ;
ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS start_code TEXT;
ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS start_code_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS provider_completed_at TIMESTAMPTZ;
ALTER TABLE booking.booking ADD COLUMN IF NOT EXISTS customer_confirmed_at TIMESTAMPTZ;
