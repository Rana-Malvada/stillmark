SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
-- "Delete my face data" must remove the correction history too: its snapshots
-- contain names. Owners (and only owners with write access) may delete their own.
GRANT DELETE ON public.face_corrections TO personal_photos_app;
CREATE POLICY app_delete ON public.face_corrections FOR DELETE TO personal_photos_app
 USING(photo_security.edits_people(owner_username));
