import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isolatedGateway } from './cloudflare-gateway.mjs'

const profile = {
  DATABASE: 'STILLMARK_LOADTEST_BASELINE',
  PG_DATABASE: 'stillmark_loadtest_baseline',
  GATEWAY_ORIGIN: 'https://stillmark-loadtest-baseline.example.workers.dev',
  APP_ORIGIN: 'https://isolated.snowflakecomputing.app',
}
const env = {
  GATEWAY_ORIGIN: profile.GATEWAY_ORIGIN,
  SNOWFLAKE_ORIGIN: profile.APP_ORIGIN,
  UPLOAD_SERVICE_ORIGIN: profile.APP_ORIGIN,
  SESSION_REVOCATION_BACKEND: 'postgres',
  AUTH0_DOMAIN: 'disabled.example.invalid',
}
test('delegates API requests unchanged to the production session checks', async () => {
  const request = new Request(env.GATEWAY_ORIGIN + '/api/auth/me')
  let count = 0
  const worker = isolatedGateway(
    {
      fetch(r, e) {
        assert.equal(r, request)
        assert.equal(e, env)
        count++
        return new Response('Sign in required', { status: 401 })
      },
    },
    profile,
  )
  assert.equal((await worker.fetch(request, env)).status, 401)
  assert.equal(count, 1)
})
test('blocks Auth0 routes and refuses production or mismatched configurations', async () => {
  const never = {
    fetch() {
      throw Error('Must not reach gateway')
    },
  }
  for (const path of [
    '/auth/start',
    '/auth/continue',
    '/auth/callback',
    '/auth/logout',
    '/share/example',
  ])
    assert.equal(
      (await isolatedGateway(never, profile).fetch(new Request(env.GATEWAY_ORIGIN + path), env))
        .status,
      404,
    )
  for (const override of [
    { SNOWFLAKE_ORIGIN: 'https://production.snowflakecomputing.app' },
    { AUTH0_DOMAIN: 'login.example.com' },
    { SESSION_REVOCATION_BACKEND: 'disabled' },
  ])
    assert.equal(
      (
        await isolatedGateway(never, profile).fetch(
          new Request(env.GATEWAY_ORIGIN + '/api/auth/me'),
          { ...env, ...override },
        )
      ).status,
      503,
    )
  assert.equal(
    (
      await isolatedGateway(never, { ...profile, DATABASE: 'PERSONAL_PHOTOS' }).fetch(
        new Request(env.GATEWAY_ORIGIN + '/api/auth/me'),
        env,
      )
    ).status,
    503,
  )
})
test('temporary isolated receipts preserve response and store no request secrets', async () => {
  const writes = []
  const pending = []
  const id = crypto.randomUUID()
  const response = new Response('ok', {
    headers: { 'server-timing': 'media_auth;dur=42.5, private;desc=secret, media_storage;dur=7' },
  })
  const worker = isolatedGateway({ fetch: async () => response }, profile)
  const request = new Request(env.GATEWAY_ORIGIN + '/api/auth/me?secret=hidden', {
    headers: { 'x-load-test-request': id, Cookie: 'secret' },
  })
  const actual = await worker.fetch(
    request,
    {
      ...env,
      RESET_TRACE_UNTIL: String(Date.now() + 600000),
      RESET_TRACE: { put: async (...args) => writes.push(args) },
    },
    { waitUntil: (p) => pending.push(p) },
  )
  await Promise.all(pending)
  assert.equal(actual, response)
  assert.deepEqual(JSON.parse(writes[1][1]).timings, { media_auth: 42.5, media_storage: 7 })
  assert.deepEqual(
    writes.map((x) => x[0]),
    [`${id}:received`, `${id}:returned`],
  )
  assert.ok(writes.every((x) => x[2].expirationTtl === 600))
  assert.ok(!JSON.stringify(writes).includes('secret'))
  writes.length = 0
  await worker.fetch(
    request,
    { ...env, RESET_TRACE_UNTIL: '1', RESET_TRACE: { put: async (...args) => writes.push(args) } },
    { waitUntil: (p) => pending.push(p) },
  )
  assert.equal(writes.length, 0)
})
