-- 009_profile.sql — nickname + date of birth on users (Fill/Edit Profile).
-- Avatar uses the existing identity.users.profile_image column.
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS nickname TEXT;
ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS dob DATE;
