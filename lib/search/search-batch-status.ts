/** Browser-facing processing status. Database run columns stay on the server. */
export interface SearchBatchStatus {
  summary: { pending: number; running: number; completed: number; failed: number }
  searches: { pending: number }
  run?: { status: string } | null
  warmIdle: boolean
  checkedAt: string
  rankingEnabled: boolean
  automaticPublishing: { status: string; error: string | null } | null
  pipeline: {
    rootId: string
    status: string
    message: string
    active: boolean
    canStop: boolean
    canRetryFollowup: boolean
    stage: number
    photoLimit: number
    photosDone: number
    searchesDone: number
    failures: number
  } | null
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
export function isSearchBatchStatus(value: unknown): value is SearchBatchStatus {
  if (!record(value) || !record(value.summary) || !record(value.searches)) return false
  const { summary, searches, run, pipeline, automaticPublishing } = value
  return (
    ['pending', 'running', 'completed', 'failed'].every((key) => count(summary[key])) &&
    count(searches.pending) &&
    typeof value.warmIdle === 'boolean' &&
    typeof value.checkedAt === 'string' &&
    typeof value.rankingEnabled === 'boolean' &&
    (run == null || (record(run) && typeof run.status === 'string')) &&
    (automaticPublishing === null ||
      (record(automaticPublishing) &&
        typeof automaticPublishing.status === 'string' &&
        (automaticPublishing.error === null || typeof automaticPublishing.error === 'string'))) &&
    (pipeline === null ||
      (record(pipeline) &&
        ['rootId', 'status', 'message'].every((key) => typeof pipeline[key] === 'string') &&
        ['active', 'canStop', 'canRetryFollowup'].every(
          (key) => typeof pipeline[key] === 'boolean',
        ) &&
        ['photoLimit', 'photosDone', 'searchesDone', 'failures'].every((key) =>
          count(pipeline[key]),
        ) &&
        [0, 1, 2].includes(pipeline.stage as number)))
  )
}
