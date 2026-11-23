SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
-- Expand first. Legacy triggers stay until every search consumer is upgraded.
CREATE TABLE search_scope_revisions(scope text PRIMARY KEY, revision bigint NOT NULL DEFAULT 1);
ALTER TABLE search_scope_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_scope_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY scope_read ON search_scope_revisions FOR SELECT TO personal_photos_app USING(
 scope='user:'||current_setting('photos.username',true) OR
 CASE WHEN scope ~ '^album:[0-9]+$' THEN photo_security.read_event(substring(scope from 7)::int) ELSE false END);
CREATE POLICY scope_worker ON search_scope_revisions FOR SELECT TO personal_photos_maintenance,personal_photos_search_worker USING(true);
GRANT SELECT ON search_scope_revisions TO personal_photos_app,personal_photos_maintenance,personal_photos_search_worker;
ALTER TABLE search_sessions ADD COLUMN scope_revision text;
ALTER TABLE search_sessions ADD COLUMN scope_ids int[];
CREATE INDEX search_session_scoped_cache ON search_sessions(username,cache_key,scope_revision,last_used_at DESC);
CREATE FUNCTION search_scope_revision(albums int[], viewer text DEFAULT current_setting('photos.username',true)) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 SELECT md5(jsonb_build_array(
   (SELECT revision FROM public.search_catalog_revision WHERE id=true),
   (SELECT jsonb_agg(jsonb_build_array(s.scope,coalesce(r.revision,0)) ORDER BY s.scope)
    FROM (SELECT 'album:'||id::text AS scope FROM unnest(albums) id
          UNION SELECT 'user:'||coalesce(viewer,'')) s
    LEFT JOIN public.search_scope_revisions r USING(scope))
 )::text)
$$;
REVOKE ALL ON FUNCTION search_scope_revision(int[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_scope_revision(int[],text) TO personal_photos_app,personal_photos_maintenance,personal_photos_search_worker;
GRANT SELECT ON search_catalog_revision TO personal_photos_search_worker;

CREATE FUNCTION invalidate_search_scopes() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rows jsonb; owners text[]; albums int[]; scopes text[];
 v_ignored text[]:=ARRAY['updated_at','search_synced_at','last_login','ai_attempts','ai_error','ai_processing_started_at','ai_claim','ai_lease_until','ai_next_attempt_at'];
BEGIN
 IF TG_OP='UPDATE' THEN
   SELECT jsonb_agg(j) INTO rows FROM (
     (SELECT to_jsonb(n)-v_ignored j FROM new_rows n EXCEPT SELECT to_jsonb(o)-v_ignored FROM old_rows o)
     UNION
     (SELECT to_jsonb(o)-v_ignored FROM old_rows o EXCEPT SELECT to_jsonb(n)-v_ignored FROM new_rows n)
   ) changed;
 ELSIF TG_OP='INSERT' THEN SELECT jsonb_agg(to_jsonb(n)) INTO rows FROM new_rows n;
 ELSE SELECT jsonb_agg(to_jsonb(o)) INTO rows FROM old_rows o; END IF;
 IF rows IS NULL THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME IN ('photos','events','album_shares') THEN
   SELECT array_agg(DISTINCT (j->>'event_id')::int) INTO albums FROM jsonb_array_elements(rows) j;
 ELSIF TG_TABLE_NAME='faces' THEN
   SELECT array_agg(DISTINCT p.event_id) INTO albums FROM jsonb_array_elements(rows) j JOIN public.photos p ON p.photo_id=(j->>'photo_id')::int;
 ELSIF TG_TABLE_NAME='face_assignments' THEN
   SELECT array_agg(DISTINCT p.event_id) INTO albums FROM jsonb_array_elements(rows) j
   JOIN public.faces f ON f.face_id=(j->>'face_id')::bigint JOIN public.photos p ON p.photo_id=f.photo_id;
 ELSIF TG_TABLE_NAME IN ('face_people','face_settings') THEN
   SELECT array_agg(DISTINCT j->>'owner_username') INTO owners FROM jsonb_array_elements(rows) j;
   SELECT array_agg(DISTINCT event_id) INTO albums FROM (
     SELECT e.event_id FROM public.events e WHERE e.owner_username=ANY(owners)
     UNION SELECT p.event_id FROM public.faces f JOIN public.photos p USING(photo_id) WHERE f.owner_username=ANY(owners)
   ) a;
 ELSE
   SELECT array_agg(DISTINCT j->>'username') INTO owners FROM jsonb_array_elements(rows) j;
 END IF;
 SELECT array_agg(scope ORDER BY scope) INTO scopes FROM (
   SELECT 'album:'||id::text scope FROM unnest(albums) id WHERE id IS NOT NULL
   UNION SELECT 'user:'||name FROM unnest(owners) name WHERE name IS NOT NULL
 ) s;
 -- Ordered, one increment per affected scope/statement; no global content lock.
 INSERT INTO public.search_scope_revisions(scope,revision) SELECT unnest(scopes),1
 ON CONFLICT(scope) DO UPDATE SET revision=search_scope_revisions.revision+1;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION invalidate_search_scopes() FROM PUBLIC;
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['photos','events','faces','face_assignments','face_people','face_settings','album_shares','users','gallery_main_admins'] LOOP
 EXECUTE format('CREATE TRIGGER search_scopes_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_search_scopes()',item);
 EXECUTE format('CREATE TRIGGER search_scopes_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_search_scopes()',item);
 EXECUTE format('CREATE TRIGGER search_scopes_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_search_scopes()',item);
 END LOOP;
END $$;
