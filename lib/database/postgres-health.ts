import { pgQuery, pgQueryOne, pgTransaction } from '../postgres'

/**
 * Confirms the tables and columns the app depends on exist and are readable by the
 * current database identity. Reads no rows; rejects on the first missing object.
 */
export async function probeRequiredSchema(): Promise<void> {
  await pgQuery('SELECT ai_attempts,search_vector,user_tags FROM photos LIMIT 0')
  await pgQuery('SELECT 1 FROM search_queue LIMIT 0')
  await pgQuery('SELECT owner_username,visibility FROM events LIMIT 0')
  await pgQuery('SELECT username FROM gallery_main_admins LIMIT 0')
  await pgQuery('SELECT event_id,username FROM album_shares LIMIT 0')
  await pgQuery('SELECT photo_id,expires_at FROM photo_trash LIMIT 0')
  await pgQuery('SELECT name,payload FROM app_reports LIMIT 0')
  await pgQuery('SELECT day FROM storage_snapshots LIMIT 0')
}

/**
 * Database size in bytes (as text, to keep precision) and the number of uploads that
 * failed in the last hour. Run with the service database identity.
 */
export function readDatabaseHealth(): Promise<{ bytes: string; failed: number } | null> {
  return pgQueryOne<{
    bytes: string
    failed: number
  }>(`SELECT pg_database_size(current_database())::text AS bytes,
   (SELECT count(*)::int FROM upload_processing_jobs WHERE state='failed' AND failed_at>now()-interval '1 hour') AS failed`)
}

/**
 * Stall signals for one kind of background work: counts, and ages in whole seconds.
 * `null` means there is nothing to report (no runnable item, no expired claim, no
 * active run) or that the kind does not have that signal.
 */
export type WorkSignals = {
  /** How long the oldest item that could be claimed right now has been claimable. */
  oldestEligibleSeconds: number | null
  /** Claims whose lease is still being renewed: evidence that a worker is running. */
  activeLeases: number | null
  /** Claims whose lease ran out without the item being finished or released. */
  expiredLeases: number | null
  oldestExpiredLeaseSeconds: number | null
  /** Age of a worker run that has been launched but has not reported in yet. */
  startingSeconds: number | null
  /** Time since the worker last reported in (run heartbeat, or last admitted claim). */
  workerSeenSeconds: number | null
}
export const WORK_KINDS = ['uploads', 'video', 'faces', 'ai', 'search'] as const
export type WorkKind = (typeof WORK_KINDS)[number]
export type WorkHealth = Partial<Record<WorkKind, WorkSignals>> & {
  /** Time since the background coordinator last renewed its lease; null if it never ran. */
  coordinatorHeartbeatSeconds?: number | null
}

/** NULL stays NULL (GREATEST alone would turn it into 0); clock skew never goes negative. */
const age = (from: string) =>
  `(CASE WHEN ${from} IS NOT NULL THEN GREATEST(0,floor(extract(epoch FROM now()-${from})))::int END)`
/** Counts stop at this many rows so a very large backlog cannot make the read slow. */
export const WORK_COUNT_LIMIT = 1000
const counted = (rows: string) =>
  `(SELECT count(*)::int FROM (SELECT 1 FROM ${rows} LIMIT ${WORK_COUNT_LIMIT}) bounded)`

/** The coordinator renews a thirty-second lease; its last renewal is its heartbeat. */
const coordinatorSql = `SELECT ${age("(lease_until-interval '30 seconds')")} AS heartbeat
 FROM background_coordinator WHERE name='application-background'`

const videoScope = '($1::boolean OR v.preparation_run_id=(SELECT id FROM run))'
const faceRun = 'q.run_id=(SELECT id FROM run)'
const aiClaimed = 'photos WHERE ai_claim IS NOT NULL AND ai_description IS NULL'

/**
 * One statement per kind. Every lookup walks an existing index in order and stops at
 * the first row, or counts at most WORK_COUNT_LIMIT rows. Eligibility repeats each
 * queue's own claim rule, so work waiting for a retry time, work that has used up its
 * attempts, and work that no active run has admitted are never counted.
 */
const workSql: Record<WorkKind, string> = {
  // Indexes: upload_processing_ready(next_attempt,created_at), upload_processing_expired(lease_until).
  uploads: `SELECT
 (SELECT ${age('next_attempt')} FROM upload_processing_jobs
   WHERE state='queued' AND next_attempt<=now() ORDER BY next_attempt LIMIT 1) AS eligible,
 ${counted("upload_processing_jobs WHERE state='processing' AND lease_until>now()")} AS active,
 ${counted("upload_processing_jobs WHERE state='processing' AND lease_until<=now()")} AS expired,
 (SELECT ${age('lease_until')} FROM upload_processing_jobs
   WHERE state='processing' AND lease_until<=now() ORDER BY lease_until LIMIT 1) AS expired_age,
 NULL::int AS starting, NULL::int AS seen`,
  // A playback copy is prepared by the worker run that admitted it. $1 is true only when
  // this application also converts videos itself and so may claim any queued row.
  // Indexes: video_playback_due(next_attempt_at,requested_at), video_playback_queue(status,requested_at).
  video: `WITH run AS (SELECT id,status,created_at,heartbeat_at FROM video_preparation_runs
   WHERE status IN ('starting','running') LIMIT 1)
 SELECT
 (SELECT ${age('v.next_attempt_at')} FROM video_playback v JOIN photos p USING(photo_id)
   WHERE v.status='queued' AND v.next_attempt_at<=now() AND ${videoScope}
     AND p.ingest_status='READY' AND p.original_stage_path=v.original_path
   ORDER BY v.next_attempt_at LIMIT 1) AS eligible,
 ${counted(`video_playback v WHERE v.status='running' AND v.lease_until>now() AND ${videoScope}`)} AS active,
 ${counted(`video_playback v WHERE v.status='running' AND v.lease_until<=now() AND ${videoScope}`)} AS expired,
 (SELECT ${age('v.lease_until')} FROM video_playback v
   WHERE v.status='running' AND v.lease_until<=now() AND ${videoScope}
   ORDER BY v.lease_until LIMIT 1) AS expired_age,
 (SELECT ${age('created_at')} FROM run WHERE status='starting') AS starting,
 (SELECT ${age('heartbeat_at')} FROM run WHERE status='running') AS seen`,
  // Index: face_scan_queue_run(run_id,status), so only the one active run's rows are read.
  faces: `WITH run AS (SELECT id,status,created_at,heartbeat_at FROM face_scan_runs
   WHERE status IN ('starting','running') LIMIT 1)
 SELECT
 (SELECT ${age('q.next_attempt_at')} FROM face_scan_queue q
   WHERE ${faceRun} AND q.status='queued' AND q.next_attempt_at<=now()
   ORDER BY q.next_attempt_at LIMIT 1) AS eligible,
 ${counted(`face_scan_queue q WHERE ${faceRun} AND q.status='running' AND q.lease_until>now()`)} AS active,
 ${counted(`face_scan_queue q WHERE ${faceRun} AND q.status='running' AND q.lease_until<=now()`)} AS expired,
 (SELECT ${age('q.lease_until')} FROM face_scan_queue q
   WHERE ${faceRun} AND q.status='running' AND q.lease_until<=now()
   ORDER BY q.lease_until LIMIT 1) AS expired_age,
 (SELECT ${age('created_at')} FROM run WHERE status='starting') AS starting,
 (SELECT ${age('heartbeat_at')} FROM run WHERE status='running') AS seen`,
  // Indexes: photos_ai_pending(ai_next_attempt_at), photos_ai_live_claim(ai_lease_until,event_id).
  // The last admitted claim is the newest row of the small per-owner admission table.
  ai: `SELECT
 (SELECT ${age('ai_next_attempt_at')} FROM photos
   WHERE ai_description IS NULL AND ingest_status='READY' AND ai_attempts<3 AND ai_next_attempt_at<=now()
     AND (ai_lease_until IS NULL OR ai_lease_until<now())
     AND display_stage_path IS NOT NULL AND media_type='photo'
   ORDER BY ai_next_attempt_at LIMIT 1) AS eligible,
 ${counted(`${aiClaimed} AND ai_lease_until>now()`)} AS active,
 ${counted(`${aiClaimed} AND ai_lease_until<=now()`)} AS expired,
 (SELECT ${age('ai_lease_until')} FROM ${aiClaimed} AND ai_lease_until<=now()
   ORDER BY ai_lease_until LIMIT 1) AS expired_age,
 NULL::int AS starting,
 (SELECT ${age('max(last_claimed_at)')} FROM photo_ai_tenant_admission) AS seen`,
  // search_enrichment has no index on its status, so only the photos an automatic run
  // admitted are looked up, by primary key; a manual run reports its heartbeat alone.
  // Claims are not counted: the worker releases expired ones only when a run starts.
  search: `WITH run AS (SELECT status,created_at,heartbeat_at,automatic_photo_ids FROM search_batch_runs
   WHERE status IN ('starting','running') LIMIT 1)
 SELECT
 (SELECT ${age('min(q.updated_at)')} FROM search_enrichment q
   WHERE q.photo_id IN (SELECT unnest(automatic_photo_ids) FROM run LIMIT ${WORK_COUNT_LIMIT})
     AND q.status='queued' AND q.attempts<3) AS eligible,
 NULL::int AS active, NULL::int AS expired, NULL::int AS expired_age,
 (SELECT ${age('created_at')} FROM run WHERE status='starting') AS starting,
 (SELECT ${age('heartbeat_at')} FROM run WHERE status='running') AS seen`,
}

const signalColumns = ['eligible', 'active', 'expired', 'expired_age', 'starting', 'seen'] as const
const seconds = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)

/** One short, time-limited transaction per read, so a slow or failing kind affects only itself. */
function bounded(sql: string, params?: unknown[]) {
  return pgTransaction(async () => {
    await pgQuery("SET LOCAL statement_timeout = '1500ms'")
    return pgQueryOne<Record<string, unknown>>(sql, params)
  })
}

/**
 * Aggregate stall signals for the gateway monitor. Run with the service database
 * identity. A kind that cannot be read is left out, and `null` means nothing could be
 * read. Returns numbers only: no names, paths or identifiers.
 */
export async function readWorkHealth(options: {
  appConvertsVideo: boolean
}): Promise<WorkHealth | null> {
  const health: WorkHealth = {}
  try {
    const row = await bounded(coordinatorSql)
    if (row && !Object.hasOwn(row, 'heartbeat')) throw Error('Invalid coordinator heartbeat')
    const heartbeat = row ? row.heartbeat : null
    if (!seconds(heartbeat)) throw Error('Invalid coordinator heartbeat')
    health.coordinatorHeartbeatSeconds = heartbeat
  } catch {
    // Left out: the gateway treats a missing signal as unknown, neither healthy nor failed.
  }
  for (const kind of WORK_KINDS) {
    try {
      const row = await bounded(
        workSql[kind],
        kind === 'video' ? [options.appConvertsVideo] : undefined,
      )
      if (!row) throw Error('Invalid work signals')
      const value = (column: (typeof signalColumns)[number]) => {
        const item = Object.hasOwn(row, column) ? row[column] : undefined
        if (!seconds(item)) throw Error('Invalid work signals')
        return item
      }
      health[kind] = {
        oldestEligibleSeconds: value('eligible'),
        activeLeases: value('active'),
        expiredLeases: value('expired'),
        oldestExpiredLeaseSeconds: value('expired_age'),
        startingSeconds: value('starting'),
        workerSeenSeconds: value('seen'),
      }
    } catch {
      // Left out, as above.
    }
  }
  return Object.keys(health).length ? health : null
}
