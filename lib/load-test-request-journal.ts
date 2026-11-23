/** Bounded isolated evidence. No headers, URLs, identities, bodies or error messages. */
export type HttpAttempt = {
  startedAt: number
  finishedAt?: number
  closedAt?: number
  status?: number
  completed?: boolean
  socket?: {
    firstObservedAt: number
    requestNumber: number
    timeoutMs: number
    timeoutAt?: number
    peerEndedAt?: number
    closedAt?: number
    hadError?: boolean
    errorCode?: string
  }
}
type Entry = {
  http?: HttpAttempt[]
  counts?: Record<string, number>
  gauges?: Record<string, number>
  abortedAt?: number
  proxyAt?: number
  enteredAt?: number
  lastAt: number
  event?: string
  status?: number
  elapsedMs?: number
  phases?: Record<string, number>
  active?: string[]
  failures?: Record<string, string>
}
type Journal = { startedAt: number; received: number; evicted: number; records: Map<string, Entry> }
const key = Symbol.for('stillmark.isolated.request.journal')
function enabled() {
  return (
    process.env.UPLOAD_REQUEST_TRACE === 'true' &&
    /^stillmark_loadtest_[a-z0-9_]+$/.test(process.env.PG_DATABASE ?? '')
  )
}
/** Deterministic sampling of random request IDs; never changes authorization. */
export function sampleLoadTestRequest(id: string) {
  const configured = Number(process.env.LOAD_TEST_REQUEST_SAMPLE_EVERY ?? '1')
  const every =
    Number.isSafeInteger(configured) && configured >= 1 && configured <= 65536 ? configured : 1
  return Number.parseInt(id.slice(0, 8), 16) % every === 0
}
function journal(): Journal {
  const root = globalThis as typeof globalThis & { [key]?: Journal }
  return (root[key] ??= { startedAt: Date.now(), received: 0, evicted: 0, records: new Map() })
}
export function recordLoadTestRequest(id: string | null, update: Partial<Entry>) {
  if (!enabled() || !id || !/^[a-f0-9-]{36}$/.test(id) || !sampleLoadTestRequest(id)) return
  const j = journal()
  const old = j.records.get(id)
  if (!old) j.received++
  j.records.set(id, {
    ...old,
    ...update,
    proxyAt: old?.proxyAt ?? update.proxyAt,
    enteredAt: old?.enteredAt ?? update.enteredAt,
    lastAt: Date.now(),
  })
  if (j.records.size > 50000) {
    j.records.delete(j.records.keys().next().value!)
    j.evicted++
  }
}
export function loadTestRequestEvidence(ids: string[]) {
  if (!enabled()) return null
  if (ids.length > 10 || ids.some((id) => !/^[a-f0-9-]{36}$/.test(id)))
    throw Error('Invalid trace IDs')
  const j = journal()
  return {
    pid: process.pid,
    startedAt: j.startedAt,
    received: j.received,
    retained: j.records.size,
    recentIds: ids.length === 0 ? [...j.records.keys()].slice(-1000) : undefined,
    evicted: j.evicted,
    records: Object.fromEntries(ids.map((id) => [id, j.records.get(id) ?? null])),
  }
}

/** Track each actual HTTP attempt separately; handler return is not stream completion. */
export function beginLoadTestHttp(id: string): HttpAttempt | undefined {
  if (!enabled() || !/^[a-f0-9-]{36}$/.test(id) || !sampleLoadTestRequest(id)) return
  const old = journal().records.get(id)?.http ?? []
  if (old.length >= 4) return
  const attempt = { startedAt: Date.now() }
  recordLoadTestRequest(id, { http: [...old, attempt] })
  return attempt
}
