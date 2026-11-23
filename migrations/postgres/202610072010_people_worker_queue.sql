SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
-- Worker queue and publication contract. Functions are SECURITY INVOKER: they run
-- with the face worker's own grants and row policies, never with elevated rights.
CREATE SCHEMA face_worker;
REVOKE ALL ON SCHEMA face_worker FROM PUBLIC;
GRANT USAGE ON SCHEMA face_worker TO personal_photos_face_worker;

-- Recover expired leases, then claim due photos for this run.
CREATE FUNCTION face_worker.claim(run uuid, batch integer)
 RETURNS TABLE(photo_id integer, owner_username text, source_path text, claim_token uuid)
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 BEGIN
 IF batch NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'batch out of range'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('face-scan-admission',0));
 UPDATE public.face_scan_queue q SET
  status=CASE WHEN q.attempts>=3 THEN 'failed' ELSE 'queued' END,
  error=CASE WHEN q.attempts>=3 THEN 'Lease expired after maximum attempts' ELSE q.error END,
  claim_token=NULL,lease_until=NULL,next_attempt_at=now()
  WHERE q.status='running' AND q.lease_until<now();
 RETURN QUERY
 UPDATE public.face_scan_queue q SET status='running',claim_token=gen_random_uuid(),
  attempts=q.attempts+1,lease_until=now()+interval '5 minutes'
  WHERE q.photo_id IN (
   SELECT c.photo_id FROM public.face_scan_queue c
   WHERE c.run_id=run AND c.status='queued' AND c.next_attempt_at<=now()
   ORDER BY c.requested_at,c.photo_id LIMIT batch FOR UPDATE SKIP LOCKED)
  RETURNING q.photo_id,q.owner_username,q.source_path,q.claim_token;
 END $$;

CREATE FUNCTION face_worker.renew(tokens uuid[]) RETURNS integer
 LANGUAGE sql SET search_path=pg_catalog,public AS $$
 WITH renewed AS (UPDATE public.face_scan_queue SET lease_until=now()+interval '5 minutes'
  WHERE claim_token=ANY(tokens) AND status='running' AND lease_until>now() RETURNING 1)
 SELECT count(*)::integer FROM renewed $$;

CREATE FUNCTION face_worker.heartbeat(run uuid) RETURNS text
 LANGUAGE sql SET search_path=pg_catalog,public AS $$
 UPDATE public.face_scan_runs SET heartbeat_at=now(),
  status=CASE WHEN status='starting' THEN 'running' ELSE status END,
  started_at=COALESCE(started_at,now())
 WHERE id=run RETURNING status $$;

-- Bounded retries with backoff. Error text is operational only, never face data.
CREATE FUNCTION face_worker.fail(photo integer, token uuid, reason text) RETURNS boolean
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE run uuid; final boolean;
 BEGIN
 UPDATE public.face_scan_queue q SET
  status=CASE WHEN q.attempts>=3 THEN 'failed' ELSE 'queued' END,
  next_attempt_at=now()+CASE WHEN q.attempts>=2 THEN interval '30 seconds' ELSE interval '10 seconds' END,
  error=left(reason,500),claim_token=NULL,lease_until=NULL
  WHERE q.photo_id=photo AND q.claim_token=token AND q.status='running'
  RETURNING q.run_id,q.status='failed' INTO run,final;
 IF NOT FOUND THEN RETURN false; END IF;
 IF final THEN UPDATE public.face_scan_runs SET failed=failed+1 WHERE id=run; END IF;
 RETURN true;
 END $$;

-- Fenced publication. Requires a live claim and an unchanged original. Replaces
-- prior scanner output for the photo except faces with a confirmed assignment.
-- faces: [{index,x,y,w,h,score,quality,quality_ok,embedding:[...],crop_path}]
CREATE FUNCTION face_worker.publish(photo integer, token uuid, model text, source text, detections jsonb)
 RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE item record; owner text; run uuid; kept integer:=0; inserted integer:=0; added integer;
 BEGIN
 SELECT q.owner_username,q.run_id INTO owner,run FROM public.face_scan_queue q
  WHERE q.photo_id=photo AND q.claim_token=token AND q.status='running' AND q.lease_until>now()
  AND q.source_path=source FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'stale face claim' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM public.photos p WHERE p.photo_id=photo AND p.original_stage_path=source;
 IF NOT FOUND THEN RAISE EXCEPTION 'photo original changed' USING ERRCODE='40001'; END IF;
 IF jsonb_typeof(detections)<>'array' OR jsonb_array_length(detections)>200 THEN RAISE EXCEPTION 'invalid face payload'; END IF;
 WITH removed AS (
  DELETE FROM public.faces f WHERE f.photo_id=photo AND f.source='detected'
   AND NOT EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=f.face_id AND a.status='confirmed')
  RETURNING f.crop_path)
 INSERT INTO public.stage_cleanup(path,next_attempt)
  SELECT crop_path,now()+interval '24 hours' FROM removed WHERE crop_path IS NOT NULL ON CONFLICT DO NOTHING;
 FOR item IN SELECT * FROM jsonb_to_recordset(detections) AS x("index" smallint,x real,y real,w real,h real,score real,
  quality real,quality_ok boolean,embedding real[],crop_path text) LOOP
  -- A confirmed face kept from an earlier scan already covers this region.
  IF EXISTS(SELECT FROM public.faces k WHERE k.photo_id=photo AND k.source='detected' AND k.box_x IS NOT NULL
   AND greatest(0,least(k.box_x+k.box_w,item.x+item.w)-greatest(k.box_x,item.x))
     *greatest(0,least(k.box_y+k.box_h,item.y+item.h)-greatest(k.box_y,item.y))
     >0.5*least(k.box_w*k.box_h,item.w*item.h)) THEN
   kept:=kept+1;
   IF item.crop_path IS NOT NULL THEN
    INSERT INTO public.stage_cleanup(path,next_attempt) VALUES(item.crop_path,now()) ON CONFLICT DO NOTHING;
   END IF;
   CONTINUE;
  END IF;
  INSERT INTO public.faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,
   detection_score,quality,quality_ok,embedding,crop_path)
  VALUES(photo,owner,'detected',source,model,item."index",item.x,item.y,item.w,item.h,item.score,item.quality,
   item.quality_ok,item.embedding::vector,item.crop_path)
  ON CONFLICT(photo_id,model_version,face_index) DO NOTHING;
  GET DIAGNOSTICS added=ROW_COUNT;
  inserted:=inserted+added;
 END LOOP;
 UPDATE public.face_scan_queue SET status='done',claim_token=NULL,lease_until=NULL,completed_at=now(),
  model_version=model,error=NULL WHERE photo_id=photo;
 UPDATE public.face_scan_runs SET processed=processed+1,faces_found=faces_found+inserted+kept WHERE id=run;
 RETURN inserted;
 END $$;

-- Conservative matching for faces with no assignment. References are a named
-- person's confirmed, good-quality faces, or every member of an unnamed group.
-- A person's score is the mean of its best three reference similarities.
-- Rejected pairs and hidden people are never candidates.
CREATE FUNCTION face_worker.match(owner text, model text, auto_at real, review_at real) RETURNS integer
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE changed integer;
 BEGIN
 IF NOT (review_at>0 AND review_at<=auto_at AND auto_at<1) THEN RAISE EXCEPTION 'invalid thresholds'; END IF;
 WITH pending AS (
  SELECT f.face_id,f.embedding FROM public.faces f
  WHERE f.owner_username=owner AND f.model_version=model AND f.source='detected' AND f.quality_ok AND NOT f.ignored
  AND NOT EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=f.face_id)),
 refs AS (
  SELECT a.person_id,r.embedding FROM public.face_assignments a
  JOIN public.faces r ON r.face_id=a.face_id AND r.model_version=model AND r.quality_ok AND NOT r.ignored
  JOIN public.face_people p ON p.person_id=a.person_id AND NOT p.hidden
  WHERE a.owner_username=owner AND (a.status='confirmed' OR (p.name IS NULL AND a.status='auto'))),
 scored AS (
  SELECT x.face_id,x.person_id,avg(x.sim)::real score FROM (
   SELECT pf.face_id,rf.person_id,1-(pf.embedding<=>rf.embedding) sim,
    row_number() OVER (PARTITION BY pf.face_id,rf.person_id ORDER BY pf.embedding<=>rf.embedding) rank
   FROM pending pf CROSS JOIN refs rf
   WHERE NOT EXISTS(SELECT FROM public.face_rejections j WHERE j.face_id=pf.face_id AND j.person_id=rf.person_id)) x
  WHERE x.rank<=3 GROUP BY x.face_id,x.person_id),
 ranked AS (
  SELECT s.*,row_number() OVER (PARTITION BY s.face_id ORDER BY s.score DESC) pick,
   lead(s.score) OVER (PARTITION BY s.face_id ORDER BY s.score DESC) runner_up FROM scored s),
 inserted AS (
  INSERT INTO public.face_assignments(face_id,person_id,owner_username,status,score)
  SELECT r.face_id,r.person_id,owner,
   -- Ambiguity between two people downgrades an automatic match to a suggestion.
   CASE WHEN r.score>=auto_at AND (r.runner_up IS NULL OR r.score-r.runner_up>=0.08) THEN 'auto' ELSE 'suggested' END,
   r.score
  FROM ranked r WHERE r.pick=1 AND r.score>=review_at
  ON CONFLICT(face_id) DO NOTHING RETURNING 1)
 SELECT count(*) INTO changed FROM inserted;
 RETURN changed;
 END $$;

-- Unassigned good-quality faces offered to the clustering step.
CREATE FUNCTION face_worker.unassigned(owner text, model text, max_faces integer)
 RETURNS TABLE(face_id bigint, embedding real[])
 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT f.face_id,f.embedding::real[] FROM public.faces f
 WHERE f.owner_username=owner AND f.model_version=model AND f.source='detected' AND f.quality_ok AND NOT f.ignored
 AND NOT EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=f.face_id)
 ORDER BY f.face_id LIMIT max_faces $$;

-- Create one unnamed group from a cluster of faces that are still unassigned.
CREATE FUNCTION face_worker.create_group(owner text, members bigint[], scores real[]) RETURNS uuid
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE person uuid; free bigint[]; free_scores real[];
 BEGIN
 IF cardinality(members)<2 OR cardinality(members)<>cardinality(scores) THEN RAISE EXCEPTION 'invalid group'; END IF;
 IF EXISTS(SELECT FROM unnest(members) m(id) WHERE NOT EXISTS(
  SELECT FROM public.faces f WHERE f.face_id=m.id AND f.owner_username=owner AND f.source='detected')) THEN
  RAISE EXCEPTION 'group member outside owner scope';
 END IF;
 SELECT array_agg(m.id ORDER BY m.id),array_agg(m.score ORDER BY m.id) INTO free,free_scores
  FROM unnest(members,scores) m(id,score)
  WHERE NOT EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=m.id);
 IF coalesce(cardinality(free),0)<2 THEN RETURN NULL; END IF;
 INSERT INTO public.face_people(owner_username) VALUES(owner) RETURNING person_id INTO person;
 INSERT INTO public.face_assignments(face_id,person_id,owner_username,status,score)
  SELECT m.id,person,owner,'auto',m.score FROM unnest(free,free_scores) m(id,score);
 UPDATE public.face_people SET cover_face_id=(
  SELECT f.face_id FROM public.faces f JOIN public.face_assignments a USING(face_id)
  WHERE a.person_id=person ORDER BY f.quality DESC,f.face_id LIMIT 1) WHERE person_id=person;
 RETURN person;
 END $$;

CREATE FUNCTION face_worker.finish(run uuid, outcome text, reason text) RETURNS void
 LANGUAGE sql SET search_path=pg_catalog,public AS $$
 UPDATE public.face_scan_runs SET status=outcome,finished_at=now(),heartbeat_at=now(),error=left(reason,500)
 WHERE id=run AND status IN ('starting','running') AND outcome IN ('completed','attention') $$;

-- Owners the run covers, so the worker never enumerates other libraries.
CREATE FUNCTION face_worker.run_owners(run uuid) RETURNS SETOF text
 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT q.owner_username FROM public.face_scan_queue q WHERE q.run_id=run $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA face_worker FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA face_worker TO personal_photos_face_worker;
