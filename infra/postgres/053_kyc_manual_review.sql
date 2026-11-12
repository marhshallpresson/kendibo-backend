-- KYC manual review fallback. When the identity provider (Prembly) is not
-- configured, unfunded, over quota or down, an ID application is saved as
-- UNDER_REVIEW with pending_reason = 'manual_verification' and handed to the
-- admin queue instead of being rejected. submitted_masked keeps only masked
-- inputs (e.g. NIN 123****8901) and document references: never raw numbers.
-- Additive only.
ALTER TABLE kyc.customer ADD COLUMN IF NOT EXISTS pending_reason TEXT;
ALTER TABLE kyc.customer ADD COLUMN IF NOT EXISTS submitted_masked JSONB;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS kyc_pending_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_kyc_customer_pending_reason ON kyc.customer (pending_reason);
CREATE INDEX IF NOT EXISTS idx_provider_kyc_pending_reason ON provider.provider (kyc_pending_reason);
