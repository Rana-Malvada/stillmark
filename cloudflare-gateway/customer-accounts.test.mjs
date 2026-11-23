import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { jwtDecrypt } from 'jose'
import { handleAuth } from './auth.mjs'
import {
  accountBootstrapMessage,
  accountLanding,
  bootstrapAccount,
  credentialEvent,
  initialDisplayName,
} from './customer-accounts.mjs'
import { identityAssertion } from './proxy.mjs'

const env = {
  GATEWAY_ORIGIN: 'https://photos.example.com',
  SNOWFLAKE_ORIGIN: 'https://test.snowflakecomputing.app',
  SNOWFLAKE_PAT: 'test-only',
  AUTH0_DOMAIN: 'test.auth0.com',
  AUTH0_CLIENT_ID: 'test-client',
  AUTH0_CLIENT_SECRET: 'test-secret',
  SESSION_KEY: '11'.repeat(32),
  GATEWAY_SIGNING_KEY: '22'.repeat(32),
  AUTH0_EVENT_KEY: '33'.repeat(32),
  CUSTOMER_ACCOUNTS_ENABLED: 'true',
  PUBLIC_SIGNUP_ENABLED: 'true',
}
test('signup is opt-in, uses PKCE and requests email verification claims', async () => {
  const denied = await handleAuth(new Request(env.GATEWAY_ORIGIN + '/auth/signup'), {
    ...env,
    PUBLIC_SIGNUP_ENABLED: 'false',
  })
  assert.equal(denied.status, 403)
  const start = await handleAuth(new Request(env.GATEWAY_ORIGIN + '/auth/signup'), env)
  assert.equal(start.status, 303)
  const cookie = start.headers.get('set-cookie').split(';')[0]
  const { payload } = await jwtDecrypt(cookie.split('=')[1], new Uint8Array(32).fill(17))
  assert.equal(payload.signup, true)
  const next = await handleAuth(
    new Request(env.GATEWAY_ORIGIN + '/auth/continue', { headers: { cookie } }),
    env,
  )
  const target = new URL(next.headers.get('location'))
  assert.equal(target.searchParams.get('screen_hint'), 'signup')
  assert.equal(target.searchParams.get('scope'), 'openid profile email')
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(target.searchParams.get('state'))
  assert.ok(target.searchParams.get('nonce'))
})
test('welcome page respects registration kill switch and has recovery instructions', async () => {
  assert.match(await accountLanding(env).text(), /Create account/)
  assert.doesNotMatch(
    await accountLanding({ ...env, PUBLIC_SIGNUP_ENABLED: 'false' }).text(),
    /Create account/,
  )
  assert.match(await accountLanding(env).text(), /Forgot password/)
})
test('onboarding claims cannot ride unrelated requests', async () => {
  const session = {
    auth0Subject: 'auth0|person',
    sid: crypto.randomUUID(),
    startedAt: Math.floor(Date.now() / 1000),
    onboarding: { issuer: 'https://test.auth0.com/', email: 'private@example.com', verified: true },
    credentialChange: 1234,
  }
  const decode = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url'))
  const normal = decode(
    await identityAssertion(session, env, new Request(env.GATEWAY_ORIGIN + '/api/photos/1')),
  )
  assert.equal(normal.onboarding, undefined)
  assert.equal(normal.credentialChange, undefined)
  const registration = decode(
    await identityAssertion(
      session,
      env,
      new Request(env.GATEWAY_ORIGIN + '/api/account/bootstrap', { method: 'POST' }),
    ),
  )
  assert.equal(registration.onboarding.email, 'private@example.com')
  assert.equal(registration.credentialChange, undefined)
})
test('bootstrap forwards only verified provider claims using trusted origin and signed assertion', async () => {
  const prior = globalThis.fetch
  let captured
  globalThis.fetch = async (request, options) => {
    captured = options
    return Response.json({ ok: true })
  }
  try {
    const r = await bootstrapAccount(
      env,
      {
        auth0Subject: 'auth0|person',
        sid: crypto.randomUUID(),
        startedAt: Math.floor(Date.now() / 1000),
      },
      {
        iss: 'https://test.auth0.com/',
        email: 'member@example.com',
        name: 'Member',
        'https://stillmark.app/username': 'chosenusername',
        email_verified: true,
      },
    )
    assert.equal(r.status, 200)
    const headers = new Headers(captured.headers)
    const claims = JSON.parse(
      Buffer.from(headers.get('x-photo-gateway-identity').split('.')[0], 'base64url'),
    )
    assert.deepEqual(claims.onboarding, {
      issuer: 'https://test.auth0.com/',
      email: 'member@example.com',
      displayName: 'chosenusername',
      verified: true,
    })
  } finally {
    globalThis.fetch = prior
  }
})
function eventRequest(overrides = {}, signatureOverride) {
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify({
    issuer: 'https://test.auth0.com/',
    subject: 'auth0|person',
    changedAt: timestamp,
    ...overrides,
  })
  const signature =
    signatureOverride ??
    createHmac('sha256', Buffer.from(env.AUTH0_EVENT_KEY, 'hex'))
      .update(`${timestamp}.${body}`)
      .digest('hex')
  return new Request(env.GATEWAY_ORIGIN + '/auth/credential-change', {
    method: 'POST',
    headers: { 'x-stillmark-time': String(timestamp), 'x-stillmark-signature': signature },
    body,
  })
}
test('password reset rejects forgery and other issuers; reports failed persistence for retry', async () => {
  assert.equal((await credentialEvent(eventRequest({}, '00'.repeat(32)), env)).status, 401)
  assert.equal(
    (await credentialEvent(eventRequest({ issuer: 'https://other.auth0.com/' }), env)).status,
    401,
  )
  assert.equal(
    (await credentialEvent(eventRequest(), { ...env, CUSTOMER_ACCOUNTS_ENABLED: 'false' })).status,
    404,
  )
  const prior = globalThis.fetch
  let captured
  globalThis.fetch = async (req, options) => {
    captured = options
    return new Response('failed', { status: 503 })
  }
  try {
    assert.equal((await credentialEvent(eventRequest(), env)).status, 503)
    globalThis.fetch = async (req, options) => {
      captured = options
      return Response.json({ ok: true })
    }
    assert.equal((await credentialEvent(eventRequest(), env)).status, 200)
    const claims = JSON.parse(
      Buffer.from(
        new Headers(captured.headers).get('x-photo-gateway-identity').split('.')[0],
        'base64url',
      ),
    )
    assert.equal(claims.target, '/api/account/credential-change')
    assert.ok(claims.credentialChange)
  } finally {
    globalThis.fetch = prior
  }
})
test('customer mode bypasses thumbnail capabilities so revocation reaches current database checks', async () => {
  const { grantedThumbnail } = await import('./thumbnail-grants.mjs')
  let fetched = false
  const result = await grantedThumbnail(
    new Request(env.GATEWAY_ORIGIN + '/api/images?path=thumbnails/a.jpg&grant=test'),
    { ...env, MEDIA_GRANTS_ENABLED: 'true', MEDIA_DELIVERY_MODE: 'enabled' },
    { auth0Subject: 'auth0|person', sid: crypto.randomUUID() },
    async () => {
      fetched = true
      return new Response('unexpected')
    },
  )
  assert.equal(result, null)
  assert.equal(fetched, false)
})

test('unverified signup gets email instructions while verified activation failures get a distinct message', async () => {
  const waiting = await accountBootstrapMessage(env, false).text()
  assert.match(waiting, /Check your email to finish creating your account/)
  assert.match(waiting, /Then return here and choose Sign in/)
  assert.doesNotMatch(waiting, /could not activate|couldn’t finish|Create account/)
  const failed = await accountBootstrapMessage(env, true).text()
  assert.match(failed, /couldn’t finish signing you in/)
  assert.doesNotMatch(failed, /verification link|Create account/)
})

test('password recovery page remains available', async () => {
  const response = await handleAuth(new Request(env.GATEWAY_ORIGIN + '/auth/recover'), env)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /Forgot password/)
})

test('email-only accounts keep email out of the initial public vanity name', () => {
  assert.equal(initialDisplayName({ name: 'person@example.com' }), 'Member')
  assert.equal(initialDisplayName({ name: 'Person' }), 'Person')
  assert.equal(
    initialDisplayName({ name: 'person@example.com', 'https://stillmark.app/username': 'Vanity' }),
    'Vanity',
  )
})

test('login forms allow their Auth0 redirect without allowing arbitrary form destinations', () => {
  const policy = accountLanding(env).headers.get('Content-Security-Policy')
  assert.match(policy, /form-action 'self' https:\/\/test\.auth0\.com;/)
  assert.match(policy, /default-src 'none'/)
  assert.match(policy, /frame-ancestors 'none'/)
  for (const domain of ['', 'test.auth0.com; form-action *', 'test.auth0.com/path']) {
    const restricted = accountLanding({ ...env, AUTH0_DOMAIN: domain }).headers.get(
      'Content-Security-Policy',
    )
    assert.match(restricted, /form-action 'self';/)
  }
})

test('failed login returns a branded fresh-start form without exposing provider input or granting a session', async () => {
  for (const path of [
    '/auth/continue',
    '/auth/callback?error=private-provider-detail&state=secret-state',
  ]) {
    const response = await handleAuth(new Request(env.GATEWAY_ORIGIN + path), env)
    assert.equal(response.status, 401)
    assert.match(response.headers.get('content-type'), /text\/html/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.match(response.headers.get('set-cookie'), /__Host-photo-flow=;.*Max-Age=0/)
    assert.doesNotMatch(response.headers.get('set-cookie'), /__Host-photo-session/)
    const html = await response.text()
    assert.match(html, /form action="\/auth\/start"/)
    assert.match(html, /If you just created an account/)
    assert.doesNotMatch(html, /test page|private-provider-detail|secret-state|Create account/)
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  }
})

test('wrong callback state rejects before token exchange and offers recovery', async () => {
  const start = await handleAuth(new Request(env.GATEWAY_ORIGIN + '/auth/start'), env)
  const cookie = start.headers.get('set-cookie').split(';')[0]
  const prior = globalThis.fetch
  let fetched = false
  globalThis.fetch = async () => {
    fetched = true
    throw Error('must not exchange')
  }
  try {
    const response = await handleAuth(
      new Request(env.GATEWAY_ORIGIN + '/auth/callback?code=fake&state=wrong', {
        headers: { cookie },
      }),
      env,
    )
    assert.equal(response.status, 401)
    assert.equal(fetched, false)
    assert.match(await response.text(), /Please try signing in again/)
  } finally {
    globalThis.fetch = prior
  }
})
