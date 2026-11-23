import {
  databaseContext,
  type DatabaseIdentity,
  databaseSignal,
} from '../database/database-context'
import { HttpError } from '../http'

function limit(name: string, fallback: number, maximum: number, minimum = 1) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number(raw)
  if (
    (raw !== undefined && !/^\d+$/.test(raw)) ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw Error(`Invalid ${name}`)
  return value
}

export function searchTimeoutMs() {
  return limit('SEARCH_REQUEST_TIMEOUT_MS', 30000, 120000, 100)
}
export function searchAdmissionLimits() {
  const active = limit('SEARCH_MAX_ACTIVE', 4, 32)
  const queued = limit('SEARCH_MAX_QUEUED', 32, 256, 0)
  const subscribers = limit('SEARCH_MAX_SUBSCRIBERS', 128, 2048)
  return {
    active,
    perUser: limit('SEARCH_MAX_ACTIVE_PER_USER', 1, active),
    queued,
    queuedPerUser: limit('SEARCH_MAX_QUEUED_PER_USER', Math.min(2, queued), queued, 0),
    subscribers,
    subscribersPerUser: limit(
      'SEARCH_MAX_SUBSCRIBERS_PER_USER',
      Math.min(8, subscribers),
      subscribers,
    ),
    timeoutMs: searchTimeoutMs(),
  }
}
export const searchBusy = () => new HttpError(503, 'Search is busy. Please retry shortly.', 1)
export const searchTimedOut = () => new HttpError(504, 'Search timed out. Please try again.', 1)

type Subscriber = { resolve: (value: unknown) => void; reject: (error: unknown) => void }
type Entry = {
  key: string
  user: string
  controller: AbortController
  work: (signal: AbortSignal) => Promise<unknown>
  subscribers: Set<Subscriber>
  timer?: ReturnType<typeof setTimeout>
  settled: boolean
  state: 'queued' | 'running' | 'done'
}

/** Per-process admission, shared by interactive retrieval and saved-search replay.
 * Timed-out work retains its active slot until the underlying work actually settles.
 * Every admitted partition remains eligible; overload is explicit, never truncation. */
export class SearchAdmission {
  private entries = new Map<string, Entry>()
  private queue: Entry[] = []
  private active = 0
  private activeUsers = new Map<string, number>()
  private waiting = 0
  private waitingUsers = new Map<string, number>()
  constructor(private limits = searchAdmissionLimits) {}

  run<T>(
    user: string,
    key: string,
    work: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    const config = this.limits()
    if (
      this.waiting >= config.subscribers ||
      (this.waitingUsers.get(user) ?? 0) >= config.subscribersPerUser
    )
      return Promise.reject(searchBusy())
    const scopedKey = JSON.stringify([user, key])
    const existing = this.entries.get(scopedKey)
    if (existing) return this.subscribe(existing, signal) as Promise<T>
    const canStart =
      this.active < config.active && (this.activeUsers.get(user) ?? 0) < config.perUser
    if (
      !canStart &&
      (this.queue.length >= config.queued ||
        this.queue.filter((entry) => entry.user === user).length >= config.queuedPerUser)
    )
      return Promise.reject(searchBusy())
    const entry: Entry = {
      key: scopedKey,
      user,
      controller: new AbortController(),
      work,
      subscribers: new Set(),
      settled: false,
      state: 'queued',
    }
    this.entries.set(scopedKey, entry)
    const result = this.subscribe(entry, signal) as Promise<T>
    if (entry.settled) return result
    entry.timer = setTimeout(() => this.stop(entry, searchTimedOut()), config.timeoutMs)
    entry.timer.unref?.()
    this.queue.push(entry)
    this.drain()
    return result
  }

  private subscribe(entry: Entry, signal?: AbortSignal) {
    return new Promise<unknown>((resolve, reject) => {
      this.waiting++
      this.waitingUsers.set(entry.user, (this.waitingUsers.get(entry.user) ?? 0) + 1)
      const cleanup = () => {
        signal?.removeEventListener('abort', abort)
        if (!entry.subscribers.delete(subscriber)) return
        this.waiting--
        this.decrement(this.waitingUsers, entry.user)
      }
      const subscriber = {
        resolve: (value: unknown) => {
          cleanup()
          resolve(value)
        },
        reject: (error: unknown) => {
          cleanup()
          reject(error)
        },
      }
      const abort = () => {
        subscriber.reject(signal?.reason)
        if (!entry.subscribers.size) this.stop(entry, signal?.reason)
      }
      entry.subscribers.add(subscriber)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }

  private decrement(counts: Map<string, number>, user: string) {
    const remaining = (counts.get(user) ?? 1) - 1
    if (remaining) counts.set(user, remaining)
    else counts.delete(user)
  }

  private finish(entry: Entry, result: { value: unknown } | { error: unknown }) {
    if (entry.settled) return
    entry.settled = true
    clearTimeout(entry.timer)
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    for (const subscriber of entry.subscribers)
      if ('error' in result) subscriber.reject(result.error)
      else subscriber.resolve(result.value)
  }

  private stop(entry: Entry, error: unknown) {
    this.finish(entry, { error })
    entry.controller.abort(error)
    if (entry.state === 'queued') {
      const index = this.queue.indexOf(entry)
      if (index >= 0) this.queue.splice(index, 1)
      entry.state = 'done'
      this.drain()
    }
  }

  private drain() {
    const config = this.limits()
    while (this.active < config.active) {
      // Skip a saturated user so their queued searches do not block other users.
      const index = this.queue.findIndex(
        (entry) => (this.activeUsers.get(entry.user) ?? 0) < config.perUser,
      )
      if (index < 0) return
      const [entry] = this.queue.splice(index, 1)
      entry.state = 'running'
      this.active++
      this.activeUsers.set(entry.user, (this.activeUsers.get(entry.user) ?? 0) + 1)
      void Promise.resolve()
        .then(() => {
          entry.controller.signal.throwIfAborted()
          return entry.work(entry.controller.signal)
        })
        .then(
          (value) =>
            this.finish(
              entry,
              entry.controller.signal.aborted
                ? { error: entry.controller.signal.reason }
                : { value },
            ),
          (error) => this.finish(entry, { error }),
        )
        .finally(() => {
          entry.state = 'done'
          this.active--
          this.decrement(this.activeUsers, entry.user)
          this.drain()
        })
    }
  }
}

const admission = new SearchAdmission()
/** Copy only verified identity. Request bindings, session bootstrap promises and
 * mutable authorization caches are never inherited by another subscriber. */
export function runSearchWork<T>(
  identity: DatabaseIdentity,
  key: string,
  work: () => Promise<T>,
  signal = databaseSignal(),
): Promise<T> {
  const verified = { ...identity }
  return admission.run(
    identity.username,
    JSON.stringify([verified, key]),
    (operationSignal) =>
      databaseContext.run(
        { kind: 'request', identity: Promise.resolve(verified), signal: operationSignal },
        work,
      ),
    signal,
  )
}
