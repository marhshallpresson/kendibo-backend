-- 019_purge_demo_content.sql — remove the test/demo content that harnesses and
-- pentests previously wrote straight into live databases (017 already removed
-- the three seeded demo identities). Same rules as 017: child-first, every
-- statement is a guarded `DELETE ... WHERE` so re-running is a no-op, and no
-- statement relies on ON CONFLICT behaviour.
--
-- The demo/test account set is computed once into a scratch table and then
-- referenced with shallow `IN (SELECT ...)` subqueries. That keeps every
-- statement idempotent AND runnable on the local pg-mem boot (packages/
-- database/local.ts executes this file too), which cannot evaluate correlated
-- subqueries such as `... WHERE user_id = identity.users.id`.
--
-- What was observed on the live DB and is purged here:
--   * payment.wallet_txn rows whose user_id resolves to nobody — all 30 were
--     `test_<uuid>` harness ids (fake money; no real user is affected).
--   * payment.payment rows pinned to the zero UUID booking (three test
--     top-ups of ₦50 that reference no real booking).
--   * payment.webhook_event pentest rows (`wt_usr_pentest_*` / `chg_12345`).
--   * Synthetic harness accounts: every `<x>-<uuid>@kendibo.local` identity
--     created by tests/*, plus the phone-only rows inserted directly by
--     tests/auth.test.ts:43. A real OTP signup always persists an
--     identity.device_session (verifyOtp -> logDevice), so a phone-only row
--     with no session/token/profile/address/provider/booking cannot be a real
--     customer — only those are staged for deletion. Real accounts (the five
--     gmail identities, any phone account with activity, and the pending
--     user@example.com OTP) are untouched.
--   * Duplicate catalog.checklist seed rows: 004 seeds with ON CONFLICT DO
--     NOTHING but the table had no unique key, so every migrate run added
--     another copy (live DB held 10 identical copies per category). The
--     dedupe keeps one copy of each distinct (category_id, items, version)
--     and the unique index stops it recurring.
--
-- Never touched: reference data (categories, services, addons, pricebook,
-- cities/zones, flags, ledger accounts), real accounts and their sessions/
-- tokens, media assets, and any wallet/payment row that still resolves to an
-- existing user.

-- ---------- 0) stage the demo/test account ids ------------------------------
CREATE TABLE IF NOT EXISTS tmp_purge_demo_users (id UUID PRIMARY KEY);
DELETE FROM tmp_purge_demo_users;

-- 0a) Harness email identities (tests/* insert these directly).
INSERT INTO tmp_purge_demo_users (id)
SELECT id FROM identity.users WHERE email LIKE '%@kendibo.local';

-- 0b) Phone-only rows with no login/dependency trail: a real OTP signup
--     always writes identity.device_session (and real customers have tokens,
--     profiles or addresses), so anything with a single dependent survives
--     staging and is therefore never deleted below.
INSERT INTO tmp_purge_demo_users (id)
SELECT DISTINCT u.id FROM identity.users u
LEFT JOIN identity.device_session s ON s.user_id = u.id
LEFT JOIN identity.refresh_token t ON t.user_id = u.id
LEFT JOIN identity.device d ON d.user_id = u.id
LEFT JOIN identity.customer_profile c ON c.user_id = u.id
LEFT JOIN property.address a ON a.user_id = u.id
LEFT JOIN provider.provider p ON p.user_id = u.id
LEFT JOIN booking.booking b ON b.user_id = u.id
LEFT JOIN booking.booking bc ON bc.customer_id = u.id
WHERE u.email IS NULL AND u.phone IS NOT NULL
  AND s.user_id IS NULL AND t.user_id IS NULL AND d.user_id IS NULL
  AND c.user_id IS NULL AND a.user_id IS NULL AND p.user_id IS NULL
  AND b.id IS NULL AND bc.id IS NULL;

-- ---------- 1) fake money: payments, refunds, reviews, wallet, webhooks ------
-- 1a) Payments hanging off a booking that does not exist (zero UUID, test
--     top-ups) or off a booking owned by a staged demo account. Runs before
--     the booking deletes below.
DELETE FROM payment.payment
 WHERE booking_id = '00000000-0000-0000-0000-000000000000'
    OR booking_id IN (SELECT id FROM booking.booking
                       WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)
                          OR customer_id IN (SELECT id FROM tmp_purge_demo_users)
                          OR provider_id IN (SELECT id FROM provider.provider
                                              WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)));

-- 1b) Refunds on demo bookings (payment.refund is booking-keyed only).
DELETE FROM payment.refund
 WHERE booking_id IN (SELECT id FROM booking.booking
                       WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)
                          OR customer_id IN (SELECT id FROM tmp_purge_demo_users)
                          OR provider_id IN (SELECT id FROM provider.provider
                                              WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)));

-- 1c) Reviews on demo bookings or by demo providers (payment.review has no
--     customer_id column).
DELETE FROM payment.review
 WHERE booking_id IN (SELECT id FROM booking.booking
                       WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)
                          OR customer_id IN (SELECT id FROM tmp_purge_demo_users)
                          OR provider_id IN (SELECT id FROM provider.provider
                                              WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)))
    OR provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

-- 1d) Wallet transactions that resolve to no user (every observed row was a
--     `test_<uuid>` harness id) plus rows owned by the staged demo accounts.
--     Rows owned by existing real users are kept.
DELETE FROM payment.wallet_txn
 WHERE user_id NOT IN (SELECT id::text FROM identity.users)
    OR user_id IN (SELECT id::text FROM tmp_purge_demo_users);

-- 1e) Pentest webhook events (fake charge.successful for chg_12345 sent by
--     scripts/pentest-payments.ts at the live PSP webhook route).
DELETE FROM payment.webhook_event WHERE raw::text LIKE '%wt\_usr\_pentest%';

-- ---------- 2) dependents of staged providers -------------------------------
DELETE FROM provider.skill
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

DELETE FROM provider.availability
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

DELETE FROM provider.quality
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

DELETE FROM provider.earning
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

-- request_offer references provider.provider and booking.service_request, so
-- it must go before either of them is deleted.
DELETE FROM booking.request_offer
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN (SELECT id FROM tmp_purge_demo_users))
    OR request_id IN (SELECT id FROM booking.service_request
                       WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)
                          OR booking_id IN (SELECT id FROM booking.booking
                                             WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)
                                                OR customer_id IN (SELECT id FROM tmp_purge_demo_users)
                                                OR provider_id IN (SELECT id FROM provider.provider
                                                                    WHERE user_id IN (SELECT id FROM tmp_purge_demo_users))));

-- No FK, but logically owned by the demo providers.
DELETE FROM dispatch.assignment
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

DELETE FROM geo.provider_location
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

DELETE FROM payment.payout
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

-- ---------- 3) service requests and bookings of the demo accounts -----------
DELETE FROM booking.service_request
 WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)
    OR booking_id IN (SELECT id FROM booking.booking
                       WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)
                          OR customer_id IN (SELECT id FROM tmp_purge_demo_users)
                          OR provider_id IN (SELECT id FROM provider.provider
                                              WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)));

DELETE FROM booking.booking
 WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)
    OR customer_id IN (SELECT id FROM tmp_purge_demo_users)
    OR provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

-- ---------- 4) properties owned by the demo accounts ------------------------
DELETE FROM property.reminder
 WHERE property_id IN (SELECT id FROM property.property
                        WHERE owner_id IN (SELECT id FROM tmp_purge_demo_users))
    OR asset_id IN (SELECT id FROM property.asset
                     WHERE property_id IN (SELECT id FROM property.property
                                            WHERE owner_id IN (SELECT id FROM tmp_purge_demo_users)));

DELETE FROM property.asset
 WHERE property_id IN (SELECT id FROM property.property
                        WHERE owner_id IN (SELECT id FROM tmp_purge_demo_users));

DELETE FROM property.history
 WHERE property_id IN (SELECT id FROM property.property
                        WHERE owner_id IN (SELECT id FROM tmp_purge_demo_users));

DELETE FROM property.recurring
 WHERE user_id IN (SELECT id FROM tmp_purge_demo_users)
    OR property_id IN (SELECT id FROM property.property
                        WHERE owner_id IN (SELECT id FROM tmp_purge_demo_users));

DELETE FROM property.property
 WHERE owner_id IN (SELECT id FROM tmp_purge_demo_users);

-- Detach surviving rows pointing at demo-owned addresses, then remove them.
UPDATE property.property
   SET address_id = NULL
 WHERE address_id IN (SELECT id FROM property.address
                       WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

UPDATE booking.service_request
   SET address_id = NULL
 WHERE address_id IN (SELECT id FROM property.address
                       WHERE user_id IN (SELECT id FROM tmp_purge_demo_users));

DELETE FROM property.address
 WHERE user_id IN (SELECT id FROM tmp_purge_demo_users);

-- ---------- 5) identity-side dependents of the demo accounts ----------------
DELETE FROM identity.refresh_token
 WHERE user_id IN (SELECT id FROM tmp_purge_demo_users);

DELETE FROM identity.device
 WHERE user_id IN (SELECT id FROM tmp_purge_demo_users);

DELETE FROM identity.device_session
 WHERE user_id IN (SELECT id FROM tmp_purge_demo_users);

DELETE FROM identity.customer_profile
 WHERE user_id IN (SELECT id FROM tmp_purge_demo_users);

-- Test OTP codes for harness identities only — live signup codes are kept
-- (including the phone code 08000000000, which may belong to a real request).
DELETE FROM identity.otp_code
 WHERE identity = 'not-an-email'
    OR identity LIKE '%@kendibo.local';

-- ---------- 6) support / b2b rows of the demo accounts ----------------------
DELETE FROM support.ticket_message
 WHERE ticket_id IN (SELECT id FROM support.ticket
                      WHERE customer_id IN (SELECT id FROM tmp_purge_demo_users));

DELETE FROM support.ticket
 WHERE customer_id IN (SELECT id FROM tmp_purge_demo_users);

DELETE FROM b2b.organisation_user
 WHERE user_id IN (SELECT id FROM tmp_purge_demo_users);

-- ---------- 7) the demo provider entities, then the demo accounts -----------
DELETE FROM provider.provider
 WHERE user_id IN (SELECT id FROM tmp_purge_demo_users);

DELETE FROM identity.users
 WHERE id IN (SELECT id FROM tmp_purge_demo_users);

-- Scratch table is only needed inside this migration.
DROP TABLE IF EXISTS tmp_purge_demo_users;

-- ---------- 8) duplicate checklist seed rows --------------------------------
-- 004 seeds two checklists per migrate run because the table had no unique
-- key for ON CONFLICT to work with. Rebuild the table content from its
-- distinct rows (identical copies collapse to one) and pin the pair with a
-- unique index so future runs of 004 become true no-ops.
CREATE TABLE IF NOT EXISTS tmp_purge_checklist (category_id TEXT, items JSONB, version INTEGER);
DELETE FROM tmp_purge_checklist;
INSERT INTO tmp_purge_checklist (category_id, items, version)
SELECT DISTINCT category_id, items, version FROM catalog.checklist;
DELETE FROM catalog.checklist;
INSERT INTO catalog.checklist (category_id, items, version)
SELECT category_id, items, version FROM tmp_purge_checklist;
DROP TABLE IF EXISTS tmp_purge_checklist;

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_checklist_category_version
  ON catalog.checklist (category_id, version);
