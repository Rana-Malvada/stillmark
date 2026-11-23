SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='personal_photos_search_worker') THEN CREATE ROLE personal_photos_search_worker NOLOGIN NOINHERIT; END IF; END $$;
GRANT USAGE ON SCHEMA public TO personal_photos_search_worker;
GRANT SELECT ON search_catalog_revision TO personal_photos_search_worker;
CREATE TABLE search_enrichment(
 photo_id int PRIMARY KEY REFERENCES photos(photo_id) ON DELETE CASCADE,
 source_path text NOT NULL,
 revision uuid NOT NULL DEFAULT gen_random_uuid(),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
 claim_token uuid,
 lease_until timestamptz,
 attempts int NOT NULL DEFAULT 0,
 ocr_text text,
 ocr_confidence real,
 visual_embedding vector(512),
 model_version text,
 error text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE search_batch_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 requested_by text NOT NULL,
 status text NOT NULL DEFAULT 'starting' CHECK(status IN ('starting','running','completed','failed','cancelled')),
 photo_limit int NOT NULL DEFAULT 100 CHECK(photo_limit BETWEEN 0 AND 100000),
 search_limit int NOT NULL DEFAULT 20 CHECK(search_limit BETWEEN 0 AND 1000),
 photos_done int NOT NULL DEFAULT 0,
 searches_done int NOT NULL DEFAULT 0,
 failures int NOT NULL DEFAULT 0,
 elapsed_ms bigint,
 created_at timestamptz NOT NULL DEFAULT now(),
 heartbeat_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 error text
);
CREATE UNIQUE INDEX one_search_batch ON search_batch_runs((true)) WHERE status IN ('starting','running');
ALTER TABLE search_enrichment ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_enrichment FORCE ROW LEVEL SECURITY;
CREATE POLICY search_asset_read ON search_enrichment FOR SELECT TO personal_photos_app USING(photo_security.read_photo(photo_id));
GRANT SELECT ON search_enrichment TO personal_photos_app;
CREATE POLICY search_asset_maintenance ON search_enrichment TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY search_asset_worker ON search_enrichment TO personal_photos_search_worker USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON search_enrichment TO personal_photos_maintenance;
GRANT SELECT,UPDATE ON search_enrichment TO personal_photos_search_worker;
ALTER TABLE search_batch_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_batch_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY search_run_admin ON search_batch_runs TO personal_photos_app USING(photo_security.flag('main_admin')) WITH CHECK(photo_security.flag('main_admin'));
CREATE POLICY search_run_maintenance ON search_batch_runs TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY search_run_worker ON search_batch_runs TO personal_photos_search_worker USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON search_batch_runs TO personal_photos_app,personal_photos_maintenance;
GRANT SELECT,UPDATE ON search_batch_runs TO personal_photos_search_worker;
CREATE POLICY search_session_worker ON search_sessions TO personal_photos_search_worker USING(expires_at>now()) WITH CHECK(expires_at>now());
GRANT SELECT ON search_sessions TO personal_photos_search_worker;
GRANT UPDATE(reranked_ids,rerank_model,rerank_status,rerank_error,claim_token,lease_until,attempts) ON search_sessions TO personal_photos_search_worker;
CREATE FUNCTION queue_search_enrichment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.media_type='photo' AND NEW.ingest_status='READY' AND NEW.original_stage_path IS NOT NULL THEN
 INSERT INTO public.search_enrichment(photo_id,source_path) VALUES(NEW.photo_id,NEW.original_stage_path)
 ON CONFLICT(photo_id) DO UPDATE SET source_path=EXCLUDED.source_path,revision=gen_random_uuid(),status='queued',
 claim_token=NULL,lease_until=NULL,attempts=0,ocr_text=NULL,ocr_confidence=NULL,visual_embedding=NULL,model_version=NULL,error=NULL,updated_at=now()
 WHERE search_enrichment.source_path<>EXCLUDED.source_path;
 END IF; RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION queue_search_enrichment() FROM PUBLIC;
CREATE TRIGGER queue_search_enrichment AFTER INSERT OR UPDATE OF original_stage_path,ingest_status ON photos FOR EACH ROW EXECUTE FUNCTION queue_search_enrichment();
INSERT INTO search_enrichment(photo_id,source_path) SELECT photo_id,original_stage_path FROM photos WHERE media_type='photo' AND ingest_status='READY' AND original_stage_path IS NOT NULL;
-- Publish OCR into the existing keyword index and revisioned Snowflake outbox.
CREATE FUNCTION publish_search_enrichment() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.status='completed' AND (OLD.status<>'completed' OR NEW.ocr_text IS DISTINCT FROM OLD.ocr_text) THEN
 UPDATE public.photos SET updated_at=now() WHERE photo_id=NEW.photo_id;
 END IF; RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION publish_search_enrichment() FROM PUBLIC;
CREATE TRIGGER publish_search_enrichment AFTER UPDATE ON search_enrichment FOR EACH ROW EXECUTE FUNCTION publish_search_enrichment();
CREATE OR REPLACE FUNCTION prepare_photo_search() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE event_text TEXT; video_text TEXT; ocr TEXT;
BEGIN
 SELECT event_search_text(e) INTO event_text FROM events e WHERE e.event_id=NEW.event_id;
 SELECT search_text INTO video_text FROM video_analyses WHERE photo_id=NEW.photo_id AND status='completed' ORDER BY created_at DESC LIMIT 1;
 SELECT ocr_text INTO ocr FROM search_enrichment WHERE photo_id=NEW.photo_id AND status='completed' AND source_path=NEW.original_stage_path;
 NEW.search_vector := to_tsvector('english',concat_ws(' ',NEW.source_filename,NEW.ai_description,
 array_to_string(NEW.ai_tags,' '),array_to_string(NEW.user_tags,' '),array_to_string(NEW.iptc_keywords,' '),NEW.caption,NEW.iptc_headline,
 NEW.camera_make,NEW.camera_model,NEW.lens_model,NEW.country,NEW.region,NEW.city,NEW.location_name,NEW.date_taken::text,event_text,video_text,ocr));
 RETURN NEW;
END $$;
