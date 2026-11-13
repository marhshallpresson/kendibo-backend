-- Admin console password sign-in. Email OTP cannot be relied on for admin seats
-- (admin@kendibo.ng does not receive mail), so admins sign in with email +
-- password, then the authenticator-app code when 2FA is on. Hash only (scrypt);
-- the password itself is never stored. Additive only.
CREATE TABLE IF NOT EXISTS identity.admin_credential (
  user_id UUID PRIMARY KEY REFERENCES identity.users(id),
  password_hash TEXT NOT NULL,
  must_change BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
