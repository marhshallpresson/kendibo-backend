-- 062_pricing_config_seed.sql
-- Urgent / weekend surcharges and the cancellation refund matrix now live in
-- the database (VAT, platform fee and per-km rate already do: catalog.pricebook).
-- Edited by admins via PUT /v1/admin/settings/pricing (configuration:edit).
-- modules/pricing/pricing.config.ts keeps the same numbers only as a fallback.
-- Rates are basis points (2000 = 20%). Never overwrites an existing row.
INSERT INTO configuration.platform_setting (key, value) VALUES
  ('pricing.config', '{
    "urgencyBps": 2000,
    "weekendBps": 1000,
    "cancellation": {
      "before_assignment":  {"refundBps": 10000, "calloutApplies": false},
      "assigned_no_travel": {"refundBps": 10000, "calloutApplies": false},
      "en_route":           {"refundBps": 8500,  "calloutApplies": false},
      "arrived":            {"refundBps": 8000,  "calloutApplies": true},
      "work_started":       {"refundBps": 5000,  "calloutApplies": true}
    }
  }')
ON CONFLICT (key) DO NOTHING;
