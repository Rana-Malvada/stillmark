import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transition } from './alerts.mjs'

test('three failures trigger one incident, two successes recover', () => {
  let s
  for (let i = 0; i < 2; i++) {
    const t = transition(s, false)
    s = t.state
    assert.equal(t.action, null)
  }
  let t = transition(s, false)
  assert.equal(t.action, 'problem')
  s = { ...t.state, notified: true }
  t = transition(s, false)
  assert.equal(t.action, null)
  t = transition(t.state, true)
  assert.equal(t.action, null)
  t = transition(t.state, true)
  assert.equal(t.action, 'recovery')
  t = transition({ ...t.state, notified: false }, true)
  assert.equal(t.action, null)
})
test('transient failures reset and failed delivery remains retryable', () => {
  let s = transition(undefined, false).state
  s = transition(s, true).state
  assert.equal(transition(s, false).action, null)
  s = { failures: 3, notified: false }
  assert.equal(transition(s, false).action, 'problem')
})
test('monitor signs internal request and evaluates storage and uploads without exposing details', async () => {
  const { EmailAlerts } = await import('./alerts.mjs')
  const state = new Map()
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls++
    if (new URL(url).pathname.endsWith('/live')) return Response.json({ status: 'ok' })
    assert.match(options.headers['x-photo-monitor-signature'], /^[a-f0-9]{64}$/)
    return Response.json({ database: true, databaseBytes: 8000000001, failedUploadsLastHour: 3 })
  }
  const env = {
    GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
    SNOWFLAKE_ORIGIN: 'https://example.snowflakecomputing.app',
    PG_STORAGE_WARNING_BYTES: '8000000000',
    GATEWAY_TOKENS: {
      idFromName: () => 1,
      get: () => ({
        fetch: async (url) =>
          url.endsWith('/token')
            ? new Response('test')
            : Response.json({ expiresAt: Date.now() + 10 * 86400000 }),
      }),
    },
  }
  try {
    const monitor = new EmailAlerts(
      { storage: { get: async (k) => state.get(k), put: async (k, v) => state.set(k, v) } },
      env,
    )
    assert.deepEqual(await monitor.check(), {
      checked: true,
      gallery: true,
      renewal: true,
      database: true,
      storage: false,
      uploads: false,
    })
    assert.equal(calls, 2)
    assert.equal(state.get('storage').failures, 1)
    assert.deepEqual(await monitor.check(), { skipped: true })
  } finally {
    globalThis.fetch = original
  }
})

test('empty queue is not healthy when independent password log recovery has failed', async () => {
  const { EmailAlerts } = await import('./alerts.mjs')
  const original = globalThis.fetch
  globalThis.fetch = async (url) =>
    new URL(url).pathname.endsWith('/live')
      ? Response.json({ status: 'ok' })
      : Response.json({ database: true, databaseBytes: 1, failedUploadsLastHour: 0 })
  try {
    for (const healthy of [false, true]) {
      const state = new Map()
      const paths = []
      const monitor = new EmailAlerts(
        {
          storage: {
            get: async (k) => state.get(k),
            put: async (k, v) => state.set(k, v),
          },
        },
        {
          CUSTOMER_ACCOUNTS_ENABLED: 'true',
          AUTH0_LOG_POLL_ENABLED: 'true',
          GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
          PG_STORAGE_WARNING_BYTES: '8000000000',
          SNOWFLAKE_ORIGIN: 'https://example.snowflakecomputing.app',
          SNOWFLAKE_PAT: 'synthetic',
          EMAIL_ALERTS: {
            idFromName: () => 'credential-events',
            get: () => ({
              fetch: async (url) => {
                paths.push(url)
                return Response.json(
                  url.endsWith('/credential-poll') ? { healthy } : { pending: 0, oldestAgeMs: 0 },
                )
              },
            }),
          },
        },
      )
      assert.equal((await monitor.check()).credentials, healthy)
      assert.deepEqual(paths, [
        'https://internal/credential-poll',
        'https://internal/credential-status',
      ])
    }
  } finally {
    globalThis.fetch = original
  }
})

test('alert delivery receipt records only provider acceptance and the known transition', async () => {
  const { alertDeliveryReceipt } = await import('./alerts.mjs')
  const original = console.info
  const output = []
  console.info = (value) => output.push(JSON.parse(value))
  try {
    alertDeliveryReceipt('credentials', 'problem', {
      accepted: true,
      password: 'never-log',
      recipient: 'private@example.invalid',
    })
    alertDeliveryReceipt('credentials', 'recovery', {
      accepted: false,
      error: 'provider-secret',
      body: 'private',
    })
    alertDeliveryReceipt('untrusted-private-value', 'problem', { accepted: true })
    alertDeliveryReceipt('credentials', 'unknown-private-value', { accepted: true })
    assert.deepEqual(output, [
      {
        event: 'stillmark_alert_delivery',
        version: 1,
        check: 'credentials',
        action: 'problem',
        accepted: true,
      },
      {
        event: 'stillmark_alert_delivery',
        version: 1,
        check: 'credentials',
        action: 'recovery',
        accepted: false,
      },
    ])
  } finally {
    console.info = original
  }
})

test('unavailable alert telemetry cannot suppress successful delivery state updates', async () => {
  const { alertDeliveryReceipt } = await import('./alerts.mjs')
  const original = console.info
  console.info = () => {
    throw Error('sink unavailable')
  }
  try {
    assert.doesNotThrow(() => alertDeliveryReceipt('credentials', 'recovery', { accepted: true }))
  } finally {
    console.info = original
  }
})

test('monitor reports each new account once without changing incident results', async () => {
  const { EmailAlerts } = await import('./alerts.mjs')
  const state = new Map()
  const original = globalThis.fetch
  const info = console.info
  console.info = () => {}
  let recentSignups = []
  globalThis.fetch = async (url) =>
    new URL(url).pathname.endsWith('/live')
      ? Response.json({ status: 'ok' })
      : Response.json({ database: true, databaseBytes: 1, failedUploadsLastHour: 0, recentSignups })
  const queue = {
    idFromName: () => 'credential-events',
    get: () => ({
      fetch: async (url) =>
        Response.json(
          url.endsWith('/credential-poll') ? { healthy: true } : { pending: 0, oldestAgeMs: 0 },
        ),
    }),
  }
  try {
    for (const enabled of ['true', 'false']) {
      state.clear()
      const monitor = new EmailAlerts(
        { storage: { get: async (k) => state.get(k), put: async (k, v) => state.set(k, v) } },
        {
          CUSTOMER_ACCOUNTS_ENABLED: enabled,
          GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
          PG_STORAGE_WARNING_BYTES: '8000000000',
          SNOWFLAKE_ORIGIN: 'https://example.snowflakecomputing.app',
          GATEWAY_TOKENS: {
            idFromName: () => 1,
            get: () => ({
              fetch: async (url) =>
                url.endsWith('/token')
                  ? new Response('test')
                  : Response.json({ expiresAt: Date.now() + 10 * 86400000 }),
            }),
          },
          EMAIL_ALERTS: queue,
        },
      )
      const sent = []
      monitor.deliver = async (subject, body) => {
        sent.push({ subject, body })
        return { accepted: true }
      }
      recentSignups = []
      const first = await monitor.check()
      assert.equal(first.database, true)
      assert.equal('signups' in first, false)
      recentSignups = [
        {
          id: '00000000-0000-4000-8000-000000000001',
          createdAt: new Date(Date.now() + 1000).toISOString(),
          displayName: 'Ada',
        },
      ]
      for (let i = 0; i < 2; i++) {
        state.delete('lastCheck')
        await monitor.check()
      }
      assert.deepEqual(
        sent.map((m) => m.subject),
        enabled === 'true' ? ['New account created'] : [],
      )
      if (enabled === 'true') assert.match(sent[0].body, /Display name: Ada/)
      assert.equal(state.get('database').failures, 0)
    }
  } finally {
    globalThis.fetch = original
    console.info = info
  }
})
