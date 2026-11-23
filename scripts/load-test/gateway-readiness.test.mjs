import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkGatewayMedia } from './gateway-readiness.mjs'

const input = {
  origin: 'https://stillmark-loadtest-baseline.test.workers.dev',
  cookie: '__Host-photo-session=test-only',
  username: 'STILLMARK_LOADTEST_BASELINE_U1',
}
function responses(mode = 'storage') {
  const list = [
    Response.json({ username: input.username }),
    Response.json({
      items: [{ ownerUsername: input.username, coverUrl: '/api/images?path=thumbnails/test.jpg' }],
    }),
    new Response('image', {
      headers: { 'Content-Type': 'image/jpeg', ...(mode ? { 'X-Media-Delivery': mode } : {}) },
    }),
  ]
  return async () => list.shift()
}
test('requires confirmed direct storage delivery rather than a successful fallback', async () => {
  assert.equal((await checkGatewayMedia(input, responses())).directMedia, true)
  await assert.rejects(checkGatewayMedia(input, responses('')), /Direct storage/)
})
test('rejects production targets before making any request', async () => {
  await assert.rejects(
    checkGatewayMedia({ ...input, origin: 'https://photos.example.com' }, () => {
      throw Error('must not fetch')
    }),
    /Isolated/,
  )
})
test('rejects an unexpected identity', async () => {
  await assert.rejects(
    checkGatewayMedia(input, async () => Response.json({ username: 'another' })),
    /identity failed/,
  )
})
