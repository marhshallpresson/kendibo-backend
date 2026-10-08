-- 010_auth_google_devices.sql — Google SSO subject + silent device history.
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON identity.users(google_sub);

CREATE TABLE IF NOT EXISTS identity.device_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.users(id),
  device_fp TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'unknown',
  model TEXT,
  os TEXT,
  app_version TEXT,
  ip TEXT,
  city TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_fp)
);
