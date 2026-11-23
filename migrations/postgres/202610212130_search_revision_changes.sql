SET LOCAL lock_timeout='5s';
-- Statement triggers also fire for zero-row housekeeping. Only actual data changes
-- invalidate search snapshots. Sync acknowledgements and bookkeeping are not data.
CREATE OR REPLACE FUNCTION invalidate_search_sessions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='UPDATE' AND
  (to_jsonb(OLD)-ARRAY['updated_at','search_synced_at','last_login','ai_attempts','ai_error','ai_processing_started_at'])=
  (to_jsonb(NEW)-ARRAY['updated_at','search_synced_at','last_login','ai_attempts','ai_error','ai_processing_started_at']) THEN RETURN NULL; END IF;
 UPDATE public.search_catalog_revision SET revision=revision+1;
 RETURN NULL;
END $$;
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['photos','events','faces','face_assignments','face_people','face_settings','album_shares','users','gallery_main_admins'] LOOP
 EXECUTE format('DROP TRIGGER invalidate_saved_search ON public.%I',item);
 EXECUTE format('CREATE TRIGGER invalidate_saved_search AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.invalidate_search_sessions()',item);
 END LOOP;
END $$;
