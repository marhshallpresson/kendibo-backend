-- Audit trail of automated KYC checks (one row per provider call), written by
-- kyc.service recordCheck() and read by checksFor() for the admin review panel.
-- The service has used this table since the tiered KYC flow, but no migration
-- created it, so POST /v1/user/kyc failed with "relation does not exist".
CREATE TABLE IF NOT EXISTS kyc.verification_check (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  tier SMALLINT NOT NULL,
  check_kind TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'stub',
  status TEXT NOT NULL,
  confidence NUMERIC,
  masked_input TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kyc_verification_check_subject
  ON kyc.verification_check (subject_type, subject_id, created_at DESC);
