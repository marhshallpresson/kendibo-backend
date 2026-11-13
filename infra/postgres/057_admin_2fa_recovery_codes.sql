-- 057_admin_2fa_recovery_codes.sql
-- Admin TOTP recovery codes: ten one-time codes issued when 2FA enrolment is
-- verified (and on regenerate). Only SHA-256 hashes are stored; the plaintext
-- is shown once. used_at marks a code as spent. Additive only.

CREATE TABLE IF NOT EXISTS identity.admin_recovery_code (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_recovery_code_user ON identity.admin_recovery_code (user_id);
