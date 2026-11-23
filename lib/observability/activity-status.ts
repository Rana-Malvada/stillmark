import { pgQuery, pgQueryOne } from '../postgres'

/**
 * Gallery-wide work counters for the activity page. The search and AI backlog counters
 * are zero placeholders; the caller overlays the projected statistics.
 */
export function readActivitySummary(): Promise<Record<string, unknown> | null> {
  return pgQueryOne(`WITH search_pending AS (SELECT 0 AS pending_sync,0 AS pending_search_removals)
    SELECT (SELECT pending_sync FROM search_pending) AS pending_sync,
    (SELECT pending_search_removals FROM search_pending) AS pending_search_removals,
    (SELECT count(*) FROM upload_jobs WHERE status='IN_PROGRESS' AND started_at>NOW()-INTERVAL '15 minutes') AS active_uploads,
    (SELECT count(*) FROM photos WHERE ai_claim IS NOT NULL AND ai_description IS NULL AND ai_lease_until>NOW()) AS active_ai,
    0 AS pending_ai,
    (SELECT count(*) FROM stage_cleanup) AS cleanup_intents,
    (SELECT count(*) FROM upload_sessions s WHERE result IS NULL AND expires_at>NOW() AND NOT EXISTS(SELECT 1 FROM upload_processing_jobs j WHERE j.upload_id=s.upload_id)) AS incomplete_uploads,
    (SELECT count(*) FROM upload_processing_jobs WHERE state='queued') AS queued_uploads,
    (SELECT count(*) FROM upload_processing_jobs WHERE state='processing') AS processing_uploads,
    (SELECT count(*) FROM upload_processing_jobs WHERE state='failed') AS failed_uploads,
    (SELECT count(*) FROM photo_trash) AS trash`)
}

/** The 100 most recent upload file results in the given albums, newest first. */
export function listRecentUploadFiles(albumIds: number[]): Promise<Record<string, unknown>[]> {
  return pgQuery(
    `SELECT f.source_filename,f.status,f.error_message,j.started_at,e.event_name,j.event_id
     FROM upload_files f
     JOIN upload_jobs j USING(upload_job_id)
     LEFT JOIN events e ON e.event_id=j.event_id
     WHERE j.event_id=ANY($1::int[])
     ORDER BY j.started_at DESC,f.upload_file_id DESC
     LIMIT 100`,
    [albumIds],
  )
}

/** Up to 100 photos in the given albums whose AI description failed, most attempts first. */
export function listAiFailures(albumIds: number[]): Promise<Record<string, unknown>[]> {
  return pgQuery(
    `SELECT photo_id,source_filename,ai_error,ai_attempts,ai_next_attempt_at FROM photos WHERE ai_description IS NULL AND ai_error IS NOT NULL AND event_id=ANY($1::int[]) ORDER BY ai_attempts DESC,photo_id LIMIT 100`,
    [albumIds],
  )
}

/**
 * Up to 50 failed storage-cleanup intents. Storage paths are gallery-wide: the caller
 * must restrict this to the main admin.
 */
export function listCleanupFailures(): Promise<Record<string, unknown>[]> {
  return pgQuery(
    'SELECT path,attempts,next_attempt,last_error FROM stage_cleanup WHERE last_error IS NOT NULL ORDER BY next_attempt LIMIT 50',
  )
}

/** Last success and last error of the search sync, or null before its first run. */
export function readSearchSyncState(): Promise<Record<string, unknown> | null> {
  return pgQueryOne(
    "SELECT last_success,last_error FROM maintenance_state WHERE name='search-sync'",
  )
}

/**
 * Makes failed storage-cleanup intents due again. Only failed work is reset; the cleanup
 * worker rechecks live and Trash references. The caller must require the main admin.
 */
export async function retryFailedCleanup(): Promise<void> {
  await pgQuery(
    'UPDATE stage_cleanup SET attempts=0,next_attempt=NOW(),last_error=NULL WHERE last_error IS NOT NULL',
  )
}
