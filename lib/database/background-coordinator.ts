import { randomUUID } from 'node:crypto'
import { withServiceDatabase } from './database-context'
import { pgQueryOne } from '../postgres'

export const acquireCoordinatorSql = `INSERT INTO background_coordinator(name,owner,lease_until)
 VALUES('application-background',$1,NOW()+INTERVAL '30 seconds')
 ON CONFLICT(name) DO UPDATE SET owner=EXCLUDED.owner,lease_until=EXCLUDED.lease_until
 WHERE background_coordinator.owner=EXCLUDED.owner OR background_coordinator.lease_until<NOW()
 RETURNING owner`

/** Web replicas elect one polling coordinator. Existing job locks/leases still
 * protect in-flight work during leadership changes; no session connection is held. */
export function startBackgroundCoordinator(onLease: (leader: boolean) => Promise<void>) {
  const owner = randomUUID()
  let validUntil = 0
  let checking = false
  const tick = async () => {
    if (checking) return
    checking = true
    const started = performance.now()
    try {
      const row = await withServiceDatabase(() => pgQueryOne(acquireCoordinatorSql, [owner]))
      // Local validity is deliberately shorter than the database lease, including
      // time spent waiting on the DB. A failed renewal stops new dispatches.
      validUntil = row ? started + 20000 : 0
    } catch {
      validUntil = 0
      console.error('[background-coordinator] Renewal failed')
    } finally {
      checking = false
    }
    try {
      await onLease(performance.now() < validUntil)
    } catch (error) {
      console.error('[background-coordinator] Listener setup failed', error)
    }
  }
  void tick()
  setInterval(tick, 10000).unref()
  return () => performance.now() < validUntil
}
