import { randomUUID } from 'node:crypto'
import { pgQuery, pgTransaction } from '../postgres'
import { type SearchRun, searchUpdateChainSql, searchUpdatePlan } from './search-update'

export const SEARCH_WORKER_INTERRUPTED = 'Worker interrupted; automatic recovery pending'
const MAX_RECOVERIES = 3

/** The launch advisory lock is held by the caller. Failed infrastructure work is
 * a continuation of its admitted snapshot, never a new admission or retry budget. */
export async function recoverAutomaticOcr(latest: SearchRun) {
  if (
    latest.status !== 'failed' ||
    latest.error !== SEARCH_WORKER_INTERRUPTED ||
    !latest.automatic_photo_ids ||
    latest.continued_by
  )
    return { pending: false }
  return pgTransaction(async () => {
    const [run] = await pgQuery<SearchRun>(
      `SELECT * FROM search_batch_runs WHERE id=$1 AND status='failed' AND error=$2
       AND continued_by IS NULL
       AND id=(SELECT id FROM search_batch_runs ORDER BY created_at DESC LIMIT 1)
       FOR UPDATE`,
      [latest.id, SEARCH_WORKER_INTERRUPTED],
    )
    if (!run) return { pending: false }
    const chain = await pgQuery<SearchRun>(searchUpdateChainSql, [run.id])
    const failures = chain.filter(
      (item) => item.status === 'failed' && item.error === SEARCH_WORKER_INTERRUPTED,
    ).length
    const plan = searchUpdatePlan(chain, run.photo_limit)
    if (failures > MAX_RECOVERIES || plan.deadline - Date.now() < 90000) return { pending: false }
    const [unfinished] = await pgQuery<{ pending: number; live: number }>(
      `SELECT count(*) FILTER(WHERE status IN ('queued','running') AND attempts<3)::int AS pending,
       count(*) FILTER(WHERE status='running' AND lease_until>now())::int AS live
       FROM search_enrichment WHERE photo_id=ANY($1::int[])`,
      [run.automatic_photo_ids],
    )
    // Reclaim only expired claims, without resetting their finite attempt count.
    await pgQuery(
      `UPDATE search_enrichment SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
       claim_token=NULL,lease_until=NULL WHERE photo_id=ANY($1::int[])
       AND status='running' AND lease_until<=now()`,
      [run.automatic_photo_ids],
    )
    if (!unfinished?.pending && !unfinished?.live) return { pending: false }
    const retryAt =
      new Date(run.finished_at ?? run.heartbeat_at).getTime() + 30000 * 2 ** (failures - 1)
    if (unfinished.live || Date.now() < retryAt) return { pending: true }
    const [queue] = await pgQuery<{ pending: number }>(
      `SELECT count(*)::int AS pending FROM search_enrichment
       WHERE photo_id=ANY($1::int[]) AND status='queued' AND attempts<3`,
      [run.automatic_photo_ids],
    )
    const remaining = searchUpdatePlan(chain, Number(queue?.pending ?? 0)).remaining
    if (!remaining) return { pending: false }
    const [child] = await pgQuery<SearchRun>(
      `WITH child AS (
         INSERT INTO search_batch_runs(id,requested_by,photo_limit,search_limit,automatic_photo_ids)
         SELECT $1,requested_by,$2,search_limit,automatic_photo_ids FROM search_batch_runs
         WHERE id=$3 AND status='failed' AND error=$4 AND continued_by IS NULL RETURNING *
       ), linked AS (
         UPDATE search_batch_runs SET continued_by=child.id,pipeline_error=NULL FROM child
         WHERE search_batch_runs.id=$3 RETURNING child.id
       ) SELECT child.* FROM child JOIN linked USING(id)`,
      [randomUUID(), remaining, run.id, SEARCH_WORKER_INTERRUPTED],
    )
    return { pending: !!child, run: child }
  })
}
