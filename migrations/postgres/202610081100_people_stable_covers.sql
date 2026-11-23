SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Keep the existing usable cover when the scanner absorbs an unnamed group.
CREATE OR REPLACE FUNCTION face_worker.merge_unnamed(owner text, keep uuid, absorb uuid[]) RETURNS integer
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
  UPDATE public.face_people SET updated_at=now(),cover_face_id=COALESCE(
   (SELECT a.face_id FROM public.face_assignments a JOIN public.faces f USING(face_id)
    WHERE a.person_id=keep AND a.face_id=face_people.cover_face_id
      AND NOT f.ignored AND f.crop_path IS NOT NULL),
   (SELECT f.face_id FROM public.faces f JOIN public.face_assignments a USING(face_id)
   WHERE a.person_id=keep AND NOT f.ignored AND f.crop_path IS NOT NULL
   ORDER BY f.quality DESC,f.face_id LIMIT 1)) WHERE person_id=keep;
 END IF;
 RETURN merged;
 END $$;
