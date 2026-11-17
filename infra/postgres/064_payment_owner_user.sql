-- Wallet top-ups: store the paying user on the payment row so the credit is
-- derived from our own record (never parsed back out of the reference string).
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS user_id TEXT;
-- Top-up references are minted server-side as wt_<userId>_<key>; backfill any existing rows.
UPDATE payment.payment SET user_id = split_part(reference, '_', 2)
 WHERE user_id IS NULL AND left(reference, 3) = 'wt_' AND booking_id = '00000000-0000-0000-0000-000000000000';
