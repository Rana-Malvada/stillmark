import { classifyHttpFailure, safeTransportFailure } from './http-failure.mjs'
import { transportTrace } from './transport-trace.mjs'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
// Keep upload attempts in the isolated app's deterministic request sample. The
// remaining UUID bits are random; this changes diagnostics only, never identity.
export function uploadTraceId() {
  return '00000000' + randomUUID().slice(8)
}
const CHUNK = 8 * 1024 * 1024
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max
export function planRun(config, actors, fixtures) {
  if (
    config.loseCompletionResponses !== undefined &&
    (!integer(config.loseCompletionResponses, 0, 10) ||
      (config.loseCompletionResponses > 0 && !config.retryTransient))
  )
    throw Error('Invalid completion-response fault budget')
  if (config.retryTransient !== undefined && !integer(config.retryTransient, 0, 3))
    throw Error('Invalid retryTransient')
  if (config.retry429 !== undefined && !integer(config.retry429, 0, 10))
    throw Error('Invalid retry429')
  const origin = new URL(config.origin)
  if (
    origin.origin !== config.origin ||
    origin.protocol !== 'https:' ||
    /(^|\.)exampleadmin\.com$/i.test(origin.hostname)
  )
    throw Error('Use an isolated HTTPS origin')
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(config.runId)) throw Error('Invalid runId')
  for (const [key, min, max] of [
    ['users', 1, 5000],
    ['maxRequests', 1, 1024],
    ['filesPerUser', 1, 1000],
    ['maxSeconds', 1, 3600],
    ['rampSeconds', 0, 3600],
    ['pollMs', 500, 30000],
  ])
    if (!integer(config[key], min, max)) throw Error(`Invalid ${key}`)
  if (config.rampSeconds >= config.maxSeconds) throw Error('Ramp must fit inside the run')
  if (actors.length < config.users || fixtures.length !== config.filesPerUser)
    throw Error('Insufficient users or wrong fixture count')
  actors = actors.slice(0, config.users)
  if (
    new Set(actors.map((a) => a.username)).size !== actors.length ||
    new Set(actors.map((a) => a.eventId)).size !== actors.length ||
    actors.some(
      (a) => typeof a.username !== 'string' || !a.username || !integer(a.eventId, 1, 2147483647),
    )
  )
    throw Error('Distinct test users and fixture albums required')
  for (const f of fixtures)
    if (
      !/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|mov|mp4)$/i.test(f.name) ||
      !integer(f.size, 1, /\.(mov|mp4)$/i.test(f.name) ? 4 * 1024 ** 3 : 64 * 1024 ** 2) ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      throw Error('Invalid fixture')
  if (new Set(fixtures.map((f) => f.sha256)).size !== fixtures.length)
    throw Error('Duplicate fixture content would invalidate processing results')
  if (config.users * fixtures.length > 100000) throw Error('Maximum 100000 files per generator')
  const bytes = fixtures.reduce((n, f) => n + f.size, 0) * config.users
  if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes < bytes)
    throw Error('Transfer budget is below planned bytes')
  return {
    users: config.users,
    files: config.users * fixtures.length,
    bytes,
    maxBytes: config.maxBytes,
    maxSeconds: config.maxSeconds,
    maxRequests: config.maxRequests,
  }
}
export function verifyAttestation(envelope, key, config, actors, plan, nonce, now = Date.now()) {
  if (
    typeof key !== 'string' ||
    Buffer.byteLength(key) < 32 ||
    typeof envelope?.payload !== 'string' ||
    envelope.payload.length > 2000000 ||
    typeof envelope?.signature !== 'string'
  )
    throw Error('Missing isolation attestation')
  const expected = createHmac('sha256', key).update(envelope.payload).digest()
  const signature = Buffer.from(envelope.signature, 'hex')
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
    throw Error('Invalid isolation signature')
  const a = JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'))
  if (
    a.nonce !== nonce ||
    a.runId !== config.runId ||
    a.origin !== config.origin ||
    a.isolated !== true ||
    a.aiDisabled !== true ||
    a.batchesDisabled !== true ||
    !a.databaseId ||
    !a.stageId ||
    !a.appService ||
    !Number.isFinite(a.expiresAt) ||
    a.expiresAt < now + config.maxSeconds * 1000 ||
    a.expiresAt > now + 3601000 ||
    !integer(a.maxUsers, 1, 5000) ||
    a.maxUsers < plan.users ||
    !Number.isSafeInteger(a.maxBytes) ||
    a.maxBytes < config.maxBytes ||
    !Number.isSafeInteger(a.maxFiles) ||
    a.maxFiles < plan.files ||
    !Array.isArray(a.actors) ||
    actors.some(
      (u) =>
        !a.actors.some(
          (x) => x.username === u.username && x.eventId === u.eventId && x.privateFixture === true,
        ),
    )
  )
    throw Error('Isolation or budget check failed')
  return a
}
function limiter(max) {
  let active = 0
  const waiters = []
  return async (fn) => {
    if (active >= max) await new Promise((resolve) => waiters.push(resolve))
    else active++
    try {
      return await fn()
    } finally {
      const next = waiters.shift()
      if (next) next()
      else active--
    }
  }
}
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('stopped'))
    const abort = () => {
      clearTimeout(t)
      reject(Error('stopped'))
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
export function actorHeaders(actor) {
  if (Boolean(actor.cookie) === Boolean(actor.token))
    throw Error('Exactly one test credential required')
  if (actor.token) {
    if (
      typeof actor.token !== 'string' ||
      !/^[\x21-\x7e]+$/.test(actor.token) ||
      /["\\]/.test(actor.token)
    )
      throw Error('Invalid test token')
    return {
      Authorization: `Snowflake Token="${actor.token}"`,
    }
  }
  if (typeof actor.cookie !== 'string' || /[\r\n]/.test(actor.cookie))
    throw Error('Invalid test cookie')
  return { Cookie: actor.cookie }
}

export async function runLoad(
  config,
  actors,
  fixtures,
  { key, fetchImpl = fetch, signal, emit = () => {}, attestationEnvelope } = {},
) {
  const plan = planRun(config, actors, fixtures)
  actors = actors.slice(0, config.users)
  actors.forEach(actorHeaders)
  const controller = new AbortController()
  const stop = () => controller.abort()
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  const deadline = setTimeout(stop, config.maxSeconds * 1000)
  const gate = limiter(config.maxRequests)
  const results = []
  const requests = []
  const requestErrors = []
  const statuses = {}
  let bytesSent = 0
  let sequence = 0
  let requestErrorCount = 0
  let remainingResponseLosses = config.loseCompletionResponses ?? 0
  let injectedResponseLosses = 0
  let failureCode = null
  const tasks = []
  const settle = async (work) => {
    const pending = work.map((fn) =>
      fn().catch((error) => {
        stop()
        throw error
      }),
    )
    tasks.push(...pending)
    const outcomes = await Promise.allSettled(pending)
    const failed = outcomes.find((x) => x.status === 'rejected')
    if (failed) throw failed.reason
  }
  const jsonOnce = async (path, actor, init = {}, bytes = 0) => {
    const scheduled = performance.now()
    return gate(async () => {
      controller.signal.throwIfAborted()
      const started = performance.now()
      let status = 0
      let phase = 'prepare'
      let errorCode = null
      let errorKind = null
      let transportFailure = null
      const timeout = AbortSignal.timeout(30000)
      const requestId = uploadTraceId()
      const transport = transportTrace()
      if (bytesSent + bytes > config.maxBytes) {
        stop()
        throw Error('byte_budget')
      }
      bytesSent += bytes
      try {
        init = typeof init === 'function' ? await init() : init
        phase = 'fetch'
        const res = await transport.run(() =>
          fetchImpl(config.origin + path, {
            ...init,
            redirect: 'error',
            signal: AbortSignal.any([controller.signal, timeout]),
            headers: {
              ...actorHeaders(actor),
              Origin: config.origin,
              ...init.headers,
              'x-load-test-request': requestId,
            },
          }),
        )
        status = res.status
        if (status === 401 || status === 403) {
          stop()
          throw Error('authorization')
        }
        if (status === 429 && config.retry429) {
          const header = res.headers?.get('Retry-After')
          const seconds = header ? Number(header) : NaN
          const delay = Number.isFinite(seconds)
            ? seconds * 1000
            : header
              ? Date.parse(header) - Date.now()
              : 2000
          await res.body?.cancel()
          throw Object.assign(Error('http_429'), {
            retry429: true,
            delayMs: Math.min(
              120000,
              Math.max(1000, (Number.isFinite(delay) ? delay : 2000) + 500),
            ),
          })
        }
        if (!res.ok) {
          errorKind = await classifyHttpFailure(res)
          throw Error('http_' + status)
        }
        phase = 'response_body'
        const data = await res.json()
        if (
          path === '/api/upload/complete' &&
          data.queued === true &&
          remainingResponseLosses > 0
        ) {
          remainingResponseLosses--
          injectedResponseLosses++
          throw Object.assign(new Error('injected response loss'), {
            injected: true,
            retryTransient: true,
            delayMs: 2000,
          })
        }
        return data
      } catch (error) {
        transportFailure = safeTransportFailure(error)
        // Retain bounded diagnostics even when ordinary request samples fill up.
        // Never persist exception text, URLs, request headers or response bodies.
        errorCode = error?.injected
          ? 'injected_response_loss'
          : timeout.aborted || error?.name === 'TimeoutError'
            ? 'request_timeout'
            : controller.signal.aborted
              ? 'run_aborted'
              : status >= 400
                ? 'http_error'
                : phase === 'prepare'
                  ? 'prepare_error'
                  : phase === 'response_body'
                    ? 'response_body_error'
                    : 'network_error'
        if (
          !controller.signal.aborted &&
          ([408, 425, 500, 502, 503, 504].includes(status) ||
            (phase === 'fetch' &&
              status === 0 &&
              ['request_timeout', 'network_error'].includes(errorCode)))
        )
          error.retryTransient = true
        throw error
      } finally {
        statuses[status] = (statuses[status] ?? 0) + 1
        const metric = {
          sequence: ++sequence,
          requestId,
          transport: transport.finish(),
          path: path.split('?')[0],
          status,
          durationMs: performance.now() - started,
          generatorWaitMs: started - scheduled,
        }
        if (errorCode) {
          requestErrorCount++
          if (requestErrors.length < 100)
            requestErrors.push({
              ...metric,
              phase,
              errorCode,
              transportFailure,
              ...(errorKind ? { errorKind } : {}),
            })
        }
        if (requests.length < 5000) requests.push(metric)
        emit({ type: 'request', ...metric })
      }
    })
  }
  const json = async (...args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await jsonOnce(...args)
      } catch (error) {
        const budget = error.retry429
          ? (config.retry429 ?? 0)
          : error.retryTransient
            ? (config.retryTransient ?? 0)
            : 0
        if (attempt >= budget) throw error
        // Release the request slot while backing off; every retransmission still
        // consumes the byte budget and all attempts remain visible in metrics.
        await pause(
          (error.delayMs ?? Math.min(8000, 500 * 2 ** attempt)) + Math.random() * 250,
          controller.signal,
        )
      }
    }
  }
  try {
    let nonce = randomUUID()
    let envelope
    if (attestationEnvelope) {
      const payload = JSON.parse(
        Buffer.from(attestationEnvelope.payload, 'base64url').toString('utf8'),
      )
      if (
        !Number.isFinite(payload.issuedAt) ||
        Date.now() - payload.issuedAt > 60000 ||
        payload.issuedAt > Date.now() + 1000 ||
        typeof payload.nonce !== 'string'
      )
        throw Error('Stale local attestation')
      nonce = payload.nonce
      envelope = attestationEnvelope
    } else {
      envelope = await json(
        '/__loadtest__/attestation?runId=' + encodeURIComponent(config.runId) + '&nonce=' + nonce,
        actors[0],
      )
    }
    verifyAttestation(envelope, key, config, actors, plan, nonce)
    // Finish every identity check before the first mutating request.
    await settle(
      actors.map((actor) => async () => {
        const me = await json('/api/auth/me', actor)
        if (
          me.authenticated !== true ||
          me.username !== actor.username ||
          me.canManagePersonal !== true
        )
          throw Error('Test identity mismatch')
      }),
    )
    await settle(
      actors.map((actor, index) => async () => {
        await pause((config.rampSeconds * 1000 * index) / config.users, controller.signal)
        const jobs = []
        // One file transfer per virtual user. Queue processing is independent.
        for (const fixture of fixtures) {
          const uploadId = randomUUID()
          const started = performance.now()
          const record = {
            actor: index,
            eventId: actor.eventId,
            uploadId,
            file: fixture.name,
            size: fixture.size,
            state: 'started',
          }
          results.push(record)
          emit({ type: 'file', ...record })
          try {
            const totalChunks = Math.ceil(fixture.size / CHUNK)
            for (let i = 0; i < totalChunks; i++) {
              controller.signal.throwIfAborted()
              const length = Math.min(CHUNK, fixture.size - i * CHUNK)
              await json(
                '/api/upload/chunk',
                actor,
                async () => {
                  const chunk = await fixture.readChunk(
                    i * CHUNK,
                    Math.min(fixture.size, (i + 1) * CHUNK),
                  )
                  if (chunk.byteLength !== length) throw Error('fixture_changed')
                  const form = new FormData()
                  form.set('uploadId', uploadId)
                  form.set('totalChunks', String(totalChunks))
                  form.set('chunkIndex', String(i))
                  form.set('chunk', new Blob([chunk]), fixture.name)
                  return { method: 'POST', body: form }
                },
                length,
              )
            }
            record.transferMs = performance.now() - started
            const accepted = await json('/api/upload/complete', actor, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                uploadId,
                totalChunks,
                fileName: fixture.name,
                eventId: actor.eventId,
                folderName: '__loadtest_' + config.runId,
                queuedProcessing: true,
              }),
            })
            const alreadyCompleted =
              accepted.successCount === 1 &&
              Number(accepted.eventId) === actor.eventId &&
              Array.isArray(accepted.results) &&
              accepted.results.length === 1 &&
              integer(Number(accepted.results[0].photoId), 1, 2147483647)
            if (!alreadyCompleted && (accepted.queued !== true || accepted.uploadId !== uploadId))
              throw Error('not_queued_or_duplicate')
            record.state = alreadyCompleted ? 'done' : 'queued'
            record.acceptedAt = performance.now()
            if (alreadyCompleted) record.acceptedToCompletionObservedMs = 0
            else jobs.push(record)
            emit({ type: 'file', ...record })
          } catch {
            record.state = 'failed'
            emit({ type: 'file', ...record })
            // Stop new files for this actor; other already accepted jobs remain durable.
            break
          }
        }
        while (
          jobs.some((j) => !['done', 'failed'].includes(j.state)) &&
          !controller.signal.aborted
        ) {
          await pause(config.pollMs, controller.signal)
          const pending = jobs.filter((j) => !['done', 'failed'].includes(j.state))
          for (let i = 0; i < pending.length; i += 100) {
            const group = pending.slice(i, i + 100)
            const data = await json('/api/upload/status', actor, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uploadIds: group.map((j) => j.uploadId) }),
            })
            if (!Array.isArray(data.jobs)) throw Error('invalid_status')
            for (const record of group) {
              const found = data.jobs.find((j) => j.uploadId === record.uploadId)
              if (!found) continue
              if (found.state === 'processing' && record.firstProcessingObservedMs === undefined)
                record.firstProcessingObservedMs = performance.now() - record.acceptedAt
              if (found.state === 'failed') record.state = 'failed'
              if (found.state === 'done') {
                record.state =
                  found.result?.successCount === 1 && Number(found.result.eventId) === actor.eventId
                    ? 'done'
                    : 'failed'
                record.acceptedToCompletionObservedMs = performance.now() - record.acceptedAt
              }
              emit({ type: 'file', ...record })
            }
          }
        }
      }),
    )
  } catch {
    failureCode = 'run_failed_or_stopped'
    stop()
  } finally {
    await Promise.allSettled(tasks)
    clearTimeout(deadline)
    signal?.removeEventListener('abort', stop)
  }
  for (const r of results) if (!['done', 'failed'].includes(r.state)) r.state = 'unfinished'
  const completed = results.filter((r) => r.state === 'done').length
  const summary = {
    runId: config.runId,
    plan,
    failureCode,
    requestCount: sequence,
    requestSamplesTruncated: sequence > requests.length,
    requestErrorCount,
    requestErrorsTruncated: requestErrorCount > requestErrors.length,
    requestErrors,
    attempted: results.length,
    completed,
    failed: results.filter((r) => r.state === 'failed').length,
    unfinished: results.filter((r) => r.state === 'unfinished').length,
    bytesSent,
    statuses,
    passed: completed === plan.files && !controller.signal.aborted,
    cleanRequests: requestErrorCount === 0,
    retryTransient: config.retryTransient ?? 0,
    injectedResponseLosses,
    results,
    requests,
  }
  emit({ type: 'summary', ...summary })
  return summary
}
