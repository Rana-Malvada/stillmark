-- Map endpoints use pgReadIdentity's restricted reader role, not the runtime role.
-- Reuse live event RLS so ownership, sharing and revocation apply immediately.
SET LOCAL lock_timeout='5s';
GRANT SELECT ON public.travel_summary_state,public.travel_area_summary,public.travel_point_summary TO personal_photos_reader;
CREATE POLICY catalog_reader ON public.travel_summary_state FOR SELECT TO personal_photos_reader
 USING(event_id IN (SELECT event_id FROM public.events));
CREATE POLICY catalog_reader ON public.travel_area_summary FOR SELECT TO personal_photos_reader
 USING(event_id IN (SELECT event_id FROM public.events));
CREATE POLICY catalog_reader ON public.travel_point_summary FOR SELECT TO personal_photos_reader
 USING(event_id IN (SELECT event_id FROM public.events));
