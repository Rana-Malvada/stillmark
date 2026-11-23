SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Merge of unnamed groups. The pilot showed one person split into several unnamed
-- groups (across years, lighting and angle). The worker may now combine unnamed groups
-- it created, never named people or groups the owner has curated.

-- Unnamed, visible groups with no confirmed face: the only groups the worker may merge.
CREATE FUNCTION face_worker.unnamed_groups(owner text, model text)
 RETURNS TABLE(person_id uuid, face_id bigint, embedding real[])
 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT a.person_id,f.face_id,f.embedding::real[] FROM public.face_people p
 JOIN public.face_assignments a USING(person_id) JOIN public.faces f USING(face_id)
 WHERE p.owner_username=owner AND p.name IS NULL AND NOT p.hidden AND f.model_version=model AND f.quality_ok AND NOT f.ignored
 AND NOT EXISTS(SELECT FROM public.face_assignments c WHERE c.person_id=p.person_id AND c.status='confirmed')
 ORDER BY a.person_id,f.face_id $$;

-- Moves every assignment of the absorbed groups into keep, then removes the empty
-- groups. Skips any group that is no longer eligible or has a face rejected for keep.
CREATE FUNCTION face_worker.merge_unnamed(owner text, keep uuid, absorb uuid[]) RETURNS integer
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 DECLARE other uuid; merged integer:=0;
 BEGIN
 IF keep=ANY(absorb) OR cardinality(absorb) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'invalid merge'; END IF;
 PERFORM 1 FROM public.face_people p WHERE p.person_id=keep AND p.owner_username=owner AND p.name IS NULL AND NOT p.hidden
  AND NOT EXISTS(SELECT FROM public.face_assignments c WHERE c.person_id=p.person_id AND c.status='confirmed') FOR UPDATE;
 IF NOT FOUND THEN RETURN 0; END IF;
 FOREACH other IN ARRAY absorb LOOP
  PERFORM 1 FROM public.face_people p WHERE p.person_id=other AND p.owner_username=owner AND p.name IS NULL AND NOT p.hidden
   AND NOT EXISTS(SELECT FROM public.face_assignments c WHERE c.person_id=p.person_id AND c.status='confirmed')
   AND NOT EXISTS(SELECT FROM public.face_assignments a JOIN public.face_rejections r ON r.face_id=a.face_id AND r.person_id=keep
    WHERE a.person_id=p.person_id) FOR UPDATE;
  CONTINUE WHEN NOT FOUND;
  UPDATE public.face_assignments SET person_id=keep WHERE person_id=other;
  DELETE FROM public.face_people WHERE person_id=other;
  merged:=merged+1;
 END LOOP;
 IF merged>0 THEN
  UPDATE public.face_people SET updated_at=now(),cover_face_id=(
   SELECT f.face_id FROM public.faces f JOIN public.face_assignments a USING(face_id)
   WHERE a.person_id=keep ORDER BY f.quality DESC,f.face_id LIMIT 1) WHERE person_id=keep;
 END IF;
 RETURN merged;
 END $$;
REVOKE ALL ON FUNCTION face_worker.unnamed_groups(text,text),face_worker.merge_unnamed(text,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION face_worker.unnamed_groups(text,text),face_worker.merge_unnamed(text,uuid,uuid[]) TO personal_photos_face_worker;

-- The worker may delete only empty, unnamed groups (the merge leftovers).
GRANT DELETE ON public.face_people TO personal_photos_face_worker;
CREATE FUNCTION photo_security.guard_person_delete() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 BEGIN
 IF current_user='personal_photos_face_worker'
 AND (OLD.name IS NOT NULL OR EXISTS(SELECT FROM public.face_assignments a WHERE a.person_id=OLD.person_id)) THEN
  RAISE EXCEPTION 'only empty unnamed groups may be removed by the scanner' USING ERRCODE='42501';
 END IF;
 RETURN OLD;
 END $$;
REVOKE ALL ON FUNCTION photo_security.guard_person_delete() FROM PUBLIC;
CREATE TRIGGER guard_person_delete BEFORE DELETE ON public.face_people
 FOR EACH ROW EXECUTE FUNCTION photo_security.guard_person_delete();
