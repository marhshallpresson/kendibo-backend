-- Provider onboarding saves after every step, so a crash, a closed tab or a
-- new phone never loses what the pro already filled in; they resume at the
-- step they reached. Sensitive numbers (NIN, BVN) are never kept in the draft:
-- they go straight to the identity check.
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS account_type TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS onboarding_step TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS onboarding_draft JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS onboarding_updated_at TIMESTAMPTZ;
