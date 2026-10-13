-- 023: hot-path indexes, platform settings, KYC documents.
-- Applied by scripts/migrate.ts (prod) and registered in packages/database/local.ts (pg-mem dev).

-- ── Performance indexes ─────────────────────────────────────────────────────
-- Every index below targets a query that runs on a 5–15s poll loop or on the
-- booking/dispatch hot path (see perf audit: N+1 + WAN Postgres amplification).
CREATE INDEX IF NOT EXISTS idx_provider_location_latest
  ON geo.provider_location (provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_event_job_created
  ON booking.job_event (job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_assignment_provider_status
  ON dispatch.assignment (provider_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_wallet_txn_user_created
  ON payment.wallet_txn (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_request_offer_provider_status
  ON booking.request_offer (provider_id, status);
CREATE INDEX IF NOT EXISTS idx_message_conversation_created
  ON messaging.message (conversation_id, created_at);

-- ── Platform settings ───────────────────────────────────────────────────────
-- Typed key/value store for runtime-switchable platform configuration
-- (map provider + fallback order, etc.). Distinct from configuration.flag
-- (booleans only). value is JSONB so each setting owns its shape.
CREATE TABLE IF NOT EXISTS configuration.platform_setting (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the map-provider switch: primary + ordered fallbacks. Availability of
-- each adapter is derived server-side from configured API keys; `osm` needs no
-- key and is always available, so it is the safe terminal fallback.
INSERT INTO configuration.platform_setting (key, value) VALUES
  ('maps.provider', '"mapbox"'),
  ('maps.fallbacks', '["osm"]')
ON CONFLICT (key) DO NOTHING;

-- ── KYC documents ───────────────────────────────────────────────────────────
-- Links media assets to a provider's KYC application. Files go through the
-- normal media pipeline (presign -> upload -> ingest); this table only stores
-- the reference plus review metadata, giving the admin queue something to
-- approve/reject and giving rejections a durable reason.
CREATE SCHEMA IF NOT EXISTS kyc;
CREATE TABLE IF NOT EXISTS kyc.submission_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES media.asset(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('id_front', 'id_back', 'selfie', 'cac', 'other')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_kyc_doc_provider
  ON kyc.submission_document (provider_id, kind);

-- Rejection reason + submission timestamp live on the provider row so the
-- app status screen and the admin queue can render them without a join.
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS kyc_submitted_at TIMESTAMPTZ;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS kyc_reviewed_at TIMESTAMPTZ;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS kyc_reviewed_by UUID;

-- Legacy deployments wrote bank_name on KYC submit but the column was never
-- migrated (route would 500 whenever bankName was supplied).
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS bank_name TEXT;
