import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDiagnostics, routeCategory } from './diagnostics.mjs'

test('diagnostics retain no URLs, queries, IDs, cookies or tokens', () => {
  const rows = []
  const record = createDiagnostics({ random: () => 0 })
  const env = {
    GATEWAY_DIAGNOSTICS: 'enabled',
    GATEWAY_METRICS: { writeDataPoint: (r) => rows.push(r) },
  }
  for (const path of [
    '/share/SECRET/media/123?kind=segment&token=SECRET',
    '/api/search?q=SECRET',
    '/api/images?path=thumbnails/SECRET.jpg',
  ])
    record(
      new Request('https://app' + path, {
        headers: { cookie: 'SECRET', authorization: 'SECRET', range: 'bytes=0-999' },
      }),
      env,
      new Response(null, { status: 206, headers: { 'server-timing': 'media_auth;dur=12.5' } }),
      45,
    )
  assert.deepEqual(
    rows.map((r) => r.blobs[1]),
    ['shared_media', 'search', 'thumbnail'],
  )
  assert.ok(!JSON.stringify(rows).includes('SECRET'))
  assert.ok(!JSON.stringify(rows).includes('123'))
  assert.deepEqual(rows[0].doubles, [206, 45, 0.01, 12.5, 1])
})
test('sampling, ceiling, reset and opt-out bound writes', () => {
  let time = 0
  let count = 0
  const env = {
    GATEWAY_DIAGNOSTICS: 'enabled',
    GATEWAY_METRICS: { writeDataPoint: () => count++ },
  }
  const req = new Request('https://app/')
  const record = createDiagnostics({ random: () => 0, now: () => time })
  for (let i = 0; i < 100; i++) record(req, env, new Response(), 1)
  assert.equal(count, 60)
  time = 60000
  record(req, env, new Response(), 1)
  assert.equal(count, 61)
  createDiagnostics({ random: () => 0.5 })(req, env, new Response(), 1)
  assert.equal(count, 61)
  record(req, { ...env, GATEWAY_DIAGNOSTICS: 'disabled' }, new Response(), 1)
  assert.equal(count, 61)
})
test('failure never consumes streaming bodies or breaks delivery', async () => {
  const response = new Response('stream')
  createDiagnostics({ random: () => 0 })(
    new Request('https://app/api/images'),
    {
      GATEWAY_DIAGNOSTICS: 'enabled',
      GATEWAY_METRICS: {
        writeDataPoint() {
          throw Error('down')
        },
      },
    },
    response,
    1,
  )
  assert.equal(response.bodyUsed, false)
  assert.equal(await response.text(), 'stream')
})
test('unknown routes and timing stay bounded and generic', () => {
  assert.equal(routeCategory(new Request('https://app/api/SECRET')), 'other_api')
  const rows = []
  createDiagnostics({ random: () => 0 })(
    new Request('https://app/SECRET'),
    { GATEWAY_DIAGNOSTICS: 'enabled', GATEWAY_METRICS: { writeDataPoint: (r) => rows.push(r) } },
    undefined,
    Infinity,
  )
  assert.deepEqual(rows[0].doubles, [500, 3600000, 0.01, -1, 0])
})
test('slow timings are bounded, private, and independent of analytics sampling', () => {
  const logs = []
  let time = 0
  const record = createDiagnostics({
    random: () => 1,
    now: () => time,
    log: (value) => logs.push(JSON.parse(value)),
  })
  const request = new Request('https://app/api/images?path=thumbnails/SECRET.jpg', {
    headers: { cookie: 'SECRET' },
  })
  const response = new Response(null, {
    headers: {
      'server-timing': 'media_auth;dur=10, media_sign;dur=2800, media_storage;dur=20, SECRET;dur=1',
    },
  })
  const env = { GATEWAY_DIAGNOSTICS: 'enabled' }
  record(request, env, response, 100)
  assert.equal(logs.length, 0)
  for (let i = 0; i < 30; i++) record(request, env, response, 3000)
  assert.equal(logs.length, 20)
  assert.deepEqual(logs[0], {
    event: 'slow_gateway',
    route: 'thumbnail',
    status: 200,
    elapsedMs: 3000,
    media_auth: 10,
    media_sign: 2800,
    media_storage: 20,
  })
  assert.ok(!JSON.stringify(logs).includes('SECRET'))
  time = 60000
  record(request, env, response, 3000)
  assert.equal(logs.length, 21)
  record(request, { GATEWAY_DIAGNOSTICS: 'disabled' }, response, 3000)
  assert.equal(logs.length, 21)
})
