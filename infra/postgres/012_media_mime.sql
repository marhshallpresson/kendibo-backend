-- 012_media_mime.sql — store MIME + filename for correct Content-Type serving.
ALTER TABLE media.asset ADD COLUMN IF NOT EXISTS mime TEXT;
ALTER TABLE media.asset ADD COLUMN IF NOT EXISTS filename TEXT;
