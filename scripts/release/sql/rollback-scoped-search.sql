-- Before reverting to a pre-scoped application/search-worker version.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['photos','events','faces','face_assignments','face_people','face_settings','album_shares','users','gallery_main_admins'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS invalidate_saved_search ON public.%I',item);
 EXECUTE format('CREATE TRIGGER invalidate_saved_search AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.invalidate_search_sessions()',item);
 END LOOP;
END $$;
UPDATE search_catalog_revision SET revision=revision+1 WHERE id=true;
COMMIT;
