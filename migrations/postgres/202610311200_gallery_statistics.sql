-- Initial installation requires drained writers; lock timeout aborts rather than waiting indefinitely.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
LOCK TABLE public.events,public.photos,public.search_queue IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE public.search_queue ADD COLUMN stats_event_id int;
ALTER TABLE public.search_queue ADD COLUMN stats_owner text;
ALTER TABLE public.search_queue ADD COLUMN operation text NOT NULL DEFAULT 'remove' CHECK(operation IN ('upsert','remove'));

CREATE FUNCTION photo_security.prepare_search_work_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source record;
BEGIN
 IF NEW.kind='photo' THEN
  SELECT p.event_id,e.owner_username,(p.ingest_status='READY' AND p.display_stage_path IS NOT NULL) publishable INTO source
   FROM public.photos p JOIN public.events e USING(event_id) WHERE p.photo_id=NEW.id;
 ELSE
  SELECT e.event_id,e.owner_username,true publishable INTO source FROM public.events e WHERE e.event_id=NEW.id;
 END IF;
 IF FOUND THEN
  NEW.stats_event_id:=source.event_id; NEW.stats_owner:=source.owner_username;
  NEW.operation:=CASE WHEN source.publishable THEN 'upsert' ELSE 'remove' END;
 ELSE
  NEW.operation:='remove';
  IF TG_OP='UPDATE' THEN
   NEW.stats_event_id:=coalesce(NEW.stats_event_id,OLD.stats_event_id);
   NEW.stats_owner:=coalesce(NEW.stats_owner,OLD.stats_owner);
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION photo_security.prepare_search_work_scope() FROM PUBLIC;
CREATE TRIGGER search_work_scope BEFORE INSERT OR UPDATE ON public.search_queue FOR EACH ROW EXECUTE FUNCTION photo_security.prepare_search_work_scope();
-- Recover only known live scope. Unresolvable historical tombstones remain admin-only.
UPDATE public.search_queue SET operation=operation;

CREATE OR REPLACE FUNCTION public.queue_search_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item_id int; album_id int; owner_name text;
BEGIN
 IF TG_TABLE_NAME='photos' THEN
  item_id:=CASE WHEN TG_OP='DELETE' THEN OLD.photo_id ELSE NEW.photo_id END;
  album_id:=CASE WHEN TG_OP='DELETE' THEN OLD.event_id ELSE NEW.event_id END;
  SELECT owner_username INTO owner_name FROM public.events WHERE event_id=album_id;
 ELSE
  item_id:=CASE WHEN TG_OP='DELETE' THEN OLD.event_id ELSE NEW.event_id END;
  album_id:=item_id;
  owner_name:=CASE WHEN TG_OP='DELETE' THEN OLD.owner_username ELSE NEW.owner_username END;
 END IF;
 INSERT INTO public.search_queue(kind,id,stats_event_id,stats_owner) VALUES(TG_ARGV[0],item_id,album_id,owner_name)
 ON CONFLICT(kind,id) DO UPDATE SET revision=nextval('public.search_revision'),queued_at=now(),
 stats_event_id=EXCLUDED.stats_event_id,stats_owner=coalesce(EXCLUDED.stats_owner,search_queue.stats_owner);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.queue_search_change() FROM PUBLIC;
-- Enqueue one set per source statement, so bulk edits do not execute a counter
-- statement for every photo. The queue BEFORE trigger still derives live scope.
DROP TRIGGER photo_search_queue ON public.photos;
CREATE FUNCTION photo_security.queue_photo_search_statement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source_sql text;
BEGIN
 IF TG_OP='INSERT' THEN source_sql:='SELECT photo_id,event_id FROM new_rows';
 ELSIF TG_OP='DELETE' THEN source_sql:='SELECT photo_id,event_id FROM old_rows';
 ELSE source_sql:='SELECT n.photo_id,n.event_id FROM new_rows n JOIN old_rows o USING(photo_id)
 WHERE (n.updated_at,n.event_id,n.ingest_status,n.display_stage_path) IS DISTINCT FROM (o.updated_at,o.event_id,o.ingest_status,o.display_stage_path)'; END IF;
 EXECUTE 'INSERT INTO public.search_queue(kind,id,stats_event_id,stats_owner)
 SELECT ''photo'',r.photo_id,r.event_id,e.owner_username FROM ('||source_sql||') r LEFT JOIN public.events e USING(event_id) ORDER BY r.photo_id
 ON CONFLICT(kind,id) DO UPDATE SET revision=nextval(''public.search_revision''),queued_at=now(),stats_event_id=EXCLUDED.stats_event_id,stats_owner=coalesce(EXCLUDED.stats_owner,search_queue.stats_owner)';
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.queue_photo_search_statement() FROM PUBLIC;
CREATE TRIGGER photo_search_queue_insert AFTER INSERT ON public.photos REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION photo_security.queue_photo_search_statement();
CREATE TRIGGER photo_search_queue_update AFTER UPDATE ON public.photos REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION photo_security.queue_photo_search_statement();
CREATE TRIGGER photo_search_queue_delete AFTER DELETE ON public.photos REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION photo_security.queue_photo_search_statement();

CREATE TABLE public.gallery_statistics(
 scope text NOT NULL CHECK(scope IN ('album','all')), scope_id int NOT NULL,
 bucket smallint NOT NULL CHECK(bucket BETWEEN 0 AND 31),
 total_photos bigint NOT NULL DEFAULT 0 ,
 total_videos bigint NOT NULL DEFAULT 0 ,
 photos_with_ai bigint NOT NULL DEFAULT 0 ,
 photos_without_ai bigint NOT NULL DEFAULT 0 ,
 photos_failed bigint NOT NULL DEFAULT 0 ,
 in_search bigint NOT NULL DEFAULT 0 ,
 photo_updates bigint NOT NULL DEFAULT 0 ,
 album_updates bigint NOT NULL DEFAULT 0 ,
 photo_removals bigint NOT NULL DEFAULT 0 ,
 album_removals bigint NOT NULL DEFAULT 0 ,
 PRIMARY KEY(scope,scope_id,bucket), CHECK(scope<>'all' OR scope_id=0)
);
-- Validate the final UPSERT row, rather than rejecting its signed input delta.
-- AFTER triggers run only for the inserted/updated result, not a speculative insert.
CREATE FUNCTION photo_security.check_gallery_statistics() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.total_photos<0 OR NEW.total_videos<0 OR NEW.photos_with_ai<0 OR NEW.photos_without_ai<0 OR NEW.photos_failed<0 OR NEW.in_search<0 OR NEW.photo_updates<0 OR NEW.album_updates<0 OR NEW.photo_removals<0 OR NEW.album_removals<0 THEN
  RAISE EXCEPTION 'Gallery statistics would become negative' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.check_gallery_statistics() FROM PUBLIC;
CREATE TRIGGER statistics_nonnegative AFTER INSERT OR UPDATE ON public.gallery_statistics
FOR EACH ROW EXECUTE FUNCTION photo_security.check_gallery_statistics();
ALTER TABLE public.gallery_statistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gallery_statistics FORCE ROW LEVEL SECURITY;
CREATE POLICY stats_read ON public.gallery_statistics FOR SELECT TO personal_photos_app USING(
 photo_security.username() IS NOT NULL AND
 ((scope='all' AND photo_security.flag('main_admin')) OR
  (scope='album' AND scope_id IN (SELECT photo_security.readable_events()))));
CREATE POLICY stats_maintain_read ON public.gallery_statistics FOR SELECT TO personal_photos_maintenance USING(true);
GRANT SELECT ON public.gallery_statistics TO personal_photos_app,personal_photos_maintenance;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.gallery_statistics FROM PUBLIC,personal_photos_app,personal_photos_maintenance;

-- Pure contribution vectors describe committed lifecycle state, never wall-clock lease expiry.
CREATE FUNCTION photo_security.stats_contribution(j jsonb, source_kind text)
RETURNS TABLE(album_id int,bucket smallint,total_photos bigint,total_videos bigint,photos_with_ai bigint,photos_without_ai bigint,photos_failed bigint,in_search bigint,photo_updates bigint,album_updates bigint,photo_removals bigint,album_removals bigint)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT (j->>'event_id')::int, (mod(abs((j->>'photo_id')::bigint),32))::smallint,
(ready AND photo)::int::bigint,(ready AND NOT photo)::int::bigint,(ready AND photo AND described)::int::bigint,(ready AND photo AND NOT described AND NOT terminal)::int::bigint,(ready AND photo AND NOT described AND terminal)::int::bigint,(ready AND photo AND acknowledged)::int::bigint,(false)::int::bigint,(false)::int::bigint,(false)::int::bigint,(false)::int::bigint
 FROM (SELECT j->>'ingest_status'='READY' ready,j->>'media_type'='photo' photo,
 j->>'ai_description' IS NOT NULL described,
 (j->>'ai_claim' IS NULL AND coalesce((j->>'ai_attempts')::int,0)>=3) terminal,
 j->>'search_synced_at' IS NOT NULL acknowledged) state WHERE source_kind='photos'
 UNION ALL
 SELECT coalesce((j->>'stats_event_id')::int,0),mod(abs((j->>'id')::bigint),32)::smallint,
(false)::int::bigint,(false)::int::bigint,(false)::int::bigint,(false)::int::bigint,(false)::int::bigint,(false)::int::bigint,(photo AND upsert)::int::bigint,(NOT photo AND upsert)::int::bigint,(photo AND NOT upsert)::int::bigint,(NOT photo AND NOT upsert)::int::bigint
 FROM (SELECT j->>'kind'='photo' photo,j->>'operation'='upsert' upsert) state WHERE source_kind='search_queue'
$$;
REVOKE ALL ON FUNCTION photo_security.stats_contribution(jsonb,text) FROM PUBLIC;

-- Separate typed statement functions let PostgreSQL cache each transition-table plan.
CREATE FUNCTION photo_security.statistics_photos_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM new_rows) THEN RETURN NULL; END IF;
WITH contributions AS (SELECT n.event_id album_id,mod(abs(n.photo_id::bigint),32)::smallint bucket,
   (n.ingest_status='READY' AND n.media_type='photo')::int::bigint total_photos,
   (n.ingest_status='READY' AND n.media_type<>'photo')::int::bigint total_videos,
   (n.ingest_status='READY' AND n.media_type='photo' AND n.ai_description IS NOT NULL)::int::bigint photos_with_ai,
   (n.ingest_status='READY' AND n.media_type='photo' AND n.ai_description IS NULL AND NOT(n.ai_claim IS NULL AND coalesce(n.ai_attempts,0)>=3))::int::bigint photos_without_ai,
   (n.ingest_status='READY' AND n.media_type='photo' AND n.ai_description IS NULL AND n.ai_claim IS NULL AND coalesce(n.ai_attempts,0)>=3)::int::bigint photos_failed,
   (n.ingest_status='READY' AND n.media_type='photo' AND n.search_synced_at IS NOT NULL)::int::bigint in_search,
   0::bigint photo_updates,0::bigint album_updates,0::bigint photo_removals,0::bigint album_removals,1::bigint sign FROM new_rows n),
 expanded AS (SELECT s.scope,CASE WHEN s.scope='all' THEN 0 ELSE c.album_id END scope_id,c.* FROM contributions c CROSS JOIN (VALUES('all'),('album')) s(scope)), deltas AS MATERIALIZED (
 SELECT scope,scope_id,bucket,sum(total_photos*sign)::bigint total_photos,sum(total_videos*sign)::bigint total_videos,sum(photos_with_ai*sign)::bigint photos_with_ai,sum(photos_without_ai*sign)::bigint photos_without_ai,sum(photos_failed*sign)::bigint photos_failed,sum(in_search*sign)::bigint in_search,sum(photo_updates*sign)::bigint photo_updates,sum(album_updates*sign)::bigint album_updates,sum(photo_removals*sign)::bigint photo_removals,sum(album_removals*sign)::bigint album_removals FROM expanded GROUP BY scope,scope_id,bucket
 HAVING sum(total_photos*sign)<>0 OR sum(total_videos*sign)<>0 OR sum(photos_with_ai*sign)<>0 OR sum(photos_without_ai*sign)<>0 OR sum(photos_failed*sign)<>0 OR sum(in_search*sign)<>0 OR sum(photo_updates*sign)<>0 OR sum(album_updates*sign)<>0 OR sum(photo_removals*sign)<>0 OR sum(album_removals*sign)<>0 ORDER BY scope,scope_id,bucket)
 INSERT INTO public.gallery_statistics(scope,scope_id,bucket,total_photos,total_videos,photos_with_ai,photos_without_ai,photos_failed,in_search,photo_updates,album_updates,photo_removals,album_removals)
 SELECT d.scope,d.scope_id,d.bucket,d.total_photos,d.total_videos,d.photos_with_ai,d.photos_without_ai,d.photos_failed,d.in_search,d.photo_updates,d.album_updates,d.photo_removals,d.album_removals FROM deltas d
 ORDER BY d.scope,d.scope_id,d.bucket
 ON CONFLICT(scope,scope_id,bucket) DO UPDATE SET total_photos=gallery_statistics.total_photos+EXCLUDED.total_photos,total_videos=gallery_statistics.total_videos+EXCLUDED.total_videos,photos_with_ai=gallery_statistics.photos_with_ai+EXCLUDED.photos_with_ai,photos_without_ai=gallery_statistics.photos_without_ai+EXCLUDED.photos_without_ai,photos_failed=gallery_statistics.photos_failed+EXCLUDED.photos_failed,in_search=gallery_statistics.in_search+EXCLUDED.in_search,photo_updates=gallery_statistics.photo_updates+EXCLUDED.photo_updates,album_updates=gallery_statistics.album_updates+EXCLUDED.album_updates,photo_removals=gallery_statistics.photo_removals+EXCLUDED.photo_removals,album_removals=gallery_statistics.album_removals+EXCLUDED.album_removals;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.statistics_photos_insert() FROM PUBLIC;

CREATE FUNCTION photo_security.statistics_photos_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM new_rows n FULL JOIN old_rows o USING(photo_id) WHERE (n.event_id,n.media_type,n.ingest_status,n.ai_description IS NULL,n.ai_claim IS NULL,n.ai_attempts,n.search_synced_at IS NULL) IS DISTINCT FROM (o.event_id,o.media_type,o.ingest_status,o.ai_description IS NULL,o.ai_claim IS NULL,o.ai_attempts,o.search_synced_at IS NULL)) THEN RETURN NULL; END IF;
WITH contributions AS (SELECT n.event_id album_id,mod(abs(n.photo_id::bigint),32)::smallint bucket,
   (n.ingest_status='READY' AND n.media_type='photo')::int::bigint total_photos,
   (n.ingest_status='READY' AND n.media_type<>'photo')::int::bigint total_videos,
   (n.ingest_status='READY' AND n.media_type='photo' AND n.ai_description IS NOT NULL)::int::bigint photos_with_ai,
   (n.ingest_status='READY' AND n.media_type='photo' AND n.ai_description IS NULL AND NOT(n.ai_claim IS NULL AND coalesce(n.ai_attempts,0)>=3))::int::bigint photos_without_ai,
   (n.ingest_status='READY' AND n.media_type='photo' AND n.ai_description IS NULL AND n.ai_claim IS NULL AND coalesce(n.ai_attempts,0)>=3)::int::bigint photos_failed,
   (n.ingest_status='READY' AND n.media_type='photo' AND n.search_synced_at IS NOT NULL)::int::bigint in_search,
   0::bigint photo_updates,0::bigint album_updates,0::bigint photo_removals,0::bigint album_removals,1::bigint sign FROM new_rows n UNION ALL SELECT o.event_id album_id,mod(abs(o.photo_id::bigint),32)::smallint bucket,
   (o.ingest_status='READY' AND o.media_type='photo')::int::bigint total_photos,
   (o.ingest_status='READY' AND o.media_type<>'photo')::int::bigint total_videos,
   (o.ingest_status='READY' AND o.media_type='photo' AND o.ai_description IS NOT NULL)::int::bigint photos_with_ai,
   (o.ingest_status='READY' AND o.media_type='photo' AND o.ai_description IS NULL AND NOT(o.ai_claim IS NULL AND coalesce(o.ai_attempts,0)>=3))::int::bigint photos_without_ai,
   (o.ingest_status='READY' AND o.media_type='photo' AND o.ai_description IS NULL AND o.ai_claim IS NULL AND coalesce(o.ai_attempts,0)>=3)::int::bigint photos_failed,
   (o.ingest_status='READY' AND o.media_type='photo' AND o.search_synced_at IS NOT NULL)::int::bigint in_search,
   0::bigint photo_updates,0::bigint album_updates,0::bigint photo_removals,0::bigint album_removals,-1::bigint sign FROM old_rows o),
 expanded AS (SELECT s.scope,CASE WHEN s.scope='all' THEN 0 ELSE c.album_id END scope_id,c.* FROM contributions c CROSS JOIN (VALUES('all'),('album')) s(scope)), deltas AS MATERIALIZED (
 SELECT scope,scope_id,bucket,sum(total_photos*sign)::bigint total_photos,sum(total_videos*sign)::bigint total_videos,sum(photos_with_ai*sign)::bigint photos_with_ai,sum(photos_without_ai*sign)::bigint photos_without_ai,sum(photos_failed*sign)::bigint photos_failed,sum(in_search*sign)::bigint in_search,sum(photo_updates*sign)::bigint photo_updates,sum(album_updates*sign)::bigint album_updates,sum(photo_removals*sign)::bigint photo_removals,sum(album_removals*sign)::bigint album_removals FROM expanded GROUP BY scope,scope_id,bucket
 HAVING sum(total_photos*sign)<>0 OR sum(total_videos*sign)<>0 OR sum(photos_with_ai*sign)<>0 OR sum(photos_without_ai*sign)<>0 OR sum(photos_failed*sign)<>0 OR sum(in_search*sign)<>0 OR sum(photo_updates*sign)<>0 OR sum(album_updates*sign)<>0 OR sum(photo_removals*sign)<>0 OR sum(album_removals*sign)<>0 ORDER BY scope,scope_id,bucket)
 INSERT INTO public.gallery_statistics(scope,scope_id,bucket,total_photos,total_videos,photos_with_ai,photos_without_ai,photos_failed,in_search,photo_updates,album_updates,photo_removals,album_removals)
 SELECT d.scope,d.scope_id,d.bucket,d.total_photos,d.total_videos,d.photos_with_ai,d.photos_without_ai,d.photos_failed,d.in_search,d.photo_updates,d.album_updates,d.photo_removals,d.album_removals FROM deltas d
 ORDER BY d.scope,d.scope_id,d.bucket
 ON CONFLICT(scope,scope_id,bucket) DO UPDATE SET total_photos=gallery_statistics.total_photos+EXCLUDED.total_photos,total_videos=gallery_statistics.total_videos+EXCLUDED.total_videos,photos_with_ai=gallery_statistics.photos_with_ai+EXCLUDED.photos_with_ai,photos_without_ai=gallery_statistics.photos_without_ai+EXCLUDED.photos_without_ai,photos_failed=gallery_statistics.photos_failed+EXCLUDED.photos_failed,in_search=gallery_statistics.in_search+EXCLUDED.in_search,photo_updates=gallery_statistics.photo_updates+EXCLUDED.photo_updates,album_updates=gallery_statistics.album_updates+EXCLUDED.album_updates,photo_removals=gallery_statistics.photo_removals+EXCLUDED.photo_removals,album_removals=gallery_statistics.album_removals+EXCLUDED.album_removals;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.statistics_photos_update() FROM PUBLIC;

CREATE FUNCTION photo_security.statistics_photos_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM old_rows) THEN RETURN NULL; END IF;
WITH contributions AS (SELECT o.event_id album_id,mod(abs(o.photo_id::bigint),32)::smallint bucket,
   (o.ingest_status='READY' AND o.media_type='photo')::int::bigint total_photos,
   (o.ingest_status='READY' AND o.media_type<>'photo')::int::bigint total_videos,
   (o.ingest_status='READY' AND o.media_type='photo' AND o.ai_description IS NOT NULL)::int::bigint photos_with_ai,
   (o.ingest_status='READY' AND o.media_type='photo' AND o.ai_description IS NULL AND NOT(o.ai_claim IS NULL AND coalesce(o.ai_attempts,0)>=3))::int::bigint photos_without_ai,
   (o.ingest_status='READY' AND o.media_type='photo' AND o.ai_description IS NULL AND o.ai_claim IS NULL AND coalesce(o.ai_attempts,0)>=3)::int::bigint photos_failed,
   (o.ingest_status='READY' AND o.media_type='photo' AND o.search_synced_at IS NOT NULL)::int::bigint in_search,
   0::bigint photo_updates,0::bigint album_updates,0::bigint photo_removals,0::bigint album_removals,-1::bigint sign FROM old_rows o),
 expanded AS (SELECT s.scope,CASE WHEN s.scope='all' THEN 0 ELSE c.album_id END scope_id,c.* FROM contributions c CROSS JOIN (VALUES('all'),('album')) s(scope)), deltas AS MATERIALIZED (
 SELECT scope,scope_id,bucket,sum(total_photos*sign)::bigint total_photos,sum(total_videos*sign)::bigint total_videos,sum(photos_with_ai*sign)::bigint photos_with_ai,sum(photos_without_ai*sign)::bigint photos_without_ai,sum(photos_failed*sign)::bigint photos_failed,sum(in_search*sign)::bigint in_search,sum(photo_updates*sign)::bigint photo_updates,sum(album_updates*sign)::bigint album_updates,sum(photo_removals*sign)::bigint photo_removals,sum(album_removals*sign)::bigint album_removals FROM expanded GROUP BY scope,scope_id,bucket
 HAVING sum(total_photos*sign)<>0 OR sum(total_videos*sign)<>0 OR sum(photos_with_ai*sign)<>0 OR sum(photos_without_ai*sign)<>0 OR sum(photos_failed*sign)<>0 OR sum(in_search*sign)<>0 OR sum(photo_updates*sign)<>0 OR sum(album_updates*sign)<>0 OR sum(photo_removals*sign)<>0 OR sum(album_removals*sign)<>0 ORDER BY scope,scope_id,bucket)
 INSERT INTO public.gallery_statistics(scope,scope_id,bucket,total_photos,total_videos,photos_with_ai,photos_without_ai,photos_failed,in_search,photo_updates,album_updates,photo_removals,album_removals)
 SELECT d.scope,d.scope_id,d.bucket,d.total_photos,d.total_videos,d.photos_with_ai,d.photos_without_ai,d.photos_failed,d.in_search,d.photo_updates,d.album_updates,d.photo_removals,d.album_removals FROM deltas d
 ORDER BY d.scope,d.scope_id,d.bucket
 ON CONFLICT(scope,scope_id,bucket) DO UPDATE SET total_photos=gallery_statistics.total_photos+EXCLUDED.total_photos,total_videos=gallery_statistics.total_videos+EXCLUDED.total_videos,photos_with_ai=gallery_statistics.photos_with_ai+EXCLUDED.photos_with_ai,photos_without_ai=gallery_statistics.photos_without_ai+EXCLUDED.photos_without_ai,photos_failed=gallery_statistics.photos_failed+EXCLUDED.photos_failed,in_search=gallery_statistics.in_search+EXCLUDED.in_search,photo_updates=gallery_statistics.photo_updates+EXCLUDED.photo_updates,album_updates=gallery_statistics.album_updates+EXCLUDED.album_updates,photo_removals=gallery_statistics.photo_removals+EXCLUDED.photo_removals,album_removals=gallery_statistics.album_removals+EXCLUDED.album_removals;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.statistics_photos_delete() FROM PUBLIC;

CREATE FUNCTION photo_security.statistics_search_queue_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM new_rows) THEN RETURN NULL; END IF;
WITH contributions AS (SELECT coalesce(n.stats_event_id,0) album_id,mod(abs(n.id::bigint),32)::smallint bucket,
   0::bigint total_photos,0::bigint total_videos,0::bigint photos_with_ai,0::bigint photos_without_ai,0::bigint photos_failed,0::bigint in_search,
   (n.kind='photo' AND n.operation='upsert')::int::bigint photo_updates,
   (n.kind<>'photo' AND n.operation='upsert')::int::bigint album_updates,
   (n.kind='photo' AND n.operation='remove')::int::bigint photo_removals,
   (n.kind<>'photo' AND n.operation='remove')::int::bigint album_removals,1::bigint sign FROM new_rows n),
 expanded AS (SELECT s.scope,CASE WHEN s.scope='all' THEN 0 ELSE c.album_id END scope_id,c.* FROM contributions c CROSS JOIN (VALUES('all'),('album')) s(scope)), deltas AS MATERIALIZED (
 SELECT scope,scope_id,bucket,sum(total_photos*sign)::bigint total_photos,sum(total_videos*sign)::bigint total_videos,sum(photos_with_ai*sign)::bigint photos_with_ai,sum(photos_without_ai*sign)::bigint photos_without_ai,sum(photos_failed*sign)::bigint photos_failed,sum(in_search*sign)::bigint in_search,sum(photo_updates*sign)::bigint photo_updates,sum(album_updates*sign)::bigint album_updates,sum(photo_removals*sign)::bigint photo_removals,sum(album_removals*sign)::bigint album_removals FROM expanded GROUP BY scope,scope_id,bucket
 HAVING sum(total_photos*sign)<>0 OR sum(total_videos*sign)<>0 OR sum(photos_with_ai*sign)<>0 OR sum(photos_without_ai*sign)<>0 OR sum(photos_failed*sign)<>0 OR sum(in_search*sign)<>0 OR sum(photo_updates*sign)<>0 OR sum(album_updates*sign)<>0 OR sum(photo_removals*sign)<>0 OR sum(album_removals*sign)<>0 ORDER BY scope,scope_id,bucket)
 INSERT INTO public.gallery_statistics(scope,scope_id,bucket,total_photos,total_videos,photos_with_ai,photos_without_ai,photos_failed,in_search,photo_updates,album_updates,photo_removals,album_removals)
 SELECT d.scope,d.scope_id,d.bucket,d.total_photos,d.total_videos,d.photos_with_ai,d.photos_without_ai,d.photos_failed,d.in_search,d.photo_updates,d.album_updates,d.photo_removals,d.album_removals FROM deltas d
 ORDER BY d.scope,d.scope_id,d.bucket
 ON CONFLICT(scope,scope_id,bucket) DO UPDATE SET total_photos=gallery_statistics.total_photos+EXCLUDED.total_photos,total_videos=gallery_statistics.total_videos+EXCLUDED.total_videos,photos_with_ai=gallery_statistics.photos_with_ai+EXCLUDED.photos_with_ai,photos_without_ai=gallery_statistics.photos_without_ai+EXCLUDED.photos_without_ai,photos_failed=gallery_statistics.photos_failed+EXCLUDED.photos_failed,in_search=gallery_statistics.in_search+EXCLUDED.in_search,photo_updates=gallery_statistics.photo_updates+EXCLUDED.photo_updates,album_updates=gallery_statistics.album_updates+EXCLUDED.album_updates,photo_removals=gallery_statistics.photo_removals+EXCLUDED.photo_removals,album_removals=gallery_statistics.album_removals+EXCLUDED.album_removals;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.statistics_search_queue_insert() FROM PUBLIC;

CREATE FUNCTION photo_security.statistics_search_queue_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM new_rows n FULL JOIN old_rows o USING(kind,id) WHERE (n.stats_event_id,n.operation) IS DISTINCT FROM (o.stats_event_id,o.operation)) THEN RETURN NULL; END IF;
WITH contributions AS (SELECT coalesce(n.stats_event_id,0) album_id,mod(abs(n.id::bigint),32)::smallint bucket,
   0::bigint total_photos,0::bigint total_videos,0::bigint photos_with_ai,0::bigint photos_without_ai,0::bigint photos_failed,0::bigint in_search,
   (n.kind='photo' AND n.operation='upsert')::int::bigint photo_updates,
   (n.kind<>'photo' AND n.operation='upsert')::int::bigint album_updates,
   (n.kind='photo' AND n.operation='remove')::int::bigint photo_removals,
   (n.kind<>'photo' AND n.operation='remove')::int::bigint album_removals,1::bigint sign FROM new_rows n UNION ALL SELECT coalesce(o.stats_event_id,0) album_id,mod(abs(o.id::bigint),32)::smallint bucket,
   0::bigint total_photos,0::bigint total_videos,0::bigint photos_with_ai,0::bigint photos_without_ai,0::bigint photos_failed,0::bigint in_search,
   (o.kind='photo' AND o.operation='upsert')::int::bigint photo_updates,
   (o.kind<>'photo' AND o.operation='upsert')::int::bigint album_updates,
   (o.kind='photo' AND o.operation='remove')::int::bigint photo_removals,
   (o.kind<>'photo' AND o.operation='remove')::int::bigint album_removals,-1::bigint sign FROM old_rows o),
 expanded AS (SELECT s.scope,CASE WHEN s.scope='all' THEN 0 ELSE c.album_id END scope_id,c.* FROM contributions c CROSS JOIN (VALUES('all'),('album')) s(scope)), deltas AS MATERIALIZED (
 SELECT scope,scope_id,bucket,sum(total_photos*sign)::bigint total_photos,sum(total_videos*sign)::bigint total_videos,sum(photos_with_ai*sign)::bigint photos_with_ai,sum(photos_without_ai*sign)::bigint photos_without_ai,sum(photos_failed*sign)::bigint photos_failed,sum(in_search*sign)::bigint in_search,sum(photo_updates*sign)::bigint photo_updates,sum(album_updates*sign)::bigint album_updates,sum(photo_removals*sign)::bigint photo_removals,sum(album_removals*sign)::bigint album_removals FROM expanded GROUP BY scope,scope_id,bucket
 HAVING sum(total_photos*sign)<>0 OR sum(total_videos*sign)<>0 OR sum(photos_with_ai*sign)<>0 OR sum(photos_without_ai*sign)<>0 OR sum(photos_failed*sign)<>0 OR sum(in_search*sign)<>0 OR sum(photo_updates*sign)<>0 OR sum(album_updates*sign)<>0 OR sum(photo_removals*sign)<>0 OR sum(album_removals*sign)<>0 ORDER BY scope,scope_id,bucket)
 INSERT INTO public.gallery_statistics(scope,scope_id,bucket,total_photos,total_videos,photos_with_ai,photos_without_ai,photos_failed,in_search,photo_updates,album_updates,photo_removals,album_removals)
 SELECT d.scope,d.scope_id,d.bucket,d.total_photos,d.total_videos,d.photos_with_ai,d.photos_without_ai,d.photos_failed,d.in_search,d.photo_updates,d.album_updates,d.photo_removals,d.album_removals FROM deltas d
 ORDER BY d.scope,d.scope_id,d.bucket
 ON CONFLICT(scope,scope_id,bucket) DO UPDATE SET total_photos=gallery_statistics.total_photos+EXCLUDED.total_photos,total_videos=gallery_statistics.total_videos+EXCLUDED.total_videos,photos_with_ai=gallery_statistics.photos_with_ai+EXCLUDED.photos_with_ai,photos_without_ai=gallery_statistics.photos_without_ai+EXCLUDED.photos_without_ai,photos_failed=gallery_statistics.photos_failed+EXCLUDED.photos_failed,in_search=gallery_statistics.in_search+EXCLUDED.in_search,photo_updates=gallery_statistics.photo_updates+EXCLUDED.photo_updates,album_updates=gallery_statistics.album_updates+EXCLUDED.album_updates,photo_removals=gallery_statistics.photo_removals+EXCLUDED.photo_removals,album_removals=gallery_statistics.album_removals+EXCLUDED.album_removals;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.statistics_search_queue_update() FROM PUBLIC;

CREATE FUNCTION photo_security.statistics_search_queue_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM old_rows) THEN RETURN NULL; END IF;
WITH contributions AS (SELECT coalesce(o.stats_event_id,0) album_id,mod(abs(o.id::bigint),32)::smallint bucket,
   0::bigint total_photos,0::bigint total_videos,0::bigint photos_with_ai,0::bigint photos_without_ai,0::bigint photos_failed,0::bigint in_search,
   (o.kind='photo' AND o.operation='upsert')::int::bigint photo_updates,
   (o.kind<>'photo' AND o.operation='upsert')::int::bigint album_updates,
   (o.kind='photo' AND o.operation='remove')::int::bigint photo_removals,
   (o.kind<>'photo' AND o.operation='remove')::int::bigint album_removals,-1::bigint sign FROM old_rows o),
 expanded AS (SELECT s.scope,CASE WHEN s.scope='all' THEN 0 ELSE c.album_id END scope_id,c.* FROM contributions c CROSS JOIN (VALUES('all'),('album')) s(scope)), deltas AS MATERIALIZED (
 SELECT scope,scope_id,bucket,sum(total_photos*sign)::bigint total_photos,sum(total_videos*sign)::bigint total_videos,sum(photos_with_ai*sign)::bigint photos_with_ai,sum(photos_without_ai*sign)::bigint photos_without_ai,sum(photos_failed*sign)::bigint photos_failed,sum(in_search*sign)::bigint in_search,sum(photo_updates*sign)::bigint photo_updates,sum(album_updates*sign)::bigint album_updates,sum(photo_removals*sign)::bigint photo_removals,sum(album_removals*sign)::bigint album_removals FROM expanded GROUP BY scope,scope_id,bucket
 HAVING sum(total_photos*sign)<>0 OR sum(total_videos*sign)<>0 OR sum(photos_with_ai*sign)<>0 OR sum(photos_without_ai*sign)<>0 OR sum(photos_failed*sign)<>0 OR sum(in_search*sign)<>0 OR sum(photo_updates*sign)<>0 OR sum(album_updates*sign)<>0 OR sum(photo_removals*sign)<>0 OR sum(album_removals*sign)<>0 ORDER BY scope,scope_id,bucket)
 INSERT INTO public.gallery_statistics(scope,scope_id,bucket,total_photos,total_videos,photos_with_ai,photos_without_ai,photos_failed,in_search,photo_updates,album_updates,photo_removals,album_removals)
 SELECT d.scope,d.scope_id,d.bucket,d.total_photos,d.total_videos,d.photos_with_ai,d.photos_without_ai,d.photos_failed,d.in_search,d.photo_updates,d.album_updates,d.photo_removals,d.album_removals FROM deltas d
 ORDER BY d.scope,d.scope_id,d.bucket
 ON CONFLICT(scope,scope_id,bucket) DO UPDATE SET total_photos=gallery_statistics.total_photos+EXCLUDED.total_photos,total_videos=gallery_statistics.total_videos+EXCLUDED.total_videos,photos_with_ai=gallery_statistics.photos_with_ai+EXCLUDED.photos_with_ai,photos_without_ai=gallery_statistics.photos_without_ai+EXCLUDED.photos_without_ai,photos_failed=gallery_statistics.photos_failed+EXCLUDED.photos_failed,in_search=gallery_statistics.in_search+EXCLUDED.in_search,photo_updates=gallery_statistics.photo_updates+EXCLUDED.photo_updates,album_updates=gallery_statistics.album_updates+EXCLUDED.album_updates,photo_removals=gallery_statistics.photo_removals+EXCLUDED.photo_removals,album_removals=gallery_statistics.album_removals+EXCLUDED.album_removals;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.statistics_search_queue_delete() FROM PUBLIC;
-- No FK cascade: deleted-album removal work must survive until acknowledged.
INSERT INTO public.gallery_statistics(scope,scope_id,bucket,total_photos,total_videos,photos_with_ai,photos_without_ai,photos_failed,in_search,photo_updates,album_updates,photo_removals,album_removals)
WITH contributions AS (
 SELECT c.* FROM public.photos p CROSS JOIN LATERAL photo_security.stats_contribution(to_jsonb(p),'photos') c
 UNION ALL SELECT c.* FROM public.search_queue q CROSS JOIN LATERAL photo_security.stats_contribution(to_jsonb(q),'search_queue') c
), expanded AS (SELECT s.scope,CASE WHEN s.scope='all' THEN 0 ELSE c.album_id END scope_id,c.* FROM contributions c CROSS JOIN (VALUES('all'),('album')) s(scope))
SELECT scope,scope_id,bucket,sum(total_photos),sum(total_videos),sum(photos_with_ai),sum(photos_without_ai),sum(photos_failed),sum(in_search),sum(photo_updates),sum(album_updates),sum(photo_removals),sum(album_removals) FROM expanded GROUP BY scope,scope_id,bucket;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['photos','search_queue'] LOOP
  EXECUTE format('CREATE TRIGGER statistics_insert AFTER INSERT ON public.%I REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION photo_security.statistics_%s_insert()',t,t);
  EXECUTE format('CREATE TRIGGER statistics_update AFTER UPDATE ON public.%I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION photo_security.statistics_%s_update()',t,t);
  EXECUTE format('CREATE TRIGGER statistics_delete AFTER DELETE ON public.%I REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION photo_security.statistics_%s_delete()',t,t);
 END LOOP;
END $$;
-- Source truncation bypasses row contributions. Reject it; maintenance must use transactional deletes.
CREATE FUNCTION photo_security.reject_stats_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'TRUNCATE would invalidate gallery statistics; use transactional DELETE'; END $$;
REVOKE ALL ON FUNCTION photo_security.reject_stats_truncate() FROM PUBLIC;
CREATE TRIGGER stats_no_truncate BEFORE TRUNCATE ON public.photos FOR EACH STATEMENT EXECUTE FUNCTION photo_security.reject_stats_truncate();
CREATE TRIGGER stats_no_truncate BEFORE TRUNCATE ON public.search_queue FOR EACH STATEMENT EXECUTE FUNCTION photo_security.reject_stats_truncate();
CREATE INDEX stats_failed_photos ON public.photos(event_id,photo_id) WHERE ingest_status='READY' AND media_type='photo' AND ai_description IS NULL AND ai_claim IS NULL AND ai_attempts>=3;
-- A restored/new row is not evidence that a remote search copy still exists.
CREATE FUNCTION photo_security.reset_inserted_search_ack() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.search_synced_at:=NULL; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION photo_security.reset_inserted_search_ack() FROM PUBLIC;
CREATE TRIGGER stats_reset_insert_ack BEFORE INSERT ON public.photos FOR EACH ROW EXECUTE FUNCTION photo_security.reset_inserted_search_ack();
