import { durationBounds, metrics } from '../diagnostic-schema'
/** Bounded numeric aggregates only: no SQL, URLs, account names or media identifiers. */
type Window = {
  count: number
  totalMs: number
  maxMs: number
  queued: number
  failures: number
  buckets: number[]
}
const windows = new Map<string, Window>()
let timer: ReturnType<typeof setTimeout> | undefined
export function flushPerformance() {
  if (timer) clearTimeout(timer)
  timer = undefined
  for (const [metric, w] of windows) {
    console.warn('[performance]', {
      metric,
      ...w,
      totalMs: Math.round(w.totalMs),
      maxMs: Math.round(w.maxMs),
    })
  }
  windows.clear()
}
export function recordPerformance(metric: string, ms: number, queued = 0, failed = false) {
  if (!metrics.has(metric) || !Number.isFinite(ms) || ms < 0) return
  let w = windows.get(metric)
  if (!w) {
    w = {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      queued: 0,
      failures: 0,
      buckets: Array.from({ length: durationBounds.length + 1 }, () => 0),
    }
    windows.set(metric, w)
  }
  w.count++
  w.totalMs += ms
  w.maxMs = Math.max(w.maxMs, ms)
  w.queued += queued > 0 ? 1 : 0
  w.failures += failed ? 1 : 0
  const bucket = durationBounds.findIndex((bound) => ms <= bound)
  w.buckets[bucket < 0 ? durationBounds.length : bucket]++
  // Flush even if traffic stops; do not keep the process alive or poll while idle.
  if (!timer) {
    timer = setTimeout(flushPerformance, 60_000)
    timer.unref?.()
  }
}
