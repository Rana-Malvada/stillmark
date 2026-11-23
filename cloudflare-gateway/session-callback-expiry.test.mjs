import test from 'node:test'
import assert from 'node:assert/strict'
import { exportJWK, generateKeyPair, jwtDecrypt, SignJWT } from 'jose'
import { handleAuth, readSession, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS } from './auth.mjs'
import { REMEMBERED_SESSION_SECONDS } from './session-policy.mjs'

const key = new Uint8Array(32).fill(17)
function cookieValue(response, name) {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith(name + '='))
    ?.split(';')[0]
    .slice(name.length + 1)
}

// Exercise the real signed ID-token callback, including the awaited account bootstrap.
for (const scenario of [
  { name: 'remembered login', remember: true, lifetime: REMEMBERED_SESSION_SECONDS },
  { name: 'ordinary login', remember: false, lifetime: SESSION_MAX_SECONDS },
  { name: 'provider-limited login', remember: true, lifetime: 30 },
  { name: 'login expiring during bootstrap', remember: true, lifetime: 2, expired: true },
]) {
  test(`${scenario.name} preserves its original expiry across a slow bootstrap`, async (t) => {
    const startedAt = Math.floor(Date.now() / 1000)
    t.mock.timers.enable({ apis: ['Date'], now: startedAt * 1000 })
    const env = {
      GATEWAY_ORIGIN: 'https://photos.stillmark.example',
      AUTH0_DOMAIN: `expiry-${crypto.randomUUID()}.auth0.com`,
      AUTH0_CLIENT_ID: 'test',
      AUTH0_CLIENT_SECRET: 'test',
      SESSION_KEY: '11'.repeat(32),
      CUSTOMER_ACCOUNTS_ENABLED: 'true',
      SESSION_REVOCATION_BACKEND: 'postgres',
      SNOWFLAKE_PAT: 'test-only',
      SNOWFLAKE_ORIGIN: 'https://test.snowflakecomputing.app',
      GATEWAY_SIGNING_KEY: '22'.repeat(32),
    }
    const start = await handleAuth(
      new Request(env.GATEWAY_ORIGIN + '/auth/start' + (scenario.remember ? '?remember=1' : '')),
      env,
    )
    const flowToken = cookieValue(start, '__Host-photo-flow')
    const { payload: flow } = await jwtDecrypt(flowToken, key)
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' }
    const idToken = await new SignJWT({
      nonce: flow.nonce,
      email_verified: true,
      email: 'synthetic@example.invalid',
      session_expiry: startedAt + scenario.lifetime,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(`https://${env.AUTH0_DOMAIN}/`)
      .setAudience(env.AUTH0_CLIENT_ID)
      .setSubject('auth0|expiry-regression')
      .setIssuedAt(startedAt)
      .setExpirationTime(startedAt + 600)
      .sign(privateKey)
    let bootstraps = 0
    t.mock.method(globalThis, 'fetch', async (input) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.hostname === env.AUTH0_DOMAIN && url.pathname === '/oauth/token')
        return Response.json({ id_token: idToken })
      if (url.hostname === env.AUTH0_DOMAIN && url.pathname === '/.well-known/jwks.json')
        return Response.json({ keys: [jwk] })
      assert.equal(url.origin, env.SNOWFLAKE_ORIGIN)
      assert.equal(url.pathname, '/api/account/bootstrap')
      bootstraps++
      t.mock.timers.tick(3000)
      return Response.json({ ok: true })
    })
    t.mock.method(console, 'error', () => {})
    const callback = await handleAuth(
      new Request(
        `${env.GATEWAY_ORIGIN}/auth/callback?code=synthetic&state=${encodeURIComponent(flow.state)}`,
        { headers: { cookie: '__Host-photo-flow=' + flowToken } },
      ),
      env,
    )
    assert.equal(bootstraps, 1)
    const sessionToken = cookieValue(callback, '__Host-photo-session')
    if (scenario.expired) {
      assert.equal(sessionToken, undefined)
      assert.notEqual(callback.status, 303)
      return
    }
    assert.equal(callback.status, 303)
    const { payload } = await jwtDecrypt(sessionToken, key)
    assert.equal(payload.startedAt, startedAt)
    assert.equal(payload.absoluteExpiresAt, startedAt + scenario.lifetime)
    assert.equal(
      payload.exp,
      Math.min(
        startedAt + scenario.lifetime,
        startedAt + 3 + (scenario.remember ? REMEMBERED_SESSION_SECONDS : SESSION_IDLE_SECONDS),
      ),
    )
    const session = await readSession(
      new Request(env.GATEWAY_ORIGIN + '/api/auth/me', {
        headers: { cookie: '__Host-photo-session=' + sessionToken },
      }),
      env,
    )
    assert.ok(session)
    assert.ok(payload.exp <= payload.absoluteExpiresAt)
    const expectedAge = payload.exp - (startedAt + 3)
    assert.match(callback.headers.get('set-cookie'), new RegExp(`Max-Age=${expectedAge}(?:,|$)`))
  })
}
