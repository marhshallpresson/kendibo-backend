-- 035: kyc.customer.provider (which identity service ran the check, e.g.
-- 'prembly'). The customer KYC status and submit queries already use it, but no
-- migration ever created it, so customer verification failed with
-- "column provider does not exist".
ALTER TABLE kyc.customer ADD COLUMN IF NOT EXISTS provider TEXT;
