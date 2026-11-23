/** One deadline for the complete admin-requested update, including continuations. */
export const SEARCH_UPDATE_MAX_MS = 3 * 60 * 60 * 1000
export interface SearchRun {
  id: string
  requested_by: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'
  photo_limit: number
  search_limit: number
  photos_done: number
  searches_done: number
  failures: number
  elapsed_ms: number | string | null
  created_at: string | Date
  heartbeat_at: string | Date
  finished_at: string | Date | null
  settled_at: string | Date | null
  idle_since: string | Date | null
  continued_by: string | null
  pipeline_error: string | null
  error: string | null
  automatic_photo_ids: number[] | null
}
type SearchPlanRun = Pick<SearchRun, 'created_at' | 'photo_limit'> &
  Partial<Pick<SearchRun, 'photos_done' | 'elapsed_ms'>>
function nonnegativeCount(value: unknown, name: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid search update ${name}`)
  return number
}
export function searchUpdatePlan<T extends SearchPlanRun>(
  chain: T[],
  pending: number,
  now = Date.now(),
) {
  if (!chain.length) throw new Error('Missing search update chain')
  const root = chain[chain.length - 1]
  const photosDone = chain.reduce(
    (n, run) => n + nonnegativeCount(run.photos_done ?? 0, 'completed count'),
    0,
  )
  const deadline = new Date(root.created_at).getTime() + SEARCH_UPDATE_MAX_MS
  if (!Number.isFinite(deadline) || !Number.isFinite(now))
    throw new Error('Invalid search update deadline')
  const photoLimit = nonnegativeCount(root.photo_limit, 'photo limit')
  const pendingCount = nonnegativeCount(pending, 'pending count')
  return {
    root,
    deadline,
    expired: now >= deadline,
    photosDone,
    photoElapsedMs: chain.reduce(
      (n, run) =>
        n +
        (Number(run.photo_limit) > 0 ? nonnegativeCount(run.elapsed_ms ?? 0, 'elapsed time') : 0),
      0,
    ),
    remaining: Math.max(0, Math.min(pendingCount, photoLimit - photosDone)),
  }
}
export const searchUpdateChainSql = `WITH RECURSIVE chain AS (
  SELECT * FROM search_batch_runs WHERE id=$1
  UNION ALL
  SELECT parent.* FROM search_batch_runs parent JOIN chain child ON parent.continued_by=child.id
) SELECT * FROM chain ORDER BY created_at DESC`

export const searchUpdateChildSql = `WITH child AS (
  INSERT INTO search_batch_runs(id,requested_by,photo_limit,search_limit,automatic_photo_ids)
  SELECT $1,$2,$3,$4,automatic_photo_ids FROM search_batch_runs
  WHERE id=$5 AND status='completed' AND continued_by IS NULL
    AND id=(SELECT id FROM search_batch_runs ORDER BY created_at DESC LIMIT 1)
  RETURNING id
) UPDATE search_batch_runs SET continued_by=child.id,pipeline_error=NULL FROM child
  WHERE search_batch_runs.id=$5 RETURNING child.id`
