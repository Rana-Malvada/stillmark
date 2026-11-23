import {
  type SearchRun,
  searchUpdateChainSql,
  searchUpdateChildSql,
  searchUpdatePlan,
} from './search-update'
import { pruneExpiredSearchSessionsSql } from './search-session-maintenance'
import { searchBatchProgress } from './search-batch-progress'
import { refreshSavedSearches } from './search-replay'
import { randomUUID } from 'node:crypto'
import { pgQuery, pgTransaction, withAdvisoryLock } from '../postgres'
import { searchBatchCommand as command } from './search-batch-control'
import { HttpError } from '../http'
import { withServiceDatabase } from '../database/database-context'
import { acknowledgeAutomaticWork, listAutomaticWork } from '../automatic-work'
import { stopAutomaticSearch } from './automatic-search'
import { recoverAutomaticOcr, SEARCH_WORKER_INTERRUPTED } from './search-ocr-recovery'
import { flagOn } from '../flags'

async function reconcileSearchWorker(run: SearchRun | Record<string, unknown>) {
  if (
    !['starting', 'running'].includes(String(run.status)) ||
    Date.now() - new Date(String(run.heartbeat_at)).getTime() <= 2 * 60 * 1000
  )
    return
  const state = await command(String(run.id), 'STATUS')
  if (['FAILED', 'DONE', 'NOT_FOUND'].includes(state?.status)) {
    const [updated] = await pgQuery<SearchRun>(
      `UPDATE search_batch_runs SET status='failed',error=$2,finished_at=now()
       WHERE id=$1 AND status IN ('starting','running') RETURNING *`,
      [run.id, SEARCH_WORKER_INTERRUPTED],
    )
    if (updated) Object.assign(run, updated)
  }
}

export async function searchBatchStatus(reconcile = false) {
  return withServiceDatabase(async () => {
    const [summary] = await pgQuery(
      `SELECT count(*) FILTER(WHERE status='queued')::int AS pending,
         count(*) FILTER(WHERE status='running')::int AS running,
         count(*) FILTER(WHERE status='completed')::int AS completed,
         count(*) FILTER(WHERE status='failed')::int AS failed
       FROM search_enrichment`,
    )
    const [searches] = await pgQuery(
      `SELECT count(*)::int AS pending FROM search_sessions WHERE rerank_status='queued' AND expires_at>now() AND scope_revision=search_scope_revision(scope_ids,username)`,
    )
    const [run] = await pgQuery<Record<string, unknown>>(
      'SELECT * FROM search_batch_runs ORDER BY created_at DESC LIMIT 1',
    )
    const automaticPublishing = flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED')
      ? ((
          await pgQuery(
            "SELECT status,started_at,deadline,finished_at,error FROM automatic_work_state WHERE kind='search'",
          )
        )[0] ?? null)
      : null
    if (reconcile && run) await reconcileSearchWorker(run)
    if (
      reconcile &&
      run &&
      !run.settled_at &&
      ['completed', 'failed', 'cancelled'].includes(String(run.status))
    ) {
      const settled = await command(String(run.id), 'SETTLE')
      if (['DONE', 'FAILED', 'NOT_FOUND', 'CANCELLED'].includes(settled?.status))
        await pgQuery('UPDATE search_batch_runs SET settled_at=now() WHERE id=$1', [run.id])
    }
    const chain = run ? await pgQuery<SearchRun>(searchUpdateChainSql, [run.id]) : []
    const [automaticQueue] = run?.automatic_photo_ids
      ? await pgQuery<{ pending: number }>(
          "SELECT count(*)::int AS pending FROM search_enrichment WHERE (status='queued' AND attempts<3 OR status='running') AND photo_id=ANY($1::int[])",
          [run.automatic_photo_ids],
        )
      : []
    const plan = chain.length
      ? searchUpdatePlan(chain, Number(automaticQueue?.pending ?? summary?.pending ?? 0))
      : null
    const root = plan
      ? {
          ...plan.root,
          photos_done: plan.photosDone,
          elapsed_ms: plan.photoElapsedMs,
          failures: chain
            .filter((r) => Number(r.photo_limit) > 0)
            .reduce((n, r) => n + Number(r.failures ?? 0), 0),
        }
      : run
    const parent = run && Number(run.photo_limit) === 0 ? root : undefined
    const child = undefined
    const displayRun =
      run && Number(run.photo_limit) > 0 && root
        ? {
            ...root,
            id: run.id,
            status: run.status,
            error: run.error,
            pipeline_error: run.pipeline_error,
            continued_by: run.continued_by,
          }
        : run
    const pipeline = run
      ? searchBatchProgress(displayRun!, parent, child, Number(summary?.pending ?? 0))
      : null
    if (
      pipeline &&
      plan &&
      run?.status === 'completed' &&
      Number(run.photo_limit) > 0 &&
      plan.remaining > 0 &&
      !run.pipeline_error
    ) {
      pipeline.status = 'follow-up pending'
      pipeline.message =
        'Preparing the next photo batch. This update continues automatically, up to three hours.'
      pipeline.active = true
      pipeline.canStop = true
    }
    if (
      pipeline &&
      plan &&
      run?.status === 'failed' &&
      run.error === SEARCH_WORKER_INTERRUPTED &&
      run.automatic_photo_ids &&
      Number(automaticQueue?.pending ?? 0) > 0 &&
      plan.remaining > 0 &&
      plan.deadline - Date.now() >= 90000 &&
      chain.filter((item) => item.status === 'failed' && item.error === SEARCH_WORKER_INTERRUPTED)
        .length <= 3
    ) {
      pipeline.status = 'follow-up pending'
      pipeline.message =
        'Worker interrupted. Automatic recovery is waiting for its retry window and active claims to expire.'
      pipeline.active = true
      pipeline.canStop = true
    }
    return {
      pipeline,
      automaticPublishing,
      warmIdle: !!run?.idle_since && run.status === 'running',
      checkedAt: new Date().toISOString(),
      summary,
      searches,
      run,
      rankingEnabled: flagOn('SEARCH_BATCH_RANKING_ENABLED'),
    }
  })
}
export async function startSearchBatch(username: string, photoLimit: number, searchLimit: number) {
  return withServiceDatabase(() =>
    withAdvisoryLock('search-batch-pipeline', async () => {
      const [active] = await pgQuery<{ id: string }>(
        "SELECT id FROM search_batch_runs WHERE status IN ('starting','running') LIMIT 1",
      )
      const id = active?.id ?? randomUUID()
      if (!active) {
        if (photoLimit > 0) {
          const [queue] = await pgQuery<{ pending: number }>(
            "SELECT count(*)::int AS pending FROM search_enrichment WHERE status IN ('queued','running')",
          )
          photoLimit = Math.max(1, Math.min(photoLimit, Number(queue?.pending ?? 0)))
        }
        if (photoLimit === 0 && searchLimit > 0) await refreshSavedSearches(searchLimit)
        await pgTransaction(async () => {
          await pgQuery(
            'INSERT INTO search_batch_runs(id,requested_by,photo_limit,search_limit) VALUES($1,$2,$3,$4)',
            [id, username, photoLimit, searchLimit],
          )
          // A manual run does not own automatic admission signals. Preserve
          // them until automatic admission, terminal completion, or explicit Stop;
          // otherwise a manual worker crash can silently consume new-upload work.
        })
      }
      // Retry is idempotent; a control timeout must not launch a second worker.
      const chain = await pgQuery<SearchRun>(searchUpdateChainSql, [id])
      await command(id, 'START', searchUpdatePlan(chain, 0).deadline)
      return { id }
    }),
  )
}
export async function stopSearchBatch() {
  const result = await withServiceDatabase(() =>
    withAdvisoryLock('search-batch-pipeline', async () => {
      const [run] = await pgQuery<{ id: string }>(
        `UPDATE search_batch_runs SET status='cancelled',finished_at=now()
       WHERE id=(SELECT id FROM search_batch_runs ORDER BY created_at DESC LIMIT 1)
       AND (status IN ('starting','running') OR (status='completed' AND photo_limit>0 AND continued_by IS NULL)
         OR (status='failed' AND error=$1 AND automatic_photo_ids IS NOT NULL AND continued_by IS NULL))
       RETURNING id`,
        [SEARCH_WORKER_INTERRUPTED],
      )
      const publishingStopped = await stopAutomaticSearch()
      if (!run && !publishingStopped) throw new HttpError(409, 'No search batch is running')
      if (!run) return { stopped: true }
      await command(run.id, 'CANCEL')
      return { stopped: true }
    }),
  )
  if (!result) throw new HttpError(409, 'Search is finishing a stage. Please retry Stop shortly.')
  return result
}

/** Explicit admin retry resumes only the latest failed follow-up, never OCR. */
export async function retrySearchFollowup(id: string) {
  return withServiceDatabase(() =>
    withAdvisoryLock('search-batch-pipeline', async () => {
      const rows = await pgQuery(
        `UPDATE search_batch_runs SET pipeline_error=NULL
         WHERE id=$1 AND id=(SELECT id FROM search_batch_runs ORDER BY created_at DESC LIMIT 1)
         AND status='completed' AND photo_limit>0 AND search_limit>0
         AND continued_by IS NULL AND pipeline_error IS NOT NULL RETURNING id`,
        [id],
      )
      if (!rows.length)
        throw new HttpError(409, 'This follow-up is no longer available to retry. Refresh status.')
      return { id, queued: true }
    }),
  )
}

/** Persist each continuation before submission, so maintenance can recover a lost
 * launch response without creating another job. Launch and Stop paths share a lock; child creation also checks the parent state. */
export async function maintainSearchBatch() {
  return withServiceDatabase(() =>
    withAdvisoryLock('search-batch-pipeline', async () => {
      await pgQuery(pruneExpiredSearchSessionsSql)
      let [run] = await pgQuery<SearchRun>(
        'SELECT * FROM search_batch_runs ORDER BY created_at DESC LIMIT 1',
      )
      if (run) await reconcileSearchWorker(run)
      if (flagOn('AUTOMATIC_MEDIA_PROCESSING_ENABLED')) {
        // Recover the admitted snapshot before new signals can supersede it.
        const recovery = run ? await recoverAutomaticOcr(run) : undefined
        if (recovery?.run) run = recovery.run
        else if (recovery?.pending) return searchBatchStatus(true)
        const active = run && ['starting', 'running'].includes(run.status)
        if (!active || run.automatic_photo_ids) {
          const admitted = await admitAutomaticOcr(run)
          if (admitted) run = admitted
        }
      }
      if (!run) return
      const chain = await pgQuery<SearchRun>(searchUpdateChainSql, [run.id])
      const [queue] = await pgQuery<{ pending: number }>(
        run.automatic_photo_ids
          ? "SELECT count(*)::int AS pending FROM search_enrichment WHERE status='queued' AND attempts<3 AND photo_id=ANY($1::int[])"
          : "SELECT count(*)::int AS pending FROM search_enrichment WHERE status='queued' AND attempts<3",
        run.automatic_photo_ids ? [run.automatic_photo_ids] : undefined,
      )
      const plan = searchUpdatePlan(chain, Number(queue?.pending ?? 0))
      if (['cancelled', 'failed'].includes(run.status) || run.pipeline_error)
        return searchBatchStatus(true)
      if (plan.expired || plan.deadline - Date.now() < 90000) {
        if (
          ['starting', 'running'].includes(run.status) ||
          (run.status === 'completed' &&
            run.photo_limit > 0 &&
            !run.continued_by &&
            (plan.remaining > 0 || Number(run.search_limit) > 0))
        ) {
          await pgQuery(
            "UPDATE search_batch_runs SET status='cancelled',error='Three-hour search update limit reached. Completed work is saved; remaining work stays queued.',finished_at=now() WHERE id=$1",
            [run.id],
          )
          await command(run.id, 'CANCEL')
        }
        return searchBatchStatus(true)
      }
      if (run.status === 'starting') {
        await command(run.id, 'START', plan.deadline)
        return
      }
      if (run.status !== 'completed' || Number(run.photo_limit) === 0 || run.continued_by)
        return searchBatchStatus(true)
      let stage = 'Search continuation'
      const signal = AbortSignal.timeout(Math.max(1, plan.deadline - Date.now()))
      try {
        const photoLimit = plan.remaining
        if (photoLimit === 0 && Number(run.search_limit) === 0) return searchBatchStatus(true)
        if (photoLimit === 0) {
          stage = 'Search publishing'
          const pending = await pgQuery('SELECT 1 FROM search_queue LIMIT 1')
          if (pending.length) {
            const synced = await (await import('./search-sync')).syncSearch({ force: true, signal })
            if (!synced || synced.remaining > 0) return
          }
          stage = 'Saved-search ranking preparation'
          await refreshSavedSearches(Number(run.search_limit), signal)
        }
        if (Date.now() >= plan.deadline - 90000) return
        const id = randomUUID()
        // One statement: no crash window between recording the child and linking it.
        const [child] = await pgQuery<{ id: string }>(searchUpdateChildSql, [
          id,
          run.requested_by,
          photoLimit,
          run.search_limit,
          run.id,
        ])
        if (child) await command(child.id, 'START', plan.deadline)
        return child
      } catch (error) {
        if (signal.aborted) {
          await pgQuery(
            "UPDATE search_batch_runs SET status='cancelled',error='Three-hour search update limit reached. Completed work is saved; remaining work stays queued.',finished_at=now() WHERE id=$1 AND continued_by IS NULL",
            [run.id],
          )
          return
        }
        // A durably created child is recovered by the starting-state branch above.
        const code = String((error as { code?: unknown })?.code ?? '')
        const detail = /^[A-Z0-9]{5}$/.test(code) ? ` (${code})` : ''
        await pgQuery(
          'UPDATE search_batch_runs SET pipeline_error=$2 WHERE id=$1 AND continued_by IS NULL',
          [
            run.id,
            `${stage} failed${detail}; automatic retry stopped. Completed work is saved. Retry the follow-up after resolving the error.`,
          ],
        )
        throw error
      }
    }),
  )
}

/** Consume only committed NEW-source signals. Infrastructure recovery separately
 * retains its admitted snapshot; terminal failures and Stop do not rearm backlog. */
async function admitAutomaticOcr(latest?: SearchRun): Promise<SearchRun | undefined> {
  const signals = await listAutomaticWork('ocr')
  if (!signals.length) return
  const active = latest && ['starting', 'running'].includes(latest.status) ? latest : undefined
  if (latest?.status === 'completed' && latest.photo_limit > 0 && !latest.continued_by) {
    const chain = await pgQuery<SearchRun>(searchUpdateChainSql, [latest.id])
    const [pending] = await pgQuery<{ pending: number }>(
      latest.automatic_photo_ids
        ? "SELECT count(*)::int AS pending FROM search_enrichment WHERE status='queued' AND attempts<3 AND photo_id=ANY($1::int[])"
        : "SELECT count(*)::int AS pending FROM search_enrichment WHERE status='queued' AND attempts<3",
      latest.automatic_photo_ids ? [latest.automatic_photo_ids] : undefined,
    )
    if (
      searchUpdatePlan(chain, Number(pending?.pending ?? 0)).remaining > 0 ||
      latest.search_limit > 0
    )
      return
  }
  if (active) {
    const chain = await pgQuery<SearchRun>(searchUpdateChainSql, [active.id])
    if (searchUpdatePlan(chain, 0).deadline - Date.now() < 90000) return
  }
  return pgTransaction(async () => {
    if (
      active &&
      !(
        await pgQuery(
          "SELECT id FROM search_batch_runs WHERE id=$1 AND status IN ('starting','running') FOR UPDATE",
          [active.id],
        )
      ).length
    )
      return
    // Signals retained across a manual worker crash may still own a live
    // claim. Do not steal it or acknowledge it before it can be admitted.
    await pgQuery(
      `UPDATE search_enrichment SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
       claim_token=NULL,lease_until=NULL WHERE photo_id=ANY($1::int[])
       AND status='running' AND lease_until<=now()`,
      [signals.map((signal) => signal.sourceId)],
    )
    const live = await pgQuery<{ photo_id: number }>(
      `SELECT photo_id FROM search_enrichment WHERE photo_id=ANY($1::int[])
       AND status='running'`,
      [signals.map((signal) => signal.sourceId)],
    )
    const liveIds = new Set(live.map((row) => Number(row.photo_id)))
    const eligible = await pgQuery<{ photo_id: number }>(
      `SELECT q.photo_id FROM search_enrichment q JOIN photos p USING(photo_id)
      WHERE q.photo_id=ANY($1::int[]) AND q.status='queued' AND q.attempts<3 AND p.ingest_status='READY'
      AND p.media_type='photo' AND p.original_stage_path=q.source_path FOR UPDATE OF q`,
      [signals.map((s) => s.sourceId)],
    )
    await acknowledgeAutomaticWork(
      'ocr',
      signals.filter((signal) => !liveIds.has(signal.sourceId)),
    )
    if (!eligible.length) return
    const ids = eligible.map((r) => Number(r.photo_id))
    if (active) {
      const [updated] = await pgQuery<SearchRun>(
        `UPDATE search_batch_runs
        SET automatic_photo_ids=(SELECT array_agg(DISTINCT n) FROM unnest(automatic_photo_ids||$2::int[]) n),
        photo_limit=LEAST(100000,photo_limit+$3)
        WHERE id=$1 AND status IN ('starting','running') RETURNING *`,
        [active.id, ids, ids.length],
      )
      const chain = await pgQuery<SearchRun>(searchUpdateChainSql, [active.id])
      const root = chain.at(-1)
      if (root && root.id !== active.id)
        await pgQuery(
          `UPDATE search_batch_runs SET photo_limit=LEAST(100000,photo_limit+$2)
        WHERE id=$1`,
          [root.id, ids.length],
        )
      return updated
    }
    const [created] = await pgQuery<SearchRun>(
      `INSERT INTO search_batch_runs(id,requested_by,photo_limit,search_limit,automatic_photo_ids)
      VALUES($1,'automatic', $2,0,$3) RETURNING *`,
      [randomUUID(), ids.length, ids],
    )
    return created
  })
}
