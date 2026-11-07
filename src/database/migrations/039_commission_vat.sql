-- 039: VAT (7.5%, COMMISSION_VAT_BPS) on Kendibo's commission, deducted from the
-- provider's share and owed to the tax authority (ledger account 3100).
ALTER TABLE provider.earning ADD COLUMN IF NOT EXISTS vat_kobo BIGINT NOT NULL DEFAULT 0;
