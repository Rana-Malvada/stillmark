BEGIN;
ALTER TABLE video_playback ADD COLUMN IF NOT EXISTS claim_token UUID;
ALTER TABLE video_playback ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS video_playback_due ON video_playback(next_attempt_at,requested_at) WHERE status='queued';
-- Enqueue only changed/new videos. Never scan the library on each worker tick.
CREATE OR REPLACE FUNCTION enqueue_video_playback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.media_type='video' AND NEW.ingest_status='READY' AND NEW.original_stage_path IS NOT NULL THEN
  INSERT INTO video_playback(photo_id,original_path) VALUES(NEW.photo_id,NEW.original_stage_path)
  ON CONFLICT(photo_id) DO UPDATE SET original_path=EXCLUDED.original_path,status='queued',attempts=0,claim_token=NULL,lease_until=NULL,next_attempt_at=NOW(),requested_at=NOW()
  WHERE video_playback.original_path IS DISTINCT FROM EXCLUDED.original_path;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS enqueue_video_playback ON photos;
CREATE TRIGGER enqueue_video_playback AFTER INSERT OR UPDATE OF original_stage_path,ingest_status ON photos FOR EACH ROW EXECUTE FUNCTION enqueue_video_playback();
-- Remove derived media by primary key when its last live/trash reference disappears.
CREATE OR REPLACE FUNCTION retire_video_playback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM photos WHERE photo_id=OLD.photo_id)
 AND NOT EXISTS(SELECT 1 FROM photo_trash WHERE photo_id=OLD.photo_id) THEN
  WITH removed AS (DELETE FROM video_playback WHERE photo_id=OLD.photo_id RETURNING stage_path,renditions)
  INSERT INTO stage_cleanup(path,next_attempt) SELECT path,NOW()+INTERVAL '24 hours' FROM (
   SELECT stage_path path FROM removed UNION SELECT r->>'stage_path' FROM removed CROSS JOIN LATERAL jsonb_array_elements(renditions) r
  ) paths WHERE path IS NOT NULL ON CONFLICT DO NOTHING;
 END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS retire_video_playback ON photos;
CREATE TRIGGER retire_video_playback AFTER DELETE ON photos FOR EACH ROW EXECUTE FUNCTION retire_video_playback();
DROP TRIGGER IF EXISTS retire_video_playback ON photo_trash;
CREATE TRIGGER retire_video_playback AFTER DELETE ON photo_trash FOR EACH ROW EXECUTE FUNCTION retire_video_playback();
COMMIT;
