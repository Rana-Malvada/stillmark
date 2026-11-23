export class ConnectionWaitTimeoutError extends Error {
  constructor() {
    super('Authentication connection wait timed out')
  }
}

/** Bound acquisition only; never execute abandoned work or replay a statement. */
export function useConnectionWithDeadline<C, R>(
  pool: {
    acquire(): Promise<C>
    release(connection: C): Promise<unknown>
    destroy(connection: C): Promise<unknown>
  },
  work: (connection: C) => Promise<R>,
  waitMs: number,
  signal?: AbortSignal,
): Promise<R> {
  signal?.throwIfAborted()
  if (!Number.isFinite(waitMs) || waitMs <= 0) throw new Error('Invalid connection deadline')
  return new Promise<R>((resolve, reject) => {
    let expired = false
    const abort = () => {
      expired = true
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const timer = setTimeout(() => {
      expired = true
      cleanup()
      reject(new ConnectionWaitTimeoutError())
    }, waitMs)
    signal?.addEventListener('abort', abort, { once: true })
    void pool
      .acquire()
      .then(async (connection) => {
        cleanup()
        if (expired) {
          // The SDK cannot cancel a pending acquisition. Return a late connection
          // to its original pool without executing the abandoned request.
          await pool.release(connection)
          return
        }
        let result: R
        try {
          result = await work(connection)
        } catch (error) {
          await pool.destroy(connection)
          throw error
        }
        await pool.release(connection)
        resolve(result)
      })
      .catch((error) => {
        cleanup()
        reject(error)
      })
  })
}
