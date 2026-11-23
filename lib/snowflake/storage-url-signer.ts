import { querySnowflakeStorage } from '../snowflake'
import { MEDIA_SIGNING_TIMEOUT_MS, MediaSigningBatch } from '../media/media-signing-batch'
import { SignedUrlCache } from '../signed-url-cache'
import { signedUrlCacheConfig } from './snowflake-capacity'
import { databaseContext, databaseSignal } from '../database/database-context'

// One bounded signing queue for photo, face and chunk requests in this process.
export const storageSigningBatch = new MediaSigningBatch(querySnowflakeStorage)

type Subscriber = { resolve: (url: string) => void; reject: (error: unknown) => void }
type Pending = {
  controller: AbortController
  subscribers: Set<Subscriber>
  timer?: ReturnType<typeof setTimeout>
  settled: boolean
}
type CacheEvent = 'hit' | 'miss' | 'coalesced' | 'evicted' | 'stored'

/** Internal URLs only. Callers must authorize and validate paths before invoking.
 * Never caches an authorization decision, response body or public redirect.
 */
export class StorageUrlSigner {
  private cache: SignedUrlCache
  private pending = new Map<string, Pending>()
  private active = 0
  private waiting = 0
  constructor(
    private sign: (expression: string, signal: AbortSignal) => Promise<string>,
    maxEntries = 4096,
    maxBytes = 16 * 1024 ** 2,
    private options: {
      timeoutMs?: number
      maxPending?: number
      observe?: (event: CacheEvent, cache: SignedUrlCache) => void
    } = {},
  ) {
    this.cache = new SignedUrlCache(maxEntries, maxBytes)
    for (const value of [options.timeoutMs ?? MEDIA_SIGNING_TIMEOUT_MS, options.maxPending ?? 4096])
      if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid signing capacity')
  }
  invalidate(expression: string) {
    this.cache.delete(expression)
    this.pending.delete(expression)
  }
  keys() {
    return new Set([...this.cache.keys(), ...this.pending.keys()])
  }
  get(expression: string, seconds: number, signal = databaseSignal()): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const cached = this.cache.get(expression)
    if (cached) {
      this.options.observe?.('hit', this.cache)
      return Promise.resolve(cached)
    }
    this.options.observe?.('miss', this.cache)
    if (this.waiting >= (this.options.maxPending ?? 4096))
      return Promise.reject(new Error('Media signing queue is full'))
    const existing = this.pending.get(expression)
    if (existing) {
      this.options.observe?.('coalesced', this.cache)
      return this.subscribe(expression, existing, signal)
    }
    if (this.active >= (this.options.maxPending ?? 4096))
      return Promise.reject(new Error('Media signing queue is full'))
    const operation: Pending = {
      controller: new AbortController(),
      subscribers: new Set(),
      settled: false,
    }
    this.active++
    this.pending.set(expression, operation)
    const result = this.subscribe(expression, operation, signal)
    if (operation.settled) return result
    const started = Date.now()
    operation.timer = setTimeout(() => {
      const error = new DOMException('Media signing deadline exceeded', 'TimeoutError')
      this.finish(expression, operation, { error })
      operation.controller.abort(error)
    }, this.options.timeoutMs ?? MEDIA_SIGNING_TIMEOUT_MS)
    operation.timer.unref?.()
    try {
      const work = databaseContext.run(
        { kind: 'anonymous', signal: operation.controller.signal },
        () => this.sign(expression, operation.controller.signal),
      )
      void work.then(
        (url) => {
          if (operation.settled) return
          if (this.pending.get(expression) === operation) {
            const evicted = this.cache.set(expression, url, started + (seconds - 30) * 1000)
            for (let i = 0; i < evicted; i++) this.options.observe?.('evicted', this.cache)
            this.options.observe?.('stored', this.cache)
          }
          this.finish(expression, operation, { url })
        },
        (error) => this.finish(expression, operation, { error }),
      )
    } catch (error) {
      this.finish(expression, operation, { error })
    }
    return result
  }
  private subscribe(expression: string, operation: Pending, signal?: AbortSignal) {
    return new Promise<string>((resolve, reject) => {
      this.waiting++
      const cleanup = () => {
        signal?.removeEventListener('abort', abort)
        if (operation.subscribers.delete(subscriber)) this.waiting--
      }
      const subscriber = {
        resolve: (url: string) => {
          cleanup()
          resolve(url)
        },
        reject: (error: unknown) => {
          cleanup()
          reject(error)
        },
      }
      const abort = () => {
        subscriber.reject(signal?.reason)
        if (!operation.subscribers.size) {
          this.finish(expression, operation, { error: signal?.reason })
          operation.controller.abort(signal?.reason)
        }
      }
      operation.subscribers.add(subscriber)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  private finish(
    expression: string,
    operation: Pending,
    result: { url: string } | { error: unknown },
  ) {
    if (operation.settled) return
    operation.settled = true
    clearTimeout(operation.timer)
    this.active--
    if (this.pending.get(expression) === operation) this.pending.delete(expression)
    for (const subscriber of operation.subscribers)
      if ('error' in result) subscriber.reject(result.error)
      else subscriber.resolve(result.url)
  }
}
const budget = signedUrlCacheConfig()
export const storageUrlSigner = new StorageUrlSigner(
  (expression, signal) => storageSigningBatch.sign(expression, signal),
  budget.maxEntries,
  budget.maxBytes,
)
