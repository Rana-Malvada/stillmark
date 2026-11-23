import test from 'node:test'
import assert from 'node:assert/strict'
import { EncryptJWT } from 'jose'
import { RevokedSession } from './session-revocation.mjs'
import { handleAuth, readSession } from './auth.mjs'

function setup() {
  const data = new Map()
  const object = new RevokedSession({
    storage: {
      get: async (k) => data.get(k),
      put: async (k, v) => data.set(k, v),
      setAlarm: async () => {},
      deleteAll: async () => data.clear(),
    },
  })
  const env = {
    GATEWAY_ORIGIN: 'https://photos.stillmark.example',
    AUTH0_DOMAIN: 'login.stillmark.example',
    AUTH0_CLIENT_ID: 'test',
    AUTH0_CLIENT_SECRET: 'test',
    SESSION_KEY: '11'.repeat(32),
    REVOKED_SESSIONS: {
      idFromName: (x) => x,
      get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }),
    },
  }
  return { env, object, data }
}
async function cookie() {
  return new EncryptJWT({ auth0Subject: 'auth0|test', sid: '11111111-1111-4111-8111-111111111111' })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setSubject('gallery-session')
    .setIssuedAt()
    .setExpirationTime('1h')
    .encrypt(new Uint8Array(32).fill(17))
}
test('logout invalidates a copied cookie and expires private revocation records', async () => {
  const { env, object, data } = setup()
  const token = await cookie()
  const request = (path) =>
    new Request(env.GATEWAY_ORIGIN + path, { headers: { cookie: '__Host-photo-session=' + token } })
  assert.equal((await readSession(request('/'), env)).auth0Subject, 'auth0|test')
  const result = await handleAuth(request('/auth/logout'), env)
  assert.equal(result.status, 303)
  assert.match(result.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal(await readSession(request('/'), env), null)
  assert.equal(data.size, 1)
  await object.alarm()
  assert.equal(data.size, 0)
})
test('fails closed if the session store is unavailable', async () => {
  const { env } = setup()
  env.REVOKED_SESSIONS.get = () => ({
    fetch: async () => {
      throw Error('offline')
    },
  })
  const req = new Request(env.GATEWAY_ORIGIN + '/auth/logout', {
    headers: { cookie: '__Host-photo-session=' + (await cookie()) },
  })
  assert.equal(await readSession(req, env), null)
  assert.equal((await handleAuth(req, env)).status, 503)
})
