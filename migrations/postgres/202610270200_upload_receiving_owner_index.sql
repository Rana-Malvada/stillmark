-- Upload admission checks unfinished sessions for one owner on every chunk.
-- Keep completed history out of this index and support the queued-job anti-join.
SET LOCAL lock_timeout='5s';
CREATE INDEX IF NOT EXISTS upload_sessions_receiving_owner
ON public.upload_sessions(owner,upload_id) WHERE result IS NULL;
