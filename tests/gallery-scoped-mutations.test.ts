import { afterEach, describe, expect, it, vi } from 'vitest'
import { createScopedMutation } from '@/components/gallery/scoped-mutation'
import { isPhotoDetail, loadPhotoDetail } from '@/components/gallery/photo-detail-data'
import {
  eventPageUrl,
  isEventFolders,
  isEventPage,
  loadEventPage,
} from '@/components/gallery/event-grid-data'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
const photo = {
  photoId: 1,
  eventId: 7,
  sourceFilename: 'one.jpg',
  canEdit: true,
  favorite: false,
  isAlbumCover: false,
  mediaType: 'photo',
}
const album = {
  eventId: 7,
  sortOrder: 2,
  eventName: 'Trip',
  visibility: 'private',
  ownerUsername: 'ALICE',
  photoCount: 1,
  eventMonth: 6,
  eventYear: 2026,
  folderId: null,
  coverUrl: null,
  location: null,
}
afterEach(() => vi.unstubAllGlobals())
describe('Gallery mutation ownership', () => {
  it('does not apply an earlier photo write to the next photo or retry the write', async () => {
    const m = createScopedMutation(() => {})
    const d = deferred<boolean>()
    const commit = vi.fn()
    const failed = vi.fn()
    const request = vi.fn(() => d.promise)
    m.setScope('A')
    const write = m.run({ request, commit, failed })
    await m.run({ request, commit, failed })
    m.setScope('B')
    d.resolve(true)
    await write
    expect(request).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
    expect(m.busy()).toBe(false)
  })
  it('keeps a pending photo fenced even after navigation away and back', async () => {
    const m = createScopedMutation(() => {})
    const d = deferred<boolean>()
    const commit = vi.fn()
    const failed = vi.fn()
    const request = vi.fn(() => d.promise)
    m.setScope('A')
    const write = m.run({ request, commit, failed })
    m.setScope('B')
    m.setScope('A')
    expect(m.busy()).toBe(true)
    await m.run({ request, commit, failed })
    d.resolve(true)
    await write
    expect(commit).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)
    expect(m.busy()).toBe(false)
  })
  it('allows independent next-photo work without clearing its busy state when old work ends', async () => {
    const m = createScopedMutation(() => {})
    const a = deferred<boolean>()
    const b = deferred<boolean>()
    const commit = vi.fn()
    const failed = vi.fn()
    m.setScope('A')
    const wa = m.run({ request: () => a.promise, commit, failed })
    m.setScope('B')
    const wb = m.run({ request: () => b.promise, commit, failed })
    a.reject(new Error('lost'))
    await wa
    expect(m.busy()).toBe(true)
    expect(failed).not.toHaveBeenCalled()
    b.resolve(true)
    await wb
    expect(commit).toHaveBeenCalledOnce()
    expect(m.busy()).toBe(false)
  })
  it('fences external editor callbacks when their owning photo changes', () => {
    const m = createScopedMutation(() => {})
    m.setScope('photo:1')
    const isCurrent = m.currentScope()
    expect(isCurrent()).toBe(true)
    m.setScope('photo:2')
    expect(isCurrent()).toBe(false)
    m.setScope('photo:1')
    expect(isCurrent()).toBe(false)
  })
  it('invalidates pending callbacks on effect disposal including Strict Mode reactivation', async () => {
    const m = createScopedMutation(() => {})
    const d = deferred<boolean>()
    const commit = vi.fn()
    const failed = vi.fn()
    m.setScope('A')
    const w = m.run({ request: () => d.promise, commit, failed })
    m.dispose()
    m.activate()
    d.resolve(true)
    await w
    expect(commit).not.toHaveBeenCalled()
  })
})
describe('Gallery response boundaries', () => {
  it('accepts only string media kinds without coercing arrays or objects into photo/video', () => {
    for (const mediaType of ['photo', 'video'])
      expect(isPhotoDetail({ ...photo, mediaType })).toBe(true)
    const toString = vi.fn(() => 'photo')
    for (const mediaType of [['photo'], ['video'], { toString }, true, 1, null, undefined])
      expect(isPhotoDetail({ ...photo, mediaType })).toBe(false)
    expect(toString).not.toHaveBeenCalled()
  })
  it('accepts photo metadata and rejects render-breaking dates, tags, coordinates and neighbor identities', () => {
    expect(
      isPhotoDetail({
        ...photo,
        dateTaken: '2026-11-21T12:30:00Z',
        latitude: 10,
        userTags: ['trip'],
        preload: [{ photoId: 2, url: '/api/media/2', width: 100, height: 200 }],
      }),
    ).toBe(true)
    for (const wrong of [
      { dateTaken: 'not a date' },
      { userTags: {} },
      { latitude: '10' },
      { next: -1 },
      { mediaType: 'unknown' },
      { canEdit: 'true' },
      { preload: [{ photoId: 2 }] },
    ])
      expect(isPhotoDetail({ ...photo, ...wrong })).toBe(false)
  })
  it('rejects another photo returned under the requested ID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...photo, photoId: 2 })),
    )
    await expect(loadPhotoDetail(1, '', new AbortController().signal)).rejects.toThrow(
      'Unable to load photo',
    )
  })
  it('accepts initial groups and later pages, rejects malformed lists and groups', () => {
    expect(
      isEventPage(
        { items: [album], groups: [{ section: 'mine', folder_id: null, albums: 1, photos: 1 }] },
        true,
      ),
    ).toBe(true)
    expect(isEventPage({ items: [album], nextCursor: 'next' })).toBe(true)
    expect(isEventPage({ items: [album] }, true)).toBe(false)
    for (const v of [
      {},
      { items: null },
      { items: [{ ...album, photoCount: '1' }] },
      { items: [album], groups: [{ section: 'mine', folder_id: null, albums: -1, photos: 1 }] },
    ])
      expect(isEventPage(v)).toBe(false)
    expect(isEventFolders([{ folderId: 1, folderName: 'Trips', sortOrder: 0 }])).toBe(true)
    expect(isEventFolders({ error: 'Denied' })).toBe(false)
  })
  it('uses the same stable sort-order/ID cursor for restored and next pages', () => {
    const p = new URL(
      eventPageUrl(true, 'mine', null, [
        { ...album, eventId: 9, sortOrder: 3 },
        album,
        { ...album, eventId: 8, sortOrder: 3 },
      ]),
      'https://fixture.invalid',
    ).searchParams
    expect(p.get('scope')).toBe('mine')
    expect(p.get('folder')).toBe('none')
    expect(JSON.parse(atob(p.get('cursor')!))).toEqual([3, 9])
  })
  it('does not retry HTTP failures or malformed successful album bodies', async () => {
    const fetcher = vi.fn(async () => Response.json({ items: null }))
    vi.stubGlobal('fetch', fetcher)
    await expect(loadEventPage('/api/events?paged=true')).rejects.toThrow('Unable to load albums')
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('Slideshow page contract and cancellation', () => {
  it('rejects a continuation without an items list or a valid cursor', async () => {
    const { isSlideshowPage } = await import('@/components/gallery/slideshow-data')
    expect(
      isSlideshowPage({
        items: [
          {
            photoId: 1,
            sourceFilename: 'one.jpg',
            mediaType: 'photo',
            displayStagePath: null,
            originalStagePath: 'originals/one.jpg',
          },
        ],
        nextCursor: 'next',
      }),
    ).toBe(true)
    for (const page of [
      { items: null, nextCursor: null },
      { items: [], nextCursor: 42 },
      { items: [{ photoId: 1 }], nextCursor: null },
    ])
      expect(isSlideshowPage(page)).toBe(false)
  })
  it('fences a response body that completes after navigation even if transport ignores abort', async () => {
    const { loadSlideshowPage } = await import('@/components/gallery/slideshow-data')
    const controller = new AbortController()
    const body = deferred<unknown>()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: () => body.promise })),
    )
    const request = loadSlideshowPage(7, 'sort=name', controller.signal, 'cursor')
    await Promise.resolve()
    controller.abort()
    body.resolve({ items: [], nextCursor: null })
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})
