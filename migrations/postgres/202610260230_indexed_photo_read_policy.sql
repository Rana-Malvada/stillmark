-- A photo's visibility is inherited from its one parent album. Check that album
-- by primary key under the existing event RLS policy, rather than hashing the
-- entire readable-album set for every bounded photo/thumbnail request.
-- OFFSET 0 keeps the correlated lookup from being flattened into a global set.
-- This does not bypass RLS, add a SECURITY DEFINER function, or change grants.
SET LOCAL lock_timeout='5s';
ALTER POLICY catalog_reader ON public.photos TO personal_photos_reader
USING (EXISTS (
 SELECT 1 FROM public.events permitted_event
 WHERE permitted_event.event_id=photos.event_id OFFSET 0
));
