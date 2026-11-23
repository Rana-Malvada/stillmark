import { afterEach, expect, it, vi } from 'vitest'
import { loadAlbumDestinations, mergeAlbumDestinations } from '@/lib/albums/album-destinations'

afterEach(() => vi.unstubAllGlobals())

it('preserves caller ordering, deduplicates repeat pages and removes newly revoked destinations', () => {
  const previous = [
    { eventId: 1, eventName: 'Trip 10' },
    { eventId: 2, eventName: 'Trip 2' },
  ]
  const incoming = [
    { eventId: 1, eventName: 'Trip 10', canEdit: true },
    { eventId: 3, eventName: 'Trip 1', canEdit: true },
  ]
  expect(mergeAlbumDestinations(previous, incoming, 'server').map((item) => item.eventId)).toEqual([
    1, 2, 3,
  ])
  expect(mergeAlbumDestinations(previous, incoming, 'natural').map((item) => item.eventId)).toEqual(
    [3, 2, 1],
  )
  expect(
    mergeAlbumDestinations(
      previous,
      [{ eventId: 1, eventName: 'Trip 10', canEdit: false }],
      'server',
    ),
  ).toEqual([previous[1]])
})

it('loads a bounded destination page with explicit editing capabilities', async () => {
  const page = {
    items: [{ eventId: 1, eventName: 'Trip', canEdit: true }],
    nextCursor: 'next',
  }
  const request = vi.fn().mockResolvedValue(Response.json(page))
  vi.stubGlobal('fetch', request)
  const controller = new AbortController()
  expect(await loadAlbumDestinations('cursor', controller.signal)).toEqual(page)
  expect(request).toHaveBeenCalledWith('/api/events?paged=true&groups=false&cursor=cursor', {
    signal: expect.any(AbortSignal),
  })
  const requestSignal = request.mock.calls[0][1].signal as AbortSignal
  expect(requestSignal.aborted).toBe(false)
  controller.abort()
  expect(requestSignal.aborted).toBe(true)
})

it.each([
  { items: null, nextCursor: null },
  { items: [{ eventId: 1, eventName: 'Trip' }], nextCursor: null },
  { items: [{ eventId: 1, eventName: 'Trip', canEdit: 'true' }], nextCursor: null },
  { items: [], nextCursor: 2 },
])('rejects malformed destination pages without treating them as an empty list', async (page) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(page)))
  await expect(loadAlbumDestinations(null, new AbortController().signal)).rejects.toThrow(
    'Unable to load destination albums',
  )
})

it('reports a failed lookup and supports a later successful retry', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response('<h1>Unavailable</h1>', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ items: [], nextCursor: null }))
  vi.stubGlobal('fetch', request)
  await expect(loadAlbumDestinations(null, new AbortController().signal)).rejects.toThrow(
    'Unable to load destination albums',
  )
  await expect(loadAlbumDestinations(null, new AbortController().signal)).resolves.toEqual({
    items: [],
    nextCursor: null,
  })
})

it('does not publish a result after its panel request was cancelled', async () => {
  const controller = new AbortController()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async () => {
      controller.abort()
      return Response.json({ items: [], nextCursor: null })
    }),
  )
  await expect(loadAlbumDestinations(null, controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  })
})
