import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { issueThumbnailGrants, verifyThumbnailGrant } from '../lib/media-grant.mjs'
import { grantedThumbnail } from './thumbnail-grants.mjs'
import { proxyGallery } from './proxy.mjs'
import { clearMediaLinks } from './media-delivery.mjs'
import { renewSessionResponse } from './auth.mjs'

const path = 'thumbnails/400/1/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/image.jpg'
const env = {
  MEDIA_GRANTS_ENABLED: 'true',
  MEDIA_GRANT_CACHE_ENABLED: 'true',
  MEDIA_DELIVERY_MODE: 'enabled',
  MEDIA_GRANT_SIGNING_KEY: 'cd'.repeat(32),
  GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
  GATEWAY_ORIGIN: 'https://photos.stillmark.example',
  SNOWFLAKE_ORIGIN: 'https://test.snowflakecomputing.app',
  SNOWFLAKE_PAT: 'test',
}
const session = { auth0Subject: 'auth0|alice', sid: crypto.randomUUID() }
const storage = 'https://example-customer-stage.s3.us-east-2.amazonaws.com/test'
async function token(at) {
  return (
    await issueThumbnailGrants(
      [path],
      { sub: session.auth0Subject, sid: session.sid },
      env.GATEWAY_ORIGIN,
      env.MEDIA_GRANT_SIGNING_KEY,
      at,
    )
  )[0]
}
const request = (t) =>
  new Request(env.GATEWAY_ORIGIN + '/api/images?' + new URLSearchParams({ path, grant: t }))
function memoryCache() {
  const values = new Map()
  return {
    async match(k) {
      return values.get(k.url)?.clone()
    },
    async put(k, v) {
      values.set(k.url, v.clone())
    },
  }
}
beforeEach(clearMediaLinks)
test('grant is bound to path, session, subject, audience and signature; expiry never widens access', async () => {
  const t = await token(100)
  assert.equal(
    (
      await verifyThumbnailGrant(
        t,
        path,
        session,
        env.GATEWAY_ORIGIN,
        env.MEDIA_GRANT_SIGNING_KEY,
        120,
      )
    ).variant,
    'thumbnail',
  )
  assert.equal(
    await verifyThumbnailGrant(
      t,
      path,
      session,
      env.GATEWAY_ORIGIN,
      env.MEDIA_GRANT_SIGNING_KEY,
      160,
    ),
    null,
  )
  for (const [p, s, a, k] of [
    [path.replace('/1/', '/2/'), session, env.GATEWAY_ORIGIN, env.MEDIA_GRANT_SIGNING_KEY],
    [
      path,
      { ...session, sid: crypto.randomUUID() },
      env.GATEWAY_ORIGIN,
      env.MEDIA_GRANT_SIGNING_KEY,
    ],
    [
      path,
      { ...session, auth0Subject: 'auth0|bob' },
      env.GATEWAY_ORIGIN,
      env.MEDIA_GRANT_SIGNING_KEY,
    ],
    [path, session, 'https://other.test', env.MEDIA_GRANT_SIGNING_KEY],
    [path, session, env.GATEWAY_ORIGIN, 'ef'.repeat(32)],
    ['originals/private.jpg', session, env.GATEWAY_ORIGIN, env.MEDIA_GRANT_SIGNING_KEY],
  ])
    await assert.rejects(verifyThumbnailGrant(t, p, s, a, k, 120))
  await assert.rejects(
    verifyThumbnailGrant(
      t + 'x',
      path,
      session,
      env.GATEWAY_ORIGIN,
      env.MEDIA_GRANT_SIGNING_KEY,
      120,
    ),
  )
  assert.deepEqual(
    await issueThumbnailGrants(
      ['thumbnails/legacy.jpg'],
      { sub: session.auth0Subject, sid: session.sid },
      env.GATEWAY_ORIGIN,
      env.MEDIA_GRANT_SIGNING_KEY,
    ),
    [null],
  )
})
test('warm edge hit skips app, SQL and storage but revalidates authority; browser must revalidate', async () => {
  const cache = memoryCache()
  const t = await token()
  let sql = 0
  let objects = 0
  const fetcher = async (url) => {
    if (url.includes('/api/v2/statements')) {
      sql++
      return Response.json({ data: [[storage]] })
    }
    objects++
    return new Response('jpeg', { headers: { 'content-length': '4', etag: '"v1"' } })
  }
  for (let i = 0; i < 2; i++) {
    const r = await grantedThumbnail(request(t), env, session, fetcher, cache)
    assert.equal(await r.text(), 'jpeg')
    assert.match(r.headers.get('cache-control'), /private, no-cache/)
    assert.equal(r.headers.get('x-media-cache'), i ? 'hit' : 'miss')
    assert.equal(r.headers.get('set-cookie'), null)
    if (i) {
      assert.match(r.headers.get('server-timing'), /^media_cache;/)
      assert.equal(r.headers.get('x-media-delivery'), 'edge-cache')
    }
  }
  assert.equal(sql, 1)
  assert.equal(objects, 1)
  assert.equal(
    (
      await grantedThumbnail(
        request(t),
        env,
        { ...session, sid: crypto.randomUUID() },
        fetcher,
        cache,
      )
    ).status,
    403,
  )
  assert.equal(await grantedThumbnail(request(t), env, null, fetcher, cache), null)
  const conditional = request(t)
  conditional.headers.set('if-none-match', '"v1"')
  assert.equal((await grantedThumbnail(conditional, env, session, fetcher, cache)).status, 304)
  assert.equal(objects, 1)
})
test('expired grants fall back to live app ACL; denied app response cannot use cached authority', async () => {
  let app = 0
  const res = await proxyGallery(
    request(await token(Math.floor(Date.now() / 1000) - 61)),
    env,
    session,
    async (url) => {
      assert.ok(url.startsWith(env.SNOWFLAKE_ORIGIN))
      app++
      return new Response('revoked', { status: 403 })
    },
  )
  assert.equal(res.status, 403)
  assert.equal(app, 1)
})
test('download, range, duplicated path and variant overrides cannot use a thumbnail grant', async () => {
  const t = await token()
  for (const suffix of ['&download=1', '&path=' + path, '&kind=original'])
    assert.equal(
      (
        await grantedThumbnail(new Request(request(t).url + suffix), env, session, () => {
          throw Error('unreachable')
        })
      ).status,
      403,
    )
  const r = request(t)
  r.headers.set('range', 'bytes=0-1')
  assert.equal((await grantedThumbnail(r, env, session)).status, 403)
  assert.equal(
    await grantedThumbnail(request(t), { ...env, MEDIA_GRANTS_ENABLED: 'false' }, session),
    null,
  )
})
test('successful grant responses do not reseal session cookies', async () => {
  const response = new Response('image', { headers: { 'X-Media-Authorization': 'grant' } })
  assert.equal(await renewSessionResponse(request(await token()), response, {}, session), response)
})

test('cache failure cannot prevent authorized delivery or authorize an invalid grant', async () => {
  const broken = {
    async match() {
      throw Error('cache unavailable')
    },
    async put() {
      throw Error('cache unavailable')
    },
  }
  let objects = 0
  const fetcher = async (url) =>
    url.includes('/api/v2/statements')
      ? Response.json({ data: [[storage]] })
      : (objects++, new Response('jpeg', { headers: { 'content-length': '4' } }))
  const r = await grantedThumbnail(request(await token()), env, session, fetcher, broken)
  assert.equal(await r.text(), 'jpeg')
  assert.equal(objects, 1)
  assert.equal(
    (await grantedThumbnail(request('invalid'), env, session, fetcher, broken)).status,
    403,
  )
  assert.equal(objects, 1)
})
test('stalled optional cache is bounded and still returns the authorized thumbnail', async () => {
  const stuck = { match: () => new Promise(() => {}), put: () => new Promise(() => {}) }
  const fetcher = async (url) =>
    url.includes('/api/v2/statements')
      ? Response.json({ data: [[storage]] })
      : new Response('jpeg', { headers: { 'content-length': '4' } })
  const start = Date.now()
  const r = await grantedThumbnail(request(await token()), env, session, fetcher, stuck)
  assert.equal(await r.text(), 'jpeg')
  assert.ok(Date.now() - start < 2000)
})
test('cold storage failures fall back through live app authorization', async () => {
  let app = 0
  const r = await proxyGallery(request(await token()), env, session, async (url) => {
    if (url.startsWith(env.SNOWFLAKE_ORIGIN)) {
      app++
      return new Response('revoked', { status: 403 })
    }
    throw Error('storage unavailable')
  })
  assert.equal(r.status, 403)
  assert.equal(app, 1)
})
