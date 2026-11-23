SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Confirmed identities are trusted references regardless of detector quality.
-- Use one reference per photo, exclude the candidate photo, and require consensus.
CREATE OR REPLACE FUNCTION face_worker.match_candidates(owner text, model text, auto_at real, review_at real, candidates bigint[]) RETURNS integer
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE changed integer;
 BEGIN
 IF NOT (review_at>0 AND review_at<=auto_at AND auto_at<1) THEN RAISE EXCEPTION 'invalid thresholds'; END IF;
 WITH pending AS (
  SELECT f.face_id,f.photo_id,f.embedding,f.quality_ok FROM public.faces f
  WHERE f.owner_username=owner AND f.model_version=model AND f.source='detected' AND NOT f.ignored
  AND f.embedding IS NOT NULL AND (candidates IS NULL OR f.face_id=ANY(candidates))
  AND NOT EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=f.face_id)),
 refs AS (
  SELECT a.person_id,r.photo_id,r.embedding,(a.status='confirmed' AND p.name IS NOT NULL) AS named_reference FROM public.face_assignments a
  JOIN public.faces r ON r.face_id=a.face_id AND r.model_version=model AND NOT r.ignored AND r.embedding IS NOT NULL
  JOIN public.face_people p ON p.person_id=a.person_id AND NOT p.hidden
  WHERE a.owner_username=owner AND r.owner_username=owner AND p.owner_username=owner AND ((a.status='confirmed' AND (p.name IS NOT NULL OR r.quality_ok)) OR (p.name IS NULL AND a.status='auto' AND r.quality_ok))),
 per_photo AS (
  SELECT pf.face_id,pf.quality_ok,rf.person_id,rf.photo_id,rf.named_reference,
   max(1-(pf.embedding<=>rf.embedding)) AS sim
  FROM pending pf CROSS JOIN refs rf
  WHERE (pf.quality_ok OR rf.named_reference) AND pf.photo_id<>rf.photo_id
   AND NOT EXISTS(SELECT FROM public.face_rejections j WHERE j.face_id=pf.face_id AND j.person_id=rf.person_id)
  GROUP BY pf.face_id,pf.quality_ok,rf.person_id,rf.photo_id,rf.named_reference),
 scored AS (
  SELECT x.face_id,x.person_id,x.quality_ok,x.named_reference,count(*) AS reference_count,avg(x.sim)::real score FROM (
   SELECT pp.*,row_number() OVER (PARTITION BY pp.face_id,pp.person_id ORDER BY pp.sim DESC) rank
   FROM per_photo pp) x
  WHERE x.rank<=3 GROUP BY x.face_id,x.person_id,x.quality_ok,x.named_reference),
 ranked AS (
  SELECT s.*,row_number() OVER (PARTITION BY s.face_id ORDER BY s.score DESC) pick,
   lead(s.score) OVER (PARTITION BY s.face_id ORDER BY s.score DESC) runner_up FROM scored s),
 inserted AS (
  INSERT INTO public.face_assignments(face_id,person_id,owner_username,status,score)
  SELECT r.face_id,r.person_id,owner,
   -- Ambiguity between two people downgrades an automatic match to a suggestion.
   CASE WHEN r.score>=CASE WHEN NOT r.named_reference THEN auto_at ELSE greatest(auto_at,0.75) END
    AND (NOT r.named_reference OR r.reference_count>=3)
    AND (r.runner_up IS NULL OR r.score-r.runner_up>=CASE WHEN NOT r.named_reference THEN 0.08 ELSE 0.12 END)
    THEN 'auto' ELSE 'suggested' END,
   r.score
  FROM ranked r WHERE r.pick=1 AND r.score>=CASE WHEN NOT r.named_reference THEN review_at ELSE greatest(review_at,0.60) END
  ON CONFLICT(face_id) DO NOTHING RETURNING 1)
 SELECT count(*) INTO changed FROM inserted;
 RETURN changed;
 END $$;


REVOKE ALL ON FUNCTION face_worker.match_candidates(text,text,real,real,bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION face_worker.match_candidates(text,text,real,real,bigint[]) TO personal_photos_face_worker,personal_photos_maintenance;
GRANT USAGE ON SCHEMA face_worker TO personal_photos_maintenance;
CREATE TABLE public.face_match_queue (
 owner_username text NOT NULL, model_version text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(), after_face_id bigint NOT NULL DEFAULT 0,
 auto_threshold real NOT NULL DEFAULT 0.75, review_threshold real NOT NULL DEFAULT 0.60,
 PRIMARY KEY(owner_username,model_version)
);
ALTER TABLE public.face_match_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.face_match_queue FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.face_match_queue TO personal_photos_app,personal_photos_face_worker,personal_photos_maintenance;
CREATE POLICY app ON public.face_match_queue TO personal_photos_app
 USING(photo_security.edits_people(owner_username)) WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY worker ON public.face_match_queue TO personal_photos_face_worker USING(true) WITH CHECK(true);
CREATE POLICY maintenance ON public.face_match_queue TO personal_photos_maintenance USING(true) WITH CHECK(true);

-- Runs inside the correction transaction: rollback/undo cannot lose a request.
CREATE FUNCTION face_worker.queue_confirmed_match() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 BEGIN
 IF NEW.status='confirmed' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR OLD.person_id IS DISTINCT FROM NEW.person_id) THEN
  INSERT INTO public.face_match_queue(owner_username,model_version)
   SELECT f.owner_username,f.model_version FROM public.faces f
   WHERE f.face_id=NEW.face_id AND f.source='detected' AND f.model_version IS NOT NULL
   ON CONFLICT(owner_username,model_version) DO UPDATE SET requested_at=now(),after_face_id=0;
 END IF;
 RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION face_worker.queue_confirmed_match() FROM PUBLIC;
CREATE TRIGGER confirmed_face_rematch AFTER INSERT OR UPDATE ON public.face_assignments
 FOR EACH ROW EXECUTE FUNCTION face_worker.queue_confirmed_match();

-- One bounded batch per transaction. The queue row lock prevents concurrent runs
-- and prevents a confirmation arriving mid-batch from losing its restart request.
CREATE FUNCTION face_worker.rematch_batch(batch integer DEFAULT 100)
 RETURNS TABLE(owner_username text,scanned integer,matched integer,remaining boolean)
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE job record; ids bigint[]; added integer;
 BEGIN
 IF batch NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'batch out of range'; END IF;
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
REVOKE ALL ON FUNCTION face_worker.rematch_batch(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION face_worker.rematch_batch(integer) TO personal_photos_maintenance;

-- Keep scan organization bounded as the library grows. The durable consumer
-- finishes remaining candidates, preserving configured stricter thresholds.
CREATE OR REPLACE FUNCTION face_worker.match(owner text, model text, auto_at real, review_at real) RETURNS integer
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE ids bigint[]; added integer;
 BEGIN
 IF NOT (review_at>0 AND review_at<=auto_at AND auto_at<1) THEN RAISE EXCEPTION 'invalid thresholds'; END IF;
 SELECT array_agg(t.face_id) INTO ids FROM (
  SELECT f.face_id FROM public.faces f WHERE f.owner_username=owner AND f.model_version=model
   AND f.source='detected' AND NOT f.ignored AND f.embedding IS NOT NULL
   AND NOT EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=f.face_id)
  ORDER BY f.face_id LIMIT 100) t;
 IF ids IS NULL THEN RETURN 0; END IF;
 added:=face_worker.match_candidates(owner,model,auto_at,review_at,ids);
 IF cardinality(ids)=100 THEN
  INSERT INTO public.face_match_queue(owner_username,model_version,auto_threshold,review_threshold)
  VALUES(owner,model,greatest(auto_at,0.75),greatest(review_at,0.60))
  ON CONFLICT(owner_username,model_version) DO UPDATE SET after_face_id=0,requested_at=now(),
   auto_threshold=EXCLUDED.auto_threshold,review_threshold=EXCLUDED.review_threshold;
 END IF;
 RETURN added;
 END $$;
