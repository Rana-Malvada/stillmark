import { setTimeout as delay } from 'node:timers/promises'
import { runWithSignal } from 'snowflake-sdk/dist/lib/http/stillmark_deadline'
import { ConnectionWaitTimeoutError } from './connection-deadline'
import { uploadTraceCount } from './upload/upload-request-trace'

type Pool<C> = { acquire(): Promise<C>; release(connection: C): Promise<unknown> }

/** Cancel a stalled login transport; never hand a late connection to abandoned work. */
function attempt<C>(pool: Pool<C>, milliseconds: number): Promise<C> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let expired = false
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
      // Let the SDK reject its original waiter before another borrower is added.
      // Its factory-error handler drains queued waiters, including new ones.
      cleanupTimer = setTimeout(() => reject(new ConnectionWaitTimeoutError()), 100)
    }, milliseconds)
    Promise.resolve()
      .then(() => runWithSignal(controller.signal, () => pool.acquire()))
      .then(async (connection) => {
        clearTimeout(timer)
        clearTimeout(cleanupTimer)
        if (expired) {
          reject(new ConnectionWaitTimeoutError())
          await pool.release(connection)
          return
        }
        resolve(connection)
      })
      .catch((error) => {
        clearTimeout(timer)
        clearTimeout(cleanupTimer)
        reject(expired ? new ConnectionWaitTimeoutError() : error)
      })
  })
}

/** Only connection acquisition is retried. No SQL has run at this point. */
export async function acquireRoleConnection<C>(pool: Pool<C>): Promise<C> {
  const deadline = Date.now() + 5000
  try {
    return await attempt(pool, 4000)
  } catch (error) {
    // The pinned SDK patch preserves only the HTTP status and error code. Retry
    // only its explicit service-unavailable response, never an OAuth denial or
    // an ambiguous message. No connection has been returned and no SQL ran.
    const unavailable =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 401002 &&
      'snowflakeHttpStatus' in error &&
      error.snowflakeHttpStatus === 503
    if (!(error instanceof ConnectionWaitTimeoutError) && !unavailable) throw error
    if (unavailable) {
      uploadTraceCount('role-connect-unavailable-retry')
      await delay(100)
    }
    uploadTraceCount('role-connect-retry')
    const remaining = deadline - Date.now() - 100 // reserve transport cleanup grace
    if (remaining <= 0) throw new ConnectionWaitTimeoutError()
    return attempt(pool, remaining)
  }
}
