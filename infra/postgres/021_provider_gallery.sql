-- Provider storefront gallery. Photos are uploaded through the normal media
-- pipeline (presign -> ingest -> clean) and then referenced here, so this table
-- only stores the reference. Position drives display order.
CREATE TABLE IF NOT EXISTS provider.gallery (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES provider.provider(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES media.asset(id) ON DELETE CASCADE,
  caption TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_gallery_provider
  ON provider.gallery (provider_id, position);
