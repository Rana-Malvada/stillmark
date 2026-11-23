import test from 'node:test'
import assert from 'node:assert/strict'
import { EncryptJWT, jwtDecrypt } from 'jose'
import {
  isSessionActivity,
  readSession,
  renewSessionResponse,
  SESSION_MAX_SECONDS,
} from './auth.mjs'
import { RevokedSession, revokeSession } from './session-revocation.mjs'

const key = new Uint8Array(32).fill(17)
const now = () => Math.floor(Date.now() / 1000)
function setup() {
  const data = new Map()
  let alarm
  const object = new RevokedSession({
    storage: {
      get: async (k) => data.get(k),
      put: async (k, v) => data.set(k, v),
      setAlarm: async (t) => {
        alarm = t
      },
      deleteAll: async () => data.clear(),
    },
  })
  return {
    env: {
      GATEWAY_ORIGIN: 'https://photos.stillmark.example',
      AUTH0_DOMAIN: 'login.stillmark.example',
      AUTH0_CLIENT_ID: 'test',
      AUTH0_CLIENT_SECRET: 'test',
      SESSION_KEY: '11'.repeat(32),
      REVOKED_SESSIONS: {
        idFromName: (x) => x,
        get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }),
      },
    },
    alarm: () => alarm,
  }
}
function session(overrides = {}) {
  return {
    auth0Subject: 'auth0|test',
    sid: '11111111-1111-4111-8111-111111111111',
    iat: now() - 1800,
    exp: now() + 1800,
    startedAt: now() - 1800,
    absoluteExpiresAt: now() - 1800 + SESSION_MAX_SECONDS,
    ...overrides,
  }
}
async function token(s) {
  return new EncryptJWT(s)
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject('gallery-session')
    .encrypt(key)
}
function request(env, token, path = '/api/upload/chunk') {
  return new Request(env.GATEWAY_ORIGIN + path, {
    headers: { cookie: '__Host-photo-session=' + token },
  })
}
async function renewed(env, s) {
  const r = await renewSessionResponse(
    request(env, await token(s)),
    new Response('{}', { headers: { 'Set-Cookie': 'gallery_activity=test; Secure' } }),
    env,
    s,
  )
  return {
    r,
    token: r.headers
      .getSetCookie()
      .find((x) => x.startsWith('__Host-photo-session='))
      .split(';')[0]
      .split('=')[1],
  }
}
test('active requests renew idle deadline, preserve original ceiling and cookie protections', async () => {
  const { env } = setup()
  const s = session()
  const { r, token: t } = await renewed(env, s)
  const { payload } = await jwtDecrypt(t, key)
  assert.equal(payload.sid, s.sid)
  assert.equal(payload.startedAt, s.startedAt)
  assert.equal(payload.absoluteExpiresAt, s.absoluteExpiresAt)
  assert.ok(payload.exp >= now() + 3598)
  assert.ok(payload.exp <= now() + 3600)
  assert.match(r.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/)
  assert.ok(r.headers.getSetCookie().some((x) => x.startsWith('gallery_activity=')))
  assert.equal(r.headers.get('cache-control'), 'private, no-store')
})
test('renewal caps at absolute lifetime and expired/idle cookies cannot authenticate', async () => {
  const { env } = setup()
  const s = session({
    startedAt: now() - SESSION_MAX_SECONDS + 120,
    absoluteExpiresAt: now() + 120,
    exp: now() + 100,
  })
  const { token: t } = await renewed(env, s)
  const { payload } = await jwtDecrypt(t, key)
  assert.equal(payload.exp, s.absoluteExpiresAt)
  for (const bad of [
    session({ exp: now() - 1 }),
    session({ absoluteExpiresAt: now() - 1 }),
    session({ absoluteExpiresAt: now() + SESSION_MAX_SECONDS * 2 }),
  ])
    assert.equal(await readSession(request(env, await token(bad)), env), null)
})
test('legacy valid cookies gain a ceiling anchored to their original issue time', async () => {
  const { env } = setup()
  const s = session()
  delete s.startedAt
  delete s.absoluteExpiresAt
  const { token: t } = await renewed(env, s)
  const { payload } = await jwtDecrypt(t, key)
  assert.equal(payload.startedAt, s.iat)
  assert.equal(payload.absoluteExpiresAt, s.iat + SESSION_MAX_SECONDS)
})
test('passive activity, cross-site requests and errors do not renew', async () => {
  const { env } = setup()
  const s = session()
  const t = await token(s)
  for (const path of [
    '/api/user-activity',
    '/api/health/live',
    '/_next/static/app.js',
    '/auth/start',
  ]) {
    const req = request(env, t, path)
    assert.equal(isSessionActivity(req), false)
    assert.equal(
      (await renewSessionResponse(req, new Response('{}'), env, s)).headers.get('set-cookie'),
      null,
    )
  }
  assert.equal(
    isSessionActivity(
      new Request(env.GATEWAY_ORIGIN + '/', { headers: { 'sec-fetch-site': 'cross-site' } }),
    ),
    false,
  )
  for (const status of [401, 403, 500])
    assert.equal(
      (
        await renewSessionResponse(request(env, t), new Response('{}', { status }), env, s)
      ).headers.get('set-cookie'),
      null,
    )
})
test('logout blocks every renewal and revocation outlasts the maximum session', async () => {
  const { env, alarm } = setup()
  const s = session()
  const { token: t } = await renewed(env, s)
  await revokeSession(env, s.sid)
  assert.equal(await readSession(request(env, t), env), null)
  assert.equal(await readSession(request(env, await token(s)), env), null)
  assert.ok(alarm() > Date.now() + SESSION_MAX_SECONDS * 1000)
})
test('the worker attaches renewed cookies to successful uploads', async () => {
  const { default: worker } = await import('./worker.mjs')
  const { env } = setup()
  Object.assign(env, {
    GALLERY_ENABLED: 'true',
    SNOWFLAKE_PAT: 'test-only',
    SNOWFLAKE_ORIGIN: 'https://test.snowflakecomputing.app',
    UPLOAD_SERVICE_ORIGIN: 'https://upload.snowflakecomputing.app',
    GATEWAY_SIGNING_KEY: '22'.repeat(32),
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ ok: true })
  try {
    const req = new Request(env.GATEWAY_ORIGIN + '/api/upload/chunk', {
      method: 'POST',
      body: 'test',
      headers: {
        origin: env.GATEWAY_ORIGIN,
        cookie: '__Host-photo-session=' + (await token(session())),
      },
    })
    const response = await worker.fetch(req, env)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie'), /__Host-photo-session=/)
    assert.deepEqual(await response.json(), { ok: true })
  } finally {
    globalThis.fetch = originalFetch
  }
})
test('Postgres sessions do not contact Durable Objects on gallery requests', async () => {
  const { env } = setup()
  env.SESSION_REVOCATION_BACKEND = 'postgres'
  env.REVOKED_SESSIONS.get = () => {
    throw Error('Must not call Durable Objects')
  }
  const s = session({ revocationBackend: 'postgres' })
  assert.equal((await readSession(request(env, await token(s)), env)).sid, s.sid)
  const { token: t } = await renewed(env, s)
  assert.equal((await readSession(request(env, t), env)).sid, s.sid)
})
test('legacy cookies are checked before migration; previously revoked sessions cannot migrate', async () => {
  const { env } = setup()
  env.SESSION_REVOCATION_BACKEND = 'postgres'
  const s = session()
  const req = request(env, await token(s))
  assert.equal((await readSession(req, env)).revocationBackend, 'postgres')
  await revokeSession(env, s.sid)
  assert.equal(await readSession(req, env), null)
})
test('Postgres logout waits for committed revocation and does not report success on failure', async () => {
  const { handleAuth } = await import('./auth.mjs')
  const { env } = setup()
  Object.assign(env, {
    SESSION_REVOCATION_BACKEND: 'postgres',
    SNOWFLAKE_PAT: 'test-only',
    SNOWFLAKE_ORIGIN: 'https://test.snowflakecomputing.app',
    UPLOAD_SERVICE_ORIGIN: 'https://upload.snowflakecomputing.app',
    GATEWAY_SIGNING_KEY: '22'.repeat(32),
  })
  const originalFetch = globalThis.fetch
  const s = session({ revocationBackend: 'postgres' })
  const req = request(env, await token(s), '/auth/logout')
  let called = 0
  try {
    globalThis.fetch = async (url, init) => {
      called++
      assert.equal(new URL(url).pathname, '/api/auth/revoke-session')
      assert.equal(init.method, 'POST')
      assert.ok(init.headers.get('x-photo-gateway-identity'))
      return new Response('Unavailable', { status: 503 })
    }
    const failed = await handleAuth(req, env)
    assert.equal(failed.status, 503)
    assert.equal(failed.headers.get('set-cookie'), null)
    globalThis.fetch = async () => Response.json({ revoked: true })
    const success = await handleAuth(req, env)
    assert.equal(success.status, 303)
    assert.match(success.headers.get('set-cookie'), /Max-Age=0/)
    assert.equal(called, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('session renewal preserves mandatory thumbnail validation without making it fresh', async () => {
  const { THUMBNAIL_CACHE_CONTROL } = await import('../lib/thumbnail-cache.mjs')
  const { env } = setup()
  const s = session()
  for (const status of [200, 304]) {
    const r = await renewSessionResponse(
      request(env, await token(s), '/api/images?path=thumbnails/a.jpg'),
      new Response(status === 304 ? null : 'image', {
        status,
        headers: { 'Cache-Control': THUMBNAIL_CACHE_CONTROL, ETag: '"a"' },
      }),
      env,
      s,
    )
    assert.equal(r.headers.get('cache-control'), THUMBNAIL_CACHE_CONTROL)
    assert.equal(r.headers.get('etag'), '"a"')
    assert.match(r.headers.get('set-cookie'), /HttpOnly; Secure/)
    assert.equal(r.status, status)
  }
})

test('remembered sessions survive inactivity, renew only to original 30-day ceiling, and revoke', async () => {
  const { env, alarm } = setup()
  const lifetime = 30 * 24 * 3600
  const s = session({
    remember: true,
    startedAt: now() - 7 * 86400,
    absoluteExpiresAt: now() + 23 * 86400,
    exp: now() + 23 * 86400,
  })
  assert.ok(await readSession(request(env, await token(s)), env))
  const { token: t } = await renewed(env, s)
  const { payload } = await jwtDecrypt(t, key)
  assert.equal(payload.remember, true)
  assert.equal(payload.exp, s.absoluteExpiresAt)
  assert.equal(payload.absoluteExpiresAt, s.absoluteExpiresAt)
  assert.equal(await readSession(request(env, await token({ ...s, remember: false })), env), null)
  assert.equal(
    await readSession(
      request(env, await token({ ...s, absoluteExpiresAt: s.startedAt + lifetime + 1 })),
      env,
    ),
    null,
  )
  await revokeSession(env, s.sid)
  assert.equal(await readSession(request(env, t), env), null)
  assert.ok(alarm() > Date.now() + lifetime * 1000)
})

test('remember choice is sealed into login flow, never inferred during renewal', async () => {
  const { handleAuth } = await import('./auth.mjs')
  const { accountLanding } = await import('./customer-accounts.mjs')
  const { env } = setup()
  for (const choice of ['', '?remember=0', '?remember=1']) {
    const response = await handleAuth(new Request(env.GATEWAY_ORIGIN + '/auth/start' + choice), env)
    const value = response.headers.get('set-cookie').split(';')[0].split('=')[1]
    const { payload } = await jwtDecrypt(value, key)
    assert.equal(payload.remember, choice === '?remember=1')
  }
  const html = await accountLanding(env).text()
  assert.match(html, /name="remember" value="1" checked/)
  assert.match(html, /Keep me logged in on this computer for 30 days/)
  assert.match(html, /<form action="\/auth\/start" method="get">/)
})

for (const remaining of [30, 2]) {
  test(`renewal respects the absolute deadline when the clock advances with ${remaining}s left`, async (t) => {
    const initialTime = Math.floor(Date.now() / 1000)
    t.mock.timers.enable({ apis: ['Date'], now: initialTime * 1000 })
    const { env } = setup()
    const s = session({
      startedAt: initialTime - SESSION_MAX_SECONDS + remaining,
      absoluteExpiresAt: initialTime + remaining,
      exp: initialTime + remaining,
    })
    const req = request(env, await token(s))
    const original = new Response('{}', { headers: { 'X-Regression': 'preserved' } })
    const origin = env.GATEWAY_ORIGIN
    // Advance between calculating remaining lifetime and sealing the renewed cookie.
    Object.defineProperty(env, 'GATEWAY_ORIGIN', {
      get() {
        t.mock.timers.tick(3000)
        return origin
      },
    })
    const result = await renewSessionResponse(req, original, env, s)
    if (remaining === 2) {
      assert.equal(result, original)
      assert.equal(result.headers.get('set-cookie'), null)
      assert.equal(result.headers.get('X-Regression'), 'preserved')
      return
    }
    const sealed = result.headers.getSetCookie()[0].split(';')[0].split('=')[1]
    const { payload } = await jwtDecrypt(sealed, key)
    assert.equal(payload.exp, s.absoluteExpiresAt)
    assert.equal(payload.startedAt, s.startedAt)
    assert.equal(payload.iat, initialTime + 3)
    assert.ok(
      await readSession(
        new Request(origin, {
          headers: { cookie: '__Host-photo-session=' + sealed },
        }),
        { ...env, GATEWAY_ORIGIN: origin },
      ),
    )
  })
}
