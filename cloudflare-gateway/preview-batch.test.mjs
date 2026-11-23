import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { proxyGallery } from './proxy.mjs'
import { clearMediaLinks } from './media-delivery.mjs'
import { readPreviewBatch } from '../public/preview-batch.mjs'

const env = {
  PREVIEW_BATCH_ENABLED: 'true',
  MEDIA_DELIVERY_MODE: 'enabled',
  GATEWAY_ORIGIN: 'https://photos.stillmark.example',
  SNOWFLAKE_ORIGIN: 'https://test.snowflakecomputing.app',
  SNOWFLAKE_PAT: 'fixture',
  GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
  CUSTOMER_ACCOUNTS_ENABLED: 'true',
}
const session = { auth0Subject: 'auth0|test', sid: crypto.randomUUID() }
const storage = 'https://example-customer-stage.s3.us-east-2.amazonaws.com/'
const paths = Array.from({ length: 8 }, (_, i) => `thumbnails/${i}.jpg`)
function request() {
  return new Request(env.GATEWAY_ORIGIN + '/api/images/batch', {
    method: 'POST',
    headers: {
      origin: env.GATEWAY_ORIGIN,
      'Content-Type': 'application/json',
      'x-photo-media-transfer': 'forged',
    },
    body: JSON.stringify({ paths }),
  })
}
beforeEach(clearMediaLinks)
test('one app authorization and one cold signing call for eight images; warm batch still reauthorizes', async () => {
  let auth = 0
  let sql = 0
  let objects = 0
  const fetcher = async (url, init) => {
    if (url.startsWith(env.SNOWFLAKE_ORIGIN)) {
      auth++
      assert.equal(init.headers.get('x-photo-media-transfer'), 'preview-batch-v1')
      assert.ok(init.headers.get('x-photo-gateway-identity'))
      return Response.json(
        { items: paths },
        { headers: { 'x-photo-media-transfer': 'preview-batch-v1' } },
      )
    }
    if (url.includes('/api/v2/statements')) {
      sql++
      assert.equal((JSON.parse(init.body).statement.match(/GET_PRESIGNED_URL/g) || []).length, 8)
      assert.doesNotMatch(JSON.parse(init.body).statement, /UNION|FROM/i)
      return Response.json({ data: [paths.map((_, i) => storage + i)] })
    }
    objects++
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers, undefined)
    return new Response(url.slice(-1), { headers: { 'Content-Type': 'image/jpeg' } })
  }
  for (let n = 0; n < 2; n++) {
    const result = await proxyGallery(request(), env, session, fetcher)
    const blobs = []
    await readPreviewBatch(result, 8, (i, blob) => (blobs[i] = blob))
    assert.equal(await blobs[5].text(), '5')
    assert.equal(result.headers.get('x-photo-media-transfer'), null)
    assert.match(result.headers.get('cache-control'), /no-store/)
  }
  assert.equal(auth, 2)
  assert.equal(sql, 1)
  assert.equal(objects, 16)
})
test('does not sign denied items or bypass a revoked user', async () => {
  let storageCalls = 0
  const denied = await proxyGallery(
    request(),
    env,
    session,
    async () => new Response('Denied', { status: 403 }),
  )
  assert.equal(denied.status, 403)
  const result = await proxyGallery(request(), env, session, async (url) => {
    if (url.startsWith(env.SNOWFLAKE_ORIGIN))
      return Response.json(
        { items: [null] },
        { headers: { 'x-photo-media-transfer': 'preview-batch-v1' } },
      )
    storageCalls++
    throw Error('must not fetch')
  })
  await readPreviewBatch(result, 1, (_, blob) => assert.equal(blob, null))
  assert.equal(storageCalls, 0)
})
test('rejects an unexpected manifest and cross-site requests', async () => {
  await assert.rejects(
    proxyGallery(request(), { ...env, PREVIEW_BATCH_ENABLED: 'false' }, session, async () =>
      Response.json(
        { items: paths },
        { headers: { 'x-photo-media-transfer': 'preview-batch-v1' } },
      ),
    ),
    /Unexpected/,
  )
  const req = request()
  req.headers.set('origin', 'https://evil.test')
  const denied = await proxyGallery(req, env, session, async () => {
    throw Error('must not fetch')
  })
  assert.equal(denied.status, 403)
})
test('rejects signing destination substitution before any image fetch', async () => {
  await assert.rejects(
    proxyGallery(request(), env, session, async (url) => {
      if (url.startsWith(env.SNOWFLAKE_ORIGIN))
        return Response.json(
          { items: [paths[0]] },
          { headers: { 'x-photo-media-transfer': 'preview-batch-v1' } },
        )
      return Response.json({ data: [['https://evil.test/image']] })
    }),
    /destination/,
  )
})
test('authorized reusable thumbnails require no signing or object fetch', async () => {
  let authorization = 0
  const result = await proxyGallery(request(), env, session, async (url) => {
    assert.ok(url.startsWith(env.SNOWFLAKE_ORIGIN))
    authorization++
    return Response.json(
      { items: [paths[0], null], reusable: [paths[0]] },
      {
        headers: { 'x-photo-media-transfer': 'preview-batch-v1' },
      },
    )
  })
  const statuses = []
  await readPreviewBatch(result, 2, (i, _, status) => {
    statuses[i] = status
  })
  assert.deepEqual(statuses, [304, 404])
  assert.equal(authorization, 1)
})
