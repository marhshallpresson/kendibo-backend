-- Preserve hosted checkout links for safe, idempotent retry of pending payments.
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS checkout_url TEXT;
