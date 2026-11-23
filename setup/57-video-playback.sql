BEGIN;
CREATE TABLE IF NOT EXISTS video_playback (
 photo_id INTEGER PRIMARY KEY,
 original_path TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','failed')),
 stage_path TEXT,
 playlist TEXT,
 file_bytes BIGINT,
 attempts INTEGER NOT NULL DEFAULT 0,
 requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 lease_until TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 error TEXT
);
CREATE INDEX IF NOT EXISTS video_playback_queue ON video_playback(status,requested_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON video_playback TO personal_photos_app;
COMMIT;
