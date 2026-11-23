import { uploadQueuePool } from '@/lib/upload/upload-queue-database'
import { pgAuthEpoch } from '@/lib/postgres'
import { flagNotOff, flagOn } from '@/lib/flags'

export const dynamic = 'force-dynamic'
let checkedAt = 0
let checking: Promise<void> | undefined
export async function GET() {
  if (flagOn('UPLOAD_PROCESSING_QUEUE_ENABLED') && flagNotOff('UPLOAD_PROCESSING_WORKER_ENABLED')) {
    try {
      if (Date.now() - checkedAt > 5000) {
        checking ??= Promise.all([
          uploadQueuePool().query('SELECT lease_token FROM upload_processing_jobs LIMIT 0'),
          uploadQueuePool().query('SELECT route FROM upload_routing WHERE id=true'),
          pgAuthEpoch(),
        ])
          .then(([, routing]) => {
            if (routing.rows.length !== 1 || !['app', 'pool'].includes(routing.rows[0].route))
              throw Error('Routing is not initialized')
            checkedAt = Date.now()
          })
          .finally(() => {
            checking = undefined
          })
        await checking
      }
    } catch {
      return Response.json({ status: 'unavailable' }, { status: 503 })
    }
  }
  return Response.json({ status: 'ready' })
}
