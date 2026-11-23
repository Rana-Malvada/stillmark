import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { planRun, runLoad, uploadTraceId, verifyAttestation } from './harness.mjs'

const key = 'test-key-that-is-at-least-thirty-two-bytes'
const config = {
  origin: 'https://isolated.example.test',
  runId: 'test-run-0001',
  users: 2,
  maxRequests: 2,
  filesPerUser: 1,
  maxSeconds: 5,
  rampSeconds: 0,
  pollMs: 500,
  maxBytes: 100,
}
const actors = [
  { username: 'one', eventId: 1, cookie: 'session=one' },
  { username: 'two', eventId: 2, cookie: 'session=two' },
]
const fixtures = [
  {
    name: 'synthetic.jpg',
    size: 10,
    sha256: 'a'.repeat(64),
    readChunk: async (a, b) => Buffer.alloc(b - a),
  },
]
function signed(c, nonce, patch = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      nonce,
      runId: c.runId,
      origin: c.origin,
      isolated: true,
      aiDisabled: true,
      batchesDisabled: true,
      databaseId: 'isolated-db',
      stageId: 'isolated-stage',
      appService: 'isolated-app',
      expiresAt: Date.now() + 60000,
      maxUsers: 2,
      maxFiles: 2,
      maxBytes: c.maxBytes,
      actors: actors.map((a) => ({ ...a, cookie: undefined, privateFixture: true })),
      ...patch,
    }),
  ).toString('base64url')
  return { payload, signature: createHmac('sha256', key).update(payload).digest('hex') }
}
function server(c, { wrongIdentity = false, wrongSignature = false, slow = false } = {}) {
  const calls = []
  const jobs = new Map()
  let identities = 0
  let active = 0
  let peak = 0
  return {
    calls,
    get peak() {
      return peak
    },
    fetch: async (url, init) => {
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise((r) => setTimeout(r, 2))
        init.signal.throwIfAborted()
        const u = new URL(url)
        calls.push({ path: u.pathname, method: init.method ?? 'GET' })
        let data
        if (u.pathname === '/__loadtest__/attestation') {
          data = signed(c, u.searchParams.get('nonce'))
          if (wrongSignature) data.signature = '0'.repeat(64)
        } else if (u.pathname === '/api/auth/me') {
          identities++
          data = {
            authenticated: true,
            username: wrongIdentity ? 'wrong' : init.headers.Cookie.split('=')[1],
            canManagePersonal: true,
          }
        } else {
          assert.equal(identities, c.users, 'all identities checked before writes')
          if (u.pathname === '/api/upload/chunk') data = { ok: true }
          if (u.pathname === '/api/upload/complete') {
            const body = JSON.parse(init.body)
            jobs.set(body.uploadId, body.eventId)
            data = { queued: true, uploadId: body.uploadId }
          }
          if (u.pathname === '/api/upload/status')
            data = {
              jobs: JSON.parse(init.body).uploadIds.map((uploadId) => ({
                uploadId,
                state: slow ? 'processing' : 'done',
                result: { successCount: 1, eventId: jobs.get(uploadId) },
              })),
            }
        }
        return { status: 200, ok: true, json: async () => data }
      } finally {
        active--
      }
    },
  }
}
test('planning is offline and rejects production, duplicate users, and budget overruns', () => {
  assert.equal(planRun(config, actors, fixtures).bytes, 20)
  for (const origin of [
    'https://photos.stillmark.example',
    'http://isolated.example.test',
    'https://isolated.example.test/path',
  ])
    assert.throws(() => planRun({ ...config, origin }, actors, fixtures))
  assert.throws(() => planRun(config, [actors[0], actors[0]], fixtures))
  assert.throws(() => planRun({ ...config, maxBytes: 19 }, actors, fixtures))
})
test('attestation binds origin, budgets, identity and disabled AI', () => {
  const plan = planRun(config, actors, fixtures)
  assert.equal(
    verifyAttestation(signed(config, 'nonce'), key, config, actors, plan, 'nonce').isolated,
    true,
  )
  for (const patch of [
    { aiDisabled: false },
    { batchesDisabled: false },
    { origin: 'https://wrong.test' },
    { maxBytes: 1 },
    { actors: [] },
    { expiresAt: 0 },
  ])
    assert.throws(() =>
      verifyAttestation(signed(config, 'nonce', patch), key, config, actors, plan, 'nonce'),
    )
})
test('invalid isolation or identity causes no uploads', async () => {
  for (const options of [{ wrongIdentity: true }, { wrongSignature: true }]) {
    const mock = server(config, options)
    const result = await runLoad(config, actors, fixtures, { key, fetchImpl: mock.fetch })
    assert.equal(result.passed, false)
    assert.equal(result.attempted, 0)
    assert.equal(mock.calls.filter((x) => x.method === 'POST').length, 0)
  }
})
test('two users upload independently with bounded requests and complete exactly once', async () => {
  const mock = server(config)
  const result = await runLoad(config, actors, fixtures, { key, fetchImpl: mock.fetch })
  assert.equal(result.passed, true)
  assert.equal(result.completed, 2)
  assert.equal(result.bytesSent, 20)
  assert.ok(mock.peak <= 2)
  assert.equal(new Set(result.results.map((r) => r.uploadId)).size, 2)
  assert.ok(result.results.every((r) => r.transferMs >= 0 && r.acceptedToCompletionObservedMs >= 0))
  assert.ok(!JSON.stringify(result).includes('session='))
})
test('deadline settles workers before returning, with durable jobs marked unfinished', async () => {
  const c = { ...config, maxSeconds: 1 }
  const mock = server(c, { slow: true })
  let events = 0
  const result = await runLoad(c, actors, fixtures, {
    key,
    fetchImpl: mock.fetch,
    emit: () => events++,
  })
  assert.equal(result.passed, false)
  assert.equal(result.unfinished, 2)
  const count = events
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(events, count)
})
test('8 MiB chunk boundaries and byte accounting', async () => {
  const size = 8 * 1024 * 1024 + 1
  const c = { ...config, users: 1, maxBytes: size }
  const ranges = []
  const f = {
    ...fixtures[0],
    size,
    readChunk: async (a, b) => {
      ranges.push([a, b])
      return Buffer.alloc(b - a)
    },
  }
  const mock = server(c)
  const result = await runLoad(c, actors, [f], { key, fetchImpl: mock.fetch })
  assert.equal(result.passed, true)
  assert.deepEqual(ranges, [
    [0, 8 * 1024 * 1024],
    [8 * 1024 * 1024, size],
  ])
  assert.equal(result.bytesSent, size)
})

test('CLI dry-run cannot access network and does not expose cookies', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { createHash } = await import('node:crypto')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const dir = await mkdtemp(join(tmpdir(), 'stillmark-load-test-'))
  try {
    const bytes = Buffer.alloc(10)
    await writeFile(join(dir, 'synthetic.jpg'), bytes)
    await writeFile(join(dir, 'actors.json'), JSON.stringify(actors), { mode: 0o600 })
    await writeFile(
      join(dir, 'no-network.mjs'),
      "globalThis.fetch=()=>{throw Error('Network forbidden in dry run')}",
    )
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        ...config,
        actorsFile: 'actors.json',
        fixtures: [
          { path: 'synthetic.jpg', sha256: createHash('sha256').update(bytes).digest('hex') },
        ],
      }),
    )
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import',
      join(dir, 'no-network.mjs'),
      resolve('scripts/load-test/run.mjs'),
      join(dir, 'config.json'),
    ])
    assert.equal(JSON.parse(stdout).mode, 'dry-run')
    assert.ok(!stdout.includes('session='))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chunk buffers are read only after obtaining request capacity', async () => {
  const c = { ...config, maxRequests: 1 }
  const mock = server(c)
  let activeReads = 0
  let peak = 0
  const fixture = {
    ...fixtures[0],
    readChunk: async (a, b) => {
      activeReads++
      peak = Math.max(peak, activeReads)
      await new Promise((r) => setTimeout(r, 10))
      activeReads--
      return Buffer.alloc(b - a)
    },
  }
  const result = await runLoad(c, actors, [fixture], { key, fetchImpl: mock.fetch })
  assert.equal(result.passed, true)
  assert.equal(peak, 1)
})

test('restricted token authentication does not send cookies or expose tokens', async () => {
  const { actorHeaders } = await import('./harness.mjs')
  assert.deepEqual(actorHeaders({ token: 'synthetic.test.token' }), {
    Authorization: 'Snowflake Token="synthetic.test.token"',
  })
  assert.throws(() => actorHeaders({ cookie: 'x', token: 'y' }))
  assert.throws(() => actorHeaders({ token: 'x\r\ny' }))
  assert.throws(() => actorHeaders({ token: 'x"y' }))
  assert.throws(() => actorHeaders({ token: 'x\\y' }))
})
test('fresh signed local attestation avoids needing a test endpoint on the app', async () => {
  const mock = server(config)
  const result = await runLoad(config, actors, fixtures, {
    key,
    fetchImpl: mock.fetch,
    attestationEnvelope: signed(config, 'local-nonce', { issuedAt: Date.now() }),
  })
  assert.equal(result.passed, true)
  assert.equal(mock.calls.filter((x) => x.path === '/__loadtest__/attestation').length, 0)
  const stale = server(config)
  const failed = await runLoad(config, actors, fixtures, {
    key,
    fetchImpl: stale.fetch,
    attestationEnvelope: signed(config, 'local-nonce', { issuedAt: Date.now() - 61000 }),
  })
  assert.equal(failed.passed, false)
  assert.equal(stale.calls.length, 0)
})

test('429 retries honor backpressure, retain failures in metrics and count retransmitted bytes', async () => {
  const c = { ...config, retry429: 2, maxSeconds: 10 }
  const mock = server(c)
  let busy = true
  const result = await runLoad(c, actors, fixtures, {
    key,
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/api/upload/chunk' && busy) {
        busy = false
        return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } })
      }
      return mock.fetch(url, init)
    },
  })
  assert.equal(result.passed, true)
  assert.equal(result.statuses[429], 1)
  assert.equal(result.bytesSent, 30)
})

test('429 retries cannot exceed the byte budget', async () => {
  const c = { ...config, retry429: 2, maxBytes: 20, maxSeconds: 10 }
  const mock = server(c)
  const result = await runLoad(c, actors, fixtures, {
    key,
    fetchImpl: async (url, init) =>
      new URL(url).pathname === '/api/upload/chunk'
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '0' } })
        : mock.fetch(url, init),
  })
  assert.equal(result.passed, false)
  assert.equal(result.bytesSent, 20)
  assert.equal(result.statuses[429], 2)
})

test('retains sanitized status-poll timeout diagnostics', async () => {
  const c = { ...config, users: 1 }
  const mock = server(c)
  const summary = await runLoad(c, actors, fixtures, {
    key,
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname === '/api/upload/status')
        throw new DOMException('secret credential and response content', 'TimeoutError')
      return mock.fetch(url, init)
    },
  })
  assert.equal(summary.passed, false)
  assert.equal(summary.requestErrorCount, 1)
  assert.equal(summary.requestErrors[0].path, '/api/upload/status')
  assert.equal(summary.requestErrors[0].phase, 'fetch')
  assert.equal(summary.requestErrors[0].errorCode, 'request_timeout')
  assert.equal(summary.requestErrors[0].status, 0)
  assert.equal(JSON.stringify(summary).includes('secret credential'), false)
})

test('retains late errors after the normal request sample cap', async () => {
  const c = { ...config, users: 5000, maxRequests: 256, maxBytes: 50000, maxSeconds: 30 }
  const manyActors = Array.from({ length: c.users }, (_, i) => ({
    username: `actor${i}`,
    eventId: i + 1,
    cookie: `session=actor${i}`,
  }))
  let releaseLateError
  const samplesFull = new Promise((resolve) => {
    releaseLateError = resolve
  })
  const summary = await runLoad(c, manyActors, fixtures, {
    emit: (event) => {
      if (event.type === 'request' && event.sequence === 5000) releaseLateError()
    },
    key,
    fetchImpl: async (url, init) => {
      const u = new URL(url)
      if (u.pathname === '/__loadtest__/attestation')
        return {
          status: 200,
          ok: true,
          json: async () =>
            signed(c, u.searchParams.get('nonce'), {
              maxUsers: c.users,
              maxFiles: c.users,
              actors: manyActors.map(({ username, eventId }) => ({
                username,
                eventId,
                privateFixture: true,
              })),
            }),
        }
      const username = init.headers.Cookie.split('=')[1]
      if (username === 'actor4999') {
        await samplesFull
        throw new TypeError('private network details')
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ authenticated: true, username, canManagePersonal: true }),
      }
    },
  })
  assert.equal(summary.requests.length, 5000)
  assert.equal(summary.requestSamplesTruncated, true)
  assert.equal(summary.requestErrors.length, 1)
  assert.equal(summary.requestErrors[0].sequence, 5001)
  assert.equal(summary.requestErrors[0].errorCode, 'network_error')
  assert.equal(summary.attempted, 0)
  assert.equal(JSON.stringify(summary).includes('private network details'), false)
})

test('optional transient retry reuses completion ID and retains the failed attempt', async () => {
  const c = { ...config, users: 1, retryTransient: 2 }
  const mock = server(c)
  let failed = false
  const ids = []
  const result = await runLoad(c, actors.slice(0, 1), fixtures, {
    key,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/upload/complete')) {
        ids.push(JSON.parse(init.body).uploadId)
        if (!failed) {
          failed = true
          return { ok: false, status: 503, json: async () => ({}) }
        }
      }
      return mock.fetch(url, init)
    },
  })
  assert.equal(result.passed, true)
  assert.equal(result.cleanRequests, false)
  assert.equal(result.requestErrorCount, 1)
  assert.equal(result.requestErrors[0].status, 503)
  assert.equal(ids.length, 2)
  assert.equal(new Set(ids).size, 1)
})
test('transient retry budget is finite and does not retry permission errors', async () => {
  for (const status of [503, 403]) {
    const c = { ...config, users: 1, retryTransient: 1 }
    const mock = server(c)
    let calls = 0
    const result = await runLoad(c, actors.slice(0, 1), fixtures, {
      key,
      fetchImpl: async (url, init) => {
        if (url.endsWith('/api/upload/complete')) {
          calls++
          return { ok: false, status, json: async () => ({}) }
        }
        return mock.fetch(url, init)
      },
    })
    assert.equal(result.passed, false)
    assert.equal(calls, status === 503 ? 2 : 1)
  }
})

test('lost completion response can recover the completed result with the same ID', async () => {
  const c = { ...config, users: 1, retryTransient: 1 }
  const mock = server(c)
  let id
  let calls = 0
  const result = await runLoad(c, actors.slice(0, 1), fixtures, {
    key,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/upload/complete')) {
        calls++
        const body = JSON.parse(init.body)
        if (calls === 1) {
          id = body.uploadId
          await mock.fetch(url, init)
          throw new TypeError('simulated response lost')
        }
        assert.equal(body.uploadId, id)
        return {
          ok: true,
          status: 200,
          json: async () => ({ eventId: body.eventId, successCount: 1, results: [{ photoId: 1 }] }),
        }
      }
      return mock.fetch(url, init)
    },
  })
  assert.equal(result.passed, true)
  assert.equal(result.completed, 1)
  assert.equal(result.requestErrorCount, 1)
  assert.equal(result.results[0].uploadId, id)
})

test('bounded response-loss injection is reported separately and recovers', async () => {
  const c = { ...config, users: 1, maxSeconds: 8, retryTransient: 1, loseCompletionResponses: 1 }
  const mock = server(c)
  const result = await runLoad(c, actors.slice(0, 1), fixtures, { key, fetchImpl: mock.fetch })
  assert.equal(result.passed, true)
  assert.equal(result.injectedResponseLosses, 1)
  assert.equal(result.requestErrors[0].errorCode, 'injected_response_loss')
  assert.equal(result.requestErrors[0].status, 200)
  assert.throws(() => planRun({ ...c, loseCompletionResponses: 11 }, actors, fixtures))
})

test('upload failures distinguish app backpressure from upstream failures without storing bodies', async () => {
  const mock = server(config)
  const r = await runLoad(config, actors, fixtures, {
    key,
    fetchImpl: async (url, init) =>
      new URL(url).pathname === '/api/upload/chunk'
        ? new Response('upstream connect error: private-provider-detail', { status: 503 })
        : mock.fetch(url, init),
  })
  assert.equal(r.passed, false)
  assert.ok(r.requestErrors.some((x) => x.errorKind === 'upstream_unavailable'))
  assert.equal(JSON.stringify(r).includes('private-provider-detail'), false)
})

test('upload attempt IDs remain unique and always enter deterministic diagnostics', () => {
  const ids = Array.from({ length: 1000 }, uploadTraceId)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) {
    assert.match(id, /^00000000-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
    for (const every of [1, 64, 256, 65536]) assert.equal(parseInt(id.slice(0, 8), 16) % every, 0)
  }
})
