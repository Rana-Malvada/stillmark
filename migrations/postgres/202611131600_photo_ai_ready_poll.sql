SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';
CREATE INDEX photos_ai_ready_poll ON photos(ai_next_attempt_at) INCLUDE (ai_lease_until)
WHERE ai_description IS NULL AND ai_attempts < 3 AND ingest_status = 'READY'
  AND display_stage_path IS NOT NULL AND media_type = 'photo';
