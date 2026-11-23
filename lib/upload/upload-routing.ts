import { pgQuery, pgQueryOne, pgTransaction, withAdvisoryLock } from '../postgres'
import { withServiceDatabase } from '../database/database-context'
import { uploadPoolStep } from './upload-routing-control'
import { HttpError } from '../http'

const WORKER_IDLE_MS = 15 * 60 * 1000
export type UploadMode = 'pool'
export type UploadRoutingState = {
  desired: UploadMode
  route: UploadMode
  phase: 'pool' | 'resuming' | 'suspending' | 'suspended' | 'error'
  error: string | null
  updated_at: string
  last_activity_at: string
  enabled: boolean
  active: number
  oldest: string | null
}
export async function uploadRoutingStatus() {
  return withServiceDatabase(async () => {
    const state = await pgQueryOne<UploadRoutingState>(`SELECT r.*,
      ((SELECT count(*) FROM upload_pool_requests)+(SELECT count(*) FROM upload_processing_jobs WHERE state IN ('queued','processing')))::int AS active,
      (SELECT min(started_at) FROM upload_pool_requests) AS oldest FROM upload_routing r WHERE id=true`)
    if (!state) throw new Error('Upload routing is not initialized')
    return { ...state, enabled: state.enabled && process.env.UPLOAD_ROUTING_MANAGED === 'true' }
  })
}
/** The current routing phase for a signed-in uploader, or null before routing is initialized. */
export async function readUploadRoutingPhase(): Promise<string | null> {
  const state = await pgQueryOne<{ phase: string }>(
    'SELECT phase FROM upload_routing WHERE id=true',
  )
  return state?.phase ?? null
}
/** Authenticated upload intent, never a GET side effect. Serialized with lifecycle DDL. */
export async function requestUploadMode(mode: UploadMode, username: string) {
  if (mode !== 'pool') throw new HttpError(400, 'Uploads require the compute pool')
  return withServiceDatabase(async () => {
    const result = await withAdvisoryLock('upload-routing-controller', async () => {
      const state = await uploadRoutingStatus()
      if (!state.enabled) throw new HttpError(503, 'Upload service management is unavailable', 5)
      await pgTransaction(async () => {
        await pgQuery(
          "SELECT pg_advisory_xact_lock(hashtextextended('upload-routing-admission',0))",
        )
        await pgQuery(
          `UPDATE upload_routing SET desired='pool',route='pool',
          phase=CASE WHEN phase='pool' THEN 'pool' ELSE 'resuming' END,
          last_activity_at=now(),error=NULL,requested_by=$1,updated_at=now() WHERE id=true`,
          [username],
        )
      })
      return uploadRoutingStatus()
    })
    if (!result) throw new HttpError(409, 'Upload service is changing state; retry shortly', 2)
    return result
  })
}
export async function maintainUploadRouting() {
  if (process.env.UPLOAD_ROUTING_MANAGED !== 'true') return
  return withServiceDatabase(async () => {
    const state = await uploadRoutingStatus()
    if (!state.enabled || state.phase === 'error') return
    if (state.phase === 'suspended' && !state.active) return
    if (
      state.phase === 'pool' &&
      (state.active || Date.now() - new Date(state.last_activity_at).getTime() < WORKER_IDLE_MS)
    )
      return
    return withAdvisoryLock('upload-routing-controller', async () => {
      // Exclusive admission lock makes the final idle check and fencing atomic
      // against both HTTP requests and queue workers. No lock is held over DDL.
      const latest = await pgTransaction(async () => {
        await pgQuery(
          "SELECT pg_advisory_xact_lock(hashtextextended('upload-routing-admission',0))",
        )
        const r = await uploadRoutingStatus()
        if (!r.enabled || r.phase === 'error') return null
        if (r.active && ['suspended', 'suspending'].includes(r.phase)) {
          await pgQuery("UPDATE upload_routing SET phase='resuming',updated_at=now() WHERE id=true")
          r.phase = 'resuming'
          r.updated_at = new Date().toISOString()
        }
        if (r.phase === 'pool') {
          if (r.active || Date.now() - new Date(r.last_activity_at).getTime() < WORKER_IDLE_MS)
            return null
          await pgQuery(
            "UPDATE upload_routing SET phase='suspending',updated_at=now() WHERE id=true",
          )
          r.phase = 'suspending'
          r.updated_at = new Date().toISOString()
        }
        return r
      })
      if (!latest || latest.phase === 'suspended') return
      try {
        if (Date.now() - new Date(latest.updated_at).getTime() > 20 * 60 * 1000)
          throw new Error('Upload infrastructure transition timed out')
        const suspending = latest.phase === 'suspending'
        if (await uploadPoolStep(suspending ? 'suspend' : 'pool'))
          await pgQuery(
            `UPDATE upload_routing SET phase=$1,error=NULL,updated_at=now(),
            last_activity_at=CASE WHEN $1='pool' THEN now() ELSE last_activity_at END WHERE id=true`,
            [suspending ? 'suspended' : 'pool'],
          )
      } catch (error) {
        console.error('[upload-routing]', error)
        await pgQuery(
          "UPDATE upload_routing SET phase='error',error=$1,updated_at=now() WHERE id=true",
          ['The upload service needs attention. Retry starting it.'],
        )
      }
    })
  })
}
