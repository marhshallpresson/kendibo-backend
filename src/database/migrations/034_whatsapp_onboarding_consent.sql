-- 034: record when (and where) a user accepted Kendibo's terms and privacy
-- notice. WhatsApp onboarding asks once before the first booking; the app
-- sign-up can write the same columns.
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS terms_source TEXT;
