-- 026_prembly_kyb_vendor_storefront_dispatch.sql
-- Prembly KYC/KYB, Mandatory CAC verification, Name/Bank Alignment,
-- Vendor Office Pinpointing, Storefront Metadata, and Customer Fast KYC.

ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS cac_number TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS cac_company_name TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS cac_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS bvn_masked TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS verified_legal_name TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS face_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS face_confidence DOUBLE PRECISION;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS name_aligned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS name_alignment_score DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS office_address TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS office_street TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS office_landmark TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS office_city TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS headline TEXT;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS operating_hours JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS storefront_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE provider.provider ADD COLUMN IF NOT EXISTS onboarding_step TEXT NOT NULL DEFAULT 'basic_info';

ALTER TABLE kyc.customer ADD COLUMN IF NOT EXISTS bvn_masked TEXT;
ALTER TABLE kyc.customer ADD COLUMN IF NOT EXISTS verified_legal_name TEXT;
ALTER TABLE kyc.customer ADD COLUMN IF NOT EXISTS face_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE kyc.customer ADD COLUMN IF NOT EXISTS face_confidence DOUBLE PRECISION;
ALTER TABLE kyc.customer ADD COLUMN IF NOT EXISTS name_aligned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE kyc.customer ADD COLUMN IF NOT EXISTS name_alignment_score DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE kyc.customer ADD COLUMN IF NOT EXISTS fast_track_method TEXT;
