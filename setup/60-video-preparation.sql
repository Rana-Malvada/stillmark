BEGIN;
CREATE TABLE IF NOT EXISTS video_preparation_runs (
 id UUID PRIMARY KEY,
 requested_by TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('starting','running','completed','attention')),
 total INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 started_at TIMESTAMPTZ,
 finished_at TIMESTAMPTZ,
 heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS video_preparation_single_active ON video_preparation_runs((true)) WHERE status IN ('starting','running');
ALTER TABLE video_playback ADD COLUMN IF NOT EXISTS preparation_run_id UUID REFERENCES video_preparation_runs(id);
CREATE INDEX IF NOT EXISTS video_playback_run ON video_playback(preparation_run_id) WHERE preparation_run_id IS NOT NULL;
GRANT SELECT,INSERT,UPDATE ON video_preparation_runs TO personal_photos_app;
GRANT SELECT,UPDATE ON video_preparation_runs TO personal_photos_video_worker;
COMMIT;
