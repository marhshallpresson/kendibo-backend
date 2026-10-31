-- 027_vendor_rules_storefront_whatsapp_kyc_cost.sql
-- Vendor platform: per-category verification rules + commission, AI-assisted
-- category proposals (new trades like interior design), provider enrollment
-- per category, provider fee ledger (verification fees recovered from
-- earnings), shareable storefronts with attribution, KYC spend controls, and
-- the WhatsApp booking assistant's session store.
-- Applied by scripts/migrate.ts (prod) and packages/database/local.ts (pg-mem).

-- ── Category taxonomy ───────────────────────────────────────────────────────
ALTER TABLE catalog.category ADD COLUMN IF NOT EXISTS parent_group TEXT;
ALTER TABLE catalog.category ADD COLUMN IF NOT EXISTS created_via TEXT NOT NULL DEFAULT 'seed';

-- What a vendor must prove before taking work in a category, and what the
-- platform keeps. Defaults are deliberately conservative; ops tune per trade.
CREATE TABLE IF NOT EXISTS catalog.category_rule (
  category_id TEXT PRIMARY KEY REFERENCES catalog.category(id),
  min_kyc_tier INT NOT NULL DEFAULT 1,
  require_face_match BOOLEAN NOT NULL DEFAULT TRUE,
  require_cac BOOLEAN NOT NULL DEFAULT FALSE,
  required_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  licence_required BOOLEAN NOT NULL DEFAULT FALSE,
  licence_label TEXT,
  insurance_required BOOLEAN NOT NULL DEFAULT FALSE,
  min_experience_years INT NOT NULL DEFAULT 0,
  commission_bps INT NOT NULL DEFAULT 1500 CHECK (commission_bps >= 0 AND commission_bps <= 5000),
  verification_fee_kobo BIGINT NOT NULL DEFAULT 0 CHECK (verification_fee_kobo >= 0),
  max_concurrent_jobs INT NOT NULL DEFAULT 3,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO catalog.category_rule (category_id)
  SELECT id FROM catalog.category ON CONFLICT DO NOTHING;
-- Safety-critical trades need ID + face and a trade licence on file.
UPDATE catalog.category_rule
  SET min_kyc_tier = 2, licence_required = TRUE, licence_label = 'Electrical installation licence or COREN/NEMSA certificate',
      required_documents = '["licence"]'::jsonb
  WHERE category_id = 'electrical';
UPDATE catalog.category_rule
  SET min_kyc_tier = 2, required_documents = '["licence"]'::jsonb, licence_required = TRUE,
      licence_label = 'Gas/generator technician certificate'
  WHERE category_id = 'generator';

-- A vendor asks for a trade we do not list yet. AI (or the deterministic
-- fallback) normalises it and drafts rules; ops approve, merge or reject.
CREATE TABLE IF NOT EXISTS catalog.category_proposal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposed_by UUID NOT NULL REFERENCES provider.provider(id),
  raw_name TEXT NOT NULL,
  description TEXT,
  suggestion JSONB NOT NULL DEFAULT '{}'::jsonb,
  suggestion_source TEXT NOT NULL DEFAULT 'deterministic',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'merged', 'rejected')),
  resolved_category_id TEXT,
  decided_by TEXT,
  decision_note TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_category_proposal_status ON catalog.category_proposal (status, created_at);

-- Which trades a vendor is cleared for. Re-evaluated whenever KYC, documents
-- or the category rule changes; `missing` tells the app what is left to do.
CREATE TABLE IF NOT EXISTS provider.category_enrollment (
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  category_id TEXT NOT NULL REFERENCES catalog.category(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'eligible', 'suspended')),
  missing JSONB NOT NULL DEFAULT '[]'::jsonb,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, category_id)
);

-- Trade credentials (licence / insurance / certificate). Uploaded by the
-- vendor through the media pipeline, approved by Trust & Safety; only an
-- approved, unexpired credential satisfies a category rule.
CREATE TABLE IF NOT EXISTS provider.credential (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  category_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('licence', 'insurance', 'certificate')),
  asset_id TEXT NOT NULL,
  label TEXT,
  number TEXT,
  expires_at DATE,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_credential ON provider.credential (provider_id, kind, status);

-- ── Vendor money ────────────────────────────────────────────────────────────
-- Fees the platform recovers from a vendor's earnings (e.g. identity
-- verification cost on onboarding). Recovered at payout time, never by
-- reaching into a bank account.
CREATE TABLE IF NOT EXISTS provider.fee_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  kind TEXT NOT NULL CHECK (kind IN ('kyc_verification', 'commission', 'adjustment')),
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'outstanding' CHECK (status IN ('outstanding', 'recovered', 'waived')),
  recovered_in TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_provider ON provider.fee_ledger (provider_id, status);
ALTER TABLE provider.earning ADD COLUMN IF NOT EXISTS gross_kobo BIGINT;
ALTER TABLE provider.earning ADD COLUMN IF NOT EXISTS commission_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE provider.earning ADD COLUMN IF NOT EXISTS commission_bps INT;

-- ── Storefronts ─────────────────────────────────────────────────────────────
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS tagline TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS logo_asset_id TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS cover_asset_id TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS social_links JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS service_areas JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS storefront_published BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_slug ON provider.provider (slug);

-- Visits / shares / bookings that arrived through a vendor's own link.
CREATE TABLE IF NOT EXISTS provider.storefront_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id),
  kind TEXT NOT NULL CHECK (kind IN ('view', 'share', 'request', 'booking')),
  channel TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_storefront_event ON provider.storefront_event (provider_id, kind, created_at);
ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS preferred_provider_id UUID;
ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app';

-- ── KYC spend control ───────────────────────────────────────────────────────
-- Every billable identity call, with what it cost. Cached hits cost 0.
CREATE TABLE IF NOT EXISTS kyc.verification_cost (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  unit_cost_kobo BIGINT NOT NULL DEFAULT 0,
  cached BOOLEAN NOT NULL DEFAULT FALSE,
  outcome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kyc_cost_day ON kyc.verification_cost (created_at);
CREATE INDEX IF NOT EXISTS idx_kyc_cost_subject ON kyc.verification_cost (subject_type, subject_id, kind, created_at);
-- Result cache keyed by an HMAC of kind + ID number (never the raw number),
-- so a retry or a second submission never pays the vendor twice.
CREATE TABLE IF NOT EXISTS kyc.verification_cache (
  lookup_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  result JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── WhatsApp assistant ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messaging.whatsapp_session (
  wa_id TEXT PRIMARY KEY,
  user_id UUID,
  state TEXT NOT NULL DEFAULT 'MENU',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Meta delivers at-least-once: the message id is the dedupe key.
CREATE TABLE IF NOT EXISTS messaging.whatsapp_inbound (
  message_id TEXT PRIMARY KEY,
  wa_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
