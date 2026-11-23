import { HttpError } from '../http'

type Client = { release: () => void }
type Pool<T extends Client> = { waitingCount: number; connect: () => Promise<T> }
function limit(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < 1 || value > 60000) throw Error(`Invalid ${name}`)
  return value
}

/** Bound request queueing; a late connection must always be returned to its pool. */
export function acquireDatabaseClient<T extends Client>(
  pool: Pool<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'))
  if (pool.waitingCount >= limit('PG_MAX_PENDING_CHECKOUTS', 1024))
    return Promise.reject(new HttpError(503, 'Database is busy; retry shortly', 1))
  const timeout = limit('PG_CHECKOUT_TIMEOUT_MS', 10000)
  return new Promise((resolve, reject) => {
    let done = false
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => {
      if (done) return
      done = true
      finish()
      reject(error)
    }
    const abort = () => fail(new DOMException('Request aborted', 'AbortError'))
    const timer = setTimeout(
      () => fail(new HttpError(503, 'Database is busy; retry shortly', 1)),
      timeout,
    )
    signal?.addEventListener('abort', abort, { once: true })
    pool.connect().then(
      (client) => {
        if (done) {
          client.release()
          return
        }
        done = true
        finish()
        resolve(client)
      },
      (error) => fail(error),
    )
  })
}
