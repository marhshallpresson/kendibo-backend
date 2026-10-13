-- 024: KYC tiers (3-level model), vendor check log, customer (user) KYC.
-- Applied by scripts/migrate.ts (prod) and registered in packages/database/local.ts (pg-mem dev).

-- ── Provider tier columns ───────────────────────────────────────────────────
-- kyc_tier: 0 = none, 1 = identity (NIN/BVN), 2 = ID + face match,
-- 3 = + business (CAC) or proof of address. nin_masked stores only a masked
-- form — the raw NIN is never persisted (vendor responses carry it transiently).
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS kyc_tier INT NOT NULL DEFAULT 0;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS nin_masked TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS kyc_provider TEXT;

-- Proof-of-address documents join the submission kinds. (Constraint recreated
-- at the end of this file so everything else applies even on pg-mem, which
-- chokes on DROP CONSTRAINT — see local.ts.)

-- ── Verification check log ──────────────────────────────────────────────────
-- Every vendor verification call (NIN/BVN/document/face-match/CAC) is logged
-- with its reference + outcome. Gives the admin review panel an audit trail
-- and lets ops re-verify against the vendor reference if a dispute arises.
CREATE TABLE IF NOT EXISTS kyc.check (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('provider', 'user')),
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('nin', 'bvn', 'doc', 'doc_face', 'cac')),
  provider TEXT NOT NULL DEFAULT 'stub',
  reference TEXT,
  result TEXT NOT NULL CHECK (result IN ('passed', 'failed', 'error')),
  response_code TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kyc_check_subject
  ON kyc.check (subject_type, subject_id, created_at DESC);

-- ── Customer (user) KYC ─────────────────────────────────────────────────────
-- Users onboard to the same 3-tier ladder; status mirrors the provider flow
-- (PENDING → UNDER_REVIEW → VERIFIED | REJECTED) so one admin queue pattern
-- serves both. Tier drives transaction limits surfaced in the app.
CREATE TABLE IF NOT EXISTS kyc.customer (
  user_id UUID PRIMARY KEY REFERENCES identity.users(id) ON DELETE CASCADE,
  tier INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  nin_masked TEXT,
  rejection_reason TEXT,
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kyc.customer_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES media.asset(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('id_front', 'id_back', 'selfie', 'cac', 'address', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_kyc_customer_doc_user
  ON kyc.customer_document (user_id, kind);

-- Auto-verify threshold: submissions whose computed tier reaches this value
-- are approved without manual review (2 = NIN + ID + face match). Below it,
-- the application lands in the admin queue. Admins can change this at runtime.
INSERT INTO configuration.platform_setting (key, value) VALUES
  ('kyc.auto_verify_min_tier', '2')
ON CONFLICT (key) DO NOTHING;

-- ── Submission kind: add 'address' (single line so local.ts can strip it) ───
ALTER TABLE kyc.submission_document DROP CONSTRAINT IF EXISTS submission_document_kind_check;
ALTER TABLE kyc.submission_document ADD CONSTRAINT submission_document_kind_check CHECK (kind IN ('id_front', 'id_back', 'selfie', 'cac', 'address', 'other'));
