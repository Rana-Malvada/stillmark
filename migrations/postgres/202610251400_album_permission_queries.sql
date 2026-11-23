-- Evaluate request constants once per statement, never cache across requests.
-- Existing function ownership/grants and the selected-photo restrictive policy stay intact.
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION photo_security.readable_events() RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH caller AS MATERIALIZED (
  SELECT photo_security.username() AS username,
         photo_security.flag('main_admin') AS main_admin,
         photo_security.public_event() AS public_event
 )
 SELECT e.event_id FROM public.events e CROSS JOIN caller c WHERE
 (c.username IS NOT NULL AND (c.main_admin OR e.owner_username=c.username OR e.visibility='GALLERY'
  OR e.event_id IN (SELECT s.event_id FROM public.album_shares s WHERE s.username=c.username)))
 OR e.event_id=c.public_event
$$;
CREATE OR REPLACE FUNCTION photo_security.editable_events() RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH caller AS MATERIALIZED (
  SELECT photo_security.username() AS username,
         photo_security.flag('can_write') AS can_write,
         photo_security.flag('main_admin') AS main_admin
 )
 SELECT e.event_id FROM public.events e CROSS JOIN caller c
 WHERE c.can_write AND (c.main_admin OR e.owner_username=c.username)
$$;
-- The events policy can use the row's owner/visibility directly. Only the user's
-- explicit shares need a set; this avoids rebuilding all accessible albums for
-- every single-album lookup, without recursively applying album_shares RLS.
CREATE FUNCTION photo_security.shared_events() RETURNS SETOF integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT s.event_id FROM public.album_shares s
 WHERE s.username=(SELECT photo_security.username())
$$;
REVOKE ALL ON FUNCTION photo_security.shared_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION photo_security.shared_events() TO personal_photos_app;
ALTER POLICY app_read ON public.events USING (
 ((SELECT photo_security.username()) IS NOT NULL AND (
   (SELECT photo_security.flag('main_admin'))
   OR owner_username=(SELECT photo_security.username())
   OR visibility='GALLERY'
   OR event_id IN (SELECT photo_security.shared_events())
 )) OR event_id=(SELECT photo_security.public_event())
);
