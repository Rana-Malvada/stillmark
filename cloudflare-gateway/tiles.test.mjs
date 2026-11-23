import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapTile } from '../lib/map-tiles.mjs'

const origin = 'https://photos.example'
test('tiles honor provider caching and edge hits avoid upstream requests', async () => {
  let saved
  let calls = 0
  const cache = {
    match: async () => saved?.clone(),
    put: async (k, v) => {
      saved = v
    },
  }
  const fetcher = async (url, init) => {
    calls++
    assert.equal(init.redirect, 'manual')
    assert.equal(url, 'https://tile.openstreetmap.org/2/1/1.png')
    assert.equal(init.headers.get('cookie'), null)
    assert.match(init.headers.get('User-Agent'), /photos.example/)
    return new Response('png', {
      headers: { 'Cache-Control': 'public, max-age=700000', ETag: '"tile"' },
    })
  }
  const req = new Request(origin + '/api/tiles/2/1/1')
  const first = await mapTile(req, origin, fetcher, cache)
  assert.equal(first.headers.get('cache-control'), 'public, max-age=700000')
  assert.equal(await (await mapTile(req, origin, fetcher, cache)).text(), 'png')
  assert.equal(calls, 1)
  const conditional = new Request(req, { headers: { 'If-None-Match': '"tile"' } })
  assert.equal((await mapTile(conditional, origin, fetcher, cache)).status, 304)
})
test('fallback is seven days, errors are never cached, coordinates cannot target other hosts', async () => {
  const req = new Request(origin + '/api/tiles/2/1/1')
  assert.equal(
    (await mapTile(req, origin, async () => new Response('png'))).headers.get('cache-control'),
    'public, max-age=604800',
  )
  let puts = 0
  assert.equal(
    (
      await mapTile(req, origin, async () => new Response('', { status: 429 }), {
        match: async () => null,
        put: async () => puts++,
      })
    ).status,
    502,
  )
  assert.equal(puts, 0)
  for (const path of ['/api/tiles/20/1/1', '/api/tiles/2/5/1', '/api/tiles/2/1/1?host=evil'])
    assert.ok(
      (
        await mapTile(new Request(origin + path), origin, () => {
          throw Error('must not fetch')
        })
      ).status >= 400,
    )
})
