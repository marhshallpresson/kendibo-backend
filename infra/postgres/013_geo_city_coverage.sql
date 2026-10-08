-- 013_geo_city_coverage.sql — city-wide serviceability (Uyo & Eket).
-- geo.city gains a center + radius so checkZone can cover an entire city,
-- not just the named sample zones in geo.zone.
ALTER TABLE geo.city ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE geo.city ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;

-- City centers (approx) + coverage radius in km.
INSERT INTO geo.city (id, name, radius_km, vat_bps, emergency_enabled, flags, lat, lng) VALUES
 ('uyo',   'Uyo',   12, 750, FALSE, '{"booking.fixed_price.enabled": true, "booking.quote_flow.enabled": true}', 5.0579, 7.9300),
 ('eket',  'Eket',  12, 750, FALSE, '{"booking.fixed_price.enabled": true, "booking.quote_flow.enabled": true}', 4.6423, 7.9160),
 ('abuja', 'Abuja', 15, 750, FALSE, '{"booking.fixed_price.enabled": true, "booking.quote_flow.enabled": true}', 9.0765, 7.3986),
 ('lagos', 'Lagos', 15, 750, FALSE, '{"booking.fixed_price.enabled": true, "booking.quote_flow.enabled": true}', 6.5244, 3.3792)
ON CONFLICT (id) DO UPDATE SET
  lat = COALESCE(EXCLUDED.lat, geo.city.lat),
  lng = COALESCE(EXCLUDED.lng, geo.city.lng);

-- Named zones stay as high-precision hotspots inside the city radius.
INSERT INTO geo.zone (city_id, name, lat, lng, radius_km) VALUES
 ('eket', 'Eket Town', 4.6423, 7.9160, 8),
 ('eket', 'Afaha Eket', 4.6700, 7.9500, 6)
ON CONFLICT (city_id, name) DO NOTHING;
