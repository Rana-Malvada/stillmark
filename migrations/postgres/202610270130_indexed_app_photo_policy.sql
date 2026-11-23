-- Check the one parent album through its existing RLS policy instead of building
-- the caller's entire readable album set for each bounded photo lookup.
-- Preserve the separate restrictive public-selection policy and all write policies.
SET LOCAL lock_timeout='5s';
ALTER POLICY app_read ON public.photos TO personal_photos_app
USING (EXISTS (
 SELECT 1 FROM public.events permitted_event
 WHERE permitted_event.event_id=photos.event_id OFFSET 0
));
