-- Manual video analysis. History survives trash/restore; permanent purge removes it.
BEGIN;
CREATE TABLE IF NOT EXISTS video_analyses (
 id UUID PRIMARY KEY,
 photo_id INTEGER NOT NULL,
 requested_by TEXT NOT NULL,
 owner_username TEXT NOT NULL,
 model TEXT NOT NULL,
 prompt_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
 result JSONB,
 search_text TEXT,
 error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 started_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 phase TEXT,
 compressed BOOLEAN NOT NULL DEFAULT FALSE,
 analysis_bytes BIGINT,
 lease_until TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS video_analyses_photo ON video_analyses(photo_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS video_analyses_active ON video_analyses(photo_id) WHERE status IN ('queued','running');
CREATE OR REPLACE FUNCTION prepare_photo_search() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE event_text TEXT; video_text TEXT;
BEGIN
 SELECT event_search_text(e) INTO event_text FROM events e WHERE e.event_id=NEW.event_id;
 SELECT search_text INTO video_text FROM video_analyses WHERE photo_id=NEW.photo_id AND status='completed' ORDER BY created_at DESC LIMIT 1;
 NEW.search_vector := to_tsvector('english',concat_ws(' ',NEW.source_filename,NEW.ai_description,
 array_to_string(NEW.ai_tags,' '),array_to_string(NEW.user_tags,' '),array_to_string(NEW.iptc_keywords,' '),NEW.caption,
 NEW.camera_make,NEW.camera_model,NEW.lens_model,NEW.country,NEW.region,NEW.city,NEW.location_name,event_text,video_text));
 RETURN NEW;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON video_analyses TO personal_photos_app;
COMMIT;
