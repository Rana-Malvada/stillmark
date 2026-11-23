import { randomUUID } from 'node:crypto'
import { acknowledgeAutomaticWork, listAutomaticWork } from '../automatic-work'
import { withServiceDatabase } from '../database/database-context'
import { pgQuery, pgTransaction, withAdvisoryLock } from '../postgres'
import { SEARCH_UPDATE_MAX_MS } from './search-update'
import { HttpError } from '../http'
import { flagOn } from '../flags'

type PublishingRun = {
  run_id: string
  status: string
  deadline: string
  next_attempt_at: string
  retry_due: boolean
}

/** Only the outbox wakes publishing. The existing bounded publisher retains its
 * own lock and revision fencing; a committed cycle survives application restart. */
export async function maintainAutomaticSearch() {
  if (!flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED')) return
  return withServiceDatabase(() =>
    withAdvisoryLock('automatic-search-publishing', async () => {
      const pendingWake =
        await pgQuery(`SELECT 1 WHERE EXISTS(SELECT 1 FROM automatic_work_signals WHERE kind='search')
        OR EXISTS(SELECT 1 FROM automatic_work_state WHERE kind='search' AND status='running')`)
      if (!pendingWake.length) return
      // The state row is the short admission/Stop fence, never held during remote I/O.
      const run = await pgTransaction(async () => {
        const current = await lockPublishingState()
        if (current.status === 'running') return current
        const signals = await listAutomaticWork('search')
        if (!signals.length) return
        const pending = await pgQuery('SELECT 1 FROM search_queue LIMIT 1')
        await acknowledgeAutomaticWork('search', signals)
        if (!pending.length) return
        const [created] = await pgQuery<PublishingRun>(
          `UPDATE automatic_work_state
          SET run_id=$1,status='running',started_at=now(),deadline=now()+interval '3 hours',finished_at=NULL,error=NULL,retry_attempts=0,next_attempt_at=now()
          WHERE kind='search' RETURNING run_id,status,deadline,next_attempt_at,true AS retry_due`,
          [randomUUID()],
        )
        return created
      })
      if (!run) return
      const remainingMs = new Date(run.deadline).getTime() - Date.now()
      if (remainingMs <= 0) {
        await finishAutomaticSearch(
          run.run_id,
          'cancelled',
          'Three-hour search update limit reached',
        )
        return
      }
      if (run.retry_due === false) return
      const stopped = new AbortController()
      let checking = false
      const monitor = setInterval(() => {
        if (checking) return
        checking = true
        void withServiceDatabase(async () => {
          const live = await pgQuery(
            "SELECT 1 FROM automatic_work_state WHERE kind='search' AND run_id=$1 AND status='running'",
            [run.run_id],
          )
          if (!live.length) stopped.abort(new Error('Search publishing stopped'))
        })
          .catch(() => stopped.abort(new Error('Unable to verify publishing run')))
          .finally(() => {
            checking = false
          })
      }, 5000)
      monitor.unref?.()
      try {
        const result = await (
          await import('./search-sync')
        ).syncSearch({
          force: true,
          signal: AbortSignal.any([
            stopped.signal,
            AbortSignal.timeout(Math.min(SEARCH_UPDATE_MAX_MS, remainingMs)),
          ]),
        })
        if (result && result.remaining === 0)
          await finishAutomaticSearch(run.run_id, 'completed', null)
        else if (result)
          await pgQuery(
            `UPDATE automatic_work_state SET retry_attempts=0,next_attempt_at=now(),error=NULL
             WHERE kind='search' AND run_id=$1 AND status='running'`,
            [run.run_id],
          )
      } catch (error) {
        // Publication is revision-fenced and safe to resume after a lost response.
        // Persist backoff without extending the original cycle or overriding Stop.
        await pgQuery(
          `UPDATE automatic_work_state SET retry_attempts=retry_attempts+1,
           next_attempt_at=now()+make_interval(secs=>LEAST(300,5*power(2,LEAST(retry_attempts,6)))::int),
           error='Search publishing interrupted; retrying automatically'
           WHERE kind='search' AND run_id=$1 AND status='running' AND deadline>now()`,
          [run.run_id],
        )
        throw error
      } finally {
        clearInterval(monitor)
      }
    }),
  )
}

async function lockPublishingState() {
  let [run] = await pgQuery<PublishingRun>(
    "SELECT run_id,status,deadline,next_attempt_at,next_attempt_at<=now() AS retry_due FROM automatic_work_state WHERE kind='search' FOR UPDATE",
  )
  if (!run) {
    await pgQuery(
      `INSERT INTO automatic_work_state(kind,run_id,status,deadline) VALUES('search',$1,'completed',now()) ON CONFLICT DO NOTHING`,
      [randomUUID()],
    )
    ;[run] = await pgQuery<PublishingRun>(
      "SELECT run_id,status,deadline,next_attempt_at,next_attempt_at<=now() AS retry_due FROM automatic_work_state WHERE kind='search' FOR UPDATE",
    )
  }
  return run
}

async function finishAutomaticSearch(id: string, status: string, error: string | null) {
  await pgTransaction(async () => {
    const rows = await pgQuery(
      `UPDATE automatic_work_state SET status=$2,error=$3,finished_at=now()
      WHERE kind='search' AND run_id=$1 AND status='running' RETURNING run_id`,
      [id, status, error],
    )
    if (!rows.length) return
    // Completion consumes only signals whose revision is no longer queued. New
    // changes survive. Failure/Stop consume the current signal snapshot, not work.
    if (status === 'completed') {
      await pgQuery(`DELETE FROM automatic_work_signals s WHERE kind='search' AND NOT EXISTS
        (SELECT 1 FROM search_queue q WHERE q.kind=s.source_type AND q.id=s.source_id)`)
    } else await pgQuery("DELETE FROM automatic_work_signals WHERE kind='search'")
  })
}

/** Called by the explicit Search Stop path. Durable pause also covers a publisher
 * that has already acknowledged table writes but has not finished index refresh. */
export async function stopAutomaticSearch() {
  if (!flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED')) return false
  return pgTransaction(async () => {
    await lockPublishingState()
    const signals = await pgQuery(
      "DELETE FROM automatic_work_signals WHERE kind IN ('search','ocr') RETURNING kind",
    )
    const rows =
      await pgQuery(`UPDATE automatic_work_state SET status='cancelled',finished_at=now(),error='Stopped by user'
      WHERE kind='search' AND status='running' RETURNING run_id`)
    return rows.length > 0 || signals.length > 0
  })
}

/** Explicit recovery is durable and returns immediately; the coordinator performs
 * publication. A double-click shares the already-running cycle. */
export async function retryAutomaticSearch() {
  if (!flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED'))
    throw new HttpError(409, 'Automatic publishing is not enabled')
  return withServiceDatabase(() =>
    pgTransaction(async () => {
      const [previous] = await pgQuery<PublishingRun>(
        "SELECT run_id,status,deadline,next_attempt_at,next_attempt_at<=now() AS retry_due FROM automatic_work_state WHERE kind='search' FOR UPDATE",
      )
      if (!previous || !['running', 'failed', 'cancelled'].includes(previous.status))
        throw new HttpError(409, 'No interrupted publishing is available to retry')
      if (previous.status === 'running') return { id: previous.run_id, queued: true }
      const id = randomUUID()
      await pgQuery(
        `UPDATE automatic_work_state SET run_id=$1,status='running',started_at=now(),
      deadline=now()+interval '3 hours',finished_at=NULL,error=NULL,retry_attempts=0,next_attempt_at=now() WHERE kind='search'`,
        [id],
      )
      return { id, queued: true }
    }),
  )
}
