import { deployment } from '../../config/deployment.mjs'
import type { CostSection } from './personal-costs'

/** Exact production resources; never include account-wide or load-test pool totals. */
export const COST_POOLS = [
  {
    key: 'gpu',
    label: 'GPU video conversion',
    pools: [deployment.GPU_POOL, deployment.LEGACY_GPU_POOL],
  },
  {
    key: 'faces',
    label: 'Face recognition and search batches',
    pools: [deployment.FACE_POOL, deployment.SEARCH_POOL],
  },
  { key: 'uploads', label: 'Upload processing', pools: ['PERSONAL_PHOTOS_UPLOAD_CPU'] },
] as const

export function productionPoolSection(source: CostSection | undefined, key: string) {
  if (!source) return undefined
  const allowed: readonly string[] = COST_POOLS.find((pool) => pool.key === key)?.pools ?? []
  // Old aggregate snapshots without resource identity cannot be safely allocated.
  if (source.rows.some((row) => !(row.COMPUTE_POOL_NAME ?? row.compute_pool_name))) return undefined
  return {
    ...source,
    rows: source.rows.filter((row) =>
      allowed.includes(String(row.COMPUTE_POOL_NAME ?? row.compute_pool_name)),
    ),
  }
}
