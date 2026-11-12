-- Paga Subsidiary Accounts: each KYC-verified customer gets their own account
-- number (a ledger-backed subsidiary account at Paga). Transfers into it are
-- recorded per sender in payment.va_funding and, once confirmed with Paga,
-- credited to the customer's Kendibo wallet. Paying from the wallet charges the
-- subsidiary account (payment.va_charge). Rotating issues a new account number,
-- moves the balance across and disables the old one (kept, status 'retired').
-- Additive only. 052 and 054 are reserved for other branches.
CREATE TABLE IF NOT EXISTS payment.virtual_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  -- = user_id while this is the customer's live number (pending/active), NULL
  -- otherwise: a plain UNIQUE column allows only one live number per customer.
  live_user_id UUID UNIQUE,
  psp TEXT NOT NULL DEFAULT 'paga' CHECK (psp IN ('paga')),
  env TEXT NOT NULL CHECK (env IN ('sandbox', 'live')),
  account_reference TEXT NOT NULL UNIQUE,
  account_number TEXT,
  account_name TEXT NOT NULL,
  bank_name TEXT NOT NULL DEFAULT 'Paga',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rotating', 'retired', 'failed')),
  create_reference TEXT NOT NULL UNIQUE,
  last_error TEXT,
  retired_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_virtual_account_user ON payment.virtual_account (user_id, status);
CREATE INDEX IF NOT EXISTS idx_virtual_account_number ON payment.virtual_account (account_number);

CREATE TABLE IF NOT EXISTS payment.va_funding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  virtual_account_id UUID NOT NULL REFERENCES payment.virtual_account(id),
  user_id UUID NOT NULL,
  funding_ref TEXT NOT NULL UNIQUE,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  payer_name TEXT,
  payer_bank TEXT,
  payer_account_masked TEXT,
  narration TEXT,
  paid_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'credited', 'unconfirmed')),
  confirmed_by TEXT,
  wallet_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  credited_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_va_funding_user ON payment.va_funding (user_id, created_at);

CREATE TABLE IF NOT EXISTS payment.va_charge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  virtual_account_id UUID NOT NULL REFERENCES payment.virtual_account(id),
  user_id UUID NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  wallet_ref TEXT NOT NULL,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'successful', 'failed', 'reversed')),
  paga_transaction_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_va_charge_user ON payment.va_charge (user_id, created_at);
