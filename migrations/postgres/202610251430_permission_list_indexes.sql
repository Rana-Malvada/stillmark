-- Split access paths so an ordinary user's list does not scan every private album.
SET LOCAL lock_timeout='5s';
CREATE INDEX IF NOT EXISTS events_gallery_read ON public.events(event_id) WHERE visibility='GALLERY';
CREATE OR REPLACE FUNCTION photo_security.readable_events() RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH caller AS MATERIALIZED (
  SELECT photo_security.username() AS username,
         photo_security.flag('main_admin') AS main_admin,
         photo_security.public_event() AS public_event
 )
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND c.main_admin
 UNION
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND NOT c.main_admin AND e.owner_username=c.username
 UNION
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND NOT c.main_admin AND e.visibility='GALLERY'
 UNION
 SELECT e.event_id FROM public.album_shares s JOIN public.events e USING(event_id) CROSS JOIN caller c
 WHERE c.username IS NOT NULL AND NOT c.main_admin AND s.username=c.username
 UNION
 SELECT e.event_id FROM public.events e CROSS JOIN caller c WHERE e.event_id=c.public_event
$$;
CREATE OR REPLACE FUNCTION photo_security.editable_events() RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH caller AS MATERIALIZED (
  SELECT photo_security.username() AS username,
         photo_security.flag('can_write') AS can_write,
         photo_security.flag('main_admin') AS main_admin
 )
 SELECT e.event_id FROM public.events e CROSS JOIN caller c WHERE c.can_write AND c.main_admin
 UNION ALL
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.can_write AND NOT c.main_admin AND e.owner_username=c.username
$$;
