import { afterEach, expect, it, vi } from 'vitest'
import { fetchBrowse } from '../lib/fetch-browse'

afterEach(() => vi.unstubAllGlobals())
it('recovers one failed read with the same options and no write replay', async () => {
  const response = new Response('{}')
  const mock = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('network reset'))
    .mockResolvedValue(response)
  vi.stubGlobal('fetch', mock)
  const controller = new AbortController()
  const options = { cache: 'no-store' as const, signal: controller.signal }
  expect(await fetchBrowse('/api/photos/12?context=favorites', options)).toBe(response)
  expect(mock).toHaveBeenCalledTimes(2)
  expect(mock.mock.calls[1]).toEqual(['/api/photos/12?context=favorites', options])
})
it('does not loop on a persistent transport error', async () => {
  const mock = vi.fn().mockRejectedValue(new TypeError('network reset'))
  vi.stubGlobal('fetch', mock)
  await expect(fetchBrowse('/api/events?paged=true')).rejects.toThrow('network reset')
  expect(mock).toHaveBeenCalledTimes(2)
})
it('returns authorization and server responses without retrying', async () => {
  for (const status of [401, 403, 404, 500, 503]) {
    const response = new Response('', { status })
    const mock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', mock)
    expect(await fetchBrowse('/api/events/1')).toBe(response)
    expect(mock).toHaveBeenCalledTimes(1)
  }
})
it('does not retry a canceled request or canceled recovery delay', async () => {
  const controller = new AbortController()
  const mock = vi.fn().mockRejectedValue(new TypeError('network reset'))
  vi.stubGlobal('fetch', mock)
  const pending = fetchBrowse('/api/events/1', { signal: controller.signal })
  queueMicrotask(() => controller.abort())
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(mock).toHaveBeenCalledTimes(1)
})
it('rejects writes and unrelated endpoints before fetching', async () => {
  const mock = vi.fn()
  vi.stubGlobal('fetch', mock)
  for (const [path, init] of [
    ['/api/events', { method: 'POST' }],
    ['/api/photos/1', { method: 'DELETE' }],
    ['/api/photos/1/favorite', {}],
    ['https://elsewhere.test/api/events', {}],
    ['/api/admin/access', {}],
  ] as const)
    await expect(fetchBrowse(path, init)).rejects.toThrow('read-only')
  expect(mock).not.toHaveBeenCalled()
})

it('recovers from a real TCP reset before response headers', async () => {
  const { createServer } = await import('node:http')
  const nativeFetch = globalThis.fetch
  let requests = 0
  const server = createServer((request, response) => {
    if (++requests === 1) return request.socket.resetAndDestroy()
    response.setHeader('Content-Type', 'application/json')
    response.end('{"photoId":1}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  vi.stubGlobal('fetch', (input: string, init: RequestInit) =>
    nativeFetch(new URL(input, `http://127.0.0.1:${address.port}`), init),
  )
  try {
    const response = await fetchBrowse('/api/photos/1')
    expect(await response.json()).toEqual({ photoId: 1 })
    expect(requests).toBe(2)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('allows bounded read-only favorites pages without enabling favorite mutations', async () => {
  const response = Response.json({ items: [], nextCursor: null })
  const fetch = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetch)
  expect(await fetchBrowse('/api/favorites?paged=true&cursor=test')).toBe(response)
  await expect(fetchBrowse('/api/favorites', { method: 'POST' })).rejects.toThrow('read-only')
  expect(fetch).toHaveBeenCalledOnce()
})
