-- Allow payment.payment.psp to record internal wallet settlements alongside PSP rails.
-- A wallet payment is not routed through Bachs/Flutterwave: the money already sits in
-- payment.wallet_txn, so the 'wallet' psp marks the intent row as settled-from-balance.
ALTER TABLE payment.payment DROP CONSTRAINT IF EXISTS payment_constraint_1;
ALTER TABLE payment.payment DROP CONSTRAINT IF EXISTS payment_payment_psp_check;
ALTER TABLE payment.payment ADD CONSTRAINT payment_constraint_1
  CHECK (psp IN ('bachs','flutterwave','wallet'));
