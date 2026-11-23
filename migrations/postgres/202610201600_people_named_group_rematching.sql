SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Naming a group can make already-confirmed faces useful without changing their
-- assignment rows. Restoring a hidden named person also restores its references.
CREATE FUNCTION face_worker.queue_named_person_match() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
 BEGIN
 IF NEW.name IS NOT NULL AND NOT NEW.hidden AND (OLD.name IS NULL OR OLD.hidden) THEN
  INSERT INTO public.face_match_queue(owner_username,model_version)
   SELECT DISTINCT f.owner_username,f.model_version
   FROM public.faces f JOIN public.face_assignments a USING(face_id)
   WHERE a.person_id=NEW.person_id AND a.status='confirmed' AND NOT f.ignored
    AND f.source='detected' AND f.model_version IS NOT NULL
   ON CONFLICT(owner_username,model_version) DO UPDATE SET requested_at=now(),after_face_id=0;
 END IF;
 RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION face_worker.queue_named_person_match() FROM PUBLIC;
CREATE TRIGGER named_person_rematch AFTER UPDATE OF name,hidden ON public.face_people
 FOR EACH ROW EXECUTE FUNCTION face_worker.queue_named_person_match();
