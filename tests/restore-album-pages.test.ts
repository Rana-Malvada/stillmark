import { expect, it, vi } from 'vitest'
import { mergeAlbumPages, restoreAlbumPages } from '@/lib/restore-album-pages'

const url = (folder: number, cursor = 'old') =>
  `/api/events?paged=true&scope=accessible&section=collection&folder=${folder}&cursor=${cursor}`
const album = (eventId: number, sortOrder = eventId) => ({ eventId, sortOrder })
const signal = () => new AbortController().signal

it('sorts incoming pages among existing albums and replaces duplicate records', () => {
  expect(mergeAlbumPages([album(1), album(9), album(2, 20)], [album(2), album(3)])).toEqual([
    album(1),
    album(2),
    album(3),
    album(9),
  ])
})
it('finds new albums inserted in a gap between historical page boundaries', async () => {
  const publish = vi.fn()
  const load = vi.fn(async (requested: string) => {
    const cursor = new URL(requested, 'https://app').searchParams.get('cursor')
    if (!cursor) return { items: [album(1), album(2)], nextCursor: 'fresh-2' }
    if (cursor === 'fresh-2') return { items: [album(3), album(4)], nextCursor: 'fresh-4' }
    if (cursor === 'fresh-4') return { items: [album(5), album(6)], nextCursor: null }
    throw Error('Stale cursor reused')
  })
  await restoreAlbumPages([album(1)], [url(8, 'old-3'), url(8, 'old-5')], load, publish, signal())
  expect(publish.mock.calls.at(-1)?.[0]).toEqual([1, 2, 3, 4, 5, 6].map((id) => album(id)))
  expect(load).toHaveBeenCalledTimes(3)
})
it('bounds restoration by saved depth and deduplicates saved requests', async () => {
  const load = vi.fn(async () => ({
    items: [album(1)],
    nextCursor: String(load.mock.calls.length),
  }))
  await restoreAlbumPages([], [url(8), url(8)], load, vi.fn(), signal())
  expect(load).toHaveBeenCalledTimes(2)
})
it('ignores unrelated saved URLs', async () => {
  const load = vi.fn()
  await restoreAlbumPages(
    [],
    ['/api/photos', 'https://evil.example/api/events?paged=true'],
    load,
    vi.fn(),
    signal(),
  )
  expect(load).not.toHaveBeenCalled()
})
it('does not publish after navigation cancellation', async () => {
  const controller = new AbortController()
  const publish = vi.fn()
  const load = vi.fn(async () => {
    controller.abort()
    return { items: [album(1)] }
  })
  await expect(
    restoreAlbumPages([], [url(8)], load, publish, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(publish).not.toHaveBeenCalled()
})
it('uses at most two concurrent folders and keeps the free slot moving', async () => {
  let release!: (page: { items: ReturnType<typeof album>[] }) => void
  const slow = new Promise<{ items: ReturnType<typeof album>[] }>((resolve) => {
    release = resolve
  })
  let active = 0
  let maximum = 0
  const load = vi.fn(async (requested: string) => {
    active++
    maximum = Math.max(maximum, active)
    const folder = Number(new URL(requested, 'https://app').searchParams.get('folder'))
    const page = folder === 8 ? await slow : { items: [album(folder)] }
    active--
    return page
  })
  const publish = vi.fn()
  const done = restoreAlbumPages([], [url(8), url(9), url(10)], load, publish, signal())
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3))
  expect(publish.mock.calls.at(-1)?.[0]).toEqual([album(9), album(10)])
  release({ items: [album(8)] })
  await done
  expect(maximum).toBe(2)
  expect(publish.mock.calls.at(-1)?.[0]).toEqual([album(8), album(9), album(10)])
})
it('stops scheduling and ignores late results after a failed request', async () => {
  let reject!: (e: Error) => void
  let release!: (p: { items: ReturnType<typeof album>[] }) => void
  const failed = new Promise<{ items: ReturnType<typeof album>[] }>((_, no) => {
    reject = no
  })
  const late = new Promise<{ items: ReturnType<typeof album>[] }>((yes) => {
    release = yes
  })
  const load = vi.fn((requested: string) => (requested.includes('folder=8') ? failed : late))
  const publish = vi.fn()
  const done = restoreAlbumPages([], [url(8), url(9), url(10)], load, publish, signal())
  const assertion = expect(done).rejects.toThrow('failed page')
  reject(Error('failed page'))
  await assertion
  release({ items: [album(1)] })
  await Promise.resolve()
  expect(publish).not.toHaveBeenCalled()
  expect(load).toHaveBeenCalledTimes(2)
})
