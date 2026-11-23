import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { credentialEvent } from './customer-accounts.mjs'

const env = {
  CUSTOMER_ACCOUNTS_ENABLED: 'true',
  GATEWAY_ORIGIN: 'https://photos.example.com',
  SNOWFLAKE_ORIGIN: 'https://test.snowflakecomputing.app',
  AUTH0_DOMAIN: 'test.auth0.com',
  AUTH0_EVENT_KEY: '33'.repeat(32),
  GATEWAY_SIGNING_KEY: '22'.repeat(32),
  SNOWFLAKE_PAT: 'test-only',
}
function request(overrides = {}, signatureOverride) {
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({
    issuer: 'https://test.auth0.com/',
    subject: 'auth0|test',
    changedAt: timestamp - 3600,
    ...overrides,
  })
  const signature =
    signatureOverride ??
    createHmac('sha256', Buffer.from(env.AUTH0_EVENT_KEY, 'hex'))
      .update(`${timestamp}.${body}`)
      .digest('hex')
  return new Request(env.GATEWAY_ORIGIN + '/auth/credential-change', {
    method: 'POST',
    body,
    headers: { 'x-stillmark-time': String(timestamp), 'x-stillmark-signature': signature },
  })
}
test('authenticated credential events retain retryable status on network, timeout, token and signing outages', async () => {
  const prior = globalThis.fetch
  try {
    for (const error of [
      new TypeError('private network detail'),
      new DOMException('private timeout detail', 'TimeoutError'),
    ]) {
      globalThis.fetch = async () => {
        throw error
      }
      const response = await credentialEvent(request(), env)
      assert.equal(response.status, 503)
      assert.equal(await response.text(), 'Retry credential event')
      assert.equal(response.headers.get('cache-control'), 'no-store')
    }
    const unavailable = {
      idFromName: () => 'test',
      get: () => ({
        fetch: async () => {
          throw Error('private token detail')
        },
      }),
    }
    assert.equal(
      (await credentialEvent(request(), { ...env, GATEWAY_TOKENS: unavailable })).status,
      503,
    )
    assert.equal(
      (await credentialEvent(request(), { ...env, GATEWAY_SIGNING_KEY: '' })).status,
      503,
    )
    assert.equal((await credentialEvent(request(), { ...env, AUTH0_EVENT_KEY: '' })).status, 503)
  } finally {
    globalThis.fetch = prior
  }
})
test('invalid signatures and identities remain 401 and never reach persistence', async () => {
  const prior = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw Error('should not fetch')
  }
  try {
    for (const input of [
      request({}, '00'.repeat(32)),
      request({ issuer: 'https://other.auth0.com/' }),
      request({ subject: 'other|test' }),
      request({ changedAt: -1 }),
    ])
      assert.equal((await credentialEvent(input, env)).status, 401)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = prior
  }
})
test('upstream rejection retries without replacing the original credential cutoff', async () => {
  const prior = globalThis.fetch
  const cutoffs = []
  globalThis.fetch = async (_request, options) => {
    const assertion = new Headers(options.headers).get('x-photo-gateway-identity')
    cutoffs.push(JSON.parse(Buffer.from(assertion.split('.')[0], 'base64url')).credentialChange)
    return new Response('private upstream detail', { status: 500 })
  }
  try {
    const changedAt = Math.floor(Date.now() / 1000) - 86400
    for (let i = 0; i < 2; i++)
      assert.equal((await credentialEvent(request({ changedAt }), env)).status, 503)
    assert.deepEqual(cutoffs, [changedAt, changedAt])
  } finally {
    globalThis.fetch = prior
  }
})
