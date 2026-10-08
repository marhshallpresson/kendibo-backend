-- 011_media_folders.sql — per-need folders (avatars/photos/videos/docs).
ALTER TABLE media.asset ADD COLUMN IF NOT EXISTS folder TEXT NOT NULL DEFAULT 'photos';
