import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clearGridCaches, GridCache } from '@/lib/grid-cache'
import { type GridPhoto, loadPhotoPages, photoRestoreTarget } from '@/lib/photos/photo-grid-loader'

const fetchMock = vi.fn()
const photo = (id: number): GridPhoto => ({
  photoId: id,
  eventId: 7,
  sourceFilename: `${id}.jpg`,
  thumbnailUrl: null,
  aspectRatio: 1,
  mediaType: 'IMAGE',
  favorite: false,
})
const allPhotos = Array.from({ length: 6000 }, (_, i) => photo(i + 1))
const signal = () => new AbortController().signal
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  clearGridCaches()
})
function paginate() {
  fetchMock.mockImplementation(async (url: string) => {
    const offset = Number(new URL(url, 'http://test').searchParams.get('cursor')) || 0
    return Response.json({
      items: allPhotos.slice(offset, offset + 96),
      nextCursor: offset + 96 < allPhotos.length ? String(offset + 96) : null,
    })
  })
}

it('loads one initial album page after an ordinary entry with 5,000 remembered photos', async () => {
  paginate()
  const result = await loadPhotoPages({
    eventId: 7,
    query: '',
    target: photoRestoreTarget(7, false, '5000'),
    signal: signal(),
  })
  expect(result.items).toHaveLength(96)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it.each(['expired', 'oversized'] as const)(
  'restores photo-return depth when the snapshot is %s',
  async (kind) => {
    vi.useFakeTimers()
    const cache = new GridCache<GridPhoto>()
    cache.put('album7', allPhotos.slice(0, kind === 'oversized' ? 5000 : 192), '192')
    if (kind === 'expired') vi.advanceTimersByTime(30001)
    expect(cache.get('album7')).toBeNull()
    paginate()
    const result = await loadPhotoPages({
      eventId: 7,
      query: '',
      target: photoRestoreTarget(7, true, '5000'),
      snapshot: cache.get('album7'),
      signal: signal(),
    })
    expect(result.items).toHaveLength(5088)
    expect(fetchMock).toHaveBeenCalledTimes(53)
    expect(result.cursor).toBe('5088')
  },
)

it('rechecks live access before using a valid return snapshot and uses fresh first-page metadata', async () => {
  paginate()
  const cached = allPhotos.slice(0, 192).map((item) => ({ ...item, sourceFilename: 'old.jpg' }))
  const result = await loadPhotoPages({
    eventId: 7,
    query: '',
    target: 192,
    snapshot: { items: cached, cursor: '192' },
    signal: signal(),
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(result.items).toHaveLength(192)
  expect(result.items[0].sourceFilename).toBe('1.jpg')
  expect(result.reused).toBe(true)
})

it.each([401, 403, 404])(
  'never publishes cached photos when access was revoked (HTTP %i)',
  async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'No access' }, { status }))
    const onPage = vi.fn()
    await expect(
      loadPhotoPages({
        eventId: 7,
        query: '',
        target: 192,
        snapshot: { items: allPhotos.slice(0, 192), cursor: '192' },
        signal: signal(),
        onPage,
      }),
    ).rejects.toMatchObject({ status })
    expect(onPage).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  },
)

it('abandons a stale snapshot when the live first page changes', async () => {
  paginate()
  const result = await loadPhotoPages({
    eventId: 7,
    query: '',
    target: 192,
    snapshot: { items: [photo(9999)], cursor: null },
    signal: signal(),
  })
  expect(result.items).toEqual(allPhotos.slice(0, 192))
  expect(result.reused).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('preserves favorites depth and rejects malformed remembered counts', () => {
  expect(photoRestoreTarget(undefined, false, '5000')).toBe(5000)
  for (const value of ['Infinity', '-1', 'wat', '500.5', null])
    expect(photoRestoreTarget(7, true, value)).toBe(96)
})

it('rejects malformed successful pages and wrong-album data before publishing a snapshot', async () => {
  for (const data of [
    { items: null, nextCursor: null },
    { items: [photo(1)] },
    { items: [{ ...photo(1), eventId: 8 }], nextCursor: null },
  ]) {
    fetchMock.mockResolvedValueOnce(Response.json(data))
    const onPage = vi.fn()
    await expect(
      loadPhotoPages({ eventId: 7, query: '', target: 96, signal: signal(), onPage }),
    ).rejects.toMatchObject({ status: 200 })
    expect(onPage).not.toHaveBeenCalled()
  }
})

it('stops a canceled deep restoration even when the transport completes late', async () => {
  let complete!: (response: Response) => void
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const controller = new AbortController()
  const onPage = vi.fn()
  const pending = loadPhotoPages({
    eventId: 7,
    query: '',
    target: 5000,
    signal: controller.signal,
    onPage,
  })
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  complete(Response.json({ items: allPhotos.slice(0, 96), nextCursor: '96' }))
  await rejected
  expect(onPage).not.toHaveBeenCalled()
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('publishes deep restoration with linear total snapshot copying and an immediate first page', async () => {
  paginate()
  const lengths: number[] = []
  const result = await loadPhotoPages({
    eventId: 7,
    query: '',
    target: 6000,
    signal: signal(),
    onPage: (items) => lengths.push(items.length),
  })
  expect(lengths[0]).toBe(96)
  expect(lengths.at(-1)).toBe(6000)
  expect(lengths.reduce((sum, length) => sum + length, 0)).toBeLessThan(3 * 6000)
  expect(result.items).toEqual(allPhotos)
  expect(fetchMock).toHaveBeenCalledTimes(63)
})

it('deduplicates repeated IDs within a page as well as across pages', async () => {
  fetchMock
    .mockResolvedValueOnce(
      Response.json({ items: [photo(1), photo(1), photo(2)], nextCursor: 'next' }),
    )
    .mockResolvedValueOnce(
      Response.json({ items: [photo(2), photo(3), photo(3)], nextCursor: null }),
    )
  const result = await loadPhotoPages({ eventId: 7, query: '', target: 96, signal: signal() })
  expect(result.items.map((row) => row.photoId)).toEqual([1, 2, 3])
})
