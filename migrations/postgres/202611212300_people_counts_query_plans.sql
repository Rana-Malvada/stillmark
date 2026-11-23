-- Separate full-owner and single-person plans: the optional OR caused a generic
-- plan with repeated photo lookups even for a complete owner inventory.
-- CREATE OR REPLACE retains ownership and the existing restricted execution ACL.
CREATE OR REPLACE FUNCTION photo_security.person_counts(selected_person uuid DEFAULT NULL)
RETURNS TABLE(person_id uuid, photo_count integer, review_count integer, sort_count integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF selected_person IS NULL THEN
  RETURN QUERY

 SELECT a.person_id,
 count(DISTINCT f.photo_id) FILTER(WHERE a.status<>'suggested')::integer,
 count(*) FILTER(WHERE a.status='suggested')::integer,
 count(DISTINCT f.photo_id)::integer
 FROM public.faces f
 JOIN public.photos ph ON ph.photo_id=f.photo_id
 JOIN public.events e ON e.event_id=ph.event_id AND e.owner_username=f.owner_username
 JOIN public.face_assignments a ON a.face_id=f.face_id AND a.owner_username=f.owner_username
 JOIN public.face_people p ON p.person_id=a.person_id AND p.owner_username=f.owner_username
 WHERE f.owner_username=photo_security.username() AND NOT f.ignored
 GROUP BY a.person_id
;
 ELSE
  RETURN QUERY

 SELECT a.person_id,
 count(DISTINCT f.photo_id) FILTER(WHERE a.status<>'suggested')::integer,
 count(*) FILTER(WHERE a.status='suggested')::integer,
 count(DISTINCT f.photo_id)::integer
 FROM public.faces f
 JOIN public.photos ph ON ph.photo_id=f.photo_id
 JOIN public.events e ON e.event_id=ph.event_id AND e.owner_username=f.owner_username
 JOIN public.face_assignments a ON a.face_id=f.face_id AND a.owner_username=f.owner_username
 JOIN public.face_people p ON p.person_id=a.person_id AND p.owner_username=f.owner_username
 WHERE f.owner_username=photo_security.username() AND NOT f.ignored
 AND a.person_id=selected_person
 GROUP BY a.person_id
;
 END IF;
END
$$;
