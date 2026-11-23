SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE TABLE search_catalog_revision(id boolean PRIMARY KEY DEFAULT true CHECK(id), revision bigint NOT NULL DEFAULT 1);
INSERT INTO search_catalog_revision DEFAULT VALUES;
GRANT SELECT ON search_catalog_revision TO personal_photos_app,personal_photos_maintenance;
CREATE FUNCTION invalidate_search_sessions() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN UPDATE public.search_catalog_revision SET revision=revision+1; RETURN NULL; END $$;
REVOKE ALL ON FUNCTION invalidate_search_sessions() FROM PUBLIC;
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['photos','events','faces','face_assignments','face_people','face_settings','album_shares','users','gallery_main_admins'] LOOP
 EXECUTE format('CREATE TRIGGER invalidate_saved_search AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.invalidate_search_sessions()',item);
 END LOOP;
END $$;
CREATE TABLE search_sessions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 username text NOT NULL DEFAULT current_setting('photos.username',true),
 cache_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('photo','event')),
 query text NOT NULL,
 options jsonb NOT NULL,
 revision bigint NOT NULL,
 payload jsonb NOT NULL,
 candidate_ids int[] NOT NULL,
 documents jsonb NOT NULL DEFAULT '[]',
 reranked_ids int[],
 rerank_model text,
 rerank_status text NOT NULL DEFAULT 'queued' CHECK(rerank_status IN ('queued','running','completed','failed','skipped')),
 rerank_error text,
 claim_token uuid,
 lease_until timestamptz,
 attempts int NOT NULL DEFAULT 0,
 hits int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '14 days'
);
CREATE INDEX search_session_cache ON search_sessions(username,cache_key,revision,last_used_at DESC);
CREATE INDEX search_session_queue ON search_sessions(rerank_status,last_used_at);
ALTER TABLE search_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY own_search ON search_sessions TO personal_photos_app USING(username=current_setting('photos.username',true)) WITH CHECK(username=current_setting('photos.username',true));
CREATE POLICY maintain_search ON search_sessions TO personal_photos_maintenance USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON search_sessions TO personal_photos_app,personal_photos_maintenance;
