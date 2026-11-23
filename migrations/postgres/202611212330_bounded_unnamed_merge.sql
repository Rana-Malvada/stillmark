SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE INDEX face_rejections_merge_person ON public.face_rejections(person_id);
-- Durable pair-scan checkpoints; application roles cannot read or modify worker state.
CREATE TABLE face_worker.merge_generation (
 owner_username text PRIMARY KEY,
 generation bigint NOT NULL DEFAULT 1
);
CREATE TABLE face_worker.merge_progress (
 owner_username text NOT NULL,
 model text NOT NULL,
 generation bigint NOT NULL,
 threshold real NOT NULL,
 left_id uuid,
 right_id uuid,
 best_left uuid,
 best_right uuid,
 best_score real,
 complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(owner_username,model)
);
REVOKE ALL ON face_worker.merge_generation,face_worker.merge_progress FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON face_worker.merge_generation,face_worker.merge_progress TO personal_photos_face_worker;

-- Once per SQL statement and owner, not once per face. User corrections and new
-- assignments invalidate unfinished scores before they can be used for a merge.
CREATE FUNCTION face_worker.invalidate_merge() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO face_worker.merge_generation(owner_username)
   SELECT DISTINCT owner_username FROM new_rows ORDER BY owner_username
   ON CONFLICT(owner_username) DO UPDATE SET generation=face_worker.merge_generation.generation+1;
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO face_worker.merge_generation(owner_username)
   SELECT DISTINCT owner_username FROM old_rows ORDER BY owner_username
   ON CONFLICT(owner_username) DO UPDATE SET generation=face_worker.merge_generation.generation+1;
 ELSE
  INSERT INTO face_worker.merge_generation(owner_username)
   SELECT owner_username FROM (SELECT owner_username FROM old_rows UNION SELECT owner_username FROM new_rows) changed ORDER BY owner_username
   ON CONFLICT(owner_username) DO UPDATE SET generation=face_worker.merge_generation.generation+1;
 END IF;
 RETURN NULL;
 END $$;
REVOKE ALL ON FUNCTION face_worker.invalidate_merge() FROM PUBLIC;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['faces','face_assignments','face_people','face_rejections'] LOOP
  EXECUTE format('CREATE TRIGGER merge_invalidate_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION face_worker.invalidate_merge()',relation);
  EXECUTE format('CREATE TRIGGER merge_invalidate_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION face_worker.invalidate_merge()',relation);
  EXECUTE format('CREATE TRIGGER merge_invalidate_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION face_worker.invalidate_merge()',relation);
 END LOOP;
END $$;

CREATE FUNCTION face_worker.merge_state(owner text, version text, minimum real)
 RETURNS SETOF face_worker.merge_progress LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE current_generation bigint;
 BEGIN
 INSERT INTO face_worker.merge_generation(owner_username) VALUES(owner) ON CONFLICT DO NOTHING;
 SELECT generation INTO current_generation FROM face_worker.merge_generation WHERE owner_username=owner;
 INSERT INTO face_worker.merge_progress(owner_username,model,generation,threshold)
 VALUES(owner,version,current_generation,minimum)
 ON CONFLICT(owner_username,model) DO UPDATE SET
  generation=EXCLUDED.generation,threshold=EXCLUDED.threshold,left_id=NULL,right_id=NULL,
  best_left=NULL,best_right=NULL,best_score=NULL,complete=false
 WHERE merge_progress.generation<>EXCLUDED.generation OR merge_progress.threshold<>EXCLUDED.threshold;
 RETURN QUERY SELECT * FROM face_worker.merge_progress WHERE owner_username=owner AND model=version;
 END $$;

CREATE FUNCTION face_worker.merge_next_pair(owner text, version text, after_left uuid, after_right uuid)
 RETURNS TABLE(left_id uuid,right_id uuid,left_count bigint,right_count bigint)
 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 WITH eligible AS MATERIALIZED (
  SELECT p.person_id,count(*) AS faces FROM public.face_people p
  JOIN public.face_assignments a USING(person_id) JOIN public.faces f USING(face_id)
  WHERE p.owner_username=owner AND p.name IS NULL AND NOT p.hidden
   AND f.model_version=version AND f.quality_ok AND NOT f.ignored
   AND NOT EXISTS(SELECT FROM public.face_assignments c WHERE c.person_id=p.person_id AND c.status='confirmed')
   AND NOT EXISTS(SELECT FROM public.face_rejections curated WHERE curated.person_id=p.person_id)
  GROUP BY p.person_id
 )
 SELECT l.person_id,r.person_id,l.faces,r.faces FROM eligible l JOIN eligible r ON l.person_id<r.person_id
 WHERE (after_left IS NULL OR (l.person_id,r.person_id)>(after_left,after_right))
 AND NOT EXISTS(
  SELECT FROM public.face_rejections reject JOIN public.face_assignments a USING(face_id)
  WHERE (a.person_id=l.person_id AND reject.person_id=r.person_id)
     OR (a.person_id=r.person_id AND reject.person_id=l.person_id)
 )
 ORDER BY l.person_id,r.person_id LIMIT 64 $$;

CREATE FUNCTION face_worker.merge_face_page(owner text, version text, person uuid, after_face bigint, page_size integer)
 RETURNS TABLE(face_id bigint,embedding real[]) LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT f.face_id,f.embedding::real[] FROM public.face_people p
 JOIN public.face_assignments a USING(person_id) JOIN public.faces f USING(face_id)
 WHERE p.person_id=person AND p.owner_username=owner AND p.name IS NULL AND NOT p.hidden
  AND f.model_version=version AND f.quality_ok AND NOT f.ignored AND f.face_id>after_face
  AND NOT EXISTS(SELECT FROM public.face_assignments c WHERE c.person_id=p.person_id AND c.status='confirmed')
   AND NOT EXISTS(SELECT FROM public.face_rejections curated WHERE curated.person_id=p.person_id)
 ORDER BY f.face_id LIMIT greatest(1,least(page_size,512)) $$;

CREATE FUNCTION face_worker.merge_checkpoint(owner text,version text,expected bigint,l uuid,r uuid,score real)
 RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 BEGIN
 UPDATE face_worker.merge_progress p SET left_id=l,right_id=r,
  best_left=CASE WHEN score>=p.threshold AND (p.best_score IS NULL OR score>=p.best_score) THEN l ELSE p.best_left END,
  best_right=CASE WHEN score>=p.threshold AND (p.best_score IS NULL OR score>=p.best_score) THEN r ELSE p.best_right END,
  best_score=CASE WHEN score>=p.threshold AND (p.best_score IS NULL OR score>=p.best_score) THEN score ELSE p.best_score END
 WHERE p.owner_username=owner AND p.model=version AND p.generation=expected
  AND EXISTS(SELECT FROM face_worker.merge_generation g WHERE g.owner_username=owner AND g.generation=expected);
 RETURN FOUND;
 END $$;

CREATE FUNCTION face_worker.merge_finish_pass(owner text,version text,expected bigint)
 RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE work face_worker.merge_progress; keep uuid; absorb uuid; merged integer;
 BEGIN
 PERFORM 1 FROM face_worker.merge_generation WHERE owner_username=owner AND generation=expected FOR UPDATE;
 IF NOT FOUND THEN RETURN -1; END IF;
 SELECT * INTO work FROM face_worker.merge_progress WHERE owner_username=owner AND model=version AND generation=expected FOR UPDATE;
 IF NOT FOUND THEN RETURN -1; END IF;
 IF work.best_left IS NULL THEN
  UPDATE face_worker.merge_progress SET complete=true WHERE owner_username=owner AND model=version;
  RETURN 0;
 END IF;
 -- Select the largest survivor and recheck both sides of user rejection evidence.
 SELECT p.person_id INTO keep FROM public.face_people p JOIN public.face_assignments a USING(person_id)
 WHERE p.person_id IN (work.best_left,work.best_right) GROUP BY p.person_id ORDER BY count(*) DESC,p.person_id LIMIT 1;
 absorb:=CASE WHEN keep=work.best_left THEN work.best_right ELSE work.best_left END;
 IF EXISTS(SELECT FROM public.face_rejections reject JOIN public.face_assignments a USING(face_id)
   WHERE (a.person_id=keep AND reject.person_id=absorb) OR (a.person_id=absorb AND reject.person_id=keep)) THEN RETURN -1; END IF;
 -- One absorbed group per transaction; never exceeds the existing 500-group cap.
 merged:=face_worker.merge_unnamed(owner,keep,ARRAY[absorb]);
 UPDATE face_worker.merge_progress SET generation=-1 WHERE owner_username=owner AND model=version;
 RETURN merged;
 END $$;
REVOKE ALL ON FUNCTION face_worker.merge_state(text,text,real),face_worker.merge_next_pair(text,text,uuid,uuid),face_worker.merge_face_page(text,text,uuid,bigint,integer),face_worker.merge_checkpoint(text,text,bigint,uuid,uuid,real),face_worker.merge_finish_pass(text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION face_worker.merge_state(text,text,real),face_worker.merge_next_pair(text,text,uuid,uuid),face_worker.merge_face_page(text,text,uuid,bigint,integer),face_worker.merge_checkpoint(text,text,bigint,uuid,uuid,real),face_worker.merge_finish_pass(text,text,bigint) TO personal_photos_face_worker;
