import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { classifyHttpFailure, Histogram, mediaPath, planMixed, runMixed } from './mixed.mjs'

const origin = 'https://isolated.example.test'
const key = 'k'.repeat(32)
const fixtures = [
  {
    name: 'synthetic-1.jpg',
    size: 100,
    sha256: 'a'.repeat(64),
    readChunk: async () => Buffer.alloc(100),
  },
]
const actors = [
  { username: 'u1', token: 'test1', eventId: 1, browseEventId: 11, uploadEventIds: [1] },
  { username: 'u2', token: 'test2', eventId: 2, browseEventId: 12 },
]
function config(extra = {}) {
  return {
    origin,
    runId: 'mixed-test-01',
    users: 2,
    filesPerUser: 1,
    maxRequests: 4,
    maxSeconds: 15,
    rampSeconds: 0,
    pollMs: 500,
    maxBytes: 200,
    uploadUsers: 0,
    uploadRounds: 1,
    durationSeconds: 1,
    warmupSeconds: 0,
    thinkMs: 100,
    readRequestBudget: 1000,
    maxReadBytes: 100000,
    ...extra,
  }
}
function envelope(c, extra = {}) {
  const p = {
    issuedAt: Date.now(),
    expiresAt: Date.now() + c.maxSeconds * 1000 + 10000,
    nonce: 'fixture',
    runId: c.runId,
    origin,
    isolated: true,
    aiDisabled: true,
    batchesDisabled: true,
    databaseId: 'isolated',
    stageId: 'isolated',
    appService: 'isolated',
    maxUsers: 2,
    maxFiles: 100,
    maxBytes: c.maxBytes,
    maxReadBytes: c.maxReadBytes,
    readRequestBudget: c.readRequestBudget,
    actors: actors.map((a) => ({ ...a, privateFixture: true })),
    ...extra,
  }
  const payload = Buffer.from(JSON.stringify(p)).toString('base64url')
  return { payload, signature: createHmac('sha256', key).update(payload).digest('hex') }
}
function responder({ leak = false, external = false, onRequest = () => {} } = {}) {
  return async (url, options) => {
    const u = new URL(url)
    const a = options.headers.Authorization.includes('test1') ? actors[0] : actors[1]
    onRequest(u, options)
    if (u.pathname === '/api/auth/me') return Response.json({ username: a.username })
    if (u.pathname === '/api/events')
      return Response.json({
        items: [{ ownerUsername: a.username }],
        nextCursor: u.searchParams.has('cursor') ? null : 'next',
      })
    if (u.pathname.startsWith('/api/events/')) {
      const id = Number(u.pathname.split('/').pop())
      if (id !== a.browseEventId && !leak) return Response.json({}, { status: 403 })
      return Response.json({
        items: [{ eventId: id, photoId: id * 10, thumbnailUrl: '/api/images?path=thumb' }],
        nextCursor: u.searchParams.has('cursor') ? null : 'next',
      })
    }
    if (u.pathname.startsWith('/api/photos/'))
      return Response.json({
        eventId: a.browseEventId,
        photoId: a.browseEventId * 10,
        displayUrl: external ? 'https://production.example/image' : '/api/images?path=display',
      })
    if (u.pathname === '/api/images')
      return new Response(Buffer.alloc(20), { headers: { 'content-type': 'image/jpeg' } })
    throw Error('Unexpected route')
  }
}
test('histograms retain all samples beyond detail sample cap', () => {
  const h = new Histogram()
  for (let i = 0; i < 10000; i++) h.add(i < 9900 ? 10 : 1000)
  const s = h.summary()
  assert.equal(s.count, 10000)
  assert.equal(s.maxMs, 1000)
  assert.ok(s.p99Ms < 11)
  assert.ok(s.meanMs > 10)
})
test('reject unsafe origins, media paths, missing fixtures, reused albums and zero read slots', () => {
  assert.throws(() => mediaPath('https://other.example/api/images', origin))
  assert.throws(() => mediaPath('/api/auth/me', origin))
  assert.equal(mediaPath('/api/images?path=x', origin), '/api/images?path=x')
  assert.throws(() =>
    planMixed(config({ origin: 'https://photos.stillmark.example' }), actors, fixtures),
  )
  assert.throws(() =>
    planMixed(config(), [{ ...actors[0], browseEventId: undefined }, actors[1]], fixtures),
  )
  assert.throws(() => planMixed(config({ uploadUsers: 1, maxRequests: 1 }), actors, fixtures))
  assert.throws(() =>
    planMixed(
      config({ uploadUsers: 1 }),
      [{ ...actors[0], browseEventId: 1 }, actors[1]],
      fixtures,
    ),
  )
  assert.equal(planMixed(config({ uploadUsers: 1, maxBytes: 100 }), actors, fixtures).bytes, 100)
})
test('read limits must be explicitly signed; no network request on invalid attestation', async () => {
  const c = config()
  let called = false
  await assert.rejects(
    runMixed(c, actors, fixtures, {
      key,
      attestationEnvelope: envelope(c, { maxReadBytes: undefined }),
      fetchImpl: () => {
        called = true
      },
    }),
    /budget/,
  )
  assert.equal(called, false)
})
test('browsing exercises pagination, actual media bytes and isolation checks', async () => {
  const c = config()
  const paths = []
  const r = await runMixed(c, actors, fixtures, {
    key,
    attestationEnvelope: envelope(c),
    fetchImpl: responder({
      onRequest: (u, options) => {
        paths.push(u.pathname + u.search)
        assert.match(options.headers['x-load-test-kind'], /^[a-z_]+$/)
        assert.match(options.headers['x-load-test-request'], /^[a-f0-9-]{36}$/)
      },
    }),
  })
  assert.equal(r.passed, true)
  assert.equal(r.capacityEligible, true)
  assert.ok(r.flows >= 2)
  for (const [label, bucket] of Object.entries(r.requestEvidence)) {
    assert.ok(bucket.slow.length > 0 && bucket.slow.length <= 10)
    assert.ok(bucket.fast.length > 0 && bucket.fast.length <= 10)
    assert.ok(bucket.slow[0].elapsedMs >= bucket.fast[0].elapsedMs)
    for (const entry of [...bucket.fast, ...bucket.slow]) {
      assert.equal(entry.label, label)
      assert.match(entry.requestId, /^[a-f0-9-]{36}$/)
      assert.ok(entry.elapsedMs >= entry.headersMs)
      assert.equal(entry.serverMs, null)
      assert.ok(!JSON.stringify(entry).includes('Authorization'))
    }
  }
  assert.ok(r.bytesReceived > 100)
  assert.ok(r.operations['measured:thumbnail'].count > 0)
  assert.ok(r.operations['measured:display'].endToEnd.count > 0)
  assert.ok(paths.some((p) => p.includes('cursor=')))
  assert.equal(r.operations['warmup:isolation'].statuses[403], 2)
})
test('cross-user fixture exposure aborts before load', async () => {
  const c = config()
  const r = await runMixed(c, actors, fixtures, {
    key,
    attestationEnvelope: envelope(c),
    fetchImpl: responder({ leak: true }),
  })
  assert.equal(r.passed, false)
  assert.equal(r.failure, 'identity_or_isolation')
  assert.equal(r.flows, 0)
})
test('never follows external media targets', async () => {
  const c = config()
  const r = await runMixed(c, actors, fixtures, {
    key,
    attestationEnvelope: envelope(c),
    fetchImpl: responder({ external: true, onRequest: (u) => assert.equal(u.origin, origin) }),
  })
  assert.equal(r.passed, false)
  assert.equal(r.flows, 0)
})
test('request and byte ceilings stop load', async () => {
  for (const extra of [{ readRequestBudget: 5 }, { maxReadBytes: 10 }]) {
    const c = config(extra)
    const r = await runMixed(c, actors, fixtures, {
      key,
      attestationEnvelope: envelope(c),
      fetchImpl: responder(),
    })
    assert.equal(r.passed, false)
    assert.match(r.failure, /budget/)
  }
})
test('abort drains active requests and does not leak credentials into errors', async () => {
  const c = config()
  const ac = new AbortController()
  let active = 0
  const promise = runMixed(c, actors, fixtures, {
    key,
    signal: ac.signal,
    attestationEnvelope: envelope(c),
    fetchImpl: async (_url, { signal }) => {
      active++
      try {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(Error('test1 secret')), { once: true })
        })
      } finally {
        active--
      }
    },
  })
  setTimeout(() => ac.abort(), 20)
  const r = await promise
  assert.equal(r.passed, false)
  assert.equal(active, 0)
  assert.ok(!JSON.stringify(r).includes('test1 secret'))
})
test('mixed runs derive bounded upload rounds, do not claim sustained overlap after exhaustion', async () => {
  const c = config({ uploadUsers: 1, maxBytes: 100 })
  const base = responder()
  let posts = 0
  const r = await runMixed(c, actors, fixtures, {
    key,
    attestationEnvelope: envelope(c),
    fetchImpl: async (url, opt) => {
      const u = new URL(url)
      if (u.pathname === '/api/auth/me')
        return Response.json({
          username: opt.headers.Authorization.includes('test1') ? 'u1' : 'u2',
          authenticated: true,
          canManagePersonal: true,
        })
      if (u.pathname === '/api/upload/chunk') {
        posts++
        return Response.json({ ok: true })
      }
      if (u.pathname === '/api/upload/complete') {
        posts++
        const b = JSON.parse(opt.body)
        return Response.json({ successCount: 1, eventId: b.eventId, results: [{ photoId: 1 }] })
      }
      return base(url, opt)
    },
  })
  assert.equal(posts, 2)
  assert.equal(r.passed, true)
  assert.equal(r.upload.completed, 1)
  assert.equal(r.uploadCoveredMeasurement, false)
  assert.equal(r.capacityEligible, false)
})
test('every upload round must be operator-attested before any traffic', async () => {
  const c = config({ uploadUsers: 1, uploadRounds: 2, maxBytes: 200 })
  let called = 0
  await assert.rejects(
    runMixed(c, [{ ...actors[0], uploadEventIds: [1, 3] }, actors[1]], fixtures, {
      key,
      attestationEnvelope: envelope(c),
      fetchImpl: () => called++,
    }),
    /attested/,
  )
  assert.equal(called, 0)
})
test('partial successful browsing cannot hide a later invalid media target', async () => {
  const c = config()
  let n = 0
  const base = responder()
  const r = await runMixed(c, actors, fixtures, {
    key,
    attestationEnvelope: envelope(c),
    fetchImpl: async (url, opt) => {
      if (url.includes('/api/photos/') && ++n > 2)
        return Response.json({
          eventId: opt.headers.Authorization.includes('test1') ? 11 : 12,
          photoId: opt.headers.Authorization.includes('test1') ? 110 : 120,
          displayUrl: 'https://wrong.example/api/images',
        })
      return base(url, opt)
    },
  })
  assert.ok(r.flows > 0)
  assert.equal(r.passed, false)
  assert.equal(r.failure, 'flow_failed')
})

test('HTTP errors retain only allowlisted categories and cap response consumption', async () => {
  assert.equal(
    await classifyHttpFailure(
      Response.json(
        { error: 'Authentication is temporarily busy. Please retry.' },
        { status: 503 },
      ),
    ),
    'authentication_busy',
  )
  assert.equal(
    await classifyHttpFailure(
      new Response('upstream connect error: private-token', { status: 503 }),
    ),
    'upstream_unavailable',
  )
  assert.equal(
    await classifyHttpFailure(new Response('private-token', { status: 503 })),
    'http_error',
  )
  let cancelled = false
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(2048))
    },
    cancel() {
      cancelled = true
    },
  })
  assert.equal(await classifyHttpFailure(new Response(body, { status: 503 })), 'http_error')
  assert.equal(cancelled, true)
})

test('read transport failures have safe categories without retaining error messages', async () => {
  const c = config()
  const respond = responder()
  const result = await runMixed(c, actors, fixtures, {
    key,
    attestationEnvelope: envelope(c),
    fetchImpl: async (url, options) => {
      if (new URL(url).pathname === '/api/events')
        throw new DOMException('secret-token-do-not-record', 'TimeoutError')
      return respond(url, options)
    },
  })
  assert.equal(result.passed, false)
  assert.ok(result.errorSamples.some((sample) => sample.errorKind === 'request_timeout'))
  assert.ok(result.errorSamples.every((sample) => typeof sample.transport === 'object'))
  assert.equal(JSON.stringify(result).includes('secret-token-do-not-record'), false)
})

test('classifies the fixed app failure marker without retaining arbitrary response text', async () => {
  assert.equal(
    await classifyHttpFailure(
      new Response(JSON.stringify({ error: 'Request failed. Please try again.' }), { status: 500 }),
    ),
    'application_request_failed',
  )
  assert.equal(
    await classifyHttpFailure(
      new Response(JSON.stringify({ error: 'private arbitrary message' }), { status: 500 }),
    ),
    'http_error',
  )
})

test('keeps response-boundary timing on a warm-up failure', async () => {
  const c = config({ durationSeconds: 2, warmupSeconds: 1 })
  const normal = responder()
  const result = await runMixed(c, actors, fixtures, {
    key,
    attestationEnvelope: envelope(c),
    fetchImpl: (url, options) =>
      new URL(url).pathname === '/api/events'
        ? Promise.resolve(
            new Response(JSON.stringify({ error: 'Request failed. Please try again.' }), {
              status: 500,
              headers: { 'server-timing': 'app;dur=12.5' },
            }),
          )
        : normal(url, options),
  })
  const first = result.errorSamples.find((x) => x.errorKind === 'application_request_failed')
  assert.ok(first)
  assert.equal(first.serverMs, 12.5)
  assert.ok(Number.isFinite(first.headersMs))
  assert.equal(result.passed, false)
})
