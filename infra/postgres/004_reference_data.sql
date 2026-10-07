-- 004_reference_data.sql — cities, zones, catalog, pricebook, flags.
-- Mirrors code defaults (cityService, catalogService, configurationService)
-- so DB-first reads agree with the API from day one.
INSERT INTO geo.city (id, name, radius_km, vat_bps, emergency_enabled, flags) VALUES
 ('uyo', 'Uyo', 12, 750, FALSE, '{"booking.fixed_price.enabled": true, "booking.quote_flow.enabled": true}'),
 ('abuja', 'Abuja', 15, 750, FALSE, '{"booking.fixed_price.enabled": true, "booking.quote_flow.enabled": true}'),
 ('lagos', 'Lagos', 15, 750, FALSE, '{"booking.fixed_price.enabled": true, "booking.quote_flow.enabled": true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO geo.zone (city_id, name, lat, lng, radius_km) VALUES
 ('uyo', 'Ewet Housing', 4.99, 7.93, 8),
 ('uyo', 'Osongama', 4.97, 7.95, 8),
 ('abuja', 'Gwarinpa', 9.09, 7.41, 8),
 ('abuja', 'Maitama', 9.09, 7.49, 6),
 ('lagos', 'Lekki', 6.45, 3.47, 10),
 ('lagos', 'Ikeja', 6.60, 3.35, 10)
ON CONFLICT (city_id, name) DO NOTHING;

INSERT INTO catalog.category (id, name, description, active, sort_order) VALUES
 ('cleaning', 'Cleaning', 'Home and office cleaning', TRUE, 1),
 ('ac', 'AC Services', 'Air-conditioner service and repair', TRUE, 2),
 ('plumbing', 'Plumbing', 'Leaks, pipes, drains, heaters', TRUE, 3),
 ('electrical', 'Electrical', 'Faults, sockets, lighting, wiring', TRUE, 4),
 ('generator', 'Generator', 'Servicing and repair', TRUE, 5),
 ('handyman', 'Handyman', 'Assembly, mounting, minor repairs', TRUE, 6),
 ('appliance', 'Appliance Repair', 'Fridge, freezer, washer, cooker', TRUE, 7),
 ('pest', 'Pest Control', 'Treatment and fumigation', TRUE, 8)
ON CONFLICT (id) DO NOTHING;

INSERT INTO catalog.service (id, category_id, name, booking_type, duration_minutes, base_price_kobo, warranty_days, requires_skill, active) VALUES
 ('svc_ac_general', 'ac', 'AC General Service', 'fixed', 90, 1500000, 7, 'hvac', TRUE),
 ('svc_ac_deep', 'ac', 'AC Deep Cleaning', 'fixed', 120, 2500000, 14, 'hvac', TRUE),
 ('svc_ac_install', 'ac', 'AC Installation', 'quote', 180, 0, 30, 'hvac', TRUE),
 ('svc_clean_home', 'cleaning', 'Home Deep Cleaning', 'fixed', 180, 2000000, 3, NULL, TRUE),
 ('svc_plumb_diag', 'plumbing', 'Plumbing Diagnosis', 'quote', 60, 0, 7, 'plumbing', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO catalog.addon (id, service_id, name, price_kobo) VALUES
 ('ao_gas', 'svc_ac_general', 'Gas Refill', 1200000),
 ('ao_wall', 'svc_ac_install', 'Wall Bracket', 800000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO catalog.checklist (category_id, items, version) VALUES
 ('ac', '["inspect outdoor unit","inspect indoor unit","clean filters","inspect drain","inspect electrical connections","test cooling","record findings","capture before/after","customer confirmation"]', 1),
 ('cleaning', '["dust surfaces","vacuum/mop floors","clean bathrooms","capture before/after","customer confirmation"]', 1)
ON CONFLICT DO NOTHING;

INSERT INTO catalog.pricebook (version, vat_bps, platform_fee_bps, per_km_kobo) VALUES
 ('pricebook_2026-10-06', 750, 1000, 20000)
ON CONFLICT (version) DO NOTHING;

INSERT INTO configuration.flag (key, value) VALUES
 ('booking.fixed_price.enabled', TRUE),
 ('booking.quote_flow.enabled', TRUE),
 ('provider.live_tracking.enabled', TRUE),
 ('provider.sos.enabled', FALSE),
 ('customer.wallet.enabled', TRUE),
 ('recurring.booking.enabled', FALSE),
 ('b2b.work_orders.enabled', FALSE),
 ('emergency.services.enabled', FALSE),
 ('payment.bank_transfer.enabled', TRUE),
 ('payment.card.enabled', TRUE)
ON CONFLICT (key) DO NOTHING;
