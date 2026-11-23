-- Preserve live-photo and trash access while checking the one referenced photo.
-- OFFSET 0 keeps the planner from expanding this into a full catalog hash/scan.
ALTER POLICY app_read ON public.video_analyses USING (
 EXISTS(SELECT 1 FROM public.photos p WHERE p.photo_id=video_analyses.photo_id OFFSET 0)
 OR EXISTS(SELECT 1 FROM public.photo_trash t WHERE t.photo_id=video_analyses.photo_id OFFSET 0)
);
