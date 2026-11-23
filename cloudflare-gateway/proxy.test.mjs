import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proxyGallery } from './proxy.mjs'

const env = {
  GATEWAY_ORIGIN: 'https://photos.stillmark.example',
  SNOWFLAKE_ORIGIN: 'https://test.snowflakecomputing.app',
  SNOWFLAKE_PAT: 'test-only',
  UPLOAD_SERVICE_ORIGIN: 'https://upload.snowflakecomputing.app',
  GATEWAY_SIGNING_KEY: 'ab'.repeat(32),
}
const session = { auth0Subject: 'auth0|user', sid: crypto.randomUUID() }
test('strips caller credentials and identity spoofing; keeps streaming range', async () => {
  const request = new Request(env.GATEWAY_ORIGIN + '/api/photos/1/file', {
    headers: {
      authorization: 'attacker',
      cookie: '__Host-photo-session=private; gallery_activity=abc',
      'sf-context-current-user': 'ACCOUNTADMIN',
      'x-photo-gateway-identity': 'forged',
      range: 'bytes=0-99',
    },
  })
  const result = await proxyGallery(request, env, session, async (url, init) => {
    assert.equal(url, env.SNOWFLAKE_ORIGIN + '/api/photos/1/file')
    assert.equal(init.headers.get('sf-context-current-user'), null)
    assert.equal(init.headers.get('authorization'), 'Snowflake Token="test-only"')
    assert.equal(init.headers.get('cookie'), 'gallery_activity=abc')
    assert.notEqual(init.headers.get('x-photo-gateway-identity'), 'forged')
    assert.equal(init.headers.get('range'), 'bytes=0-99')
    assert.equal(init.redirect, 'manual')
    return new Response('media', { status: 206, headers: { 'Content-Range': 'bytes 0-4/5' } })
  })
  assert.equal(result.status, 206)
  assert.equal(result.headers.get('content-range'), 'bytes 0-4/5')
  assert.equal(result.headers.get('cache-control'), 'private, no-store')
  assert.equal(await result.text(), 'media')
})
test('rejects cross-origin writes before upstream fetch', async () => {
  let calls = 0
  const fetcher = async () => {
    calls++
    return new Response('bad')
  }
  for (const headers of [
    {},
    { origin: 'https://evil.example' },
    { origin: env.GATEWAY_ORIGIN, 'sec-fetch-site': 'cross-site' },
  ]) {
    const res = await proxyGallery(
      new Request(env.GATEWAY_ORIGIN + '/api/upload/chunk', { method: 'POST', headers }),
      env,
      session,
      fetcher,
    )
    assert.equal(res.status, 403)
  }
  assert.equal(calls, 0)
})
test('blocks Snowflake login redirects; rewrites only same-app redirects', async () => {
  for (const location of ['https://login.example/', '/sfc-endpoint/login']) {
    const r = await proxyGallery(
      new Request(env.GATEWAY_ORIGIN),
      env,
      session,
      async () => new Response(null, { status: 302, headers: { location } }),
    )
    assert.equal(r.status, 502)
    assert.equal(r.headers.get('location'), null)
  }
  const r = await proxyGallery(
    new Request(env.GATEWAY_ORIGIN),
    env,
    session,
    async () => new Response(null, { status: 307, headers: { location: '/albums/1' } }),
  )
  assert.equal(r.headers.get('location'), env.GATEWAY_ORIGIN + '/albums/1')
})
test('a protocol-relative path cannot change the proxy origin', async () => {
  await proxyGallery(
    new Request(env.GATEWAY_ORIGIN + '//evil.example/file'),
    env,
    session,
    async (url) => {
      assert.equal(new URL(url).origin, env.SNOWFLAKE_ORIGIN)
      return new Response('ok')
    },
  )
})
test('recovers thumbnail timeouts with bounded retries and cancels failed bodies', async () => {
  let calls = 0
  let canceled = 0
  const r = await proxyGallery(
    new Request(env.GATEWAY_ORIGIN + '/api/images?path=thumbnails/test.jpg'),
    env,
    session,
    async () => {
      calls++
      if (calls < 3)
        return new Response(
          new ReadableStream({
            cancel() {
              canceled++
            },
          }),
          { status: 504 },
        )
      return new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg' } })
    },
  )
  assert.equal(calls, 3)
  assert.equal(canceled, 2)
  assert.equal(r.status, 200)
  assert.equal(await r.text(), 'jpeg')
})
test('stops retrying persistent thumbnail failures', async () => {
  let calls = 0
  const r = await proxyGallery(
    new Request(env.GATEWAY_ORIGIN + '/api/images?path=thumbnails/test.jpg'),
    env,
    session,
    async () => {
      calls++
      return new Response('timeout', { status: 504 })
    },
  )
  assert.equal(calls, 3)
  assert.equal(r.status, 504)
})
test('never retries permission errors, missing files, writes or video requests', async () => {
  for (const [path, method, status] of [
    ['thumbnails/a.jpg', 'GET', 403],
    ['thumbnails/a.jpg', 'GET', 404],
    ['originals/a.mp4', 'GET', 504],
    ['thumbnails/a.jpg', 'POST', 504],
  ]) {
    let calls = 0
    await proxyGallery(
      new Request(env.GATEWAY_ORIGIN + '/api/images?path=' + path, {
        method,
        headers: { origin: env.GATEWAY_ORIGIN },
      }),
      env,
      session,
      async () => {
        calls++
        return new Response('error', { status })
      },
    )
    assert.equal(calls, 1)
  }
})
test('recovers a thumbnail connection failure', async () => {
  let calls = 0
  const r = await proxyGallery(
    new Request(env.GATEWAY_ORIGIN + '/api/images?path=thumbnails/test.jpg'),
    env,
    session,
    async () => {
      if (++calls === 1) throw Error('connection reset')
      return new Response('jpeg')
    },
  )
  assert.equal(calls, 2)
  assert.equal(r.status, 200)
})
test('anonymous proxy is confined to public share reads and strips forged identity', async () => {
  const token = 'a'.repeat(43)
  let calls = 0
  const fetcher = async (url, init) => {
    calls++
    assert.equal(init.headers.get('x-photo-gateway-identity'), null)
    assert.equal(init.headers.get('sf-context-current-user'), null)
    return new Response('ok')
  }
  for (const path of ['/api/photos', '/', '/share/' + token + '/other'])
    assert.equal(
      (await proxyGallery(new Request(env.GATEWAY_ORIGIN + path), env, null, fetcher)).status,
      404,
    )
  assert.equal(
    (
      await proxyGallery(
        new Request(env.GATEWAY_ORIGIN + '/share/' + token, { method: 'POST' }),
        env,
        null,
        fetcher,
      )
    ).status,
    404,
  )
  assert.equal(calls, 0)
  for (const path of [
    '/share/' + token,
    '/share/' + token + '/media/1',
    '/share/' + token + '/download',
  ])
    assert.equal(
      (
        await proxyGallery(
          new Request(env.GATEWAY_ORIGIN + path, {
            headers: { 'x-photo-gateway-identity': 'forged', 'sf-context-current-user': 'ADMIN' },
          }),
          env,
          null,
          fetcher,
        )
      ).status,
      200,
    )
  assert.equal(calls, 3)
})

test('each assertion is unique and bound to its upstream request', async () => {
  const { identityAssertion } = await import('./proxy.mjs')
  const env = { GATEWAY_SIGNING_KEY: 'ab'.repeat(32), GATEWAY_ORIGIN: 'https://photos.example' }
  const request = new Request('https://photos.example/api/events/1?order=asc', { method: 'POST' })
  const session = { auth0Subject: 'auth0|test', sid: crypto.randomUUID() }
  const a = await identityAssertion(session, env, request)
  const b = await identityAssertion(session, env, request)
  const payload = JSON.parse(Buffer.from(a.split('.')[0], 'base64url').toString())
  assert.notEqual(a, b)
  assert.equal(payload.method, 'POST')
  assert.equal(payload.target, '/api/events/1?order=asc')
  assert.equal(payload.exp - payload.iat, 30)
})

test('slow upload body does not consume the server identity lifetime', async (t) => {
  let now = 1_800_000_000_000
  t.mock.method(Date, 'now', () => now)
  const bytes = new Uint8Array([1, 2, 3])
  const body = new ReadableStream(
    {
      pull(controller) {
        now += 45_000
        controller.enqueue(bytes)
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const request = new Request(env.GATEWAY_ORIGIN + '/api/upload/chunk', {
    method: 'POST',
    headers: { origin: env.GATEWAY_ORIGIN },
    body,
    duplex: 'half',
  })
  const response = await proxyGallery(request, env, session, async (_url, init) => {
    const received = new Uint8Array(await new Response(init.body).arrayBuffer())
    assert.deepEqual(received, bytes)
    const claim = JSON.parse(
      Buffer.from(
        init.headers.get('x-photo-gateway-identity').split('.')[0],
        'base64url',
      ).toString(),
    )
    assert.equal(claim.exp - claim.iat, 30)
    return new Response('', { status: claim.exp > Date.now() / 1000 ? 200 : 401 })
  })
  assert.equal(response.status, 200)
})

test('oversized chunks are rejected before forwarding, including missing length headers', async () => {
  for (const declared of [true, false]) {
    let called = false
    const response = await proxyGallery(
      new Request(env.GATEWAY_ORIGIN + '/api/upload/chunk', {
        method: 'POST',
        headers: {
          origin: env.GATEWAY_ORIGIN,
          ...(declared ? { 'content-length': String(9 * 1024 * 1024) } : {}),
        },
        body: new Uint8Array(9 * 1024 * 1024),
      }),
      env,
      session,
      async () => {
        called = true
        return new Response('')
      },
    )
    assert.equal(response.status, 413)
    assert.equal(called, false)
  }
})

test('bounds concurrent buffered uploads and frees capacity after upstream failure', async () => {
  const finishes = []
  const request = () =>
    new Request(env.GATEWAY_ORIGIN + '/api/upload/chunk', {
      method: 'POST',
      headers: { origin: env.GATEWAY_ORIGIN },
      body: 'chunk',
    })
  const pending = Array.from({ length: 4 }, () =>
    proxyGallery(request(), env, session, () => new Promise((_, reject) => finishes.push(reject))),
  )
  const settled = Promise.allSettled(pending)
  const busy = await proxyGallery(request(), env, session, () => {
    throw Error('Must not forward')
  })
  assert.equal(busy.status, 429)
  assert.equal(busy.headers.get('retry-after'), '2')
  while (finishes.length < 4) await new Promise((resolve) => setTimeout(resolve, 0))
  finishes.forEach((reject) => reject(Error('connection interrupted')))
  assert.equal(
    (await settled).every((r) => r.status === 'rejected'),
    true,
  )
  const retry = await proxyGallery(request(), env, session, async () => new Response('ok'))
  assert.equal(retry.status, 200)
})

test('canceling a browser upload stops buffering without forwarding it', async () => {
  const controller = new AbortController()
  let canceled = false
  const body = new ReadableStream({
    cancel() {
      canceled = true
    },
  })
  const request = new Request(env.GATEWAY_ORIGIN + '/api/upload/chunk', {
    method: 'POST',
    headers: { origin: env.GATEWAY_ORIGIN },
    body,
    duplex: 'half',
    signal: controller.signal,
  })
  const pending = proxyGallery(request, env, session, () => {
    throw Error('Must not forward')
  })
  const check = assert.rejects(pending, { name: 'AbortError' })
  controller.abort()
  await check
  assert.equal(canceled, true)
})

test('twelve declared small chunks can reach upstream concurrently without reserving full-size buffers', async () => {
  const finishes = []
  const tasks = Array.from({ length: 12 }, () =>
    proxyGallery(
      new Request(env.GATEWAY_ORIGIN + '/api/upload/chunk', {
        method: 'POST',
        headers: { origin: env.GATEWAY_ORIGIN, 'content-length': '5' },
        body: 'chunk',
      }),
      env,
      session,
      () => new Promise((resolve) => finishes.push(resolve)),
    ),
  )
  try {
    for (let i = 0; i < 100 && finishes.length < 12; i++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(finishes.length, 12)
  } finally {
    finishes.forEach((resolve) => resolve(new Response('ok')))
  }
  assert.ok((await Promise.all(tasks)).every((r) => r.status === 200))
})

test('a misleading small content length cannot bypass the allocated buffer bound', async () => {
  const response = await proxyGallery(
    new Request(env.GATEWAY_ORIGIN + '/api/upload/chunk', {
      method: 'POST',
      headers: { origin: env.GATEWAY_ORIGIN, 'content-length': '1' },
      body: 'chunk',
    }),
    env,
    session,
    () => {
      throw Error('Oversized body must not be forwarded')
    },
  )
  assert.equal(response.status, 413)
})

test('upload routing is pool-only, exact-path, authenticated and preserves cancellation/status', async () => {
  const uploadEnv = { ...env, UPLOAD_SERVICE_ORIGIN: 'https://upload.snowflakecomputing.app' }
  for (const [path, method] of [
    ['/api/upload/chunk', 'POST'],
    ['/api/upload/chunk?uploadId=abc', 'GET'],
    ['/api/upload/chunk?uploadId=abc', 'DELETE'],
    ['/api/upload/complete', 'POST'],
    ['/api/upload/status', 'POST'],
    ['/api/events', 'GET'],
    ['/api/upload/chunk/extra', 'POST'],
  ]) {
    for (const enabled of [undefined, 'true']) {
      const request = new Request(env.GATEWAY_ORIGIN + path, {
        method,
        headers: { origin: env.GATEWAY_ORIGIN },
      })
      await proxyGallery(
        request,
        { ...uploadEnv, UPLOAD_SERVICE_ENABLED: enabled },
        session,
        async (url, init) => {
          const routed = ['/api/upload/chunk', '/api/upload/complete'].includes(path.split('?')[0])
          assert.equal(
            url,
            (routed ? uploadEnv.UPLOAD_SERVICE_ORIGIN : env.SNOWFLAKE_ORIGIN) + path,
          )
          assert.equal(init.method, method)
          assert.ok(init.headers.get('x-photo-gateway-identity'))
          return new Response('ok')
        },
      )
    }
  }
  let called = false
  const response = await proxyGallery(
    new Request(env.GATEWAY_ORIGIN + '/api/upload/chunk'),
    { ...uploadEnv, UPLOAD_SERVICE_ENABLED: 'true' },
    null,
    async () => {
      called = true
    },
  )
  assert.equal(response.status, 404)
  assert.equal(called, false)
})
test('upload routing rejects invalid destinations and never falls back after a failed write', async () => {
  for (const origin of [
    'https://attacker.example',
    'http://upload.snowflakecomputing.app',
    'https://upload.snowflakecomputing.app/path',
  ]) {
    await assert.rejects(
      proxyGallery(
        new Request(env.GATEWAY_ORIGIN + '/api/upload/complete', {
          method: 'POST',
          headers: { origin: env.GATEWAY_ORIGIN },
        }),
        { ...env, UPLOAD_SERVICE_ENABLED: 'true', UPLOAD_SERVICE_ORIGIN: origin },
        session,
        async () => assert.fail('unexpected upstream'),
      ),
    )
  }
  let calls = 0
  await assert.rejects(
    proxyGallery(
      new Request(env.GATEWAY_ORIGIN + '/api/upload/complete', {
        method: 'POST',
        headers: { origin: env.GATEWAY_ORIGIN },
      }),
      {
        ...env,
        UPLOAD_SERVICE_ENABLED: 'true',
        UPLOAD_SERVICE_ORIGIN: 'https://upload.snowflakecomputing.app',
      },
      session,
      async () => {
        calls++
        throw Error('connection lost')
      },
    ),
  )
  assert.equal(calls, 1)
})

test('test upload page sets a scoped secure cookie and normal page clears it', async () => {
  for (const enabled of [true, false]) {
    const response = await proxyGallery(
      new Request(env.GATEWAY_ORIGIN + '/admin/upload' + (enabled ? '?uploadServiceCanary=1' : '')),
      { ...env, UPLOAD_SERVICE_CANARY: 'true' },
      session,
      async () => new Response('page'),
    )
    assert.equal(
      response.headers.get('set-cookie'),
      `upload_service_canary=${enabled ? '1' : ''}; Path=/api/upload; HttpOnly; Secure; SameSite=Strict; Max-Age=${enabled ? 900 : 0}`,
    )
  }
})

test('missing pool configuration fails closed without SAR fallback', async () => {
  const response = await proxyGallery(
    new Request(env.GATEWAY_ORIGIN + '/api/upload/complete', {
      method: 'POST',
      headers: { origin: env.GATEWAY_ORIGIN },
    }),
    { ...env, UPLOAD_SERVICE_ORIGIN: undefined },
    session,
    async () => assert.fail('must not forward to SAR'),
  )
  assert.equal(response.status, 503)
})
test('pool uploads make no per-file routing lookup', async () => {
  const calls = []
  const response = await proxyGallery(
    new Request(env.GATEWAY_ORIGIN + '/api/upload/complete', {
      method: 'POST',
      headers: { origin: env.GATEWAY_ORIGIN },
    }),
    { ...env, UPLOAD_SERVICE_DYNAMIC: 'true', UPLOAD_SERVICE_ENABLED: 'false' },
    session,
    async (url) => {
      calls.push(url)
      return new Response('worker unavailable', { status: 503 })
    },
  )
  assert.equal(response.status, 503)
  assert.deepEqual(calls, [env.UPLOAD_SERVICE_ORIGIN + '/api/upload/complete'])
})
