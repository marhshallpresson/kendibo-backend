-- Paga (sandbox first): a second PSP behind PaymentPort.
-- - payment.payment.psp may be 'paga'
-- - psp_details keeps the PSP's payment instructions (Paga: account number,
--   bank, amount to pay, expiry) so the pay page can show them again
-- - identity.users.is_test marks accounts allowed to use Paga sandbox while
--   PAGA_MODE=test-accounts; real accounts never reach sandbox money
ALTER TABLE payment.payment DROP CONSTRAINT IF EXISTS payment_constraint_1;
ALTER TABLE payment.payment DROP CONSTRAINT IF EXISTS payment_payment_psp_check;
ALTER TABLE payment.payment ADD CONSTRAINT payment_constraint_1
  CHECK (psp IN ('bachs','flutterwave','wallet','paga'));
ALTER TABLE payment.payment ADD COLUMN IF NOT EXISTS psp_details JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
