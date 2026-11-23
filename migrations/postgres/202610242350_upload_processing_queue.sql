SET LOCAL lock_timeout='5s';
-- Provision the LOGIN/password separately as a Snowflake password secret. Never
-- give the upload worker the general maintenance credential.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='personal_photos_upload_queue') THEN
  CREATE ROLE personal_photos_upload_queue NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;
GRANT CONNECT ON DATABASE postgres TO personal_photos_upload_queue;
GRANT USAGE ON SCHEMA public TO personal_photos_upload_queue;
CREATE TABLE public.upload_processing_jobs (
 upload_id uuid PRIMARY KEY REFERENCES public.upload_sessions(upload_id) ON DELETE CASCADE,
 owner text NOT NULL,
 body jsonb NOT NULL,
 thumbnail jsonb,
 caller jsonb NOT NULL,
 auth_epoch text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','done','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 lease_until timestamptz,
 executor text CHECK(executor IN ('app','pool')),
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upload_processing_ready ON public.upload_processing_jobs(next_attempt,created_at)
 WHERE state='queued';
CREATE INDEX upload_processing_expired ON public.upload_processing_jobs(lease_until)
 WHERE state='processing';
CREATE INDEX upload_processing_owner ON public.upload_processing_jobs(owner,state);
ALTER TABLE public.upload_processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_processing_jobs FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON public.upload_processing_jobs TO personal_photos_app;
CREATE POLICY app ON public.upload_processing_jobs TO personal_photos_app
 USING(owner=photo_security.username())
 WITH CHECK(owner=photo_security.username() AND photo_security.flag('can_write'));
GRANT SELECT,UPDATE ON public.upload_processing_jobs TO personal_photos_upload_queue;
CREATE POLICY worker ON public.upload_processing_jobs TO personal_photos_upload_queue USING(true) WITH CHECK(true);
GRANT SELECT ON public.upload_routing TO personal_photos_upload_queue;
CREATE POLICY queue_worker ON public.upload_routing FOR SELECT TO personal_photos_upload_queue USING(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.upload_processing_jobs TO personal_photos_maintenance;
CREATE POLICY maintenance ON public.upload_processing_jobs TO personal_photos_maintenance USING(true) WITH CHECK(true);
-- Receiving admission excludes durably queued jobs, so processing does not hold
-- one of the user's four network transfer slots.
CREATE OR REPLACE FUNCTION photo_security.active_upload_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT count(*) FROM public.upload_sessions s WHERE result IS NULL AND photo_security.username() IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.upload_processing_jobs j WHERE j.upload_id=s.upload_id)
$$;
