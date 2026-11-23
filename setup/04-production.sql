-- REVIEW BEFORE APPLYING. Run with psql -v ON_ERROR_STOP=1 after 02/03.
-- No rows are deleted. Existing duplicate event/hash pairs abort the migration.
BEGIN;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS ai_tags TEXT[];
ALTER TABLE photos ADD COLUMN IF NOT EXISTS ai_error TEXT;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS search_synced_at TIMESTAMPTZ;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS ai_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS ai_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE photos ADD COLUMN IF NOT EXISTS ai_lease_until TIMESTAMPTZ;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS ai_claim UUID;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
ALTER TABLE events ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;
CREATE UNIQUE INDEX IF NOT EXISTS photos_event_hash_unique ON photos(event_id, file_hash) WHERE file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS photos_search_gin ON photos USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS events_search_gin ON events USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS photos_original_path ON photos(original_stage_path);
CREATE INDEX IF NOT EXISTS photos_display_path ON photos(display_stage_path);
CREATE INDEX IF NOT EXISTS photos_thumbnail_path ON photos(thumbnail_stage_path);
CREATE INDEX IF NOT EXISTS photos_ai_pending ON photos(ai_next_attempt_at) WHERE ai_description IS NULL AND ingest_status = 'READY';
CREATE SEQUENCE IF NOT EXISTS search_revision;
CREATE TABLE IF NOT EXISTS search_queue (
  kind TEXT NOT NULL CHECK (kind IN ('photo','event')), id INTEGER NOT NULL,
  revision BIGINT NOT NULL DEFAULT nextval('search_revision'),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(kind,id)
);
CREATE TABLE IF NOT EXISTS maintenance_state (
  name TEXT PRIMARY KEY, next_run TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_success TIMESTAMPTZ, last_error TEXT
);
CREATE TABLE IF NOT EXISTS stage_cleanup (
  path TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_error TEXT
);
CREATE TABLE IF NOT EXISTS upload_sessions (
  upload_id UUID PRIMARY KEY, owner TEXT NOT NULL, total_chunks INTEGER NOT NULL CHECK(total_chunks BETWEEN 1 AND 32),
  bytes BIGINT NOT NULL DEFAULT 0 CHECK(bytes BETWEEN 0 AND 268435456),
  metadata JSONB, result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);
CREATE INDEX IF NOT EXISTS upload_sessions_expiry ON upload_sessions(expires_at);
CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id UUID NOT NULL REFERENCES upload_sessions(upload_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 31),
  data BYTEA NOT NULL CHECK(octet_length(data) BETWEEN 1 AND 8388608),
  hash TEXT NOT NULL, PRIMARY KEY(upload_id, chunk_index)
);
CREATE OR REPLACE FUNCTION event_search_text(e events) RETURNS TEXT LANGUAGE SQL STABLE AS $$
 SELECT concat_ws(' ', e.event_name, e.location, e.event_year::text,
 CASE WHEN e.event_month BETWEEN 1 AND 12 THEN
 (ARRAY['January','February','March','April','May','June','July','August','September','October','November','December'])[e.event_month] END)
$$;
CREATE OR REPLACE FUNCTION prepare_photo_search() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE event_text TEXT;
BEGIN
 SELECT event_search_text(e) INTO event_text FROM events e WHERE e.event_id = NEW.event_id;
 NEW.search_vector := to_tsvector('english', concat_ws(' ', NEW.source_filename, NEW.ai_description,
 array_to_string(NEW.ai_tags, ' '), array_to_string(NEW.iptc_keywords, ' '), NEW.caption,
 NEW.camera_make, NEW.camera_model, NEW.lens_model, NEW.country, NEW.region, NEW.city, NEW.location_name, event_text));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS photo_search_prepare ON photos;
CREATE TRIGGER photo_search_prepare BEFORE INSERT OR UPDATE OF source_filename, ai_description, ai_tags, iptc_keywords, caption,
 camera_make, camera_model, lens_model, country, region, city, location_name, event_id, updated_at ON photos
 FOR EACH ROW EXECUTE FUNCTION prepare_photo_search();
CREATE OR REPLACE FUNCTION prepare_event_search() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.search_vector := to_tsvector('english', event_search_text(NEW)); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS event_search_prepare ON events;
CREATE TRIGGER event_search_prepare BEFORE INSERT OR UPDATE ON events FOR EACH ROW EXECUTE FUNCTION prepare_event_search();
CREATE OR REPLACE FUNCTION queue_search_change() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE item_id INTEGER;
BEGIN
 IF TG_TABLE_NAME = 'photos' THEN
   item_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.photo_id ELSE NEW.photo_id END;
 ELSE
   item_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END;
 END IF;
 INSERT INTO search_queue(kind,id) VALUES (TG_ARGV[0],item_id)
 ON CONFLICT(kind,id) DO UPDATE SET revision=nextval('search_revision'), queued_at=NOW();
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS photo_search_queue ON photos;
CREATE TRIGGER photo_search_queue AFTER INSERT OR DELETE OR UPDATE OF updated_at ON photos
 FOR EACH ROW EXECUTE FUNCTION queue_search_change('photo');
DROP TRIGGER IF EXISTS event_search_queue ON events;
CREATE TRIGGER event_search_queue AFTER INSERT OR DELETE OR UPDATE ON events
 FOR EACH ROW EXECUTE FUNCTION queue_search_change('event');
CREATE OR REPLACE FUNCTION refresh_event_photos() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.event_name,NEW.location,NEW.event_month,NEW.event_year) IS DISTINCT FROM (OLD.event_name,OLD.location,OLD.event_month,OLD.event_year) THEN
   UPDATE photos SET updated_at=NOW() WHERE event_id=NEW.event_id;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS event_photo_search_refresh ON events;
CREATE TRIGGER event_photo_search_refresh AFTER UPDATE ON events FOR EACH ROW EXECUTE FUNCTION refresh_event_photos();
-- Populate indexes and enqueue an initial semantic refresh.
UPDATE events SET updated_at=NOW();
UPDATE photos SET updated_at=NOW();
-- Legacy permanent failures remain paused pending an explicit admin retry.
UPDATE photos SET ai_attempts=3 WHERE ai_error IS NOT NULL AND ai_description IS NULL;
COMMIT;
