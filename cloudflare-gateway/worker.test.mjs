import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker from './worker.mjs'

const env = { GATEWAY_ORIGIN: 'https://photos.stillmark.example' }
test('commissioning never exposes gallery data or origin redirects', async () => {
  for (const path of ['/', '/api/photos', '/auth/callback?code=untrusted', '/api/upload/chunk']) {
    const response = await worker.fetch(new Request(env.GATEWAY_ORIGIN + path), env)
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('location'), null)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.doesNotMatch(await response.text(), /snowflake|exampleacct/i)
  }
})
test('only the intended hostname receives health status', async () => {
  const healthy = await worker.fetch(new Request(env.GATEWAY_ORIGIN + '/healthz'), env)
  assert.equal(healthy.status, 200)
  const foreign = await worker.fetch(new Request('https://other.example/healthz'), env)
  assert.equal(foreign.status, 404)
})

test('custom login domain is used consistently for authorization and logout', async () => {
  const configured = {
    ...env,
    AUTH0_DOMAIN: 'login.stillmark.example',
    AUTH0_CLIENT_ID: 'test-client',
    AUTH0_CLIENT_SECRET: 'test-secret',
    SESSION_KEY: 'ab'.repeat(32),
  }
  const start = await worker.fetch(new Request(env.GATEWAY_ORIGIN + '/auth/start'), configured)
  assert.equal(start.status, 303)
  const flow = start.headers.get('set-cookie').split(';')[0]
  const next = await worker.fetch(
    new Request(env.GATEWAY_ORIGIN + '/auth/continue', { headers: { cookie: flow } }),
    configured,
  )
  assert.equal(new URL(next.headers.get('location')).origin, 'https://login.stillmark.example')
  const logout = await worker.fetch(new Request(env.GATEWAY_ORIGIN + '/auth/logout'), configured)
  assert.equal(new URL(logout.headers.get('location')).origin, 'https://login.stillmark.example')
  const invalid = await worker.fetch(new Request(env.GATEWAY_ORIGIN + '/auth/start'), {
    ...configured,
    AUTH0_DOMAIN: 'login.stillmark.example.attacker.example',
  })
  assert.equal(invalid.status, 503)
})
