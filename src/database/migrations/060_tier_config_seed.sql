-- 060_tier_config_seed.sql
-- Tier prices, limits and perks now live in the database: this row is the
-- source of truth, edited by admins via PUT /v1/admin/settings/tiers
-- (permission configuration:edit). modules/tiers/tier.config.ts keeps its
-- defaults only as a last-resort fallback when the row is missing or invalid.
-- Kobo values are strings. Never overwrites an existing row.
INSERT INTO configuration.platform_setting (key, value) VALUES
  ('tiers.config', '{
    "standardCommissionBps": 1500,
    "tiers": {
      "1": {"name": "Starter", "badge": "ID checked", "maxJobKobo": "5000000", "maxOpenJobs": 3, "maxListings": 10, "payoutHoldHours": 48, "commissionBps": null, "rankBoost": 0},
      "2": {"name": "Verified", "badge": "Verified pro", "maxJobKobo": "50000000", "maxOpenJobs": 10, "maxListings": 100, "payoutHoldHours": 24, "commissionBps": null, "rankBoost": 3},
      "3": {"name": "Pro / Business", "badge": "Kendibo Pro", "businessBadge": "Verified business", "maxJobKobo": null, "maxOpenJobs": null, "maxListings": null, "payoutHoldHours": 0, "commissionBps": 1200, "rankBoost": 8}
    },
    "upgradeFeeKobo": {"2": "250000", "3": {"individual": "1000000", "business": "2000000"}},
    "refundAfterJobs": {"2": 3, "3": 10},
    "tier1": {"minCategories": 1},
    "tier2": {"minPortfolioPhotos": 2, "minReferences": 1},
    "tier3": {"minCompletedJobs": 10, "minRating": 4.5, "largeJobFlagKobo": "200000000"},
    "pro": {"plan": "pro_monthly", "priceKobo": "300000", "periodDays": 30, "minTier": 2, "commissionBps": 1200, "rankBoost": 5,
            "benefits": ["Ranking boost", "Commission 12% instead of 15%", "Featured in WhatsApp suggestions", "Performance analytics"]}
  }')
ON CONFLICT (key) DO NOTHING;
