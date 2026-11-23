SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
ALTER TABLE public.album_public_links
 ADD COLUMN include_location boolean NOT NULL DEFAULT false,
 ADD COLUMN include_people boolean NOT NULL DEFAULT false;

-- Return only settled names/boxes from this capability's album, never embeddings,
-- person IDs, crops, suggestions or another owner's face records.
CREATE FUNCTION photo_security.public_photo_people(photo integer)
RETURNS TABLE(name text, box json) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
 SELECT person.name, CASE WHEN f.box_x IS NULL THEN NULL ELSE
 json_build_object('x',f.box_x,'y',f.box_y,'w',f.box_w,'h',f.box_h) END
 FROM public.album_public_links l
 JOIN public.events e ON e.event_id=l.event_id AND e.owner_username=l.owner_username
 JOIN public.photos p ON p.event_id=e.event_id AND p.photo_id=photo
 JOIN public.faces f ON f.photo_id=p.photo_id AND f.owner_username=e.owner_username AND NOT f.ignored
 JOIN public.face_assignments a ON a.face_id=f.face_id AND a.owner_username=f.owner_username AND a.status IN ('auto','confirmed')
 JOIN public.face_people person ON person.person_id=a.person_id AND person.owner_username=f.owner_username AND NOT person.hidden AND person.name IS NOT NULL
 WHERE l.token_hash=nullif(current_setting('photos.public_hash',true),'')
 AND l.include_people AND l.revoked_at IS NULL AND l.expires_at>statement_timestamp()
 ORDER BY f.box_x NULLS LAST,f.face_id
$$;
REVOKE ALL ON FUNCTION photo_security.public_photo_people(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.public_photo_people(integer) TO personal_photos_app;
