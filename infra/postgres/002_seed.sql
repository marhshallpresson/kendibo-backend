-- 002_seed.sql — Uyo pilot seed: cities, zones, catalog, pricebook, demo roles.
INSERT INTO ledger.account (code, name, type) VALUES
 ('1000','PSP Receivable','asset'), ('1100','Customer Funds Held','held'),
 ('2000','Provider Payable','liability'), ('3000','Platform Revenue','revenue'),
 ('2100','Payout In Flight','asset'), ('3100','Tax Payable (VAT)','liability'),
 ('3200','Promotions / Discounts','expense'), ('2010','Tips Payable (provider)','liability'),
 ('4000','Adjustments','expense'), ('4100','Chargebacks','expense'),
 ('3010','Commission Income','revenue'), ('2200','Refunds Payable','liability')
ON CONFLICT (code) DO NOTHING;

INSERT INTO identity.users (id, phone, email) VALUES
 ('00000000-0000-0000-0000-000000000001', '+2348012345678', 'customer@kendibo.com'),
 ('00000000-0000-0000-0000-000000000002', '+2348098765432', 'provider@kendibo.com'),
 ('00000000-0000-0000-0000-000000000003', NULL, 'ops@kendibo.com')
ON CONFLICT (id) DO NOTHING;
