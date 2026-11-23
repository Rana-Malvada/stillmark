import { costDay } from './cost-timezone'

export interface CostRefreshProgress {
  runId?: string
  status?: 'running' | 'completed' | 'interrupted' | 'failed'
  error?: string
  startedAt: string
  updatedAt: string
  sources: { key: string; label: string; status: 'waiting' | 'running' | 'complete' | 'failed' }[]
}
export interface CachedCostSection {
  key: string
  label: string
  rows: Record<string, unknown>[]
  error: string | null
  stale?: boolean
  lastSuccessAt?: string
}
/** Preserve the last successful measurement, including a genuine empty result. */
export function retainCostSection(
  current: CachedCostSection,
  previous: CachedCostSection | undefined,
  previousAsOf?: string,
): CachedCostSection {
  if (!current.error || !previous || previous.error) return current
  const cutoff = new Date(costDay(new Date().toISOString()) + 'T00:00:00Z')
  cutoff.setUTCDate(cutoff.getUTCDate() - 29)
  const firstDay = cutoff.toISOString().slice(0, 10)
  return {
    ...current,
    rows: previous.rows.filter((row) => !row.DAY || String(row.DAY).slice(0, 10) >= firstDay),
    error: null,
    stale: true,
    lastSuccessAt: previous.lastSuccessAt ?? previousAsOf,
  }
}
