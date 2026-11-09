-- booking.job_event never had the columns the job engine reads and writes:
-- - reason: exception flags (DISPUTED, REFUND_PENDING, SUSPENDED...), unflags and
--   reschedules are recorded here. Without it flagsOf() silently returned no
--   flags, so a dispute never held a job's auto-confirmation or payout.
-- - client_event_id: makes the provider app's offline sync idempotent.
-- - lat/lng: where the provider was when the step was recorded.
ALTER TABLE booking.job_event ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE booking.job_event ADD COLUMN IF NOT EXISTS client_event_id TEXT;
ALTER TABLE booking.job_event ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
ALTER TABLE booking.job_event ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_event_client_event_id ON booking.job_event (client_event_id) WHERE client_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_event_job_created ON booking.job_event (job_id, created_at DESC);
