SET LOCAL lock_timeout='2s';
CREATE FUNCTION public.notify_ready_photo_ai() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_notify('stillmark_photo_ai_ready', '');
  RETURN NULL;
END
$$;

-- The upload sets the display path and READY together. Restores may insert
-- a ready row directly. Row contents and user identifiers stay in the table.
CREATE TRIGGER notify_ready_photo_ai
AFTER INSERT OR UPDATE OF ingest_status,display_stage_path ON public.photos
FOR EACH ROW WHEN (NEW.ingest_status='READY' AND NEW.media_type='photo'
  AND NEW.display_stage_path IS NOT NULL AND NEW.ai_description IS NULL
  AND NEW.ai_attempts<3)
EXECUTE FUNCTION public.notify_ready_photo_ai();
