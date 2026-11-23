-- Fixed, owner-scoped aggregate reads. Never return faces, embeddings or shared names.
-- Use relational ownership checks once per scan instead of current_face() per row.
CREATE FUNCTION photo_security.person_counts(selected_person uuid DEFAULT NULL)
RETURNS TABLE(person_id uuid, photo_count integer, review_count integer, sort_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
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
 AND (selected_person IS NULL OR a.person_id=selected_person)
 GROUP BY a.person_id
$$;
CREATE FUNCTION photo_security.people_totals()
RETURNS TABLE(unnamed integer,people integer,review integer,unknown integer,"lowerConfidence" integer,ignored integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH inventory AS MATERIALIZED (
 SELECT f.face_id,f.ignored,f.quality_ok,a.person_id,a.status
 FROM public.faces f
 JOIN public.photos ph ON ph.photo_id=f.photo_id
 JOIN public.events e ON e.event_id=ph.event_id AND e.owner_username=f.owner_username
 LEFT JOIN public.face_assignments a ON a.face_id=f.face_id AND a.owner_username=f.owner_username
 WHERE f.owner_username=photo_security.username()
 ), people AS (
 SELECT count(*) FILTER(WHERE p.name IS NULL AND NOT p.hidden)::integer AS unnamed,count(*)::integer AS people
 FROM public.face_people p WHERE p.owner_username=photo_security.username()
 AND p.person_id IN (SELECT person_id FROM inventory WHERE NOT ignored)
 ), totals AS (
 SELECT count(*) FILTER(WHERE NOT ignored AND status='suggested')::integer AS review,
 count(*) FILTER(WHERE NOT ignored AND person_id IS NULL)::integer AS unknown,
 count(*) FILTER(WHERE NOT ignored AND NOT quality_ok AND person_id IS NULL)::integer AS "lowerConfidence",
 count(*) FILTER(WHERE ignored)::integer AS ignored FROM inventory
 ) SELECT people.unnamed,people.people,totals.* FROM people CROSS JOIN totals
$$;
REVOKE ALL ON FUNCTION photo_security.person_counts(uuid),photo_security.people_totals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.person_counts(uuid),photo_security.people_totals() TO personal_photos_app;
