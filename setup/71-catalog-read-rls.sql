-- Initial RLS rollout: scoped read transactions. Existing runtime/worker paths retain
-- their tested application ACLs; this is not a claim of RLS coverage for those paths.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='personal_photos_reader') THEN
  CREATE ROLE personal_photos_reader NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
 END IF;
END $$;
GRANT personal_photos_reader TO personal_photos_app;
GRANT USAGE ON SCHEMA public TO personal_photos_reader;
GRANT SELECT ON events,photos,album_shares TO personal_photos_reader;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE album_shares ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_runtime ON events;
CREATE POLICY catalog_runtime ON events TO personal_photos_app USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS catalog_runtime ON photos;
CREATE POLICY catalog_runtime ON photos TO personal_photos_app USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS catalog_runtime ON album_shares;
CREATE POLICY catalog_runtime ON album_shares TO personal_photos_app USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS catalog_worker ON events;
CREATE POLICY catalog_worker ON events FOR SELECT TO personal_photos_video_worker USING(true);
DROP POLICY IF EXISTS catalog_worker ON photos;
CREATE POLICY catalog_worker ON photos FOR SELECT TO personal_photos_video_worker USING(true);
DROP POLICY IF EXISTS catalog_reader ON album_shares;
CREATE POLICY catalog_reader ON album_shares FOR SELECT TO personal_photos_reader
 USING(username=nullif(current_setting('photos.username',true),''));
DROP POLICY IF EXISTS catalog_reader ON events;
CREATE POLICY catalog_reader ON events FOR SELECT TO personal_photos_reader USING(
 nullif(current_setting('photos.username',true),'') IS NOT NULL AND (
 current_setting('photos.main_admin',true)='true'
 OR owner_username=current_setting('photos.username',true) OR visibility='GALLERY'
 OR event_id IN (SELECT event_id FROM album_shares)
 ));
DROP POLICY IF EXISTS catalog_reader ON photos;
CREATE POLICY catalog_reader ON photos FOR SELECT TO personal_photos_reader USING(event_id IN (SELECT event_id FROM events));
COMMIT;
