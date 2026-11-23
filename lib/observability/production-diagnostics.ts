import { runtimeBuildIdentity } from '../build-identity'
import { diagnosticCode, durationBounds, metrics, phases, routes } from '../diagnostic-schema'
/** Production diagnostics deliberately discard free-form messages and exception text. */
const tags = new Set([
  'request',
  'user-activity',
  'maintenance',
  'video-maintenance',
  'playback-maintenance',
  'postgres-pool',
  'events-with-covers',
  'folders',
  'folders-create',
  'folders-rename',
  'csp-report',
  'assertion-cleanup',
  'background-coordinator',
  'upload-routing-maintenance',
  'preparation-maintenance',
  'face-scan-maintenance',
  'search-batch-maintenance',
  'people-matching',
  'photo-ai',
  'photo-ai-ledger',
  'access-denied',
])
export function safeDiagnostic(args: unknown[]) {
  if (args[0] === '[performance]' && args[1] && typeof args[1] === 'object') {
    const data = args[1] as Record<string, unknown>
    if (metrics.has(String(data.metric))) {
      const values: Record<string, number> = {}
      for (const key of ['count', 'totalMs', 'maxMs', 'queued', 'failures']) {
        const value = data[key]
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
          return { event: 'application' }
        values[key] = Math.min(1e12, Math.round(value))
      }
      const buckets = data.buckets
      const histogram =
        Array.isArray(buckets) &&
        buckets.length === durationBounds.length + 1 &&
        buckets.every((v) => Number.isSafeInteger(v) && v >= 0) &&
        buckets.reduce((a, b) => a + b, 0) === values.count
          ? { buckets: [...buckets], boundsMs: [...durationBounds] }
          : {}
      return { event: 'performance', metric: data.metric, ...values, ...histogram }
    }
  }
  if (
    ['[request-phase]', '[request-headers]'].includes(String(args[0])) &&
    args[1] &&
    typeof args[1] === 'object'
  ) {
    const d = args[1] as Record<string, unknown>
    if (
      typeof d.id === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(d.id) &&
      routes.has(String(d.route)) &&
      typeof d.elapsedMs === 'number' &&
      Number.isFinite(d.elapsedMs) &&
      d.elapsedMs >= 0
    ) {
      const common = {
        id: d.id,
        route: d.route,
        elapsedMs: Math.min(1e12, Math.round(d.elapsedMs)),
      }
      if (args[0] === '[request-phase]' && phases.has(String(d.phase))) {
        const code =
          diagnosticCode({ code: d.code }) ??
          (['OTHER', 'TIMEOUT'].includes(String(d.code)) ? d.code : 'OTHER')
        return { event: 'request-phase', ...common, phase: d.phase, code }
      }
      if (
        args[0] === '[request-headers]' &&
        typeof d.status === 'number' &&
        Number.isInteger(d.status) &&
        d.status >= 100 &&
        d.status <= 599
      )
        return { event: 'request-headers', ...common, status: d.status }
    }
    return { event: 'application' }
  }
  let event = 'application'
  let code: string | undefined
  for (const arg of args) {
    if (typeof arg === 'string') {
      const tag = /^\[([a-z-]+)\]$/.exec(arg)?.[1]
      if (tag && tags.has(tag)) event = tag
    }
    if (arg instanceof Error) {
      code = diagnosticCode(arg) ?? code
    }
  }
  return { event, ...(code ? { code } : {}) }
}
/** Independent finite category budgets; noisy telemetry cannot consume the error budget. */
export function createDiagnosticWriter(
  output: (line: string) => void,
  now = Date.now,
  identity = runtimeBuildIdentity,
) {
  const counts = new Map<string, number>()
  const dropped = new Map<string, number>()
  let minute = Math.floor(now() / 60000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    for (const [category, count] of dropped)
      output(
        JSON.stringify({
          level: 'warn',
          event: 'diagnostics-dropped',
          category,
          count,
          ...identity(),
        }),
      )
    counts.clear()
    dropped.clear()
    minute = Math.floor(now() / 60000)
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  return (level: string, args: unknown[]) => {
    if (level !== 'warn' && level !== 'error') return
    if (Math.floor(now() / 60000) !== minute) flush()
    const diagnostic = safeDiagnostic(args)
    const category =
      diagnostic.event === 'performance'
        ? `performance:${'metric' in diagnostic ? diagnostic.metric : 'unknown'}`
        : diagnostic.event === 'request-headers'
          ? 'request-headers'
          : diagnostic.event
    const count = counts.get(category) ?? 0
    if (count >= 30) dropped.set(category, (dropped.get(category) ?? 0) + 1)
    else {
      counts.set(category, count + 1)
      output(JSON.stringify({ level, ...diagnostic, ...identity() }))
    }
    if (!timer) {
      timer = setTimeout(flush, 60000)
      timer.unref?.()
    }
  }
}
let installed = false
export function installProductionDiagnostics() {
  if (installed || process.env.NODE_ENV !== 'production') return
  installed = true
  const output = console.warn.bind(console)
  const write = createDiagnosticWriter(output)
  for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const)
    console[method] = (...args: unknown[]) => write(method, args)
}
