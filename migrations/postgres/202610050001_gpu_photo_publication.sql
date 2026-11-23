-- The worker already has UPDATE(duration), but SELECT FOR UPDATE also requires
-- an UPDATE policy. Keep column grants unchanged: originals remain immutable.
CREATE POLICY gpu_publish_duration ON public.photos
FOR UPDATE TO personal_photos_video_worker
USING (media_type='video') WITH CHECK (media_type='video');
