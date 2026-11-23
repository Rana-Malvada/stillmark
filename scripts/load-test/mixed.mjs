import { transportTrace } from './transport-trace.mjs'
import { classifyHttpFailure, safeTransportFailure } from './http-failure.mjs'

export { classifyHttpFailure } from './http-failure.mjs'
import { createHmac, randomUUID } from 'node:crypto'
import { actorHeaders, planRun, runLoad, verifyAttestation } from './harness.mjs'

const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max
export function planMixed(config, actors, fixtures) {
  // Validate all identities/fixtures, then budget only the upload participants.
  if (config.runId?.length > 72) throw Error('Mixed run ID too long')
  for (const key of ['albumThumbnailCount', 'photoThumbnailCount'])
    if (config[key] !== undefined && !integer(config[key], 0, 96)) throw Error('Invalid ' + key)
  if (config.mediaConcurrency !== undefined && !integer(config.mediaConcurrency, 1, 16))
    throw Error('Invalid mediaConcurrency')
  const allBytes = fixtures.reduce((n, f) => n + f.size, 0) * config.users
  const upload = planRun(
    { ...config, maxBytes: Math.max(config.maxBytes, allBytes) },
    actors,
    fixtures,
  )
  for (const [key, min, max] of [
    ['uploadUsers', 0, config.users - 1],
    ['uploadRounds', 1, 100],
    ['durationSeconds', 1, 1800],
    ['warmupSeconds', 0, 300],
    ['thinkMs', 100, 60000],
    ['readRequestBudget', 1, 1000000],
    ['maxReadBytes', 1, 16 * 1024 ** 3],
  ])
    if (!integer(config[key], min, max)) throw Error('Invalid ' + key)
  if (
    config.durationSeconds + config.rampSeconds >= config.maxSeconds ||
    config.warmupSeconds >= config.durationSeconds
  )
    throw Error('Invalid measurement window')
  if (actors.slice(0, config.users).some((a) => !integer(a.browseEventId, 1, 2147483647)))
    throw Error('Owned browsing fixtures required')
  const bytes = (upload.bytes / config.users) * config.uploadUsers * config.uploadRounds
  if (
    !Number.isSafeInteger(config.maxBytes) ||
    config.maxBytes < bytes ||
    (config.uploadUsers && config.maxRequests < 2)
  )
    throw Error('Invalid upload budget or request slots')
  const targets = actors.slice(0, config.uploadUsers).flatMap((a) => {
    if (
      !Array.isArray(a.uploadEventIds) ||
      a.uploadEventIds.length !== config.uploadRounds ||
      a.uploadEventIds[0] !== a.eventId ||
      a.uploadEventIds.some((id) => !integer(id, 1, 2147483647))
    )
      throw Error('Distinct upload round fixtures required')
    return a.uploadEventIds
  })
  if (
    new Set(targets).size !== targets.length ||
    actors.slice(0, config.users).some((a) => targets.includes(a.browseEventId)) ||
    new Set(actors.slice(0, config.users).map((a) => a.browseEventId)).size !== config.users
  )
    throw Error('Fixture albums must be distinct')
  if (config.uploadUsers * fixtures.length * config.uploadRounds > 100000)
    throw Error('Too many upload files')
  return {
    ...upload,
    maxBytes: config.maxBytes,
    files: config.uploadUsers * fixtures.length * config.uploadRounds,
    bytes,
    maxReadBytes: config.maxReadBytes,
    readRequestBudget: config.readRequestBudget,
    uploadUsers: config.uploadUsers,
  }
}

// Logarithmic upper-bound percentiles (~3.6% bucket width), retaining every sample.
export class Histogram {
  buckets = new Map()
  count = 0
  sum = 0
  max = 0
  add(n) {
    if (!Number.isFinite(n) || n < 0) throw Error('Invalid latency')
    const b = Math.ceil(Math.log2(Math.max(1, n)) * 20)
    this.buckets.set(b, (this.buckets.get(b) ?? 0) + 1)
    this.count++
    this.sum += n
    this.max = Math.max(this.max, n)
  }
  summary() {
    const q = (p) => {
      let total = 0
      for (const [b, n] of [...this.buckets].sort((a, b) => a[0] - b[0])) {
        total += n
        if (total >= Math.ceil(this.count * p)) return Math.min(this.max, 2 ** (b / 20))
      }
      return null
    }
    return {
      count: this.count,
      meanMs: this.count ? this.sum / this.count : null,
      p50Ms: q(0.5),
      p95Ms: q(0.95),
      p99Ms: q(0.99),
      maxMs: this.max,
    }
  }
}
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Error('stopped'))
    const stop = () => {
      clearTimeout(timer)
      reject(Error('stopped'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal.addEventListener('abort', stop, { once: true })
  })
function limiter(max) {
  let active = 0
  const waiting = []
  return async (work) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve))
    else active++
    try {
      return await work()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
export function mediaPath(value, origin) {
  if (typeof value !== 'string') throw Error('Missing media')
  const u = new URL(value, origin)
  if (u.origin !== origin || u.pathname !== '/api/images' || u.hash || u.username || u.password)
    throw Error('Media must stay on the isolated app')
  return u.pathname + u.search
}

export async function runMixed(
  config,
  actors,
  fixtures,
  { key, attestationEnvelope, signal, fetchImpl = fetch } = {},
) {
  const plan = planMixed(config, actors, fixtures)
  actors = actors.slice(0, config.users)
  actors.forEach(actorHeaders)
  if (
    typeof attestationEnvelope?.payload !== 'string' ||
    attestationEnvelope.payload.length > 2000000
  )
    throw Error('Missing attestation')
  const payload = JSON.parse(Buffer.from(attestationEnvelope.payload, 'base64url').toString())
  const now = Date.now()
  if (
    !Number.isFinite(payload.issuedAt) ||
    now - payload.issuedAt > 60000 ||
    payload.issuedAt > now + 5000
  )
    throw Error('Stale attestation')
  verifyAttestation(attestationEnvelope, key, config, actors, plan, payload.nonce, now)
  if (
    !integer(payload.maxReadBytes, 1, 16 * 1024 ** 3) ||
    !integer(payload.readRequestBudget, 1, 1000000) ||
    payload.maxReadBytes < config.maxReadBytes ||
    payload.readRequestBudget < config.readRequestBudget ||
    actors
      .slice(0, config.uploadUsers)
      .some((a) =>
        a.uploadEventIds.some(
          (id) =>
            !payload.actors.some(
              (x) => x.username === a.username && x.eventId === id && x.privateFixture === true,
            ),
        ),
      ) ||
    actors.some(
      (a) =>
        !payload.actors.some(
          (x) =>
            x.username === a.username && x.browseEventId === a.browseEventId && x.privateFixture,
        ),
    )
  )
    throw Error('Browsing fixture or budget not attested')
  const controller = new AbortController()
  const stop = () => controller.abort()
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
  const deadline = setTimeout(stop, config.maxSeconds * 1000)
  // Read and upload limits partition the global request budget.
  const uploadSlots = config.uploadUsers ? Math.max(1, Math.floor(config.maxRequests / 5)) : 0
  const gate = limiter(config.maxRequests - uploadSlots)
  let requestCount = 0
  let bytes = 0
  let errors = 0
  let failure = null
  let flows = 0
  let flowErrors = 0
  let missedSchedules = 0
  const metrics = new Map()
  const errorSamples = []
  const requestEvidence = new Map()
  const userResults = []
  let measureAt = Infinity
  let endAt = Infinity
  let began = 0
  let timedPhaseStartedAt = null
  let measurementStartedAt = null
  let measurementEndsAt = null
  let uploadEndedAt = 0
  const inFlight = new Set()
  const metric = (label, measured) => {
    const key = measured + ':' + label
    if (!metrics.has(key))
      metrics.set(key, {
        latency: new Histogram(),
        total: new Histogram(),
        wait: new Histogram(),
        errors: 0,
        statuses: {},
      })
    return metrics.get(key)
  }
  const request = (actor, path, label, { binary = false, denied = false } = {}) => {
    if (!path.startsWith('/api/') || path.startsWith('//')) throw Error('Invalid request path')
    const queued = performance.now()
    const pending = gate(async () => {
      controller.signal.throwIfAborted()
      if (++requestCount > config.readRequestBudget) {
        failure = 'request_budget'
        stop()
        throw Error(failure)
      }
      const start = performance.now()
      const m = metric(label, start < measureAt ? 'warmup' : start < endAt ? 'measured' : 'drain')
      let serverMs = null
      let headersMs = null
      let status = 0
      let failed = true
      let errorKind = null
      let transportFailure = null
      const startedAt = Date.now()
      const requestId = randomUUID()
      const transport = transportTrace()
      try {
        const res = await transport.run(() =>
          fetchImpl(config.origin + path, {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
            headers: {
              ...actorHeaders(actor),
              'x-load-test-request': requestId,
              'x-load-test-kind': label,
            },
          }),
        )
        headersMs = performance.now() - start
        const duration = /(?:^|,)\s*app;dur=([0-9.]+)/.exec(res.headers.get('server-timing') ?? '')
        if (duration && Number.isFinite(Number(duration[1]))) serverMs = Number(duration[1])
        status = res.status
        if (denied && [403, 404].includes(status)) {
          await res.body?.cancel()
          failed = false
          return null
        }
        if (!res.ok || denied) {
          errorKind = await classifyHttpFailure(res)
          throw Error('response_status')
        }
        if (binary && !/^image\//i.test(res.headers.get('content-type') ?? '')) {
          await res.body?.cancel()
          throw Error('not_image')
        }
        const chunks = []
        let size = 0
        if (res.body) {
          const reader = res.body.getReader()
          try {
            for (;;) {
              const chunk = await reader.read()
              if (chunk.done) break
              bytes += chunk.value.length
              size += chunk.value.length
              if (bytes > config.maxReadBytes || size > (binary ? 16 * 1024 ** 2 : 2 * 1024 ** 2)) {
                failure = 'response_byte_budget'
                stop()
                await reader.cancel()
                throw Error(failure)
              }
              if (!binary) chunks.push(chunk.value)
            }
          } catch (e) {
            await reader.cancel().catch(() => {})
            throw e
          } finally {
            reader.releaseLock()
          }
        }
        if (!size) throw Error('empty_response')
        const value = binary ? size : JSON.parse(Buffer.concat(chunks).toString())
        failed = false
        return value
      } catch (error) {
        transportFailure = safeTransportFailure(error)
        errorKind ??= controller.signal.aborted
          ? 'run_canceled'
          : error?.name === 'TimeoutError'
            ? 'request_timeout'
            : 'transport_or_response_error'
        throw error
      } finally {
        const transportMetrics = transport.finish()
        const elapsedMs = performance.now() - start
        if (start >= measureAt && start < endAt && !denied) {
          const bucket = requestEvidence.get(label) ?? { fast: [], slow: [] }
          const evidence = {
            label,
            startedAt,
            requestId,
            status,
            elapsedMs,
            headersMs,
            serverMs,
            generatorWaitMs: start - queued,
            transport: transportMetrics,
          }
          bucket.slow.push(evidence)
          bucket.slow.sort((a, b) => b.elapsedMs - a.elapsedMs)
          bucket.slow.length = Math.min(bucket.slow.length, 10)
          bucket.fast.push(evidence)
          bucket.fast.sort((a, b) => a.elapsedMs - b.elapsedMs)
          bucket.fast.length = Math.min(bucket.fast.length, 10)
          requestEvidence.set(label, bucket)
        }
        m.latency.add(elapsedMs)
        m.total.add(performance.now() - queued)
        m.wait.add(start - queued)
        m.statuses[status] = (m.statuses[status] ?? 0) + 1
        if (failed) {
          errors++
          m.errors++
          if (errorSamples.length < 200)
            errorSamples.push({
              label,
              startedAt,
              status,
              requestId,
              elapsedMs: performance.now() - start,
              headersMs,
              serverMs,
              ...(errorKind ? { errorKind } : {}),
              transportFailure,
              transport: transportMetrics,
            })
          // Permission failure or data mismatch invalidates the run immediately.
          if (status === 401 || status === 403 || denied) {
            failure ??= 'identity_or_isolation'
            stop()
          }
        }
      }
    })
    inFlight.add(pending)
    void pending.finally(() => inFlight.delete(pending)).catch(() => {})
    return pending
  }
  let uploadResult = null
  try {
    // Authenticate all actors before load; never substitute an administrator token.
    for (let offset = 0; offset < actors.length; offset += 20)
      await Promise.all(
        actors.slice(offset, offset + 20).map(async (a, j) => {
          const who = await request(a, '/api/auth/me', 'identity')
          if (who.username !== a.username) {
            failure = 'identity_mismatch'
            stop()
            throw Error(failure)
          }
          if (actors.length > 1)
            await request(
              a,
              `/api/events/${actors[(offset + j + 1) % actors.length].browseEventId}?paged=true`,
              'isolation',
              { denied: true },
            )
        }),
      )
    began = performance.now()
    timedPhaseStartedAt = new Date().toISOString()
    measurementStartedAt = new Date(
      Date.now() + (config.rampSeconds + config.warmupSeconds) * 1000,
    ).toISOString()
    measurementEndsAt = new Date(
      Date.now() + (config.rampSeconds + config.durationSeconds) * 1000,
    ).toISOString()
    measureAt = began + (config.rampSeconds + config.warmupSeconds) * 1000
    endAt = began + (config.rampSeconds + config.durationSeconds) * 1000
    const uploadTask = (async () => {
      if (!config.uploadUsers) return
      const rounds = []
      let usedBytes = 0
      for (
        let round = 0;
        round < config.uploadRounds && performance.now() < endAt && !controller.signal.aborted;
        round++
      ) {
        const group = actors
          .slice(0, config.uploadUsers)
          .map((a) => ({ ...a, eventId: a.uploadEventIds[round] }))
        const remaining = Math.floor((now + config.maxSeconds * 1000 - Date.now()) / 1000)
        if (remaining < 2) {
          failure ??= 'upload_deadline'
          stop()
          break
        }
        const roundConfig = {
          ...config,
          runId: config.runId + '-r' + round,
          users: config.uploadUsers,
          maxRequests: uploadSlots,
          rampSeconds: 0,
          maxSeconds: remaining,
          maxBytes: Math.floor((config.maxBytes - usedBytes) / (config.uploadRounds - round)),
        }
        // Derive only a narrower run from the operator-attested fixture set/budget.
        const signed = {
          ...payload,
          runId: roundConfig.runId,
          issuedAt: Date.now(),
          nonce: randomUUID(),
          maxUsers: config.uploadUsers,
          maxFiles: group.length * fixtures.length,
          maxBytes: roundConfig.maxBytes,
          actors: group.map((a) => ({
            username: a.username,
            eventId: a.eventId,
            privateFixture: true,
          })),
        }
        const encoded = Buffer.from(JSON.stringify(signed)).toString('base64url')
        const envelope = {
          payload: encoded,
          signature: createHmac('sha256', key).update(encoded).digest('hex'),
        }
        const r = await runLoad(roundConfig, group, fixtures, {
          key,
          attestationEnvelope: envelope,
          signal: controller.signal,
          fetchImpl,
        })
        rounds.push(r)
        usedBytes += roundConfig.maxBytes
        if (!r.passed) {
          failure ??= 'upload_failed'
          stop()
          break
        }
      }
      uploadEndedAt = performance.now()
      uploadResult = {
        passed: rounds.length > 0 && rounds.every((x) => x.passed),
        completed: rounds.reduce((n, x) => n + x.completed, 0),
        rounds,
      }
    })()
    const tasks = actors.slice(config.uploadUsers).map(async (a, index) => {
      let completed = 0
      await sleep(
        (config.rampSeconds * 1000 * index) / Math.max(1, actors.length - config.uploadUsers),
        controller.signal,
      )
      while (performance.now() < endAt && !controller.signal.aborted) {
        const due = performance.now() + config.thinkMs
        try {
          const albums = await request(a, '/api/events?paged=true&scope=mine', 'albums')
          if (
            !Array.isArray(albums.items) ||
            albums.items.some((x) => x.ownerUsername !== a.username)
          ) {
            failure = 'album_owner_mismatch'
            stop()
            break
          }
          await Promise.all(
            albums.items
              .filter((x) => x.coverUrl)
              .slice(0, config.albumThumbnailCount ?? 2)
              .map((x) =>
                request(a, mediaPath(x.coverUrl, config.origin), 'album_thumbnail', {
                  binary: true,
                }),
              ),
          )
          if (albums.nextCursor) {
            const next = await request(
              a,
              '/api/events?paged=true&scope=mine&cursor=' + encodeURIComponent(albums.nextCursor),
              'album_page',
            )
            if (
              !Array.isArray(next.items) ||
              next.items.some((x) => x.ownerUsername !== a.username)
            ) {
              failure = 'album_owner_mismatch'
              stop()
              break
            }
          }
          const page = await request(a, `/api/events/${a.browseEventId}?paged=true`, 'photos')
          if (
            !Array.isArray(page.items) ||
            !page.items.length ||
            page.items.some((x) => x.eventId !== a.browseEventId)
          ) {
            failure = 'photo_fixture_mismatch'
            stop()
            break
          }
          if (page.nextCursor) {
            const next = await request(
              a,
              `/api/events/${a.browseEventId}?paged=true&cursor=` +
                encodeURIComponent(page.nextCursor),
              'photo_page',
            )
            if (
              !Array.isArray(next.items) ||
              next.items.some((x) => x.eventId !== a.browseEventId)
            ) {
              failure = 'photo_fixture_mismatch'
              stop()
              break
            }
          }
          const visible = Array.from(
            { length: Math.min(config.photoThumbnailCount ?? 2, page.items.length) },
            (_, i) => page.items[(completed + i) % page.items.length],
          )
          const concurrency = config.mediaConcurrency ?? 6
          for (let start = 0; start < visible.length; start += concurrency)
            await Promise.all(
              visible.slice(start, start + concurrency).map((x) =>
                request(a, mediaPath(x.thumbnailUrl, config.origin), 'thumbnail', {
                  binary: true,
                }),
              ),
            )
          const selected = page.items[completed % page.items.length]
          const photo = await request(a, `/api/photos/${selected.photoId}`, 'photo_detail')
          if (photo.eventId !== a.browseEventId || photo.photoId !== selected.photoId) {
            failure = 'photo_owner_mismatch'
            stop()
            break
          }
          await request(a, mediaPath(photo.displayUrl, config.origin), 'display', { binary: true })
          completed++
          flows++
        } catch {
          if (controller.signal.aborted) break
          flowErrors++
          failure ??= 'flow_failed'
          stop()
          break
        }
        const wait = due - performance.now()
        if (wait < 0) missedSchedules++
        if (performance.now() < endAt)
          await sleep(Math.max(0, Math.min(wait, endAt - performance.now())), controller.signal)
      }
      userResults.push({ actorIndex: index + config.uploadUsers, flows: completed })
    })
    const outcomes = await Promise.allSettled([...tasks, uploadTask])
    if (outcomes.some((x) => x.status === 'rejected')) failure ??= 'workload_task_failed'
    if (controller.signal.aborted) failure ??= 'stopped_or_deadline'
  } catch {
    failure ??= 'preflight_failed'
    stop()
  } finally {
    await Promise.allSettled(inFlight)
    clearTimeout(deadline)
    signal?.removeEventListener('abort', stop)
  }
  const operations = Object.fromEntries(
    [...metrics].map(([name, m]) => [
      name,
      {
        ...m.latency.summary(),
        generatorWait: m.wait.summary(),
        endToEnd: m.total.summary(),
        errors: m.errors,
        statuses: m.statuses,
      },
    ]),
  )
  const uploadCoveredMeasurement = !config.uploadUsers || uploadEndedAt >= endAt
  const measuredRequests = Object.entries(operations)
    .filter(([k]) => k.startsWith('measured:'))
    .reduce((n, [, v]) => n + v.count, 0)
  const passed =
    !failure &&
    flowErrors === 0 &&
    errors === 0 &&
    userResults.length === actors.length - config.uploadUsers &&
    userResults.every((x) => x.flows > 0) &&
    (!config.uploadUsers || uploadResult?.passed)
  return {
    workload: 'mixed',
    clientModel: 'API simulation; excludes browser rendering and Auth0',
    mediaPerFlow: {
      albumCovers: config.albumThumbnailCount ?? 2,
      photoThumbnails: config.photoThumbnailCount ?? 2,
    },
    browsingRequestsOnly: true,
    timedPhaseStartedAt,
    measurementStartedAt,
    measurementEndsAt,
    passed,
    capacityEligible: passed && uploadCoveredMeasurement && measuredRequests > 0,
    uploadCoveredMeasurement,
    measuredRequests,
    failure,
    requestCount,
    requestErrorCount: errors,
    flowErrorCount: flowErrors,
    bytesReceived: bytes,
    flows,
    missedSchedules,
    userResults,
    operations,
    errorSamples,
    requestEvidence: Object.fromEntries(requestEvidence),
    upload: uploadResult,
    completed: uploadResult?.completed ?? 0,
    activeUsers: config.users,
    measurementSeconds: config.durationSeconds - config.warmupSeconds,
    percentileMethod: 'logarithmic upper bounds; 20 buckets per power of two',
  }
}
