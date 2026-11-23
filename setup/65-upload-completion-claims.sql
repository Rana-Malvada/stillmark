-- Additive: existing sessions remain valid. No media data changes.
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS completion_token uuid;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS completion_lease_until timestamptz;
CREATE INDEX IF NOT EXISTS upload_completion_leases ON upload_sessions(completion_lease_until)
 WHERE result IS NULL AND completion_token IS NOT NULL;
