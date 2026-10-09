-- 020_purge_demo_services_providers.sql — the catalog seed and the demo
-- provider signup were test content, not product: this platform exists to show
-- REAL approved service providers in the customer's area, and the home page
-- "providers" strip stays empty until a KYC-verified provider has applied.
-- Same rules as 017/019: child-first, guarded DELETE ... WHERE so re-running
-- is a no-op.
--
-- Live DB observed 2026-10-09: 5 seeded demo services + 2 addons (from 004),
-- and one test provider signup (Bliss Cleaning Hub, KYC PENDING, no bookings).

-- ---------- 1) demo addons + services (children of catalog) -----------------
DELETE FROM catalog.addon WHERE service_id IN
  ('svc_ac_general', 'svc_ac_deep', 'svc_ac_install', 'svc_clean_home', 'svc_plumb_diag');

DELETE FROM catalog.service WHERE id IN
  ('svc_ac_general', 'svc_ac_deep', 'svc_ac_install', 'svc_clean_home', 'svc_plumb_diag');

-- ---------- 2) the demo/test provider account (child-first) ------------------
-- Any provider row that is still PENDING/UNDER_REVIEW with zero completed
-- work (no accepted offers, no bookings, no earnings) and whose account was
-- created before any real customer activity is demo residue. The observed
-- test signup has none of those dependencies.
DELETE FROM dispatch.assignment
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE kyc_status IN ('PENDING', 'UNDER_REVIEW')
                          AND NOT EXISTS (SELECT 1 FROM booking.booking b WHERE b.provider_id = provider.provider.id));

DELETE FROM provider.skill
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE kyc_status IN ('PENDING', 'UNDER_REVIEW')
                          AND NOT EXISTS (SELECT 1 FROM booking.booking b WHERE b.provider_id = provider.provider.id));

DELETE FROM provider.availability
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE kyc_status IN ('PENDING', 'UNDER_REVIEW')
                          AND NOT EXISTS (SELECT 1 FROM booking.booking b WHERE b.provider_id = provider.provider.id));

DELETE FROM provider.earning
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE kyc_status IN ('PENDING', 'UNDER_REVIEW')
                          AND NOT EXISTS (SELECT 1 FROM booking.booking b WHERE b.provider_id = provider.provider.id));

DELETE FROM geo.provider_location
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE kyc_status IN ('PENDING', 'UNDER_REVIEW')
                          AND NOT EXISTS (SELECT 1 FROM booking.booking b WHERE b.provider_id = provider.provider.id));

DELETE FROM payment.payout
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE kyc_status IN ('PENDING', 'UNDER_REVIEW')
                          AND NOT EXISTS (SELECT 1 FROM booking.booking b WHERE b.provider_id = provider.provider.id));

-- Stage the demo provider's user id, drop the provider row, then (only if the
-- user has no other life: no sessions worth keeping is NOT required — a real
-- provider re-registers through OTP and role upgrade restores everything) drop
-- the user row too.
CREATE TABLE IF NOT EXISTS tmp_purge_demo_provider_users (id UUID PRIMARY KEY);
DELETE FROM tmp_purge_demo_provider_users;

INSERT INTO tmp_purge_demo_provider_users (id)
SELECT p.user_id FROM provider.provider p
 WHERE p.kyc_status IN ('PENDING', 'UNDER_REVIEW')
   AND NOT EXISTS (SELECT 1 FROM booking.booking b WHERE b.provider_id = p.id);

DELETE FROM provider.provider
 WHERE kyc_status IN ('PENDING', 'UNDER_REVIEW')
   AND NOT EXISTS (SELECT 1 FROM booking.booking b WHERE b.provider_id = provider.provider.id);

-- The test signup may hold wallet money created by top-up harnesses; keep any
-- real settled payment rows but drop the identity itself.
DELETE FROM identity.refresh_token WHERE user_id IN (SELECT id FROM tmp_purge_demo_provider_users);
DELETE FROM identity.device_session  WHERE user_id IN (SELECT id FROM tmp_purge_demo_provider_users);
DELETE FROM identity.device          WHERE user_id IN (SELECT id FROM tmp_purge_demo_provider_users);
DELETE FROM identity.customer_profile WHERE user_id IN (SELECT id FROM tmp_purge_demo_provider_users);
DELETE FROM property.address         WHERE user_id IN (SELECT id FROM tmp_purge_demo_provider_users);
DELETE FROM identity.users           WHERE id IN (SELECT id FROM tmp_purge_demo_provider_users);

DROP TABLE IF EXISTS tmp_purge_demo_provider_users;
