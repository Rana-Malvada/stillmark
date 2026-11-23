-- Drain search publishers before applying; old publishers do not claim work.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
LOCK TABLE public.photos,public.search_queue IN SHARE ROW EXCLUSIVE MODE;
-- Existing work may have been submitted without an acknowledgment. Preserve it.
ALTER TABLE public.search_queue ADD COLUMN publication_attempted boolean NOT NULL DEFAULT true;
ALTER TABLE public.search_queue ALTER COLUMN publication_attempted SET DEFAULT false;

CREATE OR REPLACE FUNCTION photo_security.queue_photo_search_statement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source_sql text;
BEGIN
 IF TG_OP='INSERT' THEN source_sql:='SELECT photo_id,event_id,search_synced_at IS NOT NULL AS acknowledged FROM new_rows';
 ELSIF TG_OP='DELETE' THEN source_sql:='SELECT photo_id,event_id,search_synced_at IS NOT NULL AS acknowledged FROM old_rows';
 ELSE source_sql:='SELECT n.photo_id,n.event_id,n.search_synced_at IS NOT NULL AS acknowledged FROM new_rows n JOIN old_rows o USING(photo_id)
 WHERE (n.updated_at,n.event_id,n.ingest_status,n.display_stage_path) IS DISTINCT FROM (o.updated_at,o.event_id,o.ingest_status,o.display_stage_path)'; END IF;
 EXECUTE 'INSERT INTO public.search_queue(kind,id,stats_event_id,stats_owner,publication_attempted)
 SELECT ''photo'',r.photo_id,r.event_id,e.owner_username,r.acknowledged FROM ('||source_sql||') r LEFT JOIN public.events e USING(event_id) ORDER BY r.photo_id
 ON CONFLICT(kind,id) DO UPDATE SET revision=nextval(''public.search_revision''),queued_at=now(),stats_event_id=EXCLUDED.stats_event_id,stats_owner=coalesce(EXCLUDED.stats_owner,search_queue.stats_owner),publication_attempted=search_queue.publication_attempted OR EXCLUDED.publication_attempted';
 -- The upsert above locks the queue row before we inspect the claim. A
 -- publisher claims that same row before reading any photo data, so either
 -- deletion cancels untouched work or a racing publication retains its removal.
 IF TG_OP='DELETE' THEN
  DELETE FROM public.search_queue q USING old_rows o
  WHERE q.kind='photo' AND q.id=o.photo_id
   AND o.search_synced_at IS NULL AND NOT q.publication_attempted;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.queue_photo_search_statement() FROM PUBLIC;
