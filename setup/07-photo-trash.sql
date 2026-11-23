BEGIN;
CREATE TABLE IF NOT EXISTS photo_trash (
  photo_id INTEGER PRIMARY KEY,
  photo_data JSONB NOT NULL,
  album_name TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
);
CREATE INDEX IF NOT EXISTS photo_trash_expiry ON photo_trash(expires_at);
CREATE INDEX IF NOT EXISTS photo_trash_original ON photo_trash((photo_data->>'original_stage_path'));
CREATE INDEX IF NOT EXISTS photo_trash_display ON photo_trash((photo_data->>'display_stage_path'));
CREATE INDEX IF NOT EXISTS photo_trash_thumbnail ON photo_trash((photo_data->>'thumbnail_stage_path'));
CREATE INDEX IF NOT EXISTS photos_event_date ON photos(event_id, date_taken, photo_id);
COMMIT;
