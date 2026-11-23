import test from 'node:test'
import assert from 'node:assert/strict'
import { CredentialLogPoll } from './credential-log-poll.mjs'

const KEY = 'credential-log-poll:v1'
const config = {
  AUTH0_LOG_POLL_ENABLED: 'true',
  AUTH0_LOG_TENANT_DOMAIN: 'tenant.us.auth0.com',
  AUTH0_DOMAIN: 'login.example.com',
  AUTH0_LOG_CLIENT_ID: 'read-only',
  AUTH0_LOG_CLIENT_SECRET: 'synthetic-secret',
}
const base = Date.now()
const row = (id, type = 'scp') => ({
  log_id: String(id),
  type,
  user_id: 'auth0|synthetic-' + id,
  date: new Date(base - 3600000).toISOString(),
})
function fixture(options = {}) {
  const data = new Map()
  let time = base
  let tokens = 0
  let pages = 0
  let fail = false
  const delivered = []
  const paths = []
  let source = options.rows ?? [row(1, 's'), row(2), row(3, 'scpr')]
  const storage = {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => {
      data.set(k, structuredClone(v))
    },
  }
  const enqueue = async (e) => {
    if (fail) throw Error('private-secret-recovery-error')
    delivered.push(e)
    return Response.json({ durable: true }, { status: 202 })
  }
  const request = async (input, init) => {
    const url = new URL(input)
    paths.push(url)
    assert.equal(init.redirect, 'manual')
    assert.ok(init.signal)
    if (url.pathname === '/oauth/token') {
      tokens++
      assert.equal(JSON.parse(init.body).audience, 'https://tenant.us.auth0.com/api/v2/')
      return Response.json({
        access_token: 'synthetic-token',
        expires_in: 86400,
        token_type: 'Bearer',
      })
    }
    pages++
    assert.equal(init.headers.Authorization, 'Bearer synthetic-token')
    if (options.page) return options.page(url, pages)
    const from = url.searchParams.get('from')
    const rows = from
      ? source.filter((r) => BigInt(r.log_id) > BigInt(from)).slice(0, 100)
      : source.slice(0, 1)
    return Response.json(rows, {
      headers: from
        ? {
            link: `<https://tenant.us.auth0.com/api/v2/logs?from=${rows.at(-1)?.log_id ?? from}&take=100>; rel="next"`,
          }
        : {},
    })
  }
  const build = () =>
    new CredentialLogPoll(
      { storage },
      { ...config, ...options.config },
      enqueue,
      request,
      () => time,
    )
  return {
    build,
    data,
    delivered,
    paths,
    storage,
    advance: (delta = 300000) => {
      time += delta
    },
    fail: (value) => {
      fail = value
    },
    source: (value) => {
      source = value
    },
    counts: () => ({ tokens, pages }),
  }
}

test('checkpoint log recovery retains original timestamp/custom issuer and ignores reset requests', async () => {
  const f = fixture()
  const poll = f.build()
  assert.equal((await poll.poll()).healthy, true)
  assert.deepEqual(f.delivered, [
    {
      issuer: 'https://login.example.com/',
      subject: 'auth0|synthetic-2',
      changedAt: Math.floor((base - 3600000) / 1000),
    },
  ])
  assert.equal(f.data.get(KEY).cursor, '3')
  assert.deepEqual(f.counts(), { tokens: 1, pages: 3 })
  await poll.poll()
  assert.equal(f.counts().pages, 3, 'duplicate cron must not poll immediately')
  f.advance()
  await poll.poll()
  assert.equal(f.counts().tokens, 1, 'daily credential token is reused')
})

test('failed durable enqueue never advances cursor; restart retries exactly the original cutoff', async () => {
  const f = fixture()
  f.fail(true)
  assert.equal((await f.build().poll()).healthy, false)
  assert.equal(f.data.get(KEY).cursor, '1')
  assert.equal(JSON.stringify(f.data.get(KEY)).includes('private-secret'), false)
  f.fail(false)
  f.advance()
  assert.equal((await f.build().poll()).healthy, true)
  assert.equal(f.delivered.length, 1)
  assert.equal(f.delivered[0].changedAt, Math.floor((base - 3600000) / 1000))
})

test('concurrent cron/status calls share a single log drain', async () => {
  const f = fixture()
  const poll = f.build()
  await Promise.all([poll.poll(), poll.poll(), poll.poll()])
  assert.deepEqual(f.counts(), { tokens: 1, pages: 3 })
  assert.equal(f.delivered.length, 1)
})

test('pagination is bounded and resumes saved checkpoint without skipping records', async () => {
  const rows = Array.from({ length: 450 }, (_, i) => row(i + 1, 's'))
  rows[330] = row(331)
  const f = fixture({ rows })
  const poll = f.build()
  assert.equal((await poll.poll()).healthy, false)
  assert.equal(f.data.get(KEY).cursor, '301')
  assert.equal(f.counts().pages, 4)
  f.advance()
  assert.equal((await poll.poll()).healthy, true)
  assert.equal(f.delivered[0].subject, 'auth0|synthetic-331')
})

test('429 honors backoff and never stores provider body or advances checkpoint', async () => {
  const f = fixture({
    page: () =>
      new Response('secret provider body', { status: 429, headers: { 'retry-after': '900' } }),
  })
  const poll = f.build()
  assert.equal((await poll.poll()).error, 'rate_limited')
  f.advance()
  await poll.poll()
  assert.equal(f.counts().pages, 1)
  f.advance(600001)
  await poll.poll()
  assert.equal(f.counts().pages, 2)
  assert.equal(JSON.stringify(f.data.get(KEY)).includes('secret'), false)
})

test('untrusted pagination origins, missing links, backwards IDs and malformed password changes fail closed', async () => {
  for (const response of [
    () =>
      Response.json([row(2)], {
        headers: { link: '<https://evil.example/api/v2/logs?from=2>; rel="next"' },
      }),
    () => Response.json([row(2)]),
    () =>
      Response.json([row(1)], {
        headers: { link: '<https://tenant.us.auth0.com/api/v2/logs?from=1>; rel="next"' },
      }),
    () => Response.json([{ ...row(2), date: 'invalid' }]),
  ]) {
    const f = fixture({
      page: (_url, count) => (count === 1 ? Response.json([row(1, 's')]) : response()),
    })
    assert.equal((await f.build().poll()).healthy, false)
    assert.equal(f.data.get(KEY).cursor, '1')
    assert.equal(f.delivered.length, 0)
  }
})

test('partial batch acceptance replays safely without acknowledging the remainder', async () => {
  const f = fixture({ rows: [row(1, 's'), row(2), row(3)] })
  let calls = 0
  const poll = new CredentialLogPoll(
    { storage: f.storage },
    config,
    async (e) => {
      f.delivered.push(e)
      return Response.json({ durable: ++calls !== 2 }, { status: 202 })
    },
    async (input) => {
      const url = new URL(input)
      if (url.pathname === '/oauth/token')
        return Response.json({ access_token: 'test', expires_in: 3600, token_type: 'Bearer' })
      return url.searchParams.has('from')
        ? Response.json([row(2), row(3)], {
            headers: { link: '<https://tenant.us.auth0.com/api/v2/logs?from=3>; rel="next"' },
          })
        : Response.json([row(1, 's')])
    },
    () => base,
  )
  assert.equal((await poll.poll()).error, 'queue')
  assert.equal(f.data.get(KEY).cursor, '1')
})

test('prolonged retrieval outage remains an explicit coverage warning after recovery', async () => {
  const f = fixture()
  const poll = f.build()
  assert.equal((await poll.poll()).healthy, true)
  f.advance(21 * 3600000)
  const status = await poll.poll()
  assert.equal(status.healthy, false)
  assert.ok(status.gapDetectedAt)
  assert.equal(
    status.error,
    null,
    'retrieval recovered, but potentially expired events require reconciliation',
  )
  f.advance()
  assert.equal((await f.build().poll()).healthy, false)
})

test('disabled or invalid configuration performs no log requests', async () => {
  const disabled = fixture({ config: { AUTH0_LOG_POLL_ENABLED: 'false' } })
  assert.equal((await disabled.build().poll()).enabled, false)
  assert.equal(disabled.counts().tokens, 0)
  const invalid = fixture({ config: { AUTH0_LOG_TENANT_DOMAIN: 'evil.example' } })
  assert.equal((await invalid.build().poll()).error, 'configuration')
  assert.equal(invalid.counts().tokens, 0)
})

test('poll health receipt contains only allowlisted operational fields', async (t) => {
  const messages = []
  t.mock.method(console, 'info', (message) => messages.push(JSON.parse(message)))
  const f = fixture()
  const status = await f.build().poll()
  assert.deepEqual(messages, [
    {
      event: 'stillmark_credential_log_poll',
      version: 1,
      enabled: true,
      healthy: true,
      error: null,
      more: false,
      lastDrained: status.lastDrained,
      gapDetectedAt: null,
    },
  ])
  assert.equal(JSON.stringify(messages).includes('synthetic'), false)
})

test('poll failure receipt does not expose configuration, provider bodies or checkpoint', async (t) => {
  const messages = []
  t.mock.method(console, 'info', (message) => messages.push(JSON.parse(message)))
  const f = fixture({ page: () => new Response('private-provider-body', { status: 500 }) })
  assert.equal((await f.build().poll()).error, 'retrieval')
  assert.equal(messages[0].error, 'retrieval')
  for (const privateValue of [
    'private-provider-body',
    config.AUTH0_LOG_CLIENT_SECRET,
    config.AUTH0_LOG_CLIENT_ID,
    'cursor',
  ])
    assert.equal(JSON.stringify(messages).includes(privateValue), false)
})

test('health logging failure cannot suppress successful durable recovery acknowledgement', async (t) => {
  t.mock.method(console, 'info', () => {
    throw Error('unavailable log sink')
  })
  const f = fixture()
  assert.equal((await f.build().poll()).healthy, true)
  assert.equal(f.delivered.length, 1)
  assert.equal(f.data.get(KEY).cursor, '3')
})
