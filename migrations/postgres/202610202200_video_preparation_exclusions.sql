ALTER TABLE video_playback ADD COLUMN IF NOT EXISTS preparation_skipped BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE video_playback ADD COLUMN IF NOT EXISTS preparation_skipped_path TEXT;
