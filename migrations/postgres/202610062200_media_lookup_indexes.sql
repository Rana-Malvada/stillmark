SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE INDEX video_playback_ready_path ON video_playback(stage_path) WHERE status='ready';
CREATE INDEX video_playback_ready_renditions ON video_playback USING gin(renditions jsonb_path_ops) WHERE status='ready';
CREATE INDEX photos_ready_event_capture ON photos(event_id,COALESCE(date_taken,created_at),photo_id) WHERE ingest_status='READY';
