import { databaseContext, databaseSignal } from '../database/database-context'

export const MEDIA_SIGNING_TIMEOUT_MS = 30_000
type Item = {
  expression: string
  settled: boolean
  resolve: (url: string) => void
  reject: (error: unknown) => void
  batch?: { controller: AbortController; items: Item[] }
}

/** Coalesce cold misses without changing per-request authorization or URL caching.
 * Four statements reserve headroom in the storage pool for upload writes.
 * The queue is bounded; failed batches reject all callers and remain retryable. */
export class MediaSigningBatch {
  private queue: Item[] = []
  private active = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly query: (sql: string) => Promise<Record<string, unknown>[]>,
    private readonly timeoutMs = MEDIA_SIGNING_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw Error('Invalid signing deadline')
  }

  sign(expression: string, signal = databaseSignal()): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.queue.length >= 4096) return Promise.reject(new Error('Media signing queue is full'))
    const result = new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        item.settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      const cancel = (error: unknown) => {
        if (item.settled) return
        cleanup()
        const queued = this.queue.indexOf(item)
        if (queued >= 0) this.queue.splice(queued, 1)
        reject(error)
        // Cancel shared SQL only after its last interested caller has left.
        if (item.batch?.items.every((entry) => entry.settled)) item.batch.controller.abort(error)
      }
      const abort = () => cancel(signal?.reason)
      const item: Item = {
        expression,
        settled: false,
        resolve: (url) => {
          if (item.settled) return
          cleanup()
          resolve(url)
        },
        reject: (error) => {
          if (item.settled) return
          cleanup()
          reject(error)
        },
      }
      const timer = setTimeout(
        () => cancel(new DOMException('Media signing deadline exceeded', 'TimeoutError')),
        this.timeoutMs,
      )
      timer.unref?.()
      this.queue.push(item)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
    this.schedule()
    return result
  }

  private schedule() {
    if (this.timer || !this.queue.length || this.active >= 4) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      while (this.queue.length && this.active < 4) void this.flush()
    }, 2)
  }

  private async flush() {
    const batch = this.queue.splice(0, 32)
    const operation = { controller: new AbortController(), items: batch }
    for (const item of batch) item.batch = operation
    this.active++
    try {
      // Signing is already authorized by each subscriber. It must inherit neither
      // the first caller's identity nor their cancellation/deadline.
      const rows = await databaseContext.run(
        { kind: 'anonymous', signal: operation.controller.signal },
        () =>
          this.query(
            'SELECT ' + batch.map((item, i) => `${item.expression} AS URL${i}`).join(', '),
          ),
      )
      const urls = batch.map((_, i) => rows[0]?.[`URL${i}`])
      if (
        rows.length !== 1 ||
        urls.some((url) => typeof url !== 'string' || !url.startsWith('https://'))
      )
        throw new Error('Unable to obtain media URLs')
      batch.forEach((item, i) => item.resolve(urls[i] as string))
    } catch (error) {
      batch.forEach((item) => item.reject(error))
    } finally {
      this.active--
      this.schedule()
    }
  }
}
