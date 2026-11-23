-- Minimal native-Postgres fixture for the actual migration's locking protocol.
-- Complete permission resolution is covered by customer-accounts-postgres.test.ts.
CREATE ROLE personal_photos_app;
CREATE ROLE personal_photos_upload_queue;
CREATE SCHEMA photo_security;
GRANT USAGE ON SCHEMA photo_security,public TO personal_photos_app,personal_photos_upload_queue;
CREATE FUNCTION photo_security.username() RETURNS text LANGUAGE sql STABLE AS
 $$SELECT nullif(current_setting('photos.username',true),'')$$;
CREATE TABLE gallery_access_objects(marker uuid PRIMARY KEY,name text UNIQUE,kind text DEFAULT 'user',state text DEFAULT 'ready',deleting boolean DEFAULT false);
CREATE TABLE photo_security.app_principals(marker uuid PRIMARY KEY REFERENCES gallery_access_objects,enabled boolean DEFAULT true,revision bigint DEFAULT 1);
CREATE TABLE photo_security.customer_accounts(marker uuid PRIMARY KEY REFERENCES gallery_access_objects,deletion_requested_at timestamptz);
CREATE FUNCTION photo_security.native_app_identity(owner_name text)
 RETURNS TABLE(marker uuid,enabled boolean,can_manage_personal boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT o.marker,p.enabled,true FROM public.gallery_access_objects o JOIN photo_security.app_principals p USING(marker)
 WHERE o.name=owner_name AND o.state='ready' AND NOT o.deleting
 $$;
CREATE FUNCTION photo_security.app_permission_snapshot(target uuid)
 RETURNS TABLE(app_owner boolean,can_manage_access boolean) LANGUAGE sql STABLE AS $$SELECT false,false$$;
CREATE TABLE upload_sessions(upload_id uuid PRIMARY KEY,owner text,result jsonb,completion_token uuid,completion_lease_until timestamptz);
CREATE TABLE upload_processing_jobs(upload_id uuid PRIMARY KEY REFERENCES upload_sessions ON DELETE CASCADE,owner text,state text,lease_token uuid,lease_until timestamptz);
CREATE TABLE upload_chunks(upload_id uuid REFERENCES upload_sessions ON DELETE CASCADE,stage_path text);
CREATE TABLE stage_cleanup(path text PRIMARY KEY,next_attempt timestamptz DEFAULT now());
CREATE TABLE album_public_links(owner_username text,revoked_at timestamptz);
CREATE TABLE catalog(upload_id uuid PRIMARY KEY);
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO personal_photos_app;
ALTER TABLE upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON upload_sessions TO personal_photos_app USING(owner=photo_security.username());
ALTER TABLE upload_processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_processing_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY owner ON upload_processing_jobs TO personal_photos_app USING(owner=photo_security.username());
INSERT INTO gallery_access_objects(marker,name) VALUES
 ('00000000-0000-4000-8000-000000000001','ALICE'),('00000000-0000-4000-8000-000000000002','BOB');
INSERT INTO photo_security.app_principals(marker) SELECT marker FROM gallery_access_objects;
INSERT INTO photo_security.customer_accounts(marker) SELECT marker FROM gallery_access_objects;
