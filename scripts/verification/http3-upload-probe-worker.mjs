import {
  BASE_PATH,
  MAX_BODY,
  MAX_PLAN_BYTES,
  PLAN,
  PROBE_ORIGIN,
  WINDOW_MS,
} from './http3-upload-probe-plan.mjs'
import { CLIENT, PAGE } from './http3-upload-probe-page.mjs'

const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
}
const json = (body, status = 200) => Response.json(body, { status, headers })
const protocol = (value) =>
  ({ 'HTTP/2': 'h2', 'HTTP/3': 'h3', 'HTTP/1.1': 'h1' })[value] ?? 'unknown'
const sameToken = (actual, expected) => {
  if (!/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected ?? '')) return false
  let difference = 0
  for (let i = 0; i < expected.length; i++)
    difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i)
  return difference === 0
}

/** No outbound requests, database, user identities, durable storage, or body logging. */
export function createProbeWorker({
  now = Date.now,
  log = console.log,
  bodyTimeoutMs = 20000,
} = {}) {
  const used = new Set()
  let plannedBytes = 0
  let active = 0
  return {
    async fetch(request, env) {
      const url = new URL(request.url)
      if (url.origin !== PROBE_ORIGIN || url.search)
        return new Response('Not found', { status: 404, headers })
      const start = Number(env.PROBE_START_MS)
      const end = Number(env.PROBE_END_MS)
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        end <= start ||
        end - start > WINDOW_MS ||
        now() < start ||
        now() >= end ||
        !/^[a-f0-9-]{36}$/.test(env.PROBE_RUN_ID ?? '')
      )
        return new Response('Probe disabled or expired', { status: 410, headers })
      if (request.method === 'GET' && [BASE_PATH, BASE_PATH + '/'].includes(url.pathname))
        return new Response(PAGE, {
          headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
        })
      if (request.method === 'GET' && url.pathname === BASE_PATH + '/client.js')
        return new Response(CLIENT, {
          headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' },
        })
      const token =
        /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
      if (!sameToken(token, env.UPLOAD_PROBE_TOKEN))
        return new Response('Unauthorized', { status: 401, headers })
      const cfProtocol = protocol(request.cf?.httpProtocol)
      const colo = /^[A-Z]{3}$/.test(request.cf?.colo ?? '') ? request.cf.colo : 'unknown'
      if (request.method === 'GET' && url.pathname === BASE_PATH + '/status')
        return json({
          protocol: cfProtocol,
          colo,
          remainingMs: Math.max(0, end - now()),
          attemptsUsed: used.size,
        })
      const match = new RegExp('^' + BASE_PATH + '/upload/([1-9]|1[0-9]|20)$').exec(url.pathname)
      if (request.method !== 'POST' || !match)
        return new Response('Not found', { status: 404, headers })
      if (
        request.headers.get('origin') !== PROBE_ORIGIN ||
        request.headers.get('sec-fetch-site') === 'cross-site'
      )
        return new Response('Forbidden', { status: 403, headers })
      const item = PLAN[Number(match[1]) - 1]
      if (used.has(item.slot) || used.size >= 20 || plannedBytes + item.wireBytes > MAX_PLAN_BYTES)
        return new Response('Attempt already used or budget exhausted', { status: 409, headers })
      // Process-local replay/budget guard. The fixed client plan is the cross-isolate budget.
      used.add(item.slot)
      plannedBytes += item.wireBytes
      const entered = now()
      const id = env.PROBE_RUN_ID + ':' + item.slot
      const rayHeader = request.headers.get('cf-ray') ?? ''
      const ray = /^[a-f0-9]{16,32}-[A-Z]{3}$/.test(rayHeader) ? rayHeader : null
      let bytes = 0
      let firstByteMs = null
      const result = (reason, status) => ({
        event: 'upload_probe_result',
        id,
        slot: item.slot,
        mode: item.mode,
        protocol: cfProtocol,
        expectedProtocol: item.lane,
        colo,
        ray,
        reason,
        status,
        bytes,
        expectedBytes: item.wireBytes,
        firstByteMs,
        elapsedMs: Math.max(0, now() - entered),
        connectionReuse: 'unknown',
      })
      const record = (phase, reason, status) => {
        try {
          log(
            JSON.stringify({ ...result(reason, status), event: 'upload_probe', phase, at: now() }),
          )
        } catch {
          /* Logging cannot change request handling. */
        }
      }
      const finish = (reason, status) => {
        record('end', reason, status)
        return json(result(reason, status), status)
      }
      record('entry', 'received', 0)
      if (cfProtocol !== item.lane) return finish('protocol_mismatch', 409)
      const declared = Number(request.headers.get('content-length'))
      if (
        declared > MAX_BODY ||
        (Number.isSafeInteger(declared) && declared > 0 && declared !== item.wireBytes)
      )
        return finish('declared_size_rejected', 413)
      if (item.mode === 'reject') return finish('deliberate_reject', 413)
      if (active >= 4) return finish('concurrency_limit', 429)
      if (!request.body) return finish('missing_body', 400)
      active++
      const reader = request.body.getReader()
      const capacity = Number.isSafeInteger(declared) && declared > 0 ? declared : MAX_BODY
      const buffer = ['buffer', 'abort'].includes(item.mode) ? new Uint8Array(capacity) : null
      let interrupted = ''
      let interrupt
      const interruption = new Promise((_, reject) => {
        interrupt = reject
      })
      const abort = () => {
        interrupted = 'client_abort'
        interrupt(Error('interrupted'))
      }
      request.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(
        () => {
          interrupted = 'body_deadline'
          interrupt(Error('interrupted'))
        },
        Math.min(bodyTimeoutMs, end - now()),
      )
      try {
        if (request.signal.aborted) abort()
        for (;;) {
          const { value, done } = await Promise.race([reader.read(), interruption])
          if (done) break
          bytes += value.byteLength
          if (firstByteMs === null) {
            firstByteMs = Math.max(0, now() - entered)
            record('first_byte', 'reading', 0)
          }
          if (bytes > item.wireBytes || bytes > capacity || bytes > MAX_BODY)
            return finish('body_size_rejected', 413)
          if (buffer) buffer.set(value, bytes - value.byteLength)
        }
        return finish(
          bytes === item.wireBytes ? 'complete' : 'length_mismatch',
          bytes === item.wireBytes ? 200 : 400,
        )
      } catch {
        return finish(
          interrupted || 'read_failed',
          interrupted === 'client_abort' ? 499 : interrupted ? 408 : 400,
        )
      } finally {
        clearTimeout(timer)
        request.signal.removeEventListener('abort', abort)
        // Never wait indefinitely for a stalled producer to acknowledge cancellation.
        void reader.cancel().catch(() => {})
        try {
          reader.releaseLock()
        } catch {
          /* A pending transport read may settle later. */
        }
        active--
      }
    },
  }
}

export default createProbeWorker()
