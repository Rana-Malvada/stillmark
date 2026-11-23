SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Append-only interactive requests are independent of the worker progress lock.
CREATE TABLE public.face_match_requests (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 owner_username text NOT NULL, model_version text NOT NULL
);
ALTER TABLE public.face_match_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.face_match_requests FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON public.face_match_requests TO personal_photos_app,personal_photos_face_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.face_match_requests TO personal_photos_maintenance;
GRANT USAGE ON SEQUENCE public.face_match_requests_id_seq TO personal_photos_app,personal_photos_face_worker,personal_photos_maintenance;
CREATE POLICY app ON public.face_match_requests TO personal_photos_app
 USING(photo_security.edits_people(owner_username)) WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY worker ON public.face_match_requests TO personal_photos_face_worker USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON public.face_match_requests TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE OR REPLACE FUNCTION face_worker.queue_confirmed_match() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 BEGIN
 IF NEW.status='confirmed' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR OLD.person_id IS DISTINCT FROM NEW.person_id) THEN
  INSERT INTO public.face_match_requests(owner_username,model_version)
   SELECT f.owner_username,f.model_version FROM public.faces f
   WHERE f.face_id=NEW.face_id AND f.source='detected' AND f.model_version IS NOT NULL;
 END IF;
 RETURN NEW;
 END $$;
CREATE OR REPLACE FUNCTION face_worker.queue_named_person_match() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 BEGIN
 IF NEW.name IS NOT NULL AND NOT NEW.hidden AND (OLD.name IS NULL OR OLD.hidden) THEN
  INSERT INTO public.face_match_requests(owner_username,model_version)
   SELECT DISTINCT f.owner_username,f.model_version
   FROM public.faces f JOIN public.face_assignments a USING(face_id)
   WHERE a.person_id=NEW.person_id AND a.status='confirmed' AND NOT f.ignored
    AND f.source='detected' AND f.model_version IS NOT NULL;
 END IF;
 RETURN NEW;
 END $$;
CREATE OR REPLACE FUNCTION face_worker.rematch_batch(batch integer DEFAULT 100)
 RETURNS TABLE(owner_username text,scanned integer,matched integer,remaining boolean)
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE job record; ids bigint[]; added integer;
 BEGIN
 IF batch NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'batch out of range'; END IF;
 -- Delete only a bounded set visible to this transaction. New inserts use new
 -- IDs and never contend with the progress row held during vector matching.
 WITH pending AS (
   SELECT id FROM public.face_match_requests ORDER BY id LIMIT 1000 FOR UPDATE SKIP LOCKED
 ), drained AS (
   DELETE FROM public.face_match_requests r USING pending p WHERE r.id=p.id
   RETURNING r.owner_username,r.model_version
 )
 INSERT INTO public.face_match_queue AS q(owner_username,model_version)
 SELECT DISTINCT d.owner_username,d.model_version FROM drained d
 ORDER BY d.owner_username,d.model_version
 ON CONFLICT ON CONSTRAINT face_match_queue_pkey DO UPDATE SET after_face_id=0,requested_at=now();
 SELECT q.* INTO job FROM public.face_match_queue q ORDER BY q.requested_at
  LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN; END IF;
 IF NOT EXISTS(SELECT FROM public.face_settings s WHERE s.owner_username=job.owner_username AND s.enabled) THEN
  DELETE FROM public.face_match_queue q WHERE q.owner_username=job.owner_username AND q.model_version=job.model_version;
  RETURN;
 END IF;
 SELECT array_agg(t.face_id) INTO ids FROM (
  SELECT f.face_id FROM public.faces f WHERE f.owner_username=job.owner_username AND f.model_version=job.model_version
   AND f.source='detected' AND NOT f.ignored AND f.embedding IS NOT NULL AND f.face_id>job.after_face_id
   AND NOT EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=f.face_id)
  ORDER BY f.face_id LIMIT batch FOR UPDATE OF f) t;
 IF ids IS NULL THEN
  DELETE FROM public.face_match_queue q WHERE q.owner_username=job.owner_username AND q.model_version=job.model_version;
  RETURN QUERY SELECT job.owner_username,0,0,false;
 ELSE
  added:=face_worker.match_candidates(job.owner_username,job.model_version,job.auto_threshold,job.review_threshold,ids);
  UPDATE public.face_match_queue q SET after_face_id=(SELECT max(i) FROM unnest(ids) i),requested_at=now()
   WHERE q.owner_username=job.owner_username AND q.model_version=job.model_version;
  RETURN QUERY SELECT job.owner_username,cardinality(ids),added,true;
 END IF;
 END $$;
