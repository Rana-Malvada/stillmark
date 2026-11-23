SET LOCAL lock_timeout='5s';
CREATE TABLE travel_summary_state(
 event_id int PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
 revision uuid NOT NULL DEFAULT gen_random_uuid(), built_revision uuid
);
CREATE INDEX travel_summary_pending ON travel_summary_state(event_id) WHERE built_revision IS DISTINCT FROM revision;
CREATE TABLE travel_area_summary(
 event_id int NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
 capture_year int, lat float8, lng float8, country text NOT NULL,city text NOT NULL,
 count bigint NOT NULL,photo_id int NOT NULL,thumbnail_photo_id int
);
CREATE INDEX travel_area_album ON travel_area_summary(event_id);
CREATE TABLE travel_point_summary(
 event_id int NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
 capture_year int,lat float8 NOT NULL,lng float8 NOT NULL,
 count bigint NOT NULL,photo_id int NOT NULL
);
CREATE INDEX travel_point_album ON travel_point_summary(event_id,lat,lng);
ALTER TABLE travel_summary_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE travel_summary_state FORCE ROW LEVEL SECURITY;
ALTER TABLE travel_area_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE travel_area_summary FORCE ROW LEVEL SECURITY;
ALTER TABLE travel_point_summary ENABLE ROW LEVEL SECURITY;
ALTER TABLE travel_point_summary FORCE ROW LEVEL SECURITY;
CREATE POLICY app_read ON travel_summary_state FOR SELECT TO personal_photos_app USING(event_id IN (SELECT photo_security.readable_events()));
CREATE POLICY app_read ON travel_area_summary FOR SELECT TO personal_photos_app USING(event_id IN (SELECT photo_security.readable_events()));
CREATE POLICY app_read ON travel_point_summary FOR SELECT TO personal_photos_app USING(event_id IN (SELECT photo_security.readable_events()));
GRANT SELECT ON travel_summary_state,travel_area_summary,travel_point_summary TO personal_photos_app;
CREATE POLICY maintain ON travel_summary_state TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintain ON travel_area_summary TO personal_photos_maintenance USING(true) WITH CHECK(true);
CREATE POLICY maintain ON travel_point_summary TO personal_photos_maintenance USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE,DELETE ON travel_summary_state,travel_area_summary,travel_point_summary TO personal_photos_maintenance;

CREATE FUNCTION photo_security.invalidate_travel_summary() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO public.travel_summary_state(event_id) SELECT DISTINCT event_id FROM new_rows
  ON CONFLICT(event_id) DO UPDATE SET revision=gen_random_uuid();
 ELSIF TG_OP='DELETE' THEN
  INSERT INTO public.travel_summary_state(event_id) SELECT DISTINCT r.event_id FROM old_rows r JOIN public.events e USING(event_id)
  ON CONFLICT(event_id) DO UPDATE SET revision=gen_random_uuid();
 ELSE
  INSERT INTO public.travel_summary_state(event_id)
  SELECT DISTINCT event_id FROM (
    (SELECT photo_id,event_id,date_taken,latitude,longitude,country,city,thumbnail_stage_path IS NOT NULL AS has_thumbnail FROM old_rows
     EXCEPT SELECT photo_id,event_id,date_taken,latitude,longitude,country,city,thumbnail_stage_path IS NOT NULL FROM new_rows)
    UNION
    (SELECT photo_id,event_id,date_taken,latitude,longitude,country,city,thumbnail_stage_path IS NOT NULL FROM new_rows
     EXCEPT SELECT photo_id,event_id,date_taken,latitude,longitude,country,city,thumbnail_stage_path IS NOT NULL FROM old_rows)
  ) changed
  ON CONFLICT(event_id) DO UPDATE SET revision=gen_random_uuid();
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_security.invalidate_travel_summary() FROM PUBLIC;
CREATE TRIGGER travel_insert AFTER INSERT ON photos REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION photo_security.invalidate_travel_summary();
CREATE TRIGGER travel_delete AFTER DELETE ON photos REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION photo_security.invalidate_travel_summary();
CREATE TRIGGER travel_update AFTER UPDATE ON photos REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION photo_security.invalidate_travel_summary();
INSERT INTO travel_summary_state(event_id) SELECT event_id FROM events;

-- One album per transaction. The state lock serializes publication with the
-- source transaction's invalidation; concurrent builders skip busy albums.
CREATE FUNCTION photo_security.refresh_travel_summary() RETURNS int LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target int; candidate int;
BEGIN
 -- Lock the parent before state, matching album deletion's FK lock order.
 -- Otherwise a concurrent delete can hold the event while waiting for state,
 -- and summary insertion can wait for that same event: a lock-order cycle.
 FOR candidate IN SELECT event_id FROM public.travel_summary_state
   WHERE built_revision IS DISTINCT FROM revision ORDER BY event_id LIMIT 100
 LOOP
   PERFORM 1 FROM public.events WHERE event_id=candidate FOR KEY SHARE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   PERFORM 1 FROM public.travel_summary_state WHERE event_id=candidate
     AND built_revision IS DISTINCT FROM revision FOR UPDATE SKIP LOCKED;
   IF FOUND THEN target:=candidate; EXIT; END IF;
 END LOOP;
 IF target IS NULL THEN RETURN NULL; END IF;
 DELETE FROM public.travel_area_summary WHERE event_id=target;
 INSERT INTO public.travel_area_summary
 SELECT event_id,EXTRACT(YEAR FROM date_taken AT TIME ZONE 'UTC')::int,
 CASE WHEN latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180 THEN round(latitude::numeric,1)::float8 END,
 CASE WHEN latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180 THEN round(longitude::numeric,1)::float8 END,
 COALESCE(NULLIF(trim(country),''),''),COALESCE(NULLIF(trim(city),''),''),count(*),min(photo_id),min(photo_id) FILTER(WHERE thumbnail_stage_path IS NOT NULL)
 FROM public.photos WHERE event_id=target GROUP BY 1,2,3,4,5,6;
 DELETE FROM public.travel_point_summary WHERE event_id=target;
 INSERT INTO public.travel_point_summary
 SELECT event_id,EXTRACT(YEAR FROM date_taken AT TIME ZONE 'UTC')::int,latitude,longitude,count(*),min(photo_id)
 FROM public.photos WHERE event_id=target AND latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180 GROUP BY 1,2,3,4;
 UPDATE public.travel_summary_state SET built_revision=revision WHERE event_id=target;
 RETURN target;
END $$;
REVOKE ALL ON FUNCTION photo_security.refresh_travel_summary() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.refresh_travel_summary() TO personal_photos_maintenance,personal_photos_search_worker;
