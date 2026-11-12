-- 054_admin_console_security.sql
-- Admin console: account suspension, admin TOTP two-factor, admin login
-- lockout, admin session idle tracking and richer audit rows. Additive only.
-- Applied by scripts/migrate.ts (prod) and packages/database/local.ts (pg-mem).

-- identity.users.status already exists (003: 'active' | 'inactive' | 'deleted');
-- 'suspended' is a new value set by admins. sessions_revoked_at rejects access
-- tokens issued before it (admin "sign out everywhere" / suspend).
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS suspended_by TEXT;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS sessions_revoked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_status ON identity.users (status);

-- Admin TOTP (RFC 6238). Secrets are AES-256-GCM encrypted with a server key;
-- pending_secret_enc holds an enrollment not yet confirmed with a code.
CREATE TABLE IF NOT EXISTS identity.admin_2fa (
  user_id UUID PRIMARY KEY REFERENCES identity.users(id),
  secret_enc TEXT,
  pending_secret_enc TEXT,
  enabled_at TIMESTAMPTZ,
  last_used_step BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A first factor (OTP / Google) passed for an admin with 2FA on: the session is
-- issued only when POST /v1/admin/login/2fa answers this challenge.
CREATE TABLE IF NOT EXISTS identity.admin_login_challenge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  device JSONB,
  ip TEXT,
  user_agent TEXT,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_login_challenge_user ON identity.admin_login_challenge (user_id);

-- Admin login lockout: one row per key ('acct:<userId>' or 'ip:<address>').
CREATE TABLE IF NOT EXISTS identity.admin_login_lock (
  key TEXT PRIMARY KEY,
  failures INT NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Admin session idle tracking. Access JWTs stay stateless; sid (the refresh
-- token's device id, carried in the access token) keys this table.
CREATE TABLE IF NOT EXISTS identity.admin_session (
  sid TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES identity.users(id),
  mfa_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_session_user ON identity.admin_session (user_id);

-- Audit rows carry who/where/why.
ALTER TABLE audit.log ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE audit.log ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE audit.log ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE audit.log ADD COLUMN IF NOT EXISTS meta JSONB;
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit.log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit.log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit.log (actor);
