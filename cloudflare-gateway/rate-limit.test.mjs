import test from 'node:test'
import assert from 'node:assert/strict'
import { rateLimitBucket, rateLimited, tooManyRequests } from './rate-limit.mjs'

const request = (ip) =>
  new Request('https://gateway.example/auth/start', {
    headers: ip ? { 'cf-connecting-ip': ip } : {},
  })
const limiter = (allowed) => {
  const keys = []
  return { keys, limit: async ({ key }) => (keys.push(key), { success: allowed(key) }) }
}

test('only sign-in and public share routes are limited here', () => {
  assert.equal(rateLimitBucket('/auth/start', false), 'auth')
  assert.equal(rateLimitBucket('/auth/callback', false), 'auth')
  assert.equal(rateLimitBucket('/share/abc', true), 'share')
  assert.equal(rateLimitBucket('/api/events', false), null)
  assert.equal(rateLimitBucket('/authx', false), null)
})

test('each bucket uses its own limiter and keys by client address', async () => {
  const auth = limiter(() => true)
  const share = limiter(() => false)
  const env = { AUTH_RATE_LIMIT: auth, SHARE_RATE_LIMIT: share }
  assert.equal(await rateLimited(request('203.0.113.7'), env, 'auth'), false)
  assert.equal(await rateLimited(request('203.0.113.7'), env, 'share'), true)
  assert.deepEqual(auth.keys, ['auth:203.0.113.7'])
  assert.deepEqual(share.keys, ['share:203.0.113.7'])
})

test('a missing binding or a limiter failure never blocks a request', async () => {
  assert.equal(await rateLimited(request('203.0.113.7'), {}, 'auth'), false)
  const broken = {
    limit: async () => {
      throw new Error('unavailable')
    },
  }
  assert.equal(
    await rateLimited(request('203.0.113.7'), { AUTH_RATE_LIMIT: broken }, 'auth'),
    false,
  )
})

test('the refusal tells the client when to retry', () => {
  const response = tooManyRequests({ 'Cache-Control': 'no-store' })
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('Retry-After'), '60')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})

test('a gateway with no upstream credential fails closed', async () => {
  const { gatewayToken } = await import('./token-renewal.mjs')
  await assert.rejects(() => gatewayToken({}), /Gateway credential unavailable/)
  assert.equal(await gatewayToken({ SNOWFLAKE_PAT: 'token' }), 'token')
})
