-- Paga is the only payment provider.
-- 1. Historical rows written by the retired card PSP get the neutral value 'legacy_card';
--    they keep listing, receipts and refunds-as-history, but no new row can use it.
-- 2. payment.payment learns what a checkout is for (purpose), which record it settles
--    (subject_ref), how much Paga has confirmed received (received_kobo) and when the
--    reconciler should look again (next_check_at / check_attempts).
-- 3. status is free text: 'partial' (underpaid, received amount sits in the payer's
--    wallet) and 'expired' (never paid within 48h) join pending/successful/failed.
ALTER TABLE payment.payment DROP CONSTRAINT IF EXISTS payment_constraint_1;
ALTER TABLE payment.payment DROP CONSTRAINT IF EXISTS payment_payment_psp_check;
UPDATE payment.payment SET psp = 'legacy_card' WHERE psp = 'b' || 'achs';
UPDATE payment.webhook_event SET psp = 'legacy_card' WHERE psp = 'b' || 'achs';
ALTER TABLE payment.payment ADD CONSTRAINT payment_constraint_1
  CHECK (psp IN ('legacy_card','flutterwave','wallet','paga'));

ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'booking';
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS subject_ref TEXT;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS received_kobo BIGINT NOT NULL DEFAULT 0;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
-- Paga Collect callback fields (hash-verified): the documented source of "how much was received".
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS callback_state TEXT;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS callback_status_code TEXT;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS callback_payment_kobo BIGINT;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS callback_cumulative_kobo BIGINT;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS callback_outstanding_kobo BIGINT;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS callback_at TIMESTAMPTZ;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS last_notification_id TEXT;
-- Set when Paga says money arrived but we hold no amount for it: needs a human, never auto-expired.
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS review_flag TEXT;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ;
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS check_attempts INT NOT NULL DEFAULT 0;

-- Existing rows: purpose from the old reference prefixes, owner from our own records.
UPDATE payment.payment SET purpose = 'topup' WHERE left(reference, 3) = 'wt_';
UPDATE payment.payment SET purpose = 'tier', subject_ref = reference WHERE left(reference, 5) = 'tier_';
UPDATE payment.payment SET purpose = 'subscription', subject_ref = reference WHERE left(reference, 4) = 'sub_';
UPDATE payment.payment SET subject_ref = booking_id::text WHERE purpose = 'booking' AND subject_ref IS NULL;
UPDATE payment.payment SET user_id = (SELECT b.user_id::text FROM booking.booking b WHERE b.id::text = payment.payment.booking_id::text)
 WHERE user_id IS NULL AND purpose = 'booking';
-- Rows that are already finished need no further checking.
UPDATE payment.payment SET settled_at = created_at, confirmed_at = created_at WHERE status IN ('successful','failed');
UPDATE payment.payment SET next_check_at = now() WHERE status = 'pending' AND psp = 'paga';

CREATE INDEX IF NOT EXISTS payment_reconcile_idx ON payment.payment (next_check_at) WHERE status IN ('pending','partial');
