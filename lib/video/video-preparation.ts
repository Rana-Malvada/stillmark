import { objects } from '../../config/deployment.mjs'
import { type PreparationServiceState, startupStatusMessage } from './video-startup-status'
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

export type PreparationRun = {
  id: string
  requested_by: string
  cycle_deadline: string
  status: string
  total: number
  created_at: string
  started_at: string | null
  finished_at: string | null
  heartbeat_at: string
  error: string | null
  next_launch_at: string
  idle_since: string | null
  accepting_work: boolean
}
const eligible =
  "p.media_type='video' AND p.ingest_status='READY' AND p.original_stage_path IS NOT NULL"
const ready =
  "v.status='ready' AND v.format_version=2 AND v.original_path=p.original_stage_path AND jsonb_array_length(v.renditions)>0"
const skipped = 'v.preparation_skipped AND v.preparation_skipped_path=p.original_stage_path'
async function command(id: string, action: 'START' | 'STATUS' | 'CANCEL') {
  const rows = await querySnowflake(`CALL ${objects.videoControl}(?, ?)`, {
    binds: [id, action],
  })
  const result = Object.values(rows[0] || {})[0]
  return (typeof result === 'string' ? JSON.parse(result) : result) as PreparationServiceState
}
const activePreparation =
  "FROM video_preparation_runs WHERE status IN ('starting','running') LIMIT 1"
export const PLAYBACK_TIME_BUDGET = 'Time budget reached; remaining videos stay queued'
async function reconcile() {
  const run = await pgQueryOne<PreparationRun>(`SELECT * ${activePreparation}`)
  if (!run) return
  if (new Date(run.cycle_deadline).getTime() <= Date.now()) {
    await command(run.id, 'CANCEL')
    await pgQuery(
      "UPDATE video_preparation_runs SET status='attention',finished_at=now(),error='Three-hour playback limit reached' WHERE id=$1 AND status IN ('starting','running')",
      [run.id],
    )
    return
  }
  if (run.status === 'starting') {
    let detail = 'Snowflake startup details are unavailable.'
    try {
      const state = await command(run.id, 'STATUS')
      detail = startupStatusMessage(state)
      await pgQuery(
        "UPDATE video_preparation_runs SET error=$2 WHERE id=$1 AND status='starting'",
        [run.id, detail],
      )
      if (state.status === 'NOT_FOUND') await launch(run)
    } catch (error) {
      // Keep the last useful diagnostic, and retain the cost guard even if status lookup fails.
      detail = run.error || detail
      if (Date.now() - new Date(run.created_at).getTime() <= 30 * 60 * 1000) throw error
    }
    if (Date.now() - new Date(run.created_at).getTime() > 30 * 60 * 1000) {
      // Recheck after the status call: the worker may have started during that request.
      const current = await pgQueryOne<PreparationRun>(
        "SELECT * FROM video_preparation_runs WHERE id=$1 AND status='starting'",
        [run.id],
      )
      if (current) {
        await pgQuery(
          "UPDATE video_preparation_runs SET error=$2 WHERE id=$1 AND status='starting'",
          [run.id, detail],
        )
        await command(run.id, 'CANCEL')
        await pgQuery(
          "UPDATE video_preparation_runs SET status='attention',finished_at=NOW(),error=$2 WHERE id=$1 AND status IN ('starting','running')",
          [
            run.id,
            'Startup exceeded thirty minutes and was stopped. Last observed state: ' + detail,
          ],
        )
      }
    }
    return
  }
  if (Date.now() - new Date(run.heartbeat_at).getTime() < 180000) return
  // A crashed container or interrupted launch must not leave the button blocked forever.
  const state = await command(run.id, 'STATUS')
  if (['DONE', 'FAILED', 'NOT_FOUND'].includes(state.status))
    await pgQuery(
      "UPDATE video_preparation_runs SET status='attention',finished_at=NOW(),error=$2 WHERE id=$1 AND status IN ('starting','running') AND heartbeat_at<NOW()-INTERVAL '3 minutes'",
      [run.id, WORKER_INTERRUPTED],
    )
}
export async function preparationStatus() {
  // Polling reads Postgres only. Background maintenance handles worker recovery.
  const statusWarning = null
  const [summary, run, failures, excluded] = await Promise.all([
    pgQueryOne(
      `SELECT count(*)::int total,
         count(*) FILTER(WHERE ${ready})::int ready,
         count(*) FILTER(WHERE NOT COALESCE(${ready},false) AND NOT COALESCE(${skipped},false))::int pending,
         count(*) FILTER(WHERE ${skipped})::int skipped
       FROM photos p
       LEFT JOIN video_playback v USING(photo_id)
       WHERE ${eligible}`,
    ),
    pgQueryOne<PreparationRun>(
      'SELECT * FROM video_preparation_runs ORDER BY created_at DESC LIMIT 1',
    ),
    pgQuery(
      `SELECT v.photo_id,p.source_filename,v.error FROM video_playback v JOIN photos p USING(photo_id) WHERE v.status='failed' AND NOT COALESCE(${skipped},false) AND ${eligible} ORDER BY v.photo_id DESC LIMIT 50`,
    ),
    pgQuery(
      `SELECT v.photo_id,p.source_filename FROM video_playback v JOIN photos p USING(photo_id) WHERE ${eligible} AND ${skipped} ORDER BY v.photo_id DESC LIMIT 50`,
    ),
  ])
  const progress = run
    ? await pgQueryOne(
        `SELECT count(*) FILTER(WHERE status='ready')::int ready,
           count(*) FILTER(WHERE status='running')::int running,
           count(*) FILTER(WHERE status='queued')::int queued,
           count(*) FILTER(WHERE status='failed' AND NOT preparation_skipped)::int failed,
           count(*) FILTER(WHERE preparation_skipped)::int skipped
         FROM video_playback
         WHERE preparation_run_id=$1`,
        [run.id],
      )
    : null
  const retries = run
    ? await pgQuery(
        `SELECT v.photo_id,p.source_filename,v.status,v.attempts,v.next_attempt_at,v.error
         FROM video_playback v
         JOIN photos p USING(photo_id)
         WHERE v.preparation_run_id=$1
         AND v.status IN ('queued','running')
         AND v.attempts>0
         AND v.error IS NOT NULL
         ORDER BY v.next_attempt_at
         LIMIT 50`,
        [run.id],
      )
    : []
  return {
    summary,
    run,
    progress,
    failures,
    excluded,
    retries,
    statusWarning,
    asOf: new Date().toISOString(),
  }
}
/** Snapshot only unfinished videos. Ready copies and originals are never modified. */
export async function enqueuePreparation(username: string, automaticIds?: number[]) {
  return pgTransaction(async () => {
    const active = await pgQueryOne<PreparationRun>(
      "SELECT * FROM video_preparation_runs WHERE status IN ('starting','running') LIMIT 1",
    )
    if (active) return active
    if (
      await pgQueryOne(
        "SELECT 1 FROM video_playback WHERE status='running' AND lease_until>NOW() LIMIT 1",
      )
    )
      throw new HttpError(409, 'A video worker is already running.')
    const id = randomUUID()
    await pgQuery(
      "INSERT INTO video_preparation_runs(id,requested_by,status) VALUES($1,$2,'starting')",
      [id, username],
    )
    const rows = await pgQuery(
      `INSERT INTO video_playback(photo_id,original_path,preparation_run_id)
   SELECT p.photo_id,p.original_stage_path,$1 FROM photos p LEFT JOIN video_playback v USING(photo_id) WHERE ${eligible} AND NOT COALESCE(${ready},false) AND NOT COALESCE(${skipped},false)
   ${automaticIds ? "AND p.photo_id=ANY($2::int[]) AND v.status='queued' AND v.original_path=p.original_stage_path" : ''}
   ON CONFLICT(photo_id) DO UPDATE SET preparation_skipped=false,original_path=EXCLUDED.original_path,
     preparation_run_id=$1,status='queued',attempts=0,claim_token=NULL,lease_until=NULL,
     next_attempt_at=NOW(),requested_at=NOW(),error=NULL
   RETURNING photo_id`,
      automaticIds ? [id, automaticIds] : [id],
    )
    if (!automaticIds)
      await acknowledgeAutomaticSources(
        'playback',
        rows.map((r) => Number(r.photo_id)),
      )
    return (await pgQueryOne<PreparationRun>(
      "UPDATE video_preparation_runs SET total=$2,status=CASE WHEN $2=0 THEN 'completed' ELSE 'starting' END,finished_at=CASE WHEN $2=0 THEN NOW() ELSE NULL END WHERE id=$1 RETURNING *",
      [id, rows.length],
    ))!
  })
}
export async function startPreparation(username: string) {
  const result = await withAdvisoryLock('video-preparation-launch', async () => {
    await reconcile()
    const current = await pgQueryOne<PreparationRun>(`SELECT * ${activePreparation}`)
    if (current) return current
    const run = await enqueuePreparation(username)
    await launch(run)
    return run
  })
  if (!result)
    throw new HttpError(409, 'Video preparation is already being started. Refresh status.')
  return result
}

async function launch(run: PreparationRun) {
  if (run.status !== 'starting' || !(await reserveWorkerLaunch('video_preparation_runs', run.id)))
    return
  // The controller creates only a missing deterministic job, including after a
  // lost accepted response. Never replace pending jobs or change created_at.
  try {
    await command(run.id, 'START')
  } catch (error) {
    logError('video-preparation-start', error)
    throw new HttpError(
      503,
      'Could not confirm GPU startup. Recovery will retry this saved run automatically.',
    )
  }
}

// The queue (lib/video-playback-queue.ts) fails a file on its third attempt, so a
// queued row below this limit is still owed a retry and needs a live run to claim it.
const RETRY_LIMIT = 3
const queuedForRetry = `v.status='queued' AND v.attempts<${RETRY_LIMIT}`
/** A worker that ended by itself inside its cycle after publishing something, leaving
 * files it may still try. It reports the time budget only when an untouched file
 * remains; with only retries left it finishes with no reason at all. $1 is the budget text. */
const continuable = `r.status='attention' AND (r.error=$1 OR (r.error IS NULL AND r.finished_at IS NOT NULL))
  AND r.cycle_deadline>now()
  AND NOT EXISTS(SELECT FROM video_preparation_runs child WHERE child.continued_from=r.id)
  AND EXISTS(SELECT FROM video_playback v WHERE v.preparation_run_id=r.id AND v.status='ready')
  AND EXISTS(SELECT FROM video_playback v WHERE v.preparation_run_id=r.id AND ${queuedForRetry})`

/** Continue a run that made durable progress, inside its original cycle. Files move
 * as they are: attempt counts, backoff times and diagnostics are never reset here. */
async function continuePreparation() {
  const next = await pgTransaction(async () => {
    if (await pgQueryOne(`SELECT 1 ${activePreparation}`)) return null
    const previous = await pgQueryOne<PreparationRun>(
      `SELECT r.* FROM video_preparation_runs r WHERE ${continuable}
      ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE`,
      [PLAYBACK_TIME_BUDGET],
    )
    if (!previous) return null
    // Wait for every live claim, as recovery does, before handing over the snapshot.
    if (
      await pgQueryOne(
        "SELECT 1 FROM video_playback WHERE status='running' AND lease_until>NOW() LIMIT 1",
      )
    )
      return null
    const pending = await pgQuery<{ photo_id: number }>(
      `SELECT v.photo_id FROM video_playback v JOIN photos p USING(photo_id)
      WHERE v.preparation_run_id=$1 AND ${queuedForRetry} AND ${eligible}
       AND v.original_path=p.original_stage_path AND NOT COALESCE(${skipped},false)`,
      [previous.id],
    )
    if (!pending.length) return null
    const id = randomUUID()
    await pgQuery(
      `INSERT INTO video_preparation_runs(id,requested_by,status,total,cycle_deadline,continued_from,recovery_attempts)
      SELECT $1,requested_by,'starting',$3,cycle_deadline,id,recovery_attempts
      FROM video_preparation_runs WHERE id=$2`,
      [id, previous.id, pending.length],
    )
    await pgQuery(
      `UPDATE video_playback v SET preparation_run_id=$1
      WHERE v.preparation_run_id=$2 AND ${queuedForRetry} AND v.photo_id=ANY($3::int[])`,
      [id, previous.id, pending.map((p) => p.photo_id)],
    )
    return pgQueryOne<PreparationRun>('SELECT * FROM video_preparation_runs WHERE id=$1', [id])
  })
  if (next) await launch(next)
}

/** A retry that outlived its cycle is not signalled again, so the run being admitted
 * takes it along. Only files already tried and left on a finished run move; untouched
 * work of a stopped run still waits for an explicit start. Nothing is reset. */
async function adoptRetries(runId: string) {
  const adopted = await pgQuery(
    `UPDATE video_playback v SET preparation_run_id=$1 FROM photos p
     WHERE v.photo_id=p.photo_id AND ${eligible} AND ${queuedForRetry} AND v.attempts>0
       AND v.original_path=p.original_stage_path AND NOT COALESCE(${skipped},false)
       AND v.preparation_run_id IS DISTINCT FROM $1
       AND NOT EXISTS(SELECT FROM video_preparation_runs live
         WHERE live.id=v.preparation_run_id AND live.status IN ('starting','running'))
     RETURNING v.photo_id`,
    [runId],
  )
  if (adopted.length)
    await pgQuery('UPDATE video_preparation_runs SET total=total+$2,idle_since=NULL WHERE id=$1', [
      runId,
      adopted.length,
    ])
}

export async function maintainPreparation() {
  const { withServiceDatabase } = await import('../database/database-context')
  return withServiceDatabase(async () => {
    if (
      !(await pgQueryOne(`SELECT 1 ${activePreparation}`)) &&
      (!flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED') ||
        !(await listAutomaticWork('playback', 1)).length) &&
      !(await pgQueryOne(
        `SELECT 1 FROM video_preparation_runs r WHERE (${continuable}) OR (r.status='attention' AND r.error=$2 AND r.cycle_deadline>now() AND NOT EXISTS(SELECT FROM video_preparation_runs child WHERE child.continued_from=r.id)) LIMIT 1`,
        [PLAYBACK_TIME_BUDGET, WORKER_INTERRUPTED],
      ))
    )
      return
    return withAdvisoryLock('video-preparation-launch', async () => {
      await reconcile()
      const recovered = await recoverWorkerCycle('playback')
      if (recovered) await launch(recovered as PreparationRun)
      await continuePreparation()
      const run = await pgTransaction(async () => {
        if (!flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED')) return null
        const signals = await listAutomaticWork('playback')
        if (!signals.length) return null
        const ids = signals.map((s) => s.sourceId)
        const current = await pgQueryOne<PreparationRun>(
          "SELECT * FROM video_preparation_runs WHERE status IN ('starting','running') FOR UPDATE",
        )
        if (current) {
          if (
            !current.accepting_work ||
            (current.started_at && Date.now() - new Date(current.started_at).getTime() >= 7200000)
          )
            return null
          const added = await pgQuery(
            `UPDATE video_playback v SET preparation_run_id=$1 FROM photos p
             WHERE v.photo_id=p.photo_id AND p.photo_id=ANY($2::int[]) AND ${eligible}
               AND v.status='queued' AND v.original_path=p.original_stage_path AND NOT COALESCE(${skipped},false)
             RETURNING v.photo_id`,
            [current.id, ids],
          )
          if (added.length)
            await pgQuery(
              'UPDATE video_preparation_runs SET total=total+$2,idle_since=NULL WHERE id=$1',
              [current.id, added.length],
            )
          await adoptRetries(current.id)
          await acknowledgeAutomaticWork('playback', signals)
          return null
        }
        const pending = await pgQueryOne(
          `SELECT 1 FROM photos p JOIN video_playback v USING(photo_id)
           WHERE p.photo_id=ANY($1::int[]) AND ${eligible} AND v.status='queued'
             AND v.original_path=p.original_stage_path AND NOT COALESCE(${skipped},false) LIMIT 1`,
          [ids],
        )
        const next = pending ? await enqueuePreparation('automatic-upload', ids) : null
        if (next?.status === 'starting') await adoptRetries(next.id)
        await acknowledgeAutomaticWork('playback', signals)
        return next
      })
      if (run) await launch(run)
    })
  })
}

/** Exclusion applies to this original only; restoring permits a later explicit retry. */
export async function setPreparationSkipped(photoId: number, skip: boolean) {
  const result = await withAdvisoryLock('video-preparation-launch', async () => {
    if (
      await pgQueryOne(
        "SELECT 1 FROM video_preparation_runs WHERE status IN ('starting','running') LIMIT 1",
      )
    )
      throw new HttpError(409, 'Wait for video preparation to finish before changing exclusions.')
    const row = await pgQueryOne(
      `UPDATE video_playback v SET preparation_skipped=$2,preparation_skipped_path=CASE WHEN $2 THEN p.original_stage_path ELSE NULL END FROM photos p
       WHERE v.photo_id=$1 AND p.photo_id=v.photo_id AND ${eligible}
       AND v.original_path=p.original_stage_path AND v.status='failed' RETURNING v.photo_id`,
      [photoId, skip],
    )
    if (!row)
      throw new HttpError(409, 'Only failed videos can be excluded or restored. Refresh status.')
    return row
  })
  if (!result) throw new HttpError(409, 'Video preparation is busy. Try again.')
  return result
}
