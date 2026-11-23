SET LOCAL lock_timeout='5s';
ALTER TABLE stage_cleanup ADD COLUMN claim_token uuid;
ALTER TABLE stage_cleanup ADD COLUMN lease_until timestamptz;
-- Immutable tombstones fence late publication even after a failed/ambiguous REMOVE.
CREATE TABLE storage_retired_paths(path text PRIMARY KEY, retired_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON storage_retired_paths FROM PUBLIC;

CREATE FUNCTION photo_security.assert_storage_publishable(paths text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item text;
BEGIN
 FOR item IN SELECT DISTINCT p FROM unnest(paths) p WHERE p IS NOT NULL ORDER BY p LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('storage-path:'||item,0));
   IF EXISTS(SELECT FROM public.storage_retired_paths WHERE path=item) THEN
     RAISE EXCEPTION 'Storage path was retired; restart the upload with a new path' USING ERRCODE='55000';
   END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION photo_security.assert_storage_publishable(text[]) FROM PUBLIC;
CREATE FUNCTION photo_security.guard_storage_publication() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE paths text[]; data jsonb;
BEGIN
 data:=to_jsonb(NEW);
 IF TG_TABLE_NAME='photos' THEN
   paths:=ARRAY[data->>'original_stage_path',data->>'display_stage_path',data->>'thumbnail_stage_path'];
 ELSIF TG_TABLE_NAME='photo_trash' THEN
   paths:=ARRAY[data->'photo_data'->>'original_stage_path',data->'photo_data'->>'display_stage_path',data->'photo_data'->>'thumbnail_stage_path'];
 ELSIF TG_TABLE_NAME='video_playback' THEN
   IF NEW.status<>'ready' THEN RETURN NEW; END IF;
   SELECT array_agg(path) INTO paths FROM (SELECT NEW.stage_path path UNION SELECT r->>'stage_path' FROM jsonb_array_elements(NEW.renditions) r) p;
 ELSIF TG_TABLE_NAME='faces' THEN paths:=ARRAY[data->>'crop_path'];
 ELSE paths:=ARRAY[data->>'stage_path']; END IF;
 PERFORM photo_security.assert_storage_publishable(paths);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION photo_security.guard_storage_publication() FROM PUBLIC;
CREATE TRIGGER storage_publication BEFORE INSERT OR UPDATE OF original_stage_path,display_stage_path,thumbnail_stage_path ON photos FOR EACH ROW EXECUTE FUNCTION photo_security.guard_storage_publication();
CREATE TRIGGER storage_publication BEFORE INSERT OR UPDATE OF photo_data ON photo_trash FOR EACH ROW EXECUTE FUNCTION photo_security.guard_storage_publication();
CREATE TRIGGER storage_publication BEFORE INSERT OR UPDATE OF stage_path,renditions,status ON video_playback FOR EACH ROW EXECUTE FUNCTION photo_security.guard_storage_publication();
CREATE TRIGGER storage_publication BEFORE INSERT OR UPDATE OF crop_path ON faces FOR EACH ROW EXECUTE FUNCTION photo_security.guard_storage_publication();
CREATE TRIGGER storage_publication BEFORE INSERT OR UPDATE OF stage_path ON upload_chunks FOR EACH ROW EXECUTE FUNCTION photo_security.guard_storage_publication();

CREATE FUNCTION photo_security.reserve_stage_upload(p_path text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM photo_security.assert_storage_publishable(ARRAY[p_path]);
 INSERT INTO public.stage_cleanup(path,next_attempt) VALUES(p_path,now()+interval '24 hours') ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION photo_security.reserve_stage_upload(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.reserve_stage_upload(text) TO personal_photos_app,personal_photos_maintenance;

CREATE FUNCTION photo_security.claim_stage_cleanup(p_token uuid) RETURNS TABLE(path text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE candidates text[]; item text;
BEGIN
 SELECT array_agg(c.path ORDER BY c.path) INTO candidates FROM (
   SELECT q.path FROM public.stage_cleanup q WHERE q.next_attempt<=now() AND q.attempts<5
   AND (q.lease_until IS NULL OR q.lease_until<now()) ORDER BY q.next_attempt,q.path LIMIT 200 FOR UPDATE SKIP LOCKED
 ) c;
 IF candidates IS NULL THEN RETURN; END IF;
 FOREACH item IN ARRAY candidates LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('storage-path:'||item,0));
 END LOOP;
 UPDATE public.stage_cleanup q SET next_attempt=now()+interval '1 hour'
 WHERE q.path=ANY(candidates) AND q.path LIKE 'upload-chunks/%' AND EXISTS(
   SELECT FROM public.upload_sessions s WHERE s.upload_id::text=lower(split_part(q.path,'/',2)) AND s.result IS NULL);
 DELETE FROM public.stage_cleanup q WHERE q.path=ANY(candidates) AND (
   EXISTS(SELECT FROM public.photos p WHERE q.path IN(p.original_stage_path,p.display_stage_path,p.thumbnail_stage_path)) OR
   EXISTS(SELECT FROM public.photo_trash t WHERE q.path IN(t.photo_data->>'original_stage_path',t.photo_data->>'display_stage_path',t.photo_data->>'thumbnail_stage_path')) OR
   EXISTS(SELECT FROM public.faces f WHERE f.crop_path=q.path) OR
   EXISTS(SELECT FROM public.video_playback v WHERE v.status='ready' AND (v.stage_path=q.path OR EXISTS(SELECT FROM jsonb_array_elements(v.renditions) r WHERE r->>'stage_path'=q.path))
     AND (EXISTS(SELECT FROM public.photos p WHERE p.photo_id=v.photo_id) OR EXISTS(SELECT FROM public.photo_trash t WHERE t.photo_id=v.photo_id)))
 );
 INSERT INTO public.storage_retired_paths(path)
 SELECT q.path FROM public.stage_cleanup q WHERE q.path=ANY(candidates) AND q.next_attempt<=now()
 ON CONFLICT DO NOTHING;
 RETURN QUERY UPDATE public.stage_cleanup q SET claim_token=p_token,lease_until=now()+interval '30 minutes'
 WHERE q.path=ANY(candidates) AND q.next_attempt<=now() RETURNING q.path;
END $$;
REVOKE ALL ON FUNCTION photo_security.claim_stage_cleanup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.claim_stage_cleanup(uuid) TO personal_photos_maintenance;
