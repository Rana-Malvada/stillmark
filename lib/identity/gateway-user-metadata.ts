import { recordPerformance } from '../observability/performance-metrics'
import { identityControl } from './identity-control'
import { gatewayRoleCacheMaxEntries, gatewayRoleRefreshMax } from '../snowflake/snowflake-capacity'
import { uploadTraceCount, withoutUploadRequestTrace } from '../upload/upload-request-trace'

type Snapshot = {
  users: Record<string, any>[]
  direct: Record<string, any>[]
  expires: number
  refreshAfter: number
}
const entries = new Map<string, Snapshot>()
const pending = new Map<string, Promise<Snapshot>>()
const limit = gatewayRoleCacheMaxEntries()

// User data and shared role graphs have independent freshness windows. A shared
// graph expiry must not force every user's still-fresh SHOW reads to repeat.
// The key includes registry epoch/marker, so local access changes invalidate it.
async function readSnapshot(name: string): Promise<Snapshot> {
  const started = Date.now()
  const [users, direct] = await Promise.all([
    identityControl('findUser', { name }),
    identityControl('userGrants', { name }),
  ])
  let hash = 2166136261
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  return {
    users,
    direct,
    expires: started + 15_000,
    refreshAfter: started + 6_000 + (hash % 6_000),
  }
}

export async function gatewayUserMetadata(name: string, key?: string): Promise<Snapshot> {
  if (!key) return readSnapshot(name) // Administration always reads fresh data.
  const cached = entries.get(key)
  if (cached && cached.expires > Date.now()) {
    entries.delete(key)
    entries.set(key, cached)
    uploadTraceCount('gateway-user-cache-hit')
    return cached
  }
  entries.delete(key)
  let work = pending.get(key)
  if (!work) {
    uploadTraceCount('gateway-user-cache-read')
    work = readSnapshot(name).then((result) => {
      entries.delete(key)
      while (entries.size >= limit) entries.delete(entries.keys().next().value!)
      entries.set(key, result)
      return result
    })
    pending.set(key, work)
  }
  try {
    const result = await work
    // A foreground caller may have joined a refresh after its old entry expired.
    entries.delete(key)
    while (entries.size >= limit) entries.delete(entries.keys().next().value!)
    entries.set(key, result)
    return result
  } finally {
    if (pending.get(key) === work) pending.delete(key)
  }
}

let refreshing = 0
const maxRefreshes = gatewayRoleRefreshMax()
/** Lazy, bounded refresh for active users only; no timers or idle polling. */
export function refreshGatewayUserMetadata(name: string, key: string): void {
  const cached = entries.get(key)
  const now = Date.now()
  if (
    !cached ||
    cached.expires <= now ||
    cached.refreshAfter > now ||
    pending.has(key) ||
    refreshing >= maxRefreshes
  )
    return
  refreshing++
  // Back off failed refreshes, but never move the hard expiry deadline.
  cached.refreshAfter = now + 2_000
  const started = performance.now()
  let failed = false
  const work = withoutUploadRequestTrace(() => readSnapshot(name)).then((result) => {
    // Never resurrect an entry evicted while the refresh was in flight.
    if (entries.get(key) === cached) entries.set(key, result)
    return result
  })
  pending.set(key, work)
  void work
    .catch(() => {
      failed = true
    })
    .finally(() => {
      recordPerformance('gateway-user-refresh', performance.now() - started, 0, failed)
      refreshing--
      if (pending.get(key) === work) pending.delete(key)
    })
}
