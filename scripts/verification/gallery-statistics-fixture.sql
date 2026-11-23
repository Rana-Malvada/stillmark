CREATE ROLE personal_photos_app;
CREATE ROLE personal_photos_maintenance;
CREATE SCHEMA photo_security;
CREATE TABLE events(event_id int PRIMARY KEY,owner_username text NOT NULL,visibility text DEFAULT 'PRIVATE');
CREATE TABLE photos(photo_id int PRIMARY KEY,event_id int NOT NULL REFERENCES events ON DELETE CASCADE,
 media_type text NOT NULL DEFAULT 'photo',ingest_status text NOT NULL DEFAULT 'READY',display_stage_path text DEFAULT 'display/a.jpg',
 ai_description text,ai_claim uuid,ai_attempts int NOT NULL DEFAULT 0,ai_error text,search_synced_at timestamptz,updated_at timestamptz DEFAULT now());
CREATE SEQUENCE search_revision;
CREATE TABLE search_queue(kind text,id int,revision bigint NOT NULL DEFAULT nextval('search_revision'),queued_at timestamptz DEFAULT now(),PRIMARY KEY(kind,id));
CREATE FUNCTION photo_security.username() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('photos.username',true),'')$$;
CREATE FUNCTION photo_security.flag(key text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('photos.'||key,true)='true',false) AND photo_security.username() IS NOT NULL$$;
CREATE FUNCTION photo_security.readable_events() RETURNS SETOF int LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT event_id FROM public.events WHERE owner_username=photo_security.username() OR visibility='GALLERY' OR photo_security.flag('main_admin')$$;
CREATE FUNCTION queue_search_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL;END $$;
CREATE TRIGGER photo_search_queue AFTER INSERT OR UPDATE OR DELETE ON photos FOR EACH ROW EXECUTE FUNCTION queue_search_change('photo');
CREATE TRIGGER event_search_queue AFTER INSERT OR UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION queue_search_change('event');
GRANT USAGE ON SCHEMA photo_security TO personal_photos_app;
INSERT INTO events VALUES(1,'alice','PRIVATE'),(2,'bob','PRIVATE');
INSERT INTO photos(photo_id,event_id) SELECT i,1 FROM generate_series(1,100) i;
INSERT INTO search_queue(kind,id) VALUES('photo',9999);
