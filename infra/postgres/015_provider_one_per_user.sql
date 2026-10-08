-- One provider row per user: dedupe existing rows (keep the earliest) then
-- enforce uniqueness so POST /v1/provider/onboarding can be idempotent.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY created_at, id) AS rn
  FROM provider.provider
)
DELETE FROM provider.provider p
USING ranked r
WHERE p.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS provider_one_per_user
  ON provider.provider (user_id);
