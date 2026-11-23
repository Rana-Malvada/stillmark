import { randomUUID } from 'node:crypto'
import { pgQuery, pgQueryOne, pgTransaction } from '../postgres'
import { HttpError } from '../http'
import { databaseContext } from '../database/database-context'

/** Short, shared lock: concurrent workers do not serialize one another. The
 * controller takes the exclusive counterpart only while closing admission. */
export async function withUploadPoolAdmission<T>(owner: string, work: () => Promise<T>) {
  if (process.env.UPLOAD_SERVICE_ONLY !== 'true')
    throw new HttpError(503, 'Uploads require the separate upload service', 5)
  if (process.env.UPLOAD_ROUTING_MANAGED !== 'true') return work()
  const id = randomUUID()
  const requestContext = databaseContext.getStore()
  let admitted = false
  try {
    await pgTransaction(async () => {
      await pgQuery(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('upload-routing-admission',0)),pg_advisory_xact_lock(hashtextextended($1,0))",
        [id],
      )
      const state = await pgQueryOne<{ route: string; phase: string }>(
        'SELECT route,phase FROM upload_routing WHERE id=true',
      )
      if (state?.route !== 'pool' || state.phase !== 'pool')
        throw new HttpError(503, 'Upload routing changed; retry shortly', 2)
      await pgQuery('INSERT INTO upload_pool_requests(id,owner) VALUES($1,$2)', [id, owner])
    })
    admitted = true
    return await work()
  } finally {
    // Never expire a live request just because it is slow. An unclean worker exit
    // leaves a durable blocker requiring investigation rather than unsafe suspend.
    try {
      const remove = () =>
        pgQuery('DELETE FROM upload_pool_requests WHERE id=$1 AND owner=$2', [id, owner])
      const release = () =>
        admitted
          ? remove()
          : pgTransaction(async () => {
              // A lost COMMIT response is ambiguous. Wait for registration to finish,
              // then DELETE in a fresh statement snapshot; never replay admission/work.
              await pgQuery('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id])
              return remove()
            })
      // Cleanup must outlive a disconnected HTTP caller. Keep the exact verified
      // request identity and app credential/RLS, with a separate short deadline.
      // Only release after work settles, never while a stage write is still live.
      if (requestContext?.kind === 'request')
        await databaseContext.run({ ...requestContext, signal: AbortSignal.timeout(5000) }, release)
      else await release()
    } catch (error) {
      console.error('[upload-drain-release]', error)
    }
  }
}
