SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
-- Face data belongs to the photo's current owner. Face rows carry the owner at scan
-- time; when a photo moves to another owner's album (or an album changes owner) the
-- former owner must lose its faces, crops, names and search matches like the photo.

-- True while the face's owner still owns its photo.
CREATE FUNCTION photo_security.current_face(id bigint) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS
 $$ SELECT EXISTS(SELECT FROM public.faces f JOIN public.photos p ON p.photo_id=f.photo_id
   JOIN public.events e ON e.event_id=p.event_id WHERE f.face_id=id AND e.owner_username=f.owner_username) $$;
REVOKE ALL ON FUNCTION photo_security.current_face(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.current_face(bigint) TO personal_photos_app;

CREATE OR REPLACE FUNCTION photo_security.shared_face(id bigint) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS
 $$ SELECT photo_security.username() IS NOT NULL AND photo_security.current_face(id) AND EXISTS(
  SELECT FROM public.faces f JOIN public.face_assignments a USING(face_id)
  JOIN public.face_settings s ON s.owner_username=f.owner_username AND s.enabled AND s.share_names
  JOIN public.face_people p ON p.person_id=a.person_id AND NOT p.hidden AND p.name IS NOT NULL
  WHERE f.face_id=id AND NOT f.ignored AND a.status IN ('auto','confirmed') AND photo_security.read_photo(f.photo_id)) $$;

DROP POLICY app_read ON public.faces;
DROP POLICY app_update ON public.faces;
DROP POLICY app_delete ON public.faces;
CREATE POLICY app_read ON public.faces FOR SELECT TO personal_photos_app
 USING((photo_security.owns_people(owner_username) AND photo_security.current_face(face_id)) OR photo_security.shared_face(face_id));
CREATE POLICY app_update ON public.faces FOR UPDATE TO personal_photos_app
 USING(photo_security.edits_people(owner_username) AND photo_security.current_face(face_id))
 WITH CHECK(photo_security.edits_people(owner_username));
CREATE POLICY app_delete ON public.faces FOR DELETE TO personal_photos_app
 USING(photo_security.edits_people(owner_username) AND photo_security.current_face(face_id));

DROP POLICY app_read ON public.face_assignments;
DROP POLICY app_insert ON public.face_assignments;
DROP POLICY app_update ON public.face_assignments;
DROP POLICY app_delete ON public.face_assignments;
CREATE POLICY app_read ON public.face_assignments FOR SELECT TO personal_photos_app
 USING((photo_security.owns_people(owner_username) AND photo_security.current_face(face_id)) OR photo_security.shared_face(face_id));
CREATE POLICY app_insert ON public.face_assignments FOR INSERT TO personal_photos_app
 WITH CHECK(photo_security.edits_people(owner_username) AND photo_security.current_face(face_id));
CREATE POLICY app_update ON public.face_assignments FOR UPDATE TO personal_photos_app
 USING(photo_security.edits_people(owner_username) AND photo_security.current_face(face_id))
 WITH CHECK(photo_security.edits_people(owner_username) AND photo_security.current_face(face_id));
CREATE POLICY app_delete ON public.face_assignments FOR DELETE TO personal_photos_app
 USING(photo_security.edits_people(owner_username) AND photo_security.current_face(face_id));

-- Retires a former owner's face data for one photo and queues it for its new owner.
CREATE FUNCTION photo_security.retire_moved_faces(photo integer) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 DECLARE owner text := photo_security.photo_owner(photo);
 BEGIN
 WITH removed AS (DELETE FROM public.faces WHERE photo_id=photo AND owner_username IS DISTINCT FROM owner RETURNING crop_path)
 INSERT INTO public.stage_cleanup(path,next_attempt) SELECT crop_path,now() FROM removed WHERE crop_path IS NOT NULL
  ON CONFLICT DO NOTHING;
 DELETE FROM public.face_scan_queue WHERE photo_id=photo AND owner_username IS DISTINCT FROM owner;
 INSERT INTO public.face_scan_queue(photo_id,owner_username,source_path)
  SELECT p.photo_id,owner,p.original_stage_path FROM public.photos p
  JOIN public.face_settings s ON s.owner_username=owner AND s.enabled
  WHERE p.photo_id=photo AND p.media_type='photo' AND p.ingest_status='READY' AND p.original_stage_path IS NOT NULL
  ON CONFLICT(photo_id) DO NOTHING;
 END $$;
REVOKE ALL ON FUNCTION photo_security.retire_moved_faces(integer) FROM PUBLIC,personal_photos_app;

CREATE FUNCTION photo_security.photo_owner_changed() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 BEGIN
 IF TG_TABLE_NAME='photos' THEN
  PERFORM photo_security.retire_moved_faces(NEW.photo_id);
 ELSE
  PERFORM photo_security.retire_moved_faces(p.photo_id) FROM public.photos p WHERE p.event_id=NEW.event_id
   AND EXISTS(SELECT FROM public.faces f WHERE f.photo_id=p.photo_id
              UNION ALL SELECT FROM public.face_scan_queue q WHERE q.photo_id=p.photo_id);
 END IF;
 RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION photo_security.photo_owner_changed() FROM PUBLIC,personal_photos_app;
CREATE TRIGGER retire_moved_faces AFTER UPDATE OF event_id ON public.photos
 FOR EACH ROW WHEN (OLD.event_id IS DISTINCT FROM NEW.event_id) EXECUTE FUNCTION photo_security.photo_owner_changed();
CREATE TRIGGER retire_moved_faces AFTER UPDATE OF owner_username ON public.events
 FOR EACH ROW WHEN (OLD.owner_username IS DISTINCT FROM NEW.owner_username) EXECUTE FUNCTION photo_security.photo_owner_changed();

-- Photos that already moved before this migration.
SELECT photo_security.retire_moved_faces(m.photo_id) FROM (
 SELECT DISTINCT f.photo_id FROM public.faces f JOIN public.photos p ON p.photo_id=f.photo_id
 WHERE f.owner_username IS DISTINCT FROM photo_security.photo_owner(f.photo_id)) m;
