import { observePhase, withoutRequestObservation } from '../request-observability'
import { recordLoadTestRequest, sampleLoadTestRequest } from '../load-test-request-journal'
import { startLoadTestRuntimeSampling } from '../load-test-runtime-sample'
import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import type { ClientRequest } from 'node:http'
import type { Socket } from 'node:net'

const context = new AsyncLocalStorage<{
  phases: Record<string, number>
  active: Set<string>
  failures: Record<string, string>
  counts: Record<string, number>
  gauges: Record<string, number>
}>()
/** Background maintenance must not be charged to the triggering HTTP trace. */
export function withoutUploadRequestTrace<T>(fn: () => T): T {
  return withoutRequestObservation(() => context.exit(fn))
}
const observedAuthKeys = new Map<string, string>()
let httpTracingInstalled = false
/** Observe transport attempts without SDK debug logs, URLs, credentials or SQL. */
function installHttpTracing() {
  if (httpTracingInstalled) return
  httpTracingInstalled = true
  channel('http.client.request.start').subscribe((message) => {
    const state = context.getStore()
    if (!state) return
    try {
      const request = (message as { request: ClientRequest }).request
      const host = String(request.getHeader('host') ?? '').split(':')[0]
      if (!host.endsWith('.snowflakecomputing.com')) return
      const url = new URL(request.path, 'https://trace.invalid')
      const kind =
        url.pathname === '/session/v1/login-request'
          ? 'login'
          : url.pathname === '/queries/v1/query-request'
            ? 'query'
            : /^\/queries\/[^/]+\/result\/?$/.test(url.pathname)
              ? 'result'
              : null
      if (!kind) return
      const prefix = `sf-http-${kind}`
      const started = performance.now()
      const count = (name: string) => {
        state.counts[name] = (state.counts[name] ?? 0) + 1
      }
      const elapsed = (name: string) => {
        const ms = performance.now() - started
        state.phases[name] = (state.phases[name] ?? 0) + ms
        state.gauges[`${name}-max`] = Math.max(state.gauges[`${name}-max`] ?? 0, ms)
      }
      count(`${prefix}-attempts`)
      if (request.reusedSocket) count(`${prefix}-reused-socket`)
      const retry = Number(url.searchParams.get('retryCount') ?? 0)
      if (Number.isSafeInteger(retry) && retry > 0) {
        count(`${prefix}-retry-attempts`)
        state.gauges[`${prefix}-retry-max`] = Math.max(
          state.gauges[`${prefix}-retry-max`] ?? 0,
          retry,
        )
      }
      // Only phases and allowlisted codes: never socket addresses or error messages.
      const observeSocket = (socket: Socket) => {
        count(`${prefix}-socket-assigned`)
        count(`${prefix}-socket-${socket.connecting ? 'connecting' : 'connected'}`)
        if (socket.connecting) {
          socket.once('lookup', (error, _address, family) => {
            elapsed(`${prefix}-dns-ms`)
            count(`${prefix}-dns-${error ? 'failed' : 'ok'}`)
            if (family === 4 || family === 6) count(`${prefix}-dns-ipv${family}`)
          })
          // Node emits these on fresh outbound TCP attempts. Addresses are ignored.
          socket.on('connectionAttempt', (_address, _port, family) => {
            if (family === 4 || family === 6) count(`${prefix}-connect-attempt-ipv${family}`)
          })
          socket.on('connectionAttemptFailed', () => count(`${prefix}-connect-failed`))
          socket.on('connectionAttemptTimeout', () => count(`${prefix}-connect-attempt-timeout`))
          socket.once('connect', () => elapsed(`${prefix}-connect-ms`))
          socket.once('secureConnect', () => elapsed(`${prefix}-tls-ms`))
        }
      }
      if (request.socket) observeSocket(request.socket)
      else request.once('socket', observeSocket)
      request.once('finish', () => elapsed(`${prefix}-sent-ms`))
      request.once('timeout', () => count(`${prefix}-timeout-events`))
      request.once('response', (response) => {
        elapsed(`${prefix}-headers-ms`)
        if (response.headers.connection?.toLowerCase() === 'close')
          count(`${prefix}-server-connection-close`)
        const status = response.statusCode
        if (status && status >= 100 && status <= 599) count(`${prefix}-status-${status}`)
        response.once('end', () => elapsed(`${prefix}-complete-ms`))
      })
      request.once('error', (error: NodeJS.ErrnoException) => {
        const code = [
          'ECONNRESET',
          'ETIMEDOUT',
          'ECONNREFUSED',
          'EPIPE',
          'ENOTFOUND',
          'EAI_AGAIN',
          'ECONNABORTED',
          'ABORT_ERR',
          'ERR_SOCKET_CLOSED',
          'ERR_TLS_CERT_ALTNAME_INVALID',
          'CERT_HAS_EXPIRED',
          'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        ].includes(error.code ?? '')
          ? error.code
          : 'OTHER'
        count(`${prefix}-error-${code}`)
        count(`${prefix}-transport-errors`)
        elapsed(`${prefix}-error-ms`)
      })
    } catch {
      // Diagnostics must never affect request handling or expose error contents.
    }
  })
}
export function uploadTraceCount(name: string) {
  const state = context.getStore()
  if (state) state.counts[name] = (state.counts[name] ?? 0) + 1
}
export function uploadTraceGauge(name: string, value: number) {
  const state = context.getStore()
  if (state && Number.isFinite(value)) state.gauges[name] = value
}
export function uploadTraceDuration(name: string, milliseconds: number) {
  const state = context.getStore()
  if (state && Number.isFinite(milliseconds) && milliseconds >= 0)
    state.phases[name] = (state.phases[name] ?? 0) + milliseconds
}
/** Hashes stay in bounded isolated-test memory; only aggregate counters are logged. */
export function observeUploadAuthKey(scope: () => string, keyHash: string) {
  if (!context.getStore()) return
  const scopeHash = scope()
  const previous = observedAuthKeys.get(scopeHash)
  uploadTraceCount(
    previous === undefined
      ? 'auth-context-first-seen'
      : previous === keyHash
        ? 'auth-context-same-token'
        : 'auth-context-token-changed',
  )
  observedAuthKeys.delete(scopeHash)
  if (observedAuthKeys.size >= 512) observedAuthKeys.delete(observedAuthKeys.keys().next().value!)
  observedAuthKeys.set(scopeHash, keyHash)
}
export function uploadRequestStep<T>(name: string, work: () => Promise<T>): Promise<T> {
  const observed = () => observePhase(name, work)
  const state = context.getStore()
  if (!state) return observed()
  return (async () => {
    const started = performance.now()
    state.active.add(name)
    try {
      return await observed()
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      state.failures[name] =
        message.includes('timeout') || message.includes('timed out')
          ? 'timeout'
          : message.includes('terminated connection')
            ? 'terminated_connection'
            : message.includes('econnreset') || message.includes('socket hang up')
              ? 'connection_reset'
              : 'error'
      throw error
    } finally {
      state.active.delete(name)
      state.phases[name] = (state.phases[name] ?? 0) + performance.now() - started
    }
  })()
}

/** Isolated diagnostics only. Never log bodies, credentials, identities or query text. */
export function traceUploadRequest<A extends unknown[]>(
  handler: (req: Request, ...args: A) => Promise<Response>,
) {
  return async (req: Request, ...args: A): Promise<Response> => {
    const id = req.headers.get('x-load-test-request')
    if (
      context.getStore() ||
      process.env.UPLOAD_REQUEST_TRACE !== 'true' ||
      !/^stillmark_loadtest_[a-z0-9_]+$/.test(process.env.PG_DATABASE ?? '') ||
      !id ||
      !/^[a-f0-9-]{36}$/.test(id)
    )
      return handler(req, ...args)
    startLoadTestRuntimeSampling()
    const started = performance.now()
    if (!sampleLoadTestRequest(id)) {
      const response = await handler(req, ...args)
      response.headers.append(
        'Server-Timing',
        `app;dur=${(performance.now() - started).toFixed(2)}`,
      )
      return response
    }
    installHttpTracing()
    const state = {
      phases: {} as Record<string, number>,
      active: new Set<string>(),
      failures: {} as Record<string, string>,
      counts: {} as Record<string, number>,
      gauges: {} as Record<string, number>,
    }
    const log = (event: string, status?: number) => {
      recordLoadTestRequest(id, {
        event,
        ...(event === 'entered' ? { enteredAt: Date.now() } : {}),
        status,
        elapsedMs: Math.round(performance.now() - started),
        phases: { ...state.phases },
        failures: { ...state.failures },
        counts: { ...state.counts },
        gauges: { ...state.gauges },
        active: [...state.active],
      })
      if (process.env.UPLOAD_REQUEST_TRACE_LOG === 'false') return
      process.stdout.write(
        '[upload-request-trace] ' +
          JSON.stringify({
            id,
            event,
            at: Date.now(),
            elapsedMs: Math.round(performance.now() - started),
            ...(status === undefined ? {} : { status }),
            phases: state.phases,
            failures: state.failures,
            counts: state.counts,
            gauges: state.gauges,
            active: [...state.active],
          }) +
          '\n',
      )
    }
    const onAbort = () => recordLoadTestRequest(id, { abortedAt: Date.now() })
    req.signal.addEventListener('abort', onAbort, { once: true })
    if (req.signal.aborted) onAbort()
    log('entered')
    const timer = setInterval(() => log('pending'), 5000)
    timer.unref()
    try {
      const response = await context.run(state, () => handler(req, ...args))
      response.headers.set('x-load-test-request', id)
      response.headers.append(
        'Server-Timing',
        `app;dur=${(performance.now() - started).toFixed(2)}`,
      )
      log('returned', response.status)
      return response
    } catch (error) {
      log('threw')
      throw error
    } finally {
      clearInterval(timer)
      req.signal.removeEventListener('abort', onAbort)
    }
  }
}
