SET LOCAL lock_timeout='5s';
ALTER TABLE public.upload_routing ADD COLUMN last_activity_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.upload_routing DROP CONSTRAINT upload_routing_phase_check;
UPDATE public.upload_routing SET desired='pool',route='pool',
 phase='suspended',error=NULL,updated_at=now();
ALTER TABLE public.upload_routing ADD CONSTRAINT upload_routing_phase_check
 CHECK(phase IN ('pool','resuming','suspending','suspended','error'));
ALTER TABLE public.upload_routing ADD CONSTRAINT upload_routing_pool_only CHECK(desired='pool' AND route='pool');
-- Completed transfers and queue transitions restart the idle clock. This trigger
-- has no caller parameters and only updates the singleton activity timestamp.
CREATE FUNCTION photo_security.touch_upload_pool_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.upload_routing SET last_activity_at=clock_timestamp() WHERE id=true;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.touch_upload_pool_activity() FROM PUBLIC;
CREATE TRIGGER upload_request_activity AFTER DELETE ON public.upload_pool_requests
 FOR EACH ROW EXECUTE FUNCTION photo_security.touch_upload_pool_activity();
CREATE TRIGGER upload_job_activity AFTER INSERT OR UPDATE ON public.upload_processing_jobs
 FOR EACH ROW EXECUTE FUNCTION photo_security.touch_upload_pool_activity();

-- Idle checks read only live work, never the completed upload history.
CREATE INDEX upload_processing_live ON public.upload_processing_jobs(state)
 WHERE state IN ('queued','processing');
