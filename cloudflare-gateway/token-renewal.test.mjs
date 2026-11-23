import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayTokenStore, openToken, sealToken, verifyToken } from './token-renewal.mjs'

const env = {
  SESSION_KEY: 'ab'.repeat(32),
  SNOWFLAKE_PAT: 'initial',
  SNOWFLAKE_ORIGIN: 'https://example.snowflakecomputing.app',
}
function fixture(operations) {
  const data = new Map()
  const storage = {
    get: async (k) => data.get(k),
    put: async (k, v) => data.set(k, v),
    delete: async (k) => data.delete(k),
  }
  storage.transaction = async (cb) => cb(storage)
  return { data, store: new GatewayTokenStore({ storage }, env, operations) }
}
const expiry = () => String((Date.now() + 30 * 86400000) / 1000)
test('encrypted storage does not contain bearer token and uses the correct key', async () => {
  const e = await sealToken('sensitive-token', env)
  assert.ok(!e.includes('sensitive-token'))
  assert.equal(await openToken(e, env), 'sensitive-token')
  await assert.rejects(openToken(e, { SESSION_KEY: 'cd'.repeat(32) }))
})
test('rotation verifies before atomic activation and does not repeat before due', async () => {
  let rotations = 0
  let checks = 0
  const { data, store } = fixture({
    statement: async (e, sql) =>
      sql.startsWith('ALTER')
        ? (rotations++, [{ token_secret: 'new-token' }])
        : [{ name: 'CLOUDFLARE_GATEWAY', expires_at: expiry() }],
    verifyToken: async (t) => {
      assert.equal(t, 'new-token')
      checks++
      assert.equal(data.get('active'), undefined)
    },
  })
  assert.equal((await store.renew()).rotated, true)
  assert.equal(await (await store.fetch(new Request('https://internal/token'))).text(), 'new-token')
  assert.equal((await store.renew()).rotated, false)
  assert.equal(rotations, 1)
  assert.equal(checks, 1)
  assert.equal(data.get('pending'), undefined)
})
test('failed verification preserves active credential; retry reuses pending token', async () => {
  let healthy = false
  let rotations = 0
  const { data, store } = fixture({
    statement: async (e, sql) =>
      sql.startsWith('ALTER')
        ? (rotations++, [{ token_secret: 'new' }])
        : [{ name: 'CLOUDFLARE_GATEWAY', expires_at: expiry() }],
    verifyToken: async () => {
      if (!healthy) throw Error('unavailable')
    },
  })
  data.set('active', {
    encrypted: await sealToken('old', env),
    expiresAt: Date.now() + 3 * 86400000,
  })
  await assert.rejects(store.renew())
  assert.equal(await (await store.fetch(new Request('https://internal/token'))).text(), 'old')
  healthy = true
  await store.renew()
  assert.equal(rotations, 1)
})
test('uncertain SQL response retries same durable request ID', async () => {
  const ids = []
  const { store } = fixture({
    statement: async (e, sql, id) => {
      if (sql.startsWith('ALTER')) {
        ids.push(id)
        if (ids.length === 1) throw Error('lost response')
        return [{ token_secret: 'new' }]
      }
      return [{ name: 'CLOUDFLARE_GATEWAY', expires_at: expiry() }]
    },
    verifyToken: async () => {},
  })
  await assert.rejects(store.renew())
  await store.renew()
  assert.equal(ids.length, 2)
  assert.equal(ids[0], ids[1])
})
test('concurrent renewal requests coalesce', async () => {
  let count = 0
  const { store } = fixture({
    statement: async (e, sql) =>
      sql.startsWith('ALTER')
        ? (count++, await new Promise((r) => setTimeout(r, 10)), [{ token_secret: 'new' }])
        : [{ name: 'CLOUDFLARE_GATEWAY', expires_at: expiry() }],
    verifyToken: async () => {},
  })
  await Promise.all(
    [1, 2, 3].map(() => store.fetch(new Request('https://internal/check', { method: 'POST' }))),
  )
  assert.equal(count, 1)
})
test('expired active token never falls back to bootstrap token', async () => {
  const { data, store } = fixture({})
  data.set('active', { expiresAt: 0, encrypted: 'old' })
  assert.equal((await store.fetch(new Request('https://internal/token'))).status, 503)
})
test('health verification rejects redirects and non-app responses', async () => {
  await assert.rejects(verifyToken('token', env, async () => new Response(null, { status: 302 })))
  await assert.rejects(verifyToken('token', env, async () => Response.json({ status: 'not-app' })))
  await verifyToken('token', env, async () => Response.json({ status: 'ok' }))
})

test('SQL API uses required User-Agent, blocks redirects, and selects no warehouse', async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  const { statement } = await import('./token-renewal.mjs')
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const e = {
    SNOWFLAKE_RENEWAL_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    SNOWFLAKE_RENEWAL_KEY_FP: 'SHA256:test',
  }
  await statement(
    e,
    'SHOW USER PROGRAMMATIC ACCESS TOKENS FOR USER PERSONAL_PHOTOS_GATEWAY',
    crypto.randomUUID(),
    async (url, init) => {
      assert.equal(init.redirect, 'manual')
      assert.match(init.headers['User-Agent'], /^PersonalPhotosTokenRenewal\//)
      const body = JSON.parse(init.body)
      assert.equal(body.warehouse, undefined)
      assert.equal(body.role, 'PERSONAL_PHOTOS_TOKEN_RENEWAL')
      return Response.json({ data: [], resultSetMetaData: { rowType: [] } })
    },
  )
  await assert.rejects(
    statement(
      e,
      'SHOW USERS',
      crypto.randomUUID(),
      async () => new Response(null, { status: 302 }),
    ),
    /HTTP 302/,
  )
})
