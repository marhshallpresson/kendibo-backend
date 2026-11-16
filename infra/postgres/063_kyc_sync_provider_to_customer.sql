-- 063_kyc_sync_provider_to_customer.sql
-- One verified identity per account: users whose provider KYC is VERIFIED get
-- their customer KYC marked VERIFIED too, so the customer app stops asking
-- them to verify. Never downgrades; leaves already-verified customers alone.
-- From now on kycService.syncCustomerFromProvider keeps the two in step.
INSERT INTO kyc.customer (user_id, status, tier, provider, nin_masked, bvn_masked, verified_legal_name,
                          name_aligned, name_alignment_score, submitted_at, reviewed_at, reviewed_by)
SELECT DISTINCT ON (p.user_id)
       p.user_id, 'VERIFIED', GREATEST(COALESCE(p.kyc_tier, 1), 1), p.kyc_provider, p.nin_masked, p.bvn_masked,
       p.verified_legal_name, TRUE, 100, COALESCE(p.kyc_submitted_at, now()), now(), 'sync:provider'
  FROM provider.provider p
 WHERE p.kyc_status = 'VERIFIED' AND p.user_id IS NOT NULL
 ORDER BY p.user_id, p.kyc_reviewed_at DESC NULLS LAST
ON CONFLICT (user_id) DO UPDATE
   SET status = 'VERIFIED',
       tier = GREATEST(kyc.customer.tier, EXCLUDED.tier),
       provider = COALESCE(kyc.customer.provider, EXCLUDED.provider),
       nin_masked = COALESCE(kyc.customer.nin_masked, EXCLUDED.nin_masked),
       bvn_masked = COALESCE(kyc.customer.bvn_masked, EXCLUDED.bvn_masked),
       verified_legal_name = COALESCE(kyc.customer.verified_legal_name, EXCLUDED.verified_legal_name),
       name_aligned = TRUE, name_alignment_score = 100,
       rejection_reason = NULL, pending_reason = NULL,
       reviewed_at = now(), reviewed_by = 'sync:provider', updated_at = now()
 WHERE kyc.customer.status <> 'VERIFIED';
