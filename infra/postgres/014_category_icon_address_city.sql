-- 014_category_icon_address_city.sql
-- Production hardening: per-category icons + persist city/state on addresses.
-- catalog.category gains icon_name so the app renders a distinct icon per
-- category instead of falling back to Sparkles for everything.
-- property.address gains city/state (the API schema already accepted them but
-- the table dropped them, so the app always rendered an empty city).

ALTER TABLE catalog.category ADD COLUMN IF NOT EXISTS icon_name TEXT;

UPDATE catalog.category SET icon_name = CASE id
  WHEN 'cleaning'  THEN 'Sparkles'
  WHEN 'ac'        THEN 'Wind'
  WHEN 'plumbing'  THEN 'Wrench'
  WHEN 'electrical' THEN 'Zap'
  WHEN 'generator' THEN 'Fuel'
  WHEN 'handyman'  THEN 'Hammer'
  WHEN 'appliance' THEN 'Tv'
  WHEN 'pest'      THEN 'Bug'
  ELSE 'Sparkles'
END
WHERE icon_name IS NULL;

ALTER TABLE property.address ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE property.address ADD COLUMN IF NOT EXISTS state TEXT;

UPDATE property.address SET city = 'Uyo', state = 'Akwa Ibom' WHERE city IS NULL;
