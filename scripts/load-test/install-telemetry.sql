-- Operator-run ONLY in an empty, isolated writable test database. Not a production migration.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF current_database() !~ '^stillmark_loadtest_[a-z0-9_]+$' THEN
  RAISE EXCEPTION 'Refusing non-test database';
 END IF;
 IF EXISTS(SELECT 1 FROM public.upload_processing_jobs) OR EXISTS(SELECT 1 FROM public.photos) THEN
  RAISE EXCEPTION 'Test database must have no media or queued jobs before installing guards';
 END IF;
END $$;
CREATE SCHEMA loadtest_control;
REVOKE ALL ON SCHEMA loadtest_control FROM PUBLIC;
CREATE TABLE loadtest_control.runs (
 run_id text PRIMARY KEY CHECK(run_id ~ '^[A-Za-z0-9_-]{8,80}$'),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE loadtest_control.actors (
 run_id text NOT NULL REFERENCES loadtest_control.runs,
 owner text NOT NULL,
 event_id bigint PRIMARY KEY REFERENCES public.events(event_id),
 UNIQUE(run_id,owner)
);
CREATE TABLE loadtest_control.transitions (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 run_id text NOT NULL REFERENCES loadtest_control.runs,
 upload_id uuid NOT NULL,
 state text NOT NULL,
 attempt integer NOT NULL,
 executor text,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX transitions_run_upload ON loadtest_control.transitions(run_id,upload_id,sequence);
CREATE FUNCTION loadtest_control.record_transition() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE selected_run text;
BEGIN
 SELECT a.run_id INTO selected_run FROM loadtest_control.actors a
 JOIN loadtest_control.runs r USING(run_id)
 JOIN public.events e ON e.event_id=a.event_id
 WHERE a.owner=NEW.owner AND a.event_id=(NEW.body->>'eventId')::bigint
 AND e.owner_username=a.owner AND e.visibility='PRIVATE';
 IF selected_run IS NULL THEN RAISE EXCEPTION 'Upload is outside the isolated fixture'; END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM loadtest_control.runs WHERE run_id=selected_run AND expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'Test run expired';
 END IF;
 IF TG_OP='INSERT' OR NEW.state IS DISTINCT FROM OLD.state OR NEW.attempts IS DISTINCT FROM OLD.attempts THEN
  INSERT INTO loadtest_control.transitions(run_id,upload_id,state,attempt,executor)
   VALUES(selected_run,NEW.upload_id,NEW.state,NEW.attempts,NEW.executor);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER loadtest_record_transition AFTER INSERT OR UPDATE ON public.upload_processing_jobs
 FOR EACH ROW EXECUTE FUNCTION loadtest_control.record_transition();
CREATE FUNCTION loadtest_control.suppress_fixture_ai() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM loadtest_control.actors a JOIN public.events e ON e.event_id=a.event_id
 WHERE a.event_id=NEW.event_id AND e.owner_username=a.owner AND e.visibility='PRIVATE') THEN
  RAISE EXCEPTION 'Media is outside the isolated fixture';
 END IF;
 NEW.ai_description='Synthetic load-test fixture; AI disabled';
 RETURN NEW;
END $$;
CREATE TRIGGER loadtest_suppress_ai BEFORE INSERT OR UPDATE ON public.photos
 FOR EACH ROW EXECUTE FUNCTION loadtest_control.suppress_fixture_ai();
REVOKE ALL ON ALL TABLES IN SCHEMA loadtest_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA loadtest_control FROM PUBLIC;
COMMIT;
