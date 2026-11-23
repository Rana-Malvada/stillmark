SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Reproduced with the deployed cpu-v6 model: a museum image has 686 faces.
CREATE OR REPLACE FUNCTION face_worker.publish(photo integer, token uuid, model text, source text, detections jsonb)
 RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE item record; owner text; run uuid; inserted integer:=0; added integer;
 BEGIN
 SELECT q.owner_username,q.run_id INTO owner,run FROM public.face_scan_queue q
  WHERE q.photo_id=photo AND q.claim_token=token AND q.status='running' AND q.lease_until>now()
  AND q.source_path=source FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'stale face claim' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM public.photos p WHERE p.photo_id=photo AND p.original_stage_path=source;
 IF NOT FOUND THEN RAISE EXCEPTION 'photo original changed' USING ERRCODE='40001'; END IF;
 -- Dense group/portrait-wall photos can exceed 200 detections. Keep a bounded
 -- publication transaction without silently discarding faces.
 IF detections IS NULL OR jsonb_typeof(detections)<>'array' THEN
  RAISE EXCEPTION 'invalid face payload' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(detections)>5000 THEN
  RAISE EXCEPTION 'face payload exceeds 5000 detections' USING ERRCODE='22023';
 END IF;
 WITH removed AS (
  DELETE FROM public.faces f WHERE f.photo_id=photo AND f.source='detected'
   AND NOT EXISTS(SELECT FROM public.face_assignments a WHERE a.face_id=f.face_id AND a.status='confirmed')
  RETURNING f.crop_path)
 INSERT INTO public.stage_cleanup(path,next_attempt)
  SELECT crop_path,now()+interval '24 hours' FROM removed WHERE crop_path IS NOT NULL ON CONFLICT DO NOTHING;
 FOR item IN SELECT * FROM jsonb_to_recordset(detections) AS x("index" smallint,x real,y real,w real,h real,score real,
  quality real,quality_ok boolean,embedding real[],crop_path text) LOOP
  -- A face confirmed by the owner in an earlier scan already covers this region.
  IF EXISTS(SELECT FROM public.faces k JOIN public.face_assignments a ON a.face_id=k.face_id AND a.status='confirmed'
   WHERE k.photo_id=photo AND k.source='detected'
   AND greatest(0,least(k.box_x+k.box_w,item.x+item.w)-greatest(k.box_x,item.x))
     *greatest(0,least(k.box_y+k.box_h,item.y+item.h)-greatest(k.box_y,item.y))
     >0.5*least(k.box_w*k.box_h,item.w*item.h)) THEN
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
  IF added=0 AND item.crop_path IS NOT NULL THEN
   INSERT INTO public.stage_cleanup(path,next_attempt) VALUES(item.crop_path,now()) ON CONFLICT DO NOTHING;
  END IF;
  inserted:=inserted+added;
 END LOOP;
 UPDATE public.face_scan_queue SET status='done',claim_token=NULL,lease_until=NULL,completed_at=now(),
  model_version=model,error=NULL WHERE photo_id=photo;
 UPDATE public.face_scan_runs SET processed=processed+1,
  faces_found=faces_found+inserted+(SELECT count(*) FROM public.faces k JOIN public.face_assignments a
   ON a.face_id=k.face_id AND a.status='confirmed' WHERE k.photo_id=photo AND k.source='detected')
  WHERE id=run;
 RETURN inserted;
 END $$;

-- Old workers count failed attempts, not distinct photos. Normalize only that
-- worker-generated summary; preserve cancellation/time-budget/other errors.
CREATE OR REPLACE FUNCTION face_worker.finish(run uuid, outcome text, reason text)
 RETURNS void LANGUAGE sql SET search_path=pg_catalog,public AS $$
 UPDATE public.face_scan_runs r SET
 status=CASE WHEN reason ~ '^[0-9]+ photo\(s\) could not be scanned$'
   AND r.failed=0 AND NOT EXISTS(SELECT FROM public.face_scan_queue q
     WHERE q.run_id=run AND q.status<>'done') THEN 'completed' ELSE outcome END,
 finished_at=now(),heartbeat_at=now(),
 error=CASE WHEN reason ~ '^[0-9]+ photo\(s\) could not be scanned$'
   THEN CASE WHEN r.failed>0 THEN r.failed||' photo(s) could not be scanned'
     WHEN EXISTS(SELECT FROM public.face_scan_queue q WHERE q.run_id=run AND q.status<>'done')
     THEN 'Some photos remain queued' ELSE NULL END
   ELSE left(reason,500) END
 WHERE r.id=run AND r.status IN ('starting','running') AND outcome IN ('completed','attention') $$;
