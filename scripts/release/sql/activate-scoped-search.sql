-- POST-UPGRADE ONLY: application and search worker must both use scope_revision.
-- Stop/drain old search batches before running. Never run in pre-deploy migrations.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ DECLARE item text; BEGIN
 IF NOT EXISTS(SELECT FROM information_schema.columns WHERE table_schema='public' AND table_name='search_sessions' AND column_name='scope_revision') THEN
 RAISE EXCEPTION 'Scoped-search expansion migration is missing'; END IF;
 FOREACH item IN ARRAY ARRAY['photos','events','faces','face_assignments','face_people','face_settings','album_shares','users','gallery_main_admins'] LOOP
 EXECUTE format('DROP TRIGGER IF EXISTS invalidate_saved_search ON public.%I',item);
 END LOOP;
END $$;
-- Rare emergency generation invalidates pre-activation cached searches once.
UPDATE search_catalog_revision SET revision=revision+1 WHERE id=true;
COMMIT;
