SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

-- Timestamp terminal transitions in the database so old and new workers agree.
ALTER TABLE public.upload_processing_jobs ADD COLUMN failed_at timestamptz;
UPDATE public.upload_processing_jobs SET failed_at=updated_at WHERE state='failed';
CREATE FUNCTION photo_security.record_upload_failure_time() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.state='failed' THEN
  IF TG_OP='INSERT' THEN
   NEW.failed_at:=clock_timestamp();
  ELSIF OLD.state IS DISTINCT FROM 'failed' THEN
   NEW.failed_at:=clock_timestamp();
  ELSE
   NEW.failed_at:=OLD.failed_at;
  END IF;
 ELSE
  NEW.failed_at:=NULL;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION photo_security.record_upload_failure_time() FROM PUBLIC;
CREATE TRIGGER upload_failure_time BEFORE INSERT OR UPDATE ON public.upload_processing_jobs
 FOR EACH ROW EXECUTE FUNCTION photo_security.record_upload_failure_time();
CREATE INDEX upload_processing_failed_at ON public.upload_processing_jobs(failed_at)
 WHERE state='failed';
