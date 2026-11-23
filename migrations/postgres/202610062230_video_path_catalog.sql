SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- Keep evaluation local to one candidate photo; this function is SECURITY INVOKER.
-- Its query continues to enforce the caller's photo RLS policies.
CREATE FUNCTION photo_security.visible_photo(id integer) RETURNS boolean
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS
 $$ SELECT EXISTS(SELECT 1 FROM public.photos WHERE photo_id=id) $$;
REVOKE ALL ON FUNCTION photo_security.visible_photo(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.visible_photo(integer) TO personal_photos_app;
ALTER POLICY app_read ON public.video_playback USING(photo_security.visible_photo(photo_id));
CREATE TABLE public.video_rendition_paths (
 stage_path text NOT NULL,
 photo_id integer NOT NULL REFERENCES public.video_playback(photo_id) ON DELETE CASCADE,
 PRIMARY KEY(stage_path,photo_id)
);
CREATE INDEX video_rendition_paths_photo ON public.video_rendition_paths(photo_id);
ALTER TABLE public.video_rendition_paths ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_rendition_paths FROM PUBLIC,personal_photos_app;
GRANT SELECT ON public.video_rendition_paths TO personal_photos_app;
CREATE POLICY app_read ON public.video_rendition_paths FOR SELECT TO personal_photos_app
 USING(photo_security.visible_photo(photo_id));
-- Only the trigger writes this projection. It derives paths exclusively from the
-- playback row already authorized by the existing source-table write policies.
CREATE FUNCTION photo_security.sync_video_paths() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
 BEGIN
 DELETE FROM public.video_rendition_paths WHERE photo_id=NEW.photo_id;
 INSERT INTO public.video_rendition_paths(stage_path,photo_id)
 SELECT DISTINCT r->>'stage_path',NEW.photo_id FROM jsonb_array_elements(NEW.renditions) r
 WHERE jsonb_typeof(r->'stage_path')='string';
 RETURN NEW;
 END $$;
REVOKE ALL ON FUNCTION photo_security.sync_video_paths() FROM PUBLIC,personal_photos_app;
CREATE TRIGGER sync_video_paths AFTER INSERT OR UPDATE OF renditions ON public.video_playback
 FOR EACH ROW EXECUTE FUNCTION photo_security.sync_video_paths();
INSERT INTO public.video_rendition_paths(stage_path,photo_id)
 SELECT DISTINCT r->>'stage_path',v.photo_id FROM public.video_playback v,
 LATERAL jsonb_array_elements(v.renditions) r WHERE jsonb_typeof(r->'stage_path')='string';
DROP INDEX public.video_playback_ready_renditions;
