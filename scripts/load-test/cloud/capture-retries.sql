-- Additive diagnostic for an already guarded isolated test database only.
BEGIN;
DO $$ BEGIN
 IF current_database() <> 'stillmark_loadtest_baseline' OR
    NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='loadtest_record_transition' AND tgenabled='O') THEN
  RAISE EXCEPTION 'Guarded isolated load-test database required';
 END IF;
END $$;
CREATE TABLE loadtest_control.retry_errors (
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 upload_id uuid NOT NULL,
 attempt integer NOT NULL,
 error text
);
REVOKE ALL ON loadtest_control.retry_errors FROM PUBLIC;
CREATE FUNCTION loadtest_control.capture_retry_error() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF OLD.state='processing' AND NEW.state IN ('queued','failed') THEN
  INSERT INTO loadtest_control.retry_errors(upload_id,attempt,error)
  VALUES (NEW.upload_id,NEW.attempts,NEW.error);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION loadtest_control.capture_retry_error() FROM PUBLIC;
CREATE TRIGGER loadtest_capture_retry_error AFTER UPDATE ON public.upload_processing_jobs
 FOR EACH ROW EXECUTE FUNCTION loadtest_control.capture_retry_error();
COMMIT;
