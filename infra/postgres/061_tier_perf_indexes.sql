-- 061_tier_perf_indexes.sql
-- Tier requirement checks (completed jobs, rating, open disputes) run on hot
-- paths (dispatch, matching, settlement). Additive indexes only.
CREATE INDEX IF NOT EXISTS idx_earning_provider ON provider.earning (provider_id);
CREATE INDEX IF NOT EXISTS idx_review_provider ON payment.review (provider_id);
CREATE INDEX IF NOT EXISTS idx_dispute_job ON payment.dispute (job_id);
