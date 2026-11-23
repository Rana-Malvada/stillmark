import { objects } from '../../config/deployment.mjs'
import { randomUUID } from 'node:crypto'
import { pgQuery, pgQueryOne, pgTransaction, withAdvisoryLock } from '../postgres'
import { querySnowflake } from '../snowflake'
import { HttpError } from '../http'
import { recoverWorkerCycle, WORKER_INTERRUPTED } from '../worker-cycle-recovery'
import { reserveWorkerLaunch } from '../worker-launch-recovery'
import {
  acknowledgeAutomaticSources,
  acknowledgeAutomaticWork,
  listAutomaticWork,
} from '../automatic-work'
import { flagOn } from '../flags'
import { logError } from '../log'

/**
 * Admin-started face scanning, modelled on video preparation. Start queues every
 * unscanned photo of owners who turned People on and launches the CPU job. Each job
 * stops at its time budget; upkeep then starts the next job for the photos left,
 * so one Start covers the whole library. Stop never restarts the cancelled work;
 * new upload signals may start a separate incremental run.
 */

export type FaceScanRun = {
  id: string
  requested_by: string
  kind: string
  status: string
  total: number
  processed: number
  failed: number
  faces_found: number
  created_at: string
  started_at: string | null
  finished_at: string | null
  heartbeat_at: string
  error: string | null
  next_launch_at: string
  idle_since: string | null
  accepting_work: boolean
  cycle_deadline: string
  recovery_attempts: number
  organization_pending: boolean
}
type JobState = {
  status: string
  job?: string
  pool?: string
  containers?: { status: string; message: string }[]
}

/** The worker's reason when it stops at its time budget (workers/face-cpu/worker.py). */
export const TIME_BUDGET = 'Time budget reached; remaining photos stay queued'
const LOCK = 'face-scan-launch'
const STARTUP_LIMIT_MS = 30 * 60 * 1000
const HEARTBEAT_LIMIT_MS = 3 * 60 * 1000
/** Measured in the pilot on CPU_X64_S: about 1.6 seconds per photo. */
const SECONDS_PER_PHOTO = 1.6

const ELIGIBLE = `p.media_type='photo' AND p.ingest_status='READY' AND p.original_stage_path IS NOT NULL
  AND EXISTS(SELECT FROM events e JOIN face_settings s ON s.owner_username=e.owner_username AND s.enabled
             WHERE e.event_id=p.event_id)`
/** Scanned means the current original was scanned for its current owner; a replaced or moved photo needs a new scan. */
const SCANNED = `q.status='done' AND q.source_path=p.original_stage_path
  AND q.owner_username=(SELECT owner_username FROM events WHERE event_id=p.event_id)`

async function command(id: string, action: 'START' | 'STATUS' | 'CANCEL' | 'SETTLE') {
  const rows = await querySnowflake(`CALL ${objects.faceControl}(?, ?)`, { binds: [id, action] })
  const result = Object.values(rows[0] || {})[0]
  return (typeof result === 'string' ? JSON.parse(result) : result) as JobState
}

const active = () =>
  pgQueryOne<FaceScanRun>(
    "SELECT * FROM face_scan_runs WHERE status IN ('starting','running') ORDER BY created_at DESC LIMIT 1",
  )

/** Queues remaining photos into a new run. Photos queued for `from` move with it. */
async function createRun(username: string, from: string | null, automaticIds?: number[]) {
  return pgTransaction(async () => {
    const id = randomUUID()
    await pgQuery(
      `INSERT INTO face_scan_runs(id,requested_by,kind,status,photo_limit) VALUES($1,$2,$3,'starting',100000)`,
      [id, username, automaticIds ? 'incremental' : 'backfill'],
    )
    if (from)
      await pgQuery(
        `UPDATE face_scan_runs child
         SET cycle_deadline=parent.cycle_deadline,
           continued_from=parent.id,
           recovery_attempts=parent.recovery_attempts,
           organization_pending=parent.organization_pending
         FROM face_scan_runs parent
         WHERE child.id=$1 AND parent.id=$2`,
        [id, from],
      )
    const rows = from
      ? await pgQuery(
          `UPDATE face_scan_queue SET run_id=$1, next_attempt_at=now() WHERE run_id=$2 AND status='queued' RETURNING photo_id`,
          [id, from],
        )
      : await pgQuery(
          `INSERT INTO face_scan_queue(photo_id,owner_username,source_path,run_id)
           SELECT p.photo_id, e.owner_username, p.original_stage_path, $1
           FROM photos p JOIN events e ON e.event_id=p.event_id
           LEFT JOIN face_scan_queue q ON q.photo_id=p.photo_id
           WHERE ${ELIGIBLE} AND NOT COALESCE(${SCANNED}, false)
             AND NOT COALESCE(q.status='running' AND q.lease_until>now(), false)
             ${automaticIds ? "AND p.photo_id=ANY($2::int[]) AND q.status='queued' AND q.source_path=p.original_stage_path" : ''}
           ON CONFLICT(photo_id) DO UPDATE SET owner_username=EXCLUDED.owner_username, source_path=EXCLUDED.source_path,
             run_id=$1, status='queued', attempts=0, claim_token=NULL, lease_until=NULL, next_attempt_at=now(),
             requested_at=now(), completed_at=NULL, error=NULL
           RETURNING photo_id`,
          automaticIds ? [id, automaticIds] : [id],
        )
    if (!automaticIds && !from)
      await acknowledgeAutomaticSources(
        'faces',
        rows.map((r) => Number(r.photo_id)),
      )
    return (await pgQueryOne<FaceScanRun>(
      `UPDATE face_scan_runs SET total=$2,
         status=CASE WHEN $2=0 AND NOT organization_pending THEN 'completed' ELSE 'starting' END,
         finished_at=CASE WHEN $2=0 AND NOT organization_pending THEN now() END
       WHERE id=$1 RETURNING *`,
      [id, rows.length],
    ))!
  })
}

async function launch(run: FaceScanRun) {
  if (run.status !== 'starting' || !(await reserveWorkerLaunch('face_scan_runs', run.id)))
    return run
  try {
    // The job name is derived from the run ID, so a retried START never launches twice.
    await command(run.id, 'START')
  } catch (error) {
    logError('face-scan-start', error)
    throw new HttpError(
      503,
      'Could not confirm the scanner started. Recovery will retry this saved run automatically.',
    )
  }
  return run
}

async function markAttention(id: string, reason: string) {
  await pgQuery(
    `UPDATE face_scan_runs SET status='attention', finished_at=now(), error=$2 WHERE id=$1 AND status IN ('starting','running')`,
    [id, reason],
  )
}

/** Recovers stuck or crashed jobs and continues a scan that stopped at its time budget. */
async function reconcile(): Promise<FaceScanRun | null> {
  const run = await active()
  if (run && new Date(run.cycle_deadline).getTime() <= Date.now()) {
    await command(run.id, 'CANCEL')
    await markAttention(run.id, 'Three-hour face scan limit reached')
    return null
  }
  if (run?.status === 'starting') {
    if (Date.now() - new Date(run.created_at).getTime() <= STARTUP_LIMIT_MS) {
      if (new Date(run.next_launch_at).getTime() <= Date.now()) {
        const state = await command(run.id, 'STATUS')
        if (state.status === 'NOT_FOUND') return launch(run)
      }
      return run
    }
    await command(run.id, 'CANCEL')
    await markAttention(
      run.id,
      'Startup took longer than thirty minutes and was stopped. Scan photos again to retry.',
    )
    return null
  }
  if (run) {
    if (Date.now() - new Date(run.heartbeat_at).getTime() < HEARTBEAT_LIMIT_MS) return run
    const state = await command(run.id, 'STATUS')
    if (['DONE', 'FAILED', 'NOT_FOUND'].includes(state.status))
      await markAttention(run.id, WORKER_INTERRUPTED)
    return null
  }
  const recovered = await recoverWorkerCycle('faces')
  if (recovered) return launch(recovered as FaceScanRun)
  // Continue only a run that stopped at its budget after making progress.
  const last = await pgQueryOne<FaceScanRun & { remaining: number }>(
    `SELECT r.*, (SELECT count(*)::int FROM face_scan_queue q WHERE q.run_id=r.id AND q.status='queued') AS remaining
     FROM face_scan_runs r ORDER BY r.created_at DESC LIMIT 1`,
  )
  if (
    !last ||
    last.error !== TIME_BUDGET ||
    (!last.organization_pending && (last.processed === 0 || last.remaining === 0)) ||
    new Date(last.cycle_deadline).getTime() <= Date.now()
  )
    return null
  return launch(await createRun(last.requested_by, last.id))
}

export async function scanStatus() {
  // Polling reads Postgres only. Background maintenance handles worker recovery.
  const statusWarning = null
  const [summary, run, failures] = await Promise.all([
    pgQueryOne<{ total: number; scanned: number; pending: number; failed: number; owners: number }>(
      `SELECT count(*)::int AS total,
         count(*) FILTER (WHERE ${SCANNED})::int AS scanned,
         count(*) FILTER (WHERE NOT COALESCE(${SCANNED}, false))::int AS pending,
         count(*) FILTER (WHERE q.status='failed' AND q.source_path=p.original_stage_path)::int AS failed,
         (SELECT count(*)::int FROM face_settings WHERE enabled) AS owners
       FROM photos p LEFT JOIN face_scan_queue q ON q.photo_id=p.photo_id WHERE ${ELIGIBLE}`,
    ),
    pgQueryOne<FaceScanRun>('SELECT * FROM face_scan_runs ORDER BY created_at DESC LIMIT 1'),
    pgQuery<{ photo_id: number; source_filename: string; error: string | null }>(
      `SELECT q.photo_id, p.source_filename, q.error FROM face_scan_queue q JOIN photos p ON p.photo_id=q.photo_id
       WHERE q.status='failed' AND q.source_path=p.original_stage_path ORDER BY q.photo_id DESC LIMIT 50`,
    ),
  ])
  const progress = run
    ? await pgQueryOne<{ done: number; running: number; queued: number; failed: number }>(
        `SELECT count(*) FILTER (WHERE status='done')::int AS done, count(*) FILTER (WHERE status='running')::int AS running,
           count(*) FILTER (WHERE status='queued')::int AS queued, count(*) FILTER (WHERE status='failed')::int AS failed
         FROM face_scan_queue WHERE run_id=$1`,
        [run.id],
      )
    : null
  return {
    summary,
    run,
    progress,
    failures,
    statusWarning,
    continuing: run?.error === TIME_BUDGET,
    estimatedMinutes: Math.ceil(((summary?.pending ?? 0) * SECONDS_PER_PHOTO) / 60),
    asOf: new Date().toISOString(),
  }
}

export async function startScan(username: string) {
  const result = await withAdvisoryLock(LOCK, async () => {
    const current = await reconcile()
    if (current) return current
    return launch(await createRun(username, null))
  })
  if (!result) throw new HttpError(409, 'A scan is already being started. Refresh status.')
  return result
}

/** Cancels the current job. Queued photos stay queued for the next Scan photos. */
export async function stopScan() {
  const result = await withAdvisoryLock(LOCK, async () => {
    const run = await active()
    if (!run) throw new HttpError(409, 'No scan is running.')
    await command(run.id, 'CANCEL')
    await pgQuery(
      `UPDATE face_scan_runs SET status='cancelled', finished_at=now(), error='Stopped by an administrator'
       WHERE id=$1 AND status IN ('starting','running')`,
      [run.id],
    )
    return { stopped: run.id }
  })
  if (!result) throw new HttpError(409, 'The scan is changing state. Refresh status.')
  return result
}

/** Background upkeep: same recovery and continuation as the status page, as the service. */
export async function maintainFaceScan() {
  const { withServiceDatabase } = await import('../database/database-context')
  return withServiceDatabase(() =>
    withAdvisoryLock(LOCK, async () => {
      const recovered = await reconcile()
      const run = await pgTransaction(async () => {
        if (!flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED')) return null
        const signals = await listAutomaticWork('faces')
        if (!signals.length) return null
        const ids = signals.map((s) => s.sourceId)
        const current = await pgQueryOne<FaceScanRun>(
          "SELECT * FROM face_scan_runs WHERE status IN ('starting','running') FOR UPDATE",
        )
        if (current) {
          if (
            !current.accepting_work ||
            (current.started_at && Date.now() - new Date(current.started_at).getTime() >= 7200000)
          )
            return null
          const added = await pgQuery(
            `UPDATE face_scan_queue q SET run_id=$1 FROM photos p
           WHERE q.photo_id=p.photo_id AND p.photo_id=ANY($2::int[]) AND ${ELIGIBLE}
             AND q.status='queued' AND q.source_path=p.original_stage_path RETURNING q.photo_id`,
            [current.id, ids],
          )
          if (added.length)
            await pgQuery('UPDATE face_scan_runs SET total=total+$2,idle_since=NULL WHERE id=$1', [
              current.id,
              added.length,
            ])
          await acknowledgeAutomaticWork('faces', signals)
          return null
        }
        const eligible = await pgQueryOne(
          `SELECT 1 FROM photos p JOIN face_scan_queue q ON q.photo_id=p.photo_id
         WHERE p.photo_id=ANY($1::int[]) AND ${ELIGIBLE} AND q.status='queued'
           AND q.source_path=p.original_stage_path LIMIT 1`,
          [ids],
        )
        const next = eligible ? await createRun('automatic-upload', null, ids) : null
        // Exact revision acknowledgement cannot erase an upload arriving during admission.
        await acknowledgeAutomaticWork('faces', signals)
        return next
      })
      return run ? launch(run) : recovered
    }),
  )
}
