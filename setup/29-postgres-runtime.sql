-- Run as the database administrator. Password is set separately from a secret.
-- Runtime owns no schema/table and cannot administer PostgreSQL.
BEGIN;
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='personal_photos_app') THEN
  CREATE ROLE personal_photos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS ADMIN snowflake_admin;
 END IF;
END $$;
GRANT CONNECT ON DATABASE postgres TO personal_photos_app;
GRANT USAGE ON SCHEMA public TO personal_photos_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON
 public.photos, public.search_queue, public.maintenance_state, public.stage_cleanup,
 public.app_reports, public.storage_snapshots, public.events, public.folders,
 public.upload_jobs, public.upload_files, public.gallery_access_operations,
 public.gallery_access_objects, public.user_activity_sessions, public.user_activity_maintenance,
 public.identity_log_sync, public.user_activity_daily, public.user_activity_events,
 public.album_shares, public.photo_trash, public.upload_sessions, public.upload_chunks,
 public.travel_place_cache TO personal_photos_app;
GRANT SELECT ON public.gallery_main_admins, public.travel_lookup_settings TO personal_photos_app;
GRANT UPDATE(next_request_at) ON public.travel_lookup_settings TO personal_photos_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO personal_photos_app;
ALTER ROLE personal_photos_app SET search_path = public, pg_catalog;
ALTER ROLE personal_photos_app SET statement_timeout = '30s';
-- No automatic grants on future tables: migrations must declare required access.
COMMIT;
