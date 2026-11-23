import test from 'node:test'
import assert from 'node:assert/strict'
import { publicShareRoute } from './public-share-route.mjs'

const base = '/share/' + 'a'.repeat(43)
test('public batching permits only the exact read-only POST endpoint', () => {
  assert.equal(publicShareRoute(base + '/previews', 'POST'), true)
  for (const path of [
    base,
    base + '/download',
    base + '/media/1',
    '/api/images/batch',
    base + '/previews/other',
  ])
    assert.equal(publicShareRoute(path, 'POST'), false)
  assert.equal(publicShareRoute(base + '/previews', 'GET'), false)
  assert.equal(publicShareRoute(base + '/previews', 'DELETE'), false)
})
