import { randomUUID } from 'node:crypto'
import { pgIndependent } from '../postgres'
import { costContext } from './cost-context'

export type CostWeights = Record<string, number>
export function ownerWeights(rows: Record<string, unknown>[]): CostWeights {
  const weights: CostWeights = {}
  for (const row of rows) {
    const owner = String(row.owner_username ?? '')
    if (!owner) continue
    // Text bytes are a proxy for processing/embedding work, not a token count.
    const units = Math.max(1, Number(row.cost_units) || Buffer.byteLength(JSON.stringify(row)))
    weights[owner] = (weights[owner] ?? 0) + units
  }
  return weights
}
/** Durable before executing: errors/retries can also incur cost. No identities in query tags. */
export async function costWork<T>(
  category: 'search_ai' | 'photo_ai' | 'video_ai' | 'search_indexing' | 'warehouse',
  owners: CostWeights,
  fn: () => Promise<T>,
  service?: string,
  phase: 'merge' | 'refresh' = 'merge',
): Promise<T> {
  const id = randomUUID()
  await pgIndependent('INSERT INTO cost_work(id,category,owners) VALUES($1,$2,$3::jsonb)', [
    id,
    category,
    JSON.stringify(owners),
  ])
  const result = await costContext.run(id, fn)
  if (service)
    for (const [owner, units] of Object.entries(owners))
      await pgIndependent(
        'INSERT INTO cost_index_weights(work_id,service,username,units,phase) VALUES($1,$2,$3,$4,$5)',
        [id, service, owner, Math.max(1, Math.round(units)), phase],
      )
  return result
}
