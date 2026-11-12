-- 052_product_vendors.sql
-- Product vendors: a provider.offering can be a product (cleaning supplies,
-- plumbing materials, solar/inverter gear...) priced per item. Customers ask
-- for a quantity; the vendor accepts; payment uses the same escrow. Additive.
--
-- photo_asset_id is TEXT because media.asset ids are text ('med_...').
-- media.asset.owner_user_id records who uploaded an asset (new uploads only),
-- so a vendor can only attach their own photos to a product.
-- Applied by scripts/migrate.ts (prod) and packages/database/local.ts (pg-mem).

ALTER TABLE provider.offering ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'service';
ALTER TABLE provider.offering ADD COLUMN IF NOT EXISTS stock_note TEXT;
ALTER TABLE provider.offering ADD COLUMN IF NOT EXISTS photo_asset_id TEXT;
ALTER TABLE provider.offering ADD COLUMN IF NOT EXISTS max_quantity INT;
CREATE INDEX IF NOT EXISTS offering_provider_kind_idx ON provider.offering (provider_id, kind);

ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 1;
ALTER TABLE booking.service_request ADD COLUMN IF NOT EXISTS unit_price_kobo BIGINT;

ALTER TABLE media.asset ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
