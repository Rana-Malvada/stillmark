SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- NULL means a whole-album link, including future uploads. A nonempty array is
-- an immutable selection; deleted/moved photos never widen it to the full album.
ALTER TABLE public.album_public_links ADD COLUMN photo_ids integer[];
ALTER TABLE public.album_public_links ADD CONSTRAINT public_link_selection_size
 CHECK (photo_ids IS NULL OR (cardinality(photo_ids) BETWEEN 1 AND 200 AND array_position(photo_ids,NULL) IS NULL));

CREATE FUNCTION photo_security.public_photos() RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT p.photo_id FROM public.album_public_links l
 JOIN public.events e ON e.event_id=l.event_id AND e.owner_username=l.owner_username
 JOIN public.photos p ON p.event_id=e.event_id
 WHERE l.token_hash=nullif(current_setting('photos.public_hash',true),'')
 AND l.revoked_at IS NULL AND l.expires_at>statement_timestamp()
 AND (l.photo_ids IS NULL OR p.photo_id=ANY(l.photo_ids))
$$;
REVOKE ALL ON FUNCTION photo_security.public_photos() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.public_photos() TO personal_photos_app;

-- Restrictive policy composes with existing signed-in and public-album policies.
CREATE POLICY public_selection ON public.photos AS RESTRICTIVE
 FOR SELECT TO personal_photos_app USING (
 nullif(current_setting('photos.public_hash',true),'') IS NULL
 OR photo_id IN (SELECT photo_security.public_photos())
 );
CREATE OR REPLACE FUNCTION photo_security.read_photo(id integer) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT FROM public.photos p WHERE p.photo_id=id
 AND photo_security.read_event(p.event_id)
 AND (nullif(current_setting('photos.public_hash',true),'') IS NULL
 OR p.photo_id IN (SELECT photo_security.public_photos())))
$$;

CREATE OR REPLACE FUNCTION photo_security.public_photo_people(photo integer)
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
 AND (l.photo_ids IS NULL OR p.photo_id=ANY(l.photo_ids))
 AND l.include_people AND l.revoked_at IS NULL AND l.expires_at>statement_timestamp()
 ORDER BY f.box_x NULLS LAST,f.face_id
$$;
REVOKE ALL ON FUNCTION photo_security.public_photo_people(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.public_photo_people(integer) TO personal_photos_app;
