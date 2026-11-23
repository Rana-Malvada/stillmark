-- Read-only sampling for the isolated mixed workload. Authentication in progress
-- can produce a pg_stat_activity row with NULL usename; JSON object keys cannot
-- be NULL. Keep that connection in the total and label it rather than aborting
-- the entire workload while sampling.
SELECT json_build_object(
  'at', clock_timestamp(),
  'queued', (SELECT count(*) FROM upload_processing_jobs WHERE state = 'queued'),
  'processing', (SELECT count(*) FROM upload_processing_jobs WHERE state = 'processing'),
  'oldestUploadAgeSeconds', (
    SELECT coalesce(greatest(0, extract(epoch FROM clock_timestamp() - min(created_at))), 0)
    FROM upload_processing_jobs WHERE state IN ('queued', 'processing')
  ),
  'connections', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
  'connectionsByUser', (
    SELECT json_object_agg(coalesce(usename, 'unassigned'), n)
    FROM (
      SELECT usename, count(*) n
      FROM pg_stat_activity WHERE datname = current_database() GROUP BY usename
    ) c
  ),
  'activeConnections', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND state = 'active'),
  'lockWaits', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock')
);
