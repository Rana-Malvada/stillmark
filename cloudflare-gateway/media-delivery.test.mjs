import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { proxyGallery } from './proxy.mjs'
import { clearMediaLinks } from './media-delivery.mjs'

const env = {
  MEDIA_DELIVERY_MODE: 'enabled',
  GATEWAY_ORIGIN: 'https://photos.stillmark.example',
  SNOWFLAKE_ORIGIN: 'https://test.snowflakecomputing.app',
  SNOWFLAKE_PAT: 'secret',
  GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
}
const session = { auth0Subject: 'auth0|test', sid: crypto.randomUUID() }
const storage = 'https://example-customer-stage.s3.us-east-2.amazonaws.com/file?signature=secret'
const request = (path = '/api/images?path=originals/test.mov') =>
  new Request(env.GATEWAY_ORIGIN + path, {
    headers: { range: 'bytes=0-3', cookie: 'private', 'x-photo-media-transfer': 'forged' },
  })
const grant = () =>
  Response.json(
    { path: 'originals/test.mov', type: 'video/quicktime' },
    { headers: { 'x-photo-media-transfer': 'public-sql-v2' } },
  )
beforeEach(clearMediaLinks)
test('checks access every time while reusing only storage links and preserves exact ranges', async () => {
  let auth = 0
  let sql = 0
  let objects = 0
  const fetcher = async (url, init) => {
    if (url.startsWith(env.SNOWFLAKE_ORIGIN)) {
      auth++
      assert.equal(init.headers.get('x-photo-media-transfer'), 'public-sql-v2')
      return grant()
    }
    if (url.includes('/api/v2/statements')) {
      sql++
      assert.equal(init.headers['User-Agent'], 'PersonalPhotosMediaDelivery/1.0')
      assert.match(JSON.parse(init.body).statement, /GET_PRESIGNED_URL/)
      return Response.json({ data: [[storage]] })
    }
    objects++
    assert.equal(url, storage)
    assert.equal(init.headers.get('range'), 'bytes=0-3')
    for (const h of ['cookie', 'authorization', 'x-photo-gateway-identity'])
      assert.equal(init.headers.get(h), null)
    return new Response(new Uint8Array([0, 1, 2, 3]), {
      status: 206,
      headers: { 'content-range': 'bytes 0-3/100', 'content-length': '4', etag: '"unchanged"' },
    })
  }
  for (let i = 0; i < 2; i++) {
    const r = await proxyGallery(request(), env, session, fetcher)
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), 'bytes 0-3/100')
    assert.equal(r.headers.get('etag'), '"unchanged"')
    assert.equal(r.headers.get('x-photo-media-transfer'), null)
    assert.equal(r.headers.get('location'), null)
    assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0, 1, 2, 3])
  }
  assert.equal(auth, 2)
  assert.equal(sql, 1)
  assert.equal(objects, 2)
})
test('expired or revoked shares and sessions never fetch storage, even with a cached storage link', async () => {
  for (const [path, s] of [
    ['/api/images?path=originals/test.mov', session],
    ['/share/' + 'a'.repeat(43) + '/media/1', null],
  ]) {
    let calls = 0
    const r = await proxyGallery(request(path), env, s, async () => {
      calls++
      return new Response('Denied', { status: 403 })
    })
    assert.equal(r.status, 403)
    assert.equal(calls, 1)
  }
})
test('public share playback uses the approved path and never forwards an identity', async () => {
  let calls = 0
  const r = await proxyGallery(
    request('/share/' + 'a'.repeat(43) + '/media/1'),
    env,
    null,
    async (url, init) => {
      if (++calls === 1) {
        assert.equal(init.headers.get('x-photo-gateway-identity'), null)
        return grant()
      }
      if (calls === 2) return Response.json({ data: [[storage]] })
      return new Response('data')
    },
  )
  assert.equal(await r.text(), 'data')
  assert.equal(calls, 3)
})
test('signing failure rechecks authorization through the existing route instead of breaking playback', async () => {
  let calls = 0
  const r = await proxyGallery(request(), env, session, async (url, init) => {
    calls++
    if (calls === 1) return grant()
    if (calls === 2) return new Response('signing unavailable', { status: 503 })
    assert.equal(init.headers.get('x-photo-media-transfer'), null)
    return new Response('original fallback')
  })
  assert.equal(await r.text(), 'original fallback')
  assert.equal(calls, 3)
})
test('rejects a foreign signed destination and falls back without contacting it', async () => {
  let calls = 0
  const r = await proxyGallery(request(), env, session, async (url) => {
    calls++
    assert.ok(!url.includes('evil'))
    if (calls === 1) return grant()
    if (calls === 2) return Response.json({ data: [['https://evil.example/video']] })
    return new Response('safe fallback')
  })
  assert.equal(await r.text(), 'safe fallback')
})
test('canary is opt-in; downloads and disabled mode retain the original route', async () => {
  for (const [url, e] of [
    ['/api/images?path=originals/test.mov', { ...env, MEDIA_DELIVERY_MODE: 'canary' }],
    ['/api/images?path=originals/test.mov&download=1', env],
    ['/share/' + 'a'.repeat(43) + '/media/1?kind=original', env],
  ]) {
    const r = await proxyGallery(
      request(url),
      e,
      url.startsWith('/share/') ? null : session,
      async (_, init) => {
        assert.equal(init.headers.get('x-photo-media-transfer'), null)
        return new Response('old route')
      },
    )
    assert.equal(await r.text(), 'old route')
  }
})
test('streams the first bytes without waiting for end of file', async () => {
  let close
  let calls = 0
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1]))
      close = () => c.close()
    },
  })
  const r = await proxyGallery(request(), env, session, async () =>
    ++calls === 1
      ? grant()
      : calls === 2
        ? Response.json({ data: [[storage]] })
        : new Response(body),
  )
  const reader = r.body.getReader()
  assert.equal((await reader.read()).value[0], 1)
  close()
  assert.equal((await reader.read()).done, true)
})
test('a warmed storage-link cache never bypasses a newly revoked user session', async () => {
  let allowed = true
  let objects = 0
  let signs = 0
  const fetcher = async (url) => {
    if (url.startsWith(env.SNOWFLAKE_ORIGIN))
      return allowed ? grant() : new Response('Signed out', { status: 401 })
    if (url.includes('/api/v2/statements')) {
      signs++
      return Response.json({ data: [[storage]] })
    }
    objects++
    return new Response('data')
  }
  assert.equal((await proxyGallery(request(), env, session, fetcher)).status, 200)
  allowed = false
  assert.equal((await proxyGallery(request(), env, session, fetcher)).status, 401)
  assert.equal(signs, 1)
  assert.equal(objects, 1)
})

test('new derived playback is signed from its own stage', async () => {
  let sql = ''
  const fetcher = async (url, init) => {
    if (url.startsWith(env.SNOWFLAKE_ORIGIN))
      return Response.json(
        { path: 'display/prepared/id/720/playback.mp4', type: 'video/mp4' },
        { headers: { 'x-photo-media-transfer': 'public-sql-v2' } },
      )
    if (url.includes('/api/v2/statements')) {
      sql = JSON.parse(init.body).statement
      return Response.json({ data: [[storage]] })
    }
    return new Response('video')
  }
  assert.equal((await proxyGallery(request(), env, session, fetcher)).status, 200)
  assert.match(sql, /@PERSONAL_MEDIA.RAW.DERIVED_FILES/)
})

test('thumbnail revalidation preserves 304 through the proxy and still checks live access', async () => {
  let authorized = true
  let auth = 0
  let bytes = 0
  const req = new Request(env.GATEWAY_ORIGIN + '/api/images?path=thumbnails/cache.jpg', {
    headers: { 'if-none-match': '"same"' },
  })
  const fetcher = async (url, init) => {
    if (url.startsWith(env.SNOWFLAKE_ORIGIN)) {
      auth++
      return authorized
        ? Response.json(
            { path: 'thumbnails/cache.jpg', type: 'image/jpeg', revalidateThumbnail: true },
            { headers: { 'x-photo-media-transfer': 'public-sql-v2' } },
          )
        : new Response('Denied', { status: 404 })
    }
    if (url.includes('/api/v2/statements')) return Response.json({ data: [[storage]] })
    bytes++
    assert.equal(init.headers.get('if-none-match'), '"same"')
    return new Response(null, { status: 304, headers: { etag: '"same"' } })
  }
  const r = await proxyGallery(req, env, session, fetcher)
  assert.equal(r.status, 304)
  assert.equal(r.body, null)
  assert.match(r.headers.get('cache-control'), /private, no-cache/)
  assert.equal(r.headers.get('etag'), '"same"')
  authorized = false
  const denied = await proxyGallery(req, env, session, fetcher)
  assert.equal(denied.status, 404)
  assert.match(denied.headers.get('cache-control'), /no-store/)
  assert.equal(auth, 2)
  assert.equal(bytes, 1)
})

test('public shares, downloads, ranges, and old grants cannot enable thumbnail caching', async () => {
  for (const [path, headers, grantCache, user] of [
    ['/share/' + 'a'.repeat(43) + '/media/1', {}, true, null],
    ['/api/images?path=thumbnails/cache.jpg', {}, false, session],
    ['/api/images?path=thumbnails/cache.jpg', { range: 'bytes=0-3' }, true, session],
  ]) {
    const r = await proxyGallery(
      new Request(env.GATEWAY_ORIGIN + path, {
        headers: { 'if-none-match': '"same"', ...headers },
      }),
      env,
      user,
      async (url, init) => {
        if (url.startsWith(env.SNOWFLAKE_ORIGIN))
          return Response.json(
            { path: 'thumbnails/cache.jpg', type: 'image/jpeg', revalidateThumbnail: grantCache },
            { headers: { 'x-photo-media-transfer': 'public-sql-v2' } },
          )
        if (url.includes('/api/v2/statements')) return Response.json({ data: [[storage]] })
        assert.equal(init.headers.get('if-none-match'), null)
        return new Response('bytes')
      },
    )
    assert.match(r.headers.get('cache-control'), /no-store/)
  }
})

test('changed thumbnail bytes return 200 and a new validator', async () => {
  const req = new Request(env.GATEWAY_ORIGIN + '/api/images?path=thumbnails/cache.jpg', {
    headers: { 'if-none-match': '"old"' },
  })
  const r = await proxyGallery(req, env, session, async (url) => {
    if (url.startsWith(env.SNOWFLAKE_ORIGIN))
      return Response.json(
        { path: 'thumbnails/cache.jpg', type: 'image/jpeg', revalidateThumbnail: true },
        { headers: { 'x-photo-media-transfer': 'public-sql-v2' } },
      )
    if (url.includes('/api/v2/statements')) return Response.json({ data: [[storage]] })
    return new Response('updated', { headers: { etag: '"new"' } })
  })
  assert.equal(r.status, 200)
  assert.equal(await r.text(), 'updated')
  assert.equal(r.headers.get('etag'), '"new"')
  assert.match(r.headers.get('cache-control'), /must-revalidate/)
})

test('signs cold thumbnails independently and reuses completed links', async () => {
  const { publicStorageUrl } = await import('./media-delivery.mjs')
  let calls = 0
  const fetcher = async (_url, init) => {
    calls++
    const statement = JSON.parse(init.body).statement
    const items = [...statement.matchAll(/GET_PRESIGNED_URL\([^,]+, '([^']+)'/g)]
    assert.ok(items.length <= 20)
    return Response.json({ data: [items.map((m) => storage + '&path=' + m[1])] })
  }
  const paths = Array.from({ length: 45 }, (_, i) => `thumbnails/${i}.jpg`)
  const urls = await Promise.all(paths.map((p) => publicStorageUrl(p, env, fetcher)))
  assert.equal(calls, 45)
  urls.forEach((url, i) => assert.equal(new URL(url).searchParams.get('path'), paths[i]))
  await Promise.all(paths.map((p) => publicStorageUrl(p, env, fetcher)))
  assert.equal(calls, 45)
})

test('failed thumbnail requests reject all callers and can retry without a stuck pending entry', async () => {
  const { publicStorageUrl } = await import('./media-delivery.mjs')
  let failing = true
  const fetcher = async () =>
    failing ? Response.json({}, { status: 503 }) : Response.json({ data: [[storage]] })
  const results = await Promise.allSettled(
    ['a', 'b'].map((p) => publicStorageUrl(`thumbnails/${p}.jpg`, env, fetcher)),
  )
  assert.ok(results.every((r) => r.status === 'rejected'))
  failing = false
  assert.equal(await publicStorageUrl('thumbnails/a.jpg', env, fetcher), storage)
})

test('stalled edge signing falls back within one shared header budget', async () => {
  const keepAlive = setTimeout(() => {}, 20000)
  const started = performance.now()
  let auth = 0
  try {
    const r = await proxyGallery(
      request(),
      { ...env, MEDIA_EDGE_TIMEOUT_MS: '100' },
      session,
      async (url, init) => {
        if (url.startsWith(env.SNOWFLAKE_ORIGIN)) {
          if (++auth === 1) return grant()
          assert.equal(init.headers.has('x-photo-media-transfer'), false)
          return new Response('authorized fallback')
        }
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        })
      },
    )
    assert.equal(await r.text(), 'authorized fallback')
    assert.equal(auth, 2)
    assert.ok(performance.now() - started < 1000, 'fallback must run before the client deadline')
  } finally {
    clearTimeout(keepAlive)
  }
})

test('edge header budget does not terminate a healthy video body', async () => {
  const r = await proxyGallery(
    request(),
    { ...env, MEDIA_EDGE_TIMEOUT_MS: '100' },
    session,
    async (url, init) => {
      if (url.startsWith(env.SNOWFLAKE_ORIGIN)) return grant()
      if (url.includes('/api/v2/statements')) return Response.json({ data: [[storage]] })
      return new Response(
        new ReadableStream({
          start(controller) {
            const abort = () => controller.error(init.signal.reason)
            init.signal.addEventListener('abort', abort, { once: true })
            setTimeout(() => {
              init.signal.removeEventListener('abort', abort)
              controller.enqueue(new TextEncoder().encode('video'))
              controller.close()
            }, 150)
          },
        }),
      )
    },
  )
  assert.equal(await r.text(), 'video')
})

test('client cancellation does not start a new app fallback', async () => {
  const controller = new AbortController()
  const req = new Request(request(), { signal: controller.signal })
  let auth = 0
  const pending = proxyGallery(req, env, session, async (url, init) => {
    if (url.startsWith(env.SNOWFLAKE_ORIGIN)) {
      auth++
      return grant()
    }
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      controller.abort()
    })
  })
  await assert.rejects(pending)
  assert.equal(auth, 1)
})

test('signed-link LRU stays bounded without extending authorization or signature lifetime', async () => {
  const { publicStorageUrl, clearMediaLinks } = await import('./media-delivery.mjs')
  clearMediaLinks()
  let calls = 0
  const fetcher = async () => {
    calls++
    return Response.json({ data: [[storage]] })
  }
  const small = { ...env, MEDIA_SIGNED_URL_CACHE_MAX: '2' }
  for (const p of ['a', 'b', 'a', 'c', 'a'])
    await publicStorageUrl(`thumbnails/${p}.jpg`, small, fetcher)
  assert.equal(calls, 3)
  await publicStorageUrl('thumbnails/b.jpg', small, fetcher)
  assert.equal(calls, 4)
})
