import test from 'node:test'
import assert from 'node:assert/strict'
import { CredentialOutbox } from './credential-outbox.mjs'
import { credentialLog } from './credential-log.mjs'
import { credentialEvent } from './customer-accounts.mjs'
import { deliverCredential } from './credential-delivery.mjs'
import { createHmac } from 'node:crypto'

const env = {
  AUTH0_DOMAIN: 'fixture.auth0.com',
  CUSTOMER_ACCOUNTS_ENABLED: 'true',
  AUTH0_LOG_STREAM_TOKEN: '71'.repeat(32),
  AUTH0_EVENT_KEY: '72'.repeat(32),
  GATEWAY_SIGNING_KEY: '73'.repeat(32),
  GATEWAY_ORIGIN: 'https://photos.example.com',
  SNOWFLAKE_ORIGIN: 'https://fixture.snowflakecomputing.app',
  SNOWFLAKE_PAT: 'synthetic-only',
}
const original = () => ({
  issuer: 'https://fixture.auth0.com/',
  subject: 'auth0|fixture',
  changedAt: Math.floor(Date.now() / 1000) - 3600,
})
function storage() {
  const data = new Map()
  let alarm = null
  let chain = Promise.resolve()
  const api = {
    get: async (k) => structuredClone(data.get(k)),
    put: async (k, v) => data.set(k, structuredClone(v)),
    delete: async (k) => data.delete(k),
    list: async ({ prefix, limit }) =>
      new Map(
        [...data]
          .filter(([k]) => k.startsWith(prefix))
          .sort()
          .slice(0, limit)
          .map(([k, v]) => [k, structuredClone(v)]),
      ),
    getAlarm: async () => alarm,
    setAlarm: async (t) => {
      alarm = t
    },
    transaction: (fn) => {
      const result = chain.then(() => fn(api))
      chain = result.catch(() => {})
      return result
    },
  }
  return { data, api, alarm: () => alarm }
}
function binding(outbox) {
  return {
    idFromName: (name) => {
      assert.equal(name, 'credential-events')
      return name
    },
    get: () => ({ fetch: async (_url, init) => outbox.enqueue(JSON.parse(init.body)) }),
  }
}
const pending = (store) =>
  [...store.data.values()].filter((v) => typeof v === 'object' && 'nextAttempt' in v)
async function due(store) {
  for (const [k, v] of store.data)
    if (k.startsWith('pending:')) await store.api.put(k, { ...v, nextAttempt: 0 })
}

test('durable acceptance survives restart/outage and replays the original cutoff until explicit persistence acknowledgment', async () => {
  const store = storage()
  const event = original()
  let calls = 0
  let box = new CredentialOutbox({ storage: store.api }, env, async () => {
    calls++
    throw Error('outage')
  })
  assert.equal((await box.enqueue(event)).status, 202)
  assert.ok(store.alarm())
  await due(store)
  await box.alarm()
  assert.equal(pending(store)[0].changedAt, event.changedAt)
  assert.equal(pending(store)[0].attempts, 1)
  box = new CredentialOutbox({ storage: store.api }, env, async (delivered) => {
    calls++
    assert.deepEqual(delivered.subject, event.subject)
    assert.equal(delivered.changedAt, event.changedAt)
  })
  await due(store)
  await box.alarm()
  assert.equal(pending(store).length, 0)
  await box.enqueue(event)
  await box.enqueue({ ...event, changedAt: event.changedAt - 1 })
  assert.equal(pending(store).length, 0, 'late duplicate cannot revoke a newer login')
  assert.equal(calls, 2)
})
test('newer event arriving during replay is retained and eventually acknowledged monotonically', async () => {
  const store = storage()
  const event = original()
  let release
  let started
  const began = new Promise((r) => {
    started = r
  })
  const wait = new Promise((r) => {
    release = r
  })
  const box = new CredentialOutbox({ storage: store.api }, env, async () => {
    started()
    await wait
  })
  await box.enqueue(event)
  await due(store)
  const replay = box.alarm()
  await began
  await box.enqueue({ ...event, changedAt: event.changedAt + 1 })
  release()
  await replay
  assert.equal(pending(store)[0].changedAt, event.changedAt + 1)
  await due(store)
  await box.alarm()
  assert.equal(pending(store).length, 0)
})
test('alarm work is capped and retained failures use bounded backoff without expiry', async () => {
  const store = storage()
  let calls = 0
  const box = new CredentialOutbox({ storage: store.api }, env, async () => {
    calls++
    throw Error('offline')
  })
  for (let i = 0; i < 7; i++) await box.enqueue({ ...original(), subject: 'auth0|' + i })
  await due(store)
  await box.alarm()
  assert.equal(calls, 4)
  assert.equal(pending(store).length, 7)
  const key = [...store.data.keys()].find((k) => k.startsWith('pending:'))
  await store.api.put(key, { ...store.data.get(key), attempts: 10000, nextAttempt: 0 })
  await due(store)
  await box.alarm()
  assert.ok(pending(store).every((e) => e.nextAttempt <= Date.now() + 300000))
})
test('Auth0 stream only accepts authenticated successful-password-change events, including wrapped batches', async () => {
  const store = storage()
  const box = new CredentialOutbox({ storage: store.api }, env)
  const config = { ...env, EMAIL_ALERTS: binding(box) }
  const cutoff = original()
  const event = {
    type: 'scp',
    date: new Date(cutoff.changedAt * 1000 + 999).toISOString(),
    user_id: cutoff.subject,
  }
  const req = (body, token = env.AUTH0_LOG_STREAM_TOKEN) =>
    new Request(env.GATEWAY_ORIGIN + '/auth/credential-log', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    })
  assert.equal(
    (await credentialLog(req([{ log_id: 'synthetic', data: event }]), config)).status,
    202,
  )
  assert.equal(pending(store)[0].changedAt, cutoff.changedAt)
  assert.equal(
    (await credentialLog(req({ ...event, type: 'scpr', user_id: 'auth0|not-changed' }), config))
      .status,
    202,
  )
  assert.equal(pending(store).length, 1)
  assert.equal((await credentialLog(req(event, 'wrong'), config)).status, 401)
  assert.equal((await credentialLog(req({ ...event, date: 'bad' }), config)).status, 400)
  assert.equal(
    (await credentialLog(req(event), { ...config, EMAIL_ALERTS: undefined })).status,
    503,
  )
})
test('queue failures are never acknowledged and direct event fallback returns202 only after durable storage', async () => {
  const prior = globalThis.fetch
  globalThis.fetch = async () => {
    throw Error('upstream unavailable')
  }
  const store = storage()
  const box = new CredentialOutbox({ storage: store.api }, env)
  const event = original()
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify(event)
  const request = () =>
    new Request(env.GATEWAY_ORIGIN + '/auth/credential-change', {
      method: 'POST',
      body,
      headers: {
        'x-stillmark-time': String(timestamp),
        'x-stillmark-signature': createHmac('sha256', Buffer.from(env.AUTH0_EVENT_KEY, 'hex'))
          .update(`${timestamp}.${body}`)
          .digest('hex'),
      },
    })
  try {
    const response = await credentialEvent(request(), { ...env, EMAIL_ALERTS: binding(box) })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { accepted: true, durable: true })
    assert.equal(pending(store).length, 1)
    const failing = {
      idFromName: () => '',
      get: () => ({
        fetch: async () => {
          throw Error('storage unavailable')
        },
      }),
    }
    assert.equal((await credentialEvent(request(), { ...env, EMAIL_ALERTS: failing })).status, 503)
    const malformed = {
      idFromName: () => '',
      get: () => ({ fetch: async () => Response.json({}) }),
    }
    assert.equal(
      (await credentialEvent(request(), { ...env, EMAIL_ALERTS: malformed })).status,
      503,
    )
  } finally {
    globalThis.fetch = prior
  }
})
test('delivery bounds token/response-body hangs and rejects a success without database acknowledgment', async () => {
  const prior = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json({})
    await assert.rejects(deliverCredential(original(), env, 30), /not acknowledged/)
    globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }))
    await assert.rejects(deliverCredential(original(), env, 30), /timed out/)
    const never = { idFromName: () => '', get: () => ({ fetch: () => new Promise(() => {}) }) }
    await assert.rejects(
      deliverCredential(original(), { ...env, GATEWAY_TOKENS: never }, 30),
      /timed out/,
    )
  } finally {
    globalThis.fetch = prior
  }
})

test('capacity failures preserve existing pending accounts and monitor rearms a lost alarm', async () => {
  const store = storage()
  const box = new CredentialOutbox({ storage: store.api }, env)
  for (let i = 0; i < 1000; i++)
    await store.api.put('pending:seed-' + i, {
      ...original(),
      nextAttempt: Date.now(),
      firstSeen: Date.now(),
      attempts: 0,
    })
  await assert.rejects(box.enqueue({ ...original(), subject: 'auth0|new-capacity' }), /capacity/)
  assert.equal(pending(store).length, 1000)
  assert.equal(store.alarm(), null)
  assert.equal((await box.status()).pending, 1000)
  assert.ok(store.alarm() > 0)
})

test('existing operations monitor sees overdue credential backlog without exposing account data', async () => {
  const { EmailAlerts } = await import('./alerts.mjs')
  const store = storage()
  const prior = globalThis.fetch
  globalThis.fetch = async (url) =>
    new URL(url).pathname.endsWith('/live')
      ? Response.json({ status: 'ok' })
      : Response.json({ database: true, databaseBytes: 100, failedUploadsLastHour: 0 })
  const config = {
    ...env,
    PG_STORAGE_WARNING_BYTES: '8000000000',
    GATEWAY_TOKENS: {
      idFromName: () => '',
      get: () => ({
        fetch: async (url) =>
          url.endsWith('/token')
            ? new Response('fixture')
            : Response.json({ expiresAt: Date.now() + 10 * 86400000 }),
      }),
    },
    EMAIL_ALERTS: {
      idFromName: () => '',
      get: () => ({ fetch: async () => Response.json({ pending: 1, oldestAgeMs: 61000 }) }),
    },
  }
  try {
    const result = await new EmailAlerts({ storage: store.api }, config).check()
    assert.equal(result.credentials, false)
    assert.equal(store.data.get('credentials').failures, 1)
    assert.equal(JSON.stringify(result).includes('auth0|'), false)
  } finally {
    globalThis.fetch = prior
  }
})
