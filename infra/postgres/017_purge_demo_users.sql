-- 017_purge_demo_users.sql — remove the seeded demo users from live databases.
-- Historically 002_seed.sql inserted three demo identities:
--   00000000-0000-0000-0000-000000000001  customer@kendibo.com
--   00000000-0000-0000-0000-000000000002  provider@kendibo.com
--   00000000-0000-0000-0000-000000000003  ops@kendibo.com
-- Editing 002 only fixes fresh installs, so this migration cleans the rows out
-- of already-provisioned databases. It is idempotent (every statement filters by
-- the three UUIDs; re-running deletes nothing) and child-first so foreign keys
-- to identity.users and provider.provider stay satisfied. Legitimate reference
-- data (catalog, cities, zones, pricebook, ledger accounts) is never touched.

-- 1) Dependents of the demo providers (provider.provider -> identity.users).
DELETE FROM provider.skill
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                          '00000000-0000-0000-0000-000000000002',
                                          '00000000-0000-0000-0000-000000000003'));

DELETE FROM provider.availability
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                          '00000000-0000-0000-0000-000000000002',
                                          '00000000-0000-0000-0000-000000000003'));

DELETE FROM provider.quality
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                          '00000000-0000-0000-0000-000000000002',
                                          '00000000-0000-0000-0000-000000000003'));

DELETE FROM provider.earning
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                          '00000000-0000-0000-0000-000000000002',
                                          '00000000-0000-0000-0000-000000000003'));

-- request_offer references both provider.provider and booking.service_request,
-- so it must go before either of them is deleted.
DELETE FROM booking.request_offer
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                          '00000000-0000-0000-0000-000000000002',
                                          '00000000-0000-0000-0000-000000000003'))
    OR request_id IN (SELECT id FROM booking.service_request
                       WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                         '00000000-0000-0000-0000-000000000002',
                                         '00000000-0000-0000-0000-000000000003'));

-- No FK, but logically owned by the demo providers.
DELETE FROM dispatch.assignment
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                          '00000000-0000-0000-0000-000000000002',
                                          '00000000-0000-0000-0000-000000000003'));

DELETE FROM geo.provider_location
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                          '00000000-0000-0000-0000-000000000002',
                                          '00000000-0000-0000-0000-000000000003'));

DELETE FROM payment.payout
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                          '00000000-0000-0000-0000-000000000002',
                                          '00000000-0000-0000-0000-000000000003'));

DELETE FROM payment.review
 WHERE provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                          '00000000-0000-0000-0000-000000000002',
                                          '00000000-0000-0000-0000-000000000003'));

-- 2) Service requests of the demo users (booking.service_request -> identity.users
-- and -> booking.booking). Must precede the booking and user deletes.
DELETE FROM booking.service_request
 WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                   '00000000-0000-0000-0000-000000000002',
                   '00000000-0000-0000-0000-000000000003')
    OR booking_id IN (SELECT id FROM booking.booking
                       WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                         '00000000-0000-0000-0000-000000000002',
                                         '00000000-0000-0000-0000-000000000003')
                          OR customer_id IN ('00000000-0000-0000-0000-000000000001',
                                             '00000000-0000-0000-0000-000000000002',
                                             '00000000-0000-0000-0000-000000000003')
                          OR provider_id IN (SELECT id FROM provider.provider
                                              WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                                                '00000000-0000-0000-0000-000000000002',
                                                                '00000000-0000-0000-0000-000000000003')));

-- 3) Bookings involving the demo customers or demo providers, plus their
-- booking-keyed rows (no FK enforcement on booking.booking -> these, but they
-- are demo data and would otherwise dangle).
DELETE FROM payment.payment
 WHERE booking_id IN (SELECT id FROM booking.booking
                       WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                         '00000000-0000-0000-0000-000000000002',
                                         '00000000-0000-0000-0000-000000000003')
                          OR customer_id IN ('00000000-0000-0000-0000-000000000001',
                                             '00000000-0000-0000-0000-000000000002',
                                             '00000000-0000-0000-0000-000000000003')
                          OR provider_id IN (SELECT id FROM provider.provider
                                              WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                                                '00000000-0000-0000-0000-000000000002',
                                                                '00000000-0000-0000-0000-000000000003')));

DELETE FROM payment.refund
 WHERE booking_id IN (SELECT id FROM booking.booking
                       WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                         '00000000-0000-0000-0000-000000000002',
                                         '00000000-0000-0000-0000-000000000003')
                          OR customer_id IN ('00000000-0000-0000-0000-000000000001',
                                             '00000000-0000-0000-0000-000000000002',
                                             '00000000-0000-0000-0000-000000000003')
                          OR provider_id IN (SELECT id FROM provider.provider
                                              WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                                                '00000000-0000-0000-0000-000000000002',
                                                                '00000000-0000-0000-0000-000000000003')));

DELETE FROM payment.review
 WHERE booking_id IN (SELECT id FROM booking.booking
                       WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                         '00000000-0000-0000-0000-000000000002',
                                         '00000000-0000-0000-0000-000000000003')
                          OR customer_id IN ('00000000-0000-0000-0000-000000000001',
                                             '00000000-0000-0000-0000-000000000002',
                                             '00000000-0000-0000-0000-000000000003')
                          OR provider_id IN (SELECT id FROM provider.provider
                                              WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                                                '00000000-0000-0000-0000-000000000002',
                                                                '00000000-0000-0000-0000-000000000003')));

-- booking.booking.customer_id is an FK to identity.users; clear these before users.
DELETE FROM booking.booking
 WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                   '00000000-0000-0000-0000-000000000002',
                   '00000000-0000-0000-0000-000000000003')
    OR customer_id IN ('00000000-0000-0000-0000-000000000001',
                       '00000000-0000-0000-0000-000000000002',
                       '00000000-0000-0000-0000-000000000003')
    OR provider_id IN (SELECT id FROM provider.provider
                        WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                          '00000000-0000-0000-0000-000000000002',
                                          '00000000-0000-0000-0000-000000000003'));

-- 4) Properties owned by the demo users and their dependent rows.
DELETE FROM property.reminder
 WHERE property_id IN (SELECT id FROM property.property
                        WHERE owner_id IN ('00000000-0000-0000-0000-000000000001',
                                           '00000000-0000-0000-0000-000000000002',
                                           '00000000-0000-0000-0000-000000000003'))
    OR asset_id IN (SELECT id FROM property.asset
                     WHERE property_id IN (SELECT id FROM property.property
                                            WHERE owner_id IN ('00000000-0000-0000-0000-000000000001',
                                                               '00000000-0000-0000-0000-000000000002',
                                                               '00000000-0000-0000-0000-000000000003')));

DELETE FROM property.asset
 WHERE property_id IN (SELECT id FROM property.property
                        WHERE owner_id IN ('00000000-0000-0000-0000-000000000001',
                                           '00000000-0000-0000-0000-000000000002',
                                           '00000000-0000-0000-0000-000000000003'));

DELETE FROM property.history
 WHERE property_id IN (SELECT id FROM property.property
                        WHERE owner_id IN ('00000000-0000-0000-0000-000000000001',
                                           '00000000-0000-0000-0000-000000000002',
                                           '00000000-0000-0000-0000-000000000003'));

DELETE FROM property.recurring
 WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                   '00000000-0000-0000-0000-000000000002',
                   '00000000-0000-0000-0000-000000000003')
    OR property_id IN (SELECT id FROM property.property
                        WHERE owner_id IN ('00000000-0000-0000-0000-000000000001',
                                           '00000000-0000-0000-0000-000000000002',
                                           '00000000-0000-0000-0000-000000000003'));

DELETE FROM property.property
 WHERE owner_id IN ('00000000-0000-0000-0000-000000000001',
                    '00000000-0000-0000-0000-000000000002',
                    '00000000-0000-0000-0000-000000000003');

-- Detach any surviving rows that point at demo-owned addresses, then remove the
-- addresses (property.address -> identity.users).
UPDATE property.property
   SET address_id = NULL
 WHERE address_id IN (SELECT id FROM property.address
                       WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                         '00000000-0000-0000-0000-000000000002',
                                         '00000000-0000-0000-0000-000000000003'));

UPDATE booking.service_request
   SET address_id = NULL
 WHERE address_id IN (SELECT id FROM property.address
                       WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                                         '00000000-0000-0000-0000-000000000002',
                                         '00000000-0000-0000-0000-000000000003'));

DELETE FROM property.address
 WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                   '00000000-0000-0000-0000-000000000002',
                   '00000000-0000-0000-0000-000000000003');

-- 5) Remaining identity-side dependents of the demo users.
DELETE FROM identity.refresh_token
 WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                   '00000000-0000-0000-0000-000000000002',
                   '00000000-0000-0000-0000-000000000003');

DELETE FROM identity.device
 WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                   '00000000-0000-0000-0000-000000000002',
                   '00000000-0000-0000-0000-000000000003');

DELETE FROM identity.device_session
 WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                   '00000000-0000-0000-0000-000000000002',
                   '00000000-0000-0000-0000-000000000003');

DELETE FROM identity.customer_profile
 WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                   '00000000-0000-0000-0000-000000000002',
                   '00000000-0000-0000-0000-000000000003');

DELETE FROM support.ticket_message
 WHERE ticket_id IN (SELECT id FROM support.ticket
                      WHERE customer_id IN ('00000000-0000-0000-0000-000000000001',
                                            '00000000-0000-0000-0000-000000000002',
                                            '00000000-0000-0000-0000-000000000003'));

DELETE FROM support.ticket
 WHERE customer_id IN ('00000000-0000-0000-0000-000000000001',
                       '00000000-0000-0000-0000-000000000002',
                       '00000000-0000-0000-0000-000000000003');

DELETE FROM b2b.organisation_user
 WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                   '00000000-0000-0000-0000-000000000002',
                   '00000000-0000-0000-0000-000000000003');

-- 6) Demo provider rows (all dependents above are gone).
DELETE FROM provider.provider
 WHERE user_id IN ('00000000-0000-0000-0000-000000000001',
                   '00000000-0000-0000-0000-000000000002',
                   '00000000-0000-0000-0000-000000000003');

-- 7) Finally the demo users themselves.
DELETE FROM identity.users
 WHERE id IN ('00000000-0000-0000-0000-000000000001',
              '00000000-0000-0000-0000-000000000002',
              '00000000-0000-0000-0000-000000000003');
