SET LOCAL lock_timeout='5s';
CREATE TABLE public.background_coordinator (
 name text PRIMARY KEY,
 owner uuid NOT NULL,
 lease_until timestamptz NOT NULL
);
REVOKE ALL ON public.background_coordinator FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.background_coordinator TO personal_photos_maintenance;

-- Preserve single-use claims and their retention margin. Housekeeping is no
-- longer a side effect of every authenticated read.
CREATE OR REPLACE FUNCTION photo_security.gateway_identity_once(subject text, session_id uuid, assertion_id uuid, expiry bigint)
 RETURNS TABLE(name text, marker uuid, revoked boolean, epoch bigint)
 LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH claim AS (
  INSERT INTO photo_security.gateway_assertions(jti,expires_at)
  SELECT assertion_id,to_timestamp(expiry)+interval '5 seconds'
  WHERE expiry > extract(epoch FROM clock_timestamp())
    AND expiry <= extract(epoch FROM clock_timestamp())+35
  ON CONFLICT DO NOTHING RETURNING jti
 )
 SELECT i.name,i.marker,i.revoked,photo_security.authorization_epoch()
 FROM claim CROSS JOIN photo_security.gateway_identity(subject,session_id) i
 $$;
CREATE FUNCTION photo_security.cleanup_gateway_assertions(batch_size integer DEFAULT 10000)
 RETURNS bigint LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH removed AS (
  DELETE FROM photo_security.gateway_assertions WHERE jti IN (
   SELECT jti FROM photo_security.gateway_assertions WHERE expires_at<statement_timestamp()
   ORDER BY expires_at LIMIT LEAST(GREATEST(batch_size,1),50000) FOR UPDATE SKIP LOCKED
  ) RETURNING 1
 ) SELECT count(*) FROM removed
 $$;
REVOKE ALL ON FUNCTION photo_security.cleanup_gateway_assertions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.cleanup_gateway_assertions(integer) TO personal_photos_maintenance;

CREATE OR REPLACE FUNCTION photo_security.active_upload_count() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT count(*) FROM public.upload_sessions s WHERE result IS NULL AND expires_at>statement_timestamp() AND photo_security.username() IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM public.upload_processing_jobs j WHERE j.upload_id=s.upload_id)
$$;
