-- Immutable, reviewed classifications for historical metering records.
-- No prompts, SQL text, paths or usernames are stored here.
CREATE TABLE public.cost_ai_history (
 query_id text NOT NULL,
 function_name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('photo_ai','video_ai','search_indexing','search_ai')),
 basis text NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(query_id,function_name)
);
ALTER TABLE public.cost_ai_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_ai_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.cost_ai_history FROM PUBLIC;
GRANT SELECT,INSERT ON public.cost_ai_history TO personal_photos_maintenance;
CREATE POLICY maintenance_read ON public.cost_ai_history FOR SELECT TO personal_photos_maintenance USING(true);
CREATE POLICY maintenance_insert ON public.cost_ai_history FOR INSERT TO personal_photos_maintenance WITH CHECK(true);
