-- Apply after 08. Personal labels stay separate from generated and embedded metadata.
BEGIN;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS user_tags TEXT[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS photos_favorites ON photos(photo_id) WHERE favorite=true AND ingest_status='READY';
CREATE OR REPLACE FUNCTION prepare_photo_search() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE event_text TEXT;
BEGIN
 SELECT event_search_text(e) INTO event_text FROM events e WHERE e.event_id = NEW.event_id;
 NEW.search_vector := to_tsvector('english', concat_ws(' ', NEW.source_filename, NEW.ai_description,
 array_to_string(NEW.ai_tags, ' '), array_to_string(NEW.user_tags, ' '), array_to_string(NEW.iptc_keywords, ' '), NEW.caption,
 NEW.camera_make, NEW.camera_model, NEW.lens_model, NEW.country, NEW.region, NEW.city, NEW.location_name, event_text));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS photo_search_prepare ON photos;
CREATE TRIGGER photo_search_prepare BEFORE INSERT OR UPDATE OF source_filename, ai_description, ai_tags, user_tags, iptc_keywords, caption,
 camera_make, camera_model, lens_model, country, region, city, location_name, event_id, updated_at ON photos
 FOR EACH ROW EXECUTE FUNCTION prepare_photo_search();
-- No backfill needed: existing rows have no personal tags. Do not dirty all search documents.
COMMIT;
