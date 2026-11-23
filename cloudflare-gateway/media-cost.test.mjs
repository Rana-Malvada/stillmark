import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deployment } from '../config/deployment.mjs'
import { clearMediaLinks, publicStorageUrl, publicStorageUrls } from './media-delivery.mjs'

function signer(counter) {
  return async (_, init) => {
    counter.calls++
    const paths = [
      ...JSON.parse(init.body).statement.matchAll(/GET_PRESIGNED_URL\([^,]+, '([^']+)'/g),
    ]
    return Response.json({ data: [paths.map((m) => `https://${deployment.STORAGE_HOST}/${m[1]}`)] })
  }
}
test('one-hour repeat-browse fixture uses four signing batches instead of six', async (t) => {
  clearMediaLinks()
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const count = { calls: 0 }
  const paths = Array.from({ length: 8 }, (_, i) => `thumbnails/cost-${i}.jpg`)
  for (let minute = 0; minute < 60; minute++) {
    now = 1_000_000 + minute * 60_000
    assert.equal((await publicStorageUrls(paths, {}, signer(count))).size, 8)
  }
  assert.equal(count.calls, 4)
  // Baseline 10-minute cache would sign at minutes 0,10,20,30,40,50.
  t.diagnostic(
    '60 views × 8 URLs: baseline 6 SQL batches; optimized 4 (33.3% fewer in this fixture)',
  )
})
test('signature lifetime starts before signing and warm batch hits never extend expiry', async (t) => {
  clearMediaLinks()
  let now = 1_000_000
  t.mock.method(Date, 'now', () => now)
  const count = { calls: 0 }
  const fetcher = async (...args) => {
    now += 20_000
    return signer(count)(...args)
  }
  await publicStorageUrl('thumbnails/lifetime.jpg', {}, fetcher)
  now = 1_000_000 + 869_999
  await publicStorageUrls(['thumbnails/lifetime.jpg'], {}, fetcher)
  assert.equal(count.calls, 1)
  now = 1_000_000 + 870_000
  await publicStorageUrl('thumbnails/lifetime.jpg', {}, fetcher)
  assert.equal(count.calls, 2)
})
test('batch hits keep hot links within the bounded LRU cache', async () => {
  clearMediaLinks()
  const count = { calls: 0 }
  const env = { MEDIA_SIGNED_URL_CACHE_MAX: '2' }
  const fetcher = signer(count)
  await publicStorageUrls(['thumbnails/a.jpg', 'thumbnails/b.jpg'], env, fetcher)
  await publicStorageUrls(['thumbnails/a.jpg'], env, fetcher)
  await publicStorageUrl('thumbnails/c.jpg', env, fetcher)
  await publicStorageUrl('thumbnails/a.jpg', env, fetcher)
  assert.equal(count.calls, 2)
  await publicStorageUrl('thumbnails/b.jpg', env, fetcher)
  assert.equal(count.calls, 3)
})
