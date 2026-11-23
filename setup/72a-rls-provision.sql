-- Provision dependencies before deploying the scoped runtime. Does not remove compatibility policies.
-- Apply after the scoped runtime is deployed; no row is deleted.
BEGIN;
CREATE SCHEMA IF NOT EXISTS photo_security;
REVOKE ALL ON SCHEMA photo_security FROM PUBLIC;
GRANT USAGE ON SCHEMA photo_security TO personal_photos_app;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='personal_photos_maintenance') THEN
 CREATE ROLE personal_photos_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS ADMIN snowflake_admin;
 END IF;
END $$;
GRANT CONNECT ON DATABASE postgres TO personal_photos_maintenance;
GRANT USAGE ON SCHEMA public TO personal_photos_maintenance;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_maintenance;
ALTER ROLE personal_photos_maintenance SET search_path=public,pg_catalog;
ALTER ROLE personal_photos_maintenance SET statement_timeout='30s';
-- No membership in the maintenance role is granted to the web login.
CREATE OR REPLACE FUNCTION photo_security.username() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('photos.username',true),'')$$;
CREATE OR REPLACE FUNCTION photo_security.flag(key text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT COALESCE(current_setting('photos.'||key,true)='true',false) AND photo_security.username() IS NOT NULL$$;
CREATE OR REPLACE FUNCTION photo_security.main_admin(who text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT FROM public.gallery_main_admins WHERE username=who)$$;
CREATE OR REPLACE FUNCTION photo_security.gateway_identity(subject text,session_id uuid) RETURNS TABLE(name text,marker uuid,revoked boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT o.name,o.marker,EXISTS(SELECT FROM public.gallery_revoked_sessions r WHERE r.sid=session_id AND r.expires_at>now())
 FROM public.gallery_access_objects o WHERE o.kind='user' AND o.auth0_user_id=subject AND o.state='ready' AND NOT o.deleting$$;
CREATE OR REPLACE FUNCTION photo_security.revoke_session(session_id uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.gallery_revoked_sessions(sid) VALUES(session_id) ON CONFLICT(sid) DO UPDATE SET expires_at=GREATEST(gallery_revoked_sessions.expires_at,EXCLUDED.expires_at);
 BEGIN
  DELETE FROM public.gallery_revoked_sessions WHERE sid IN (SELECT sid FROM public.gallery_revoked_sessions WHERE expires_at<now() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED);
 EXCEPTION WHEN OTHERS THEN NULL;
 END;
END $$;
CREATE OR REPLACE FUNCTION photo_security.public_event() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT l.event_id FROM public.album_public_links l JOIN public.events e USING(event_id)
 WHERE l.token_hash=nullif(current_setting('photos.public_hash',true),'') AND l.revoked_at IS NULL AND l.expires_at>statement_timestamp() AND l.owner_username=e.owner_username$$;
CREATE OR REPLACE FUNCTION photo_security.read_event(id integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT FROM public.events e WHERE e.event_id=id AND (
 (photo_security.username() IS NOT NULL AND (photo_security.flag('main_admin') OR e.owner_username=photo_security.username() OR e.visibility='GALLERY' OR EXISTS(SELECT FROM public.album_shares s WHERE s.event_id=e.event_id AND s.username=photo_security.username())))
 OR e.event_id=photo_security.public_event()))$$;
CREATE OR REPLACE FUNCTION photo_security.edit_event(id integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT photo_security.flag('can_write') AND EXISTS(SELECT FROM public.events e WHERE e.event_id=id AND (e.owner_username=photo_security.username() OR photo_security.flag('main_admin')))$$;
CREATE OR REPLACE FUNCTION photo_security.read_photo(id integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT FROM public.photos p WHERE p.photo_id=id AND photo_security.read_event(p.event_id))$$;
CREATE OR REPLACE FUNCTION photo_security.edit_photo(id integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT FROM public.photos p WHERE p.photo_id=id AND photo_security.edit_event(p.event_id))$$;
CREATE OR REPLACE FUNCTION photo_security.readable_events() RETURNS SETOF integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT e.event_id FROM public.events e WHERE
 (photo_security.username() IS NOT NULL AND (photo_security.flag('main_admin') OR e.owner_username=photo_security.username() OR e.visibility='GALLERY' OR e.event_id IN (SELECT event_id FROM public.album_shares WHERE username=photo_security.username())))
 OR e.event_id=photo_security.public_event()$$;
CREATE OR REPLACE FUNCTION photo_security.editable_events() RETURNS SETOF integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT e.event_id FROM public.events e WHERE photo_security.flag('can_write') AND (photo_security.flag('main_admin') OR e.owner_username=photo_security.username())$$;
CREATE OR REPLACE FUNCTION photo_security.active_username(who text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT photo_security.username() IS NOT NULL AND (EXISTS(SELECT FROM public.gallery_access_objects WHERE kind='user' AND name=who AND state='ready' AND NOT deleting) OR EXISTS(SELECT FROM public.gallery_main_admins WHERE username=who))$$;
CREATE OR REPLACE FUNCTION photo_security.active_upload_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT count(*) FROM public.upload_sessions WHERE result IS NULL AND photo_security.username() IS NOT NULL$$;
CREATE OR REPLACE FUNCTION photo_security.analysis_queue_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT count(*) FROM public.video_analyses WHERE status IN ('queued','running') AND photo_security.flag('admin_write')$$;
CREATE OR REPLACE FUNCTION photo_security.assign_folder(id integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT id IS NULL OR photo_security.flag('main_admin') OR EXISTS(SELECT FROM public.folders f WHERE f.folder_id=id AND f.owner_username=photo_security.username())$$;
CREATE OR REPLACE FUNCTION photo_security.keeps_folder(event integer, folder integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$SELECT EXISTS(SELECT FROM public.events e WHERE e.event_id=event AND e.folder_id IS NOT DISTINCT FROM folder)$$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA photo_security FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA photo_security TO personal_photos_app;
-- Cleanup intents are attributed to the verified writer, never supplied by clients.
ALTER TABLE public.stage_cleanup ADD COLUMN IF NOT EXISTS owner_username text DEFAULT nullif(current_setting('photos.username',true),'');
-- Internal trigger effects cannot be blocked by the user's row scope after a delete.
ALTER FUNCTION public.queue_search_change() SECURITY DEFINER;
ALTER FUNCTION public.queue_search_change() SET search_path=pg_catalog,public;
ALTER FUNCTION public.enqueue_video_playback() SECURITY DEFINER;
ALTER FUNCTION public.enqueue_video_playback() SET search_path=pg_catalog,public;
ALTER FUNCTION public.retire_video_playback() SECURITY DEFINER;
ALTER FUNCTION public.retire_video_playback() SET search_path=pg_catalog,public;
ALTER FUNCTION public.summarize_user_activity() SECURITY DEFINER;
ALTER FUNCTION public.summarize_user_activity() SET search_path=pg_catalog,public;
DROP POLICY IF EXISTS maintenance ON public.events;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.events TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.events TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.photos;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.photos TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.photos TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.folders;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.folders TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.folders TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.album_shares;
DROP POLICY IF EXISTS maintenance ON public.album_public_links;
DROP POLICY IF EXISTS maintenance ON public.photo_trash;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.photo_trash TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.photo_trash TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.user_folder_state;
DROP POLICY IF EXISTS maintenance ON public.upload_sessions;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.upload_sessions TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.upload_sessions TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.upload_start_limits;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.upload_start_limits TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.upload_start_limits TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.upload_chunks;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.upload_chunks TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.upload_chunks TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.upload_jobs;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.upload_jobs TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.upload_jobs TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.upload_files;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.upload_files TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.upload_files TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.album_location_changes;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.album_location_changes TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.album_location_changes TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.album_location_items;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.album_location_items TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.album_location_items TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.video_playback;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.video_playback TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.video_playback TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.video_analyses;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.video_analyses TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.video_analyses TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.video_preparation_runs;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.video_preparation_runs TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.video_preparation_runs TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.gallery_main_admins;
GRANT SELECT ON public.gallery_main_admins TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.gallery_main_admins TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.gallery_access_objects;
GRANT SELECT ON public.gallery_access_objects TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.gallery_access_objects TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.gallery_access_operations;
DROP POLICY IF EXISTS maintenance ON public.gallery_revoked_sessions;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.gallery_revoked_sessions TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.gallery_revoked_sessions TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.identity_log_sync;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.identity_log_sync TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.identity_log_sync TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.user_activity_events;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.user_activity_events TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.user_activity_events TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.user_activity_daily;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.user_activity_daily TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.user_activity_daily TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.user_activity_sessions;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.user_activity_sessions TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.user_activity_sessions TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.user_activity_maintenance;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.user_activity_maintenance TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.user_activity_maintenance TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.app_reports;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.app_reports TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.app_reports TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.storage_snapshots;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.storage_snapshots TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.storage_snapshots TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.cost_work;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.cost_work TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.cost_work TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.cost_index_weights;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.cost_index_weights TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.cost_index_weights TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.stage_cleanup;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.stage_cleanup TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.stage_cleanup TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.search_queue;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.search_queue TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.search_queue TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.maintenance_state;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.maintenance_state TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.maintenance_state TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.travel_lookup_settings;
GRANT SELECT ON public.travel_lookup_settings TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.travel_lookup_settings TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.travel_place_cache;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.travel_place_cache TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.travel_place_cache TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.travel_search_cache;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.travel_search_cache TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.travel_search_cache TO personal_photos_maintenance USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS maintenance ON public.users;
DROP POLICY IF EXISTS gpu_worker ON public.video_playback;
CREATE POLICY gpu_worker ON public.video_playback TO personal_photos_video_worker USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS gpu_worker ON public.video_preparation_runs;
CREATE POLICY gpu_worker ON public.video_preparation_runs TO personal_photos_video_worker USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS gpu_worker ON public.stage_cleanup;
CREATE POLICY gpu_worker ON public.stage_cleanup TO personal_photos_video_worker USING(true) WITH CHECK(true);
GRANT UPDATE(next_request_at) ON public.travel_lookup_settings TO personal_photos_maintenance;
COMMIT;
