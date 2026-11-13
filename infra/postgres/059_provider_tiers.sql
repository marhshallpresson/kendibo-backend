-- 059_provider_tiers.sql
-- Provider / vendor tiers (1 Starter, 2 Verified, 3 Pro / Business), paid
-- upgrade applications, the "Kendibo Pro" monthly subscription, references /
-- guarantors, and the Tier-3-only trades. Additive only.
--
-- provider.tier is the tier GRANTED by an approved application, an admin, or
-- the grandfathering below (0 = nothing granted). Tier 1 is also reached
-- automatically once its requirements are met (modules/tiers/tier.service.ts);
-- Tier 2 and 3 only through an approved application or an admin.
-- kyc_tier keeps its identity-check meaning (024); category_rule.min_kyc_tier
-- is now compared with the provider tier (eligibility.service.ts).
-- Prices and limits live in modules/tiers/tier.config.ts (override:
-- configuration.platform_setting 'tiers.config').
-- Applied by scripts/migrate.ts (prod) and packages/database/local.ts (pg-mem).

ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS tier INT NOT NULL DEFAULT 0;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS tier_source TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS tier_reason TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS tier_set_by TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS tier_set_at TIMESTAMPTZ;

-- Upgrade applications. One fee per application, charged on apply (wallet or
-- PSP checkout); admin approves or rejects; rejection refunds to the wallet;
-- approval refunds as wallet credit after N completed jobs at the new tier.
CREATE TABLE IF NOT EXISTS provider.tier_application (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  target_tier INT NOT NULL CHECK (target_tier IN (2, 3)),
  business_kind TEXT NOT NULL DEFAULT 'individual' CHECK (business_kind IN ('individual', 'business')),
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'under_review', 'approved', 'rejected')),
  fee_kobo BIGINT NOT NULL CHECK (fee_kobo >= 0),
  payment_method TEXT,
  payment_reference TEXT NOT NULL,
  paid_at TIMESTAMPTZ,
  requirements JSONB,
  reason TEXT,
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  -- completed jobs (provider.earning rows) when approved: the refund counts jobs after this.
  jobs_at_decision INT,
  refund_status TEXT NOT NULL DEFAULT 'none' CHECK (refund_status IN ('none', 'pending', 'refunded')),
  refund_reference TEXT,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tier_application_provider ON provider.tier_application (provider_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tier_application_status ON provider.tier_application (status, created_at);
CREATE INDEX IF NOT EXISTS idx_tier_application_ref ON provider.tier_application (payment_reference);

-- "Kendibo Pro" subscription (Tier 2+). Cancel = at period end. Renewal is
-- charged from the wallet when the period ends; no balance -> expired.
CREATE TABLE IF NOT EXISTS provider.subscription (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  plan TEXT NOT NULL DEFAULT 'pro_monthly',
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'active', 'expired')),
  price_kobo BIGINT NOT NULL CHECK (price_kobo >= 0),
  periods INT NOT NULL DEFAULT 0,
  payment_reference TEXT,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_subscription ON provider.subscription (provider_id, status);
CREATE INDEX IF NOT EXISTS idx_provider_subscription_ref ON provider.subscription (payment_reference);

-- start / renew / cancel / resume / expire, with the charge reference.
CREATE TABLE IF NOT EXISTS provider.subscription_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL,
  provider_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'renew', 'cancel', 'resume', 'expire')),
  amount_kobo BIGINT,
  reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscription_event_sub ON provider.subscription_event (subscription_id, created_at);

-- Tier 2: one reference or guarantor (checked by ops on review).
CREATE TABLE IF NOT EXISTS provider.tier_reference (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  kind TEXT NOT NULL DEFAULT 'reference' CHECK (kind IN ('reference', 'guarantor')),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  relationship TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'confirmed', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tier_reference_provider ON provider.tier_reference (provider_id);

-- Grandfathering: providers already approved before tiers keep working.
-- KYC tier 2+ (ID + face) kept the Tier-2 trades (electrical, gas, roofing…)
-- open before, so they start at Tier 2; other approved providers at Tier 1.
-- Admins can change either with POST /v1/admin/providers/:id/tier.
UPDATE provider.provider SET tier = 2, tier_source = 'grandfathered', tier_set_at = now()
  WHERE tier = 0 AND kyc_status = 'VERIFIED' AND kyc_tier >= 2;
UPDATE provider.provider SET tier = 1, tier_source = 'grandfathered', tier_set_at = now()
  WHERE tier = 0 AND kyc_status = 'VERIFIED';

-- Tier-3-only trades: in-home care, private chef, security (CCTV, electric
-- fence / perimeter alarms), septic evacuation, facility management (also
-- needs a CAC, set in 051). B2B contracts have no category yet (b2b module).
UPDATE catalog.category_rule SET min_kyc_tier = 3
  WHERE category_id IN ('home-care', 'private-chef', 'cctv', 'electric-fence', 'septic-evacuation', 'facility-management');
UPDATE catalog.category_rule SET require_cac = TRUE WHERE category_id IN ('facility-management');
