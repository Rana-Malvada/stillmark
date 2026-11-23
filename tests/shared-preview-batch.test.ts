import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ link: vi.fn(), query: vi.fn(), sign: vi.fn(), fetch: vi.fn() }))
vi.mock('@/lib/public-request', () => ({ withPublicRequest: (fn: unknown) => fn }))
vi.mock('@/lib/database/database-context', () => ({
  withPublicDatabase: (_: string, fn: () => unknown) => fn(),
}))
vi.mock('@/lib/albums/public-albums', () => ({
  publicAlbum: m.link,
  tokenHash: () => 'hash',
  shareHeaders: { 'Cache-Control': 'private, no-store' },
}))
vi.mock('@/lib/postgres', () => ({ pgQuery: m.query }))
vi.mock('@/lib/media/image-urls', () => ({ getPresignedUrl: m.sign }))
vi.mock('@/lib/media/media-fetch', () => ({ fetchMedia: m.fetch }))
import { POST } from '@/app/share/[token]/previews/route'
import { readPreviewBatch } from '../public/preview-batch.mjs'
import { HttpError } from '../lib/http'

const run = (ids: unknown, cached: unknown = []) =>
  POST(
    new Request('https://app/share/token/previews', {
      method: 'POST',
      body: JSON.stringify({ ids, cached }),
    }),
    { params: Promise.resolve({ token: 'token' }) },
  )
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('PREVIEW_BATCH_ENABLED', 'true')
  m.link.mockResolvedValue({ event_id: 4, photo_ids: [1] })
  m.query.mockResolvedValue([
    { photo_id: 1, thumbnail_stage_path: 'thumbnails/a.jpg' },
    { photo_id: 2, thumbnail_stage_path: 'thumbnails/b.jpg' },
  ])
  m.sign.mockResolvedValue('https://storage/a')
  m.fetch.mockImplementation(
    async () => new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } }),
  )
})
afterEach(() => vi.unstubAllEnvs())
it('batches selected photos without exposing other album photos or storage URLs', async () => {
  const res = await run([1, 2, 3])
  const output: (Blob | null)[] = []
  await readPreviewBatch(res, 3, (i, blob) => {
    output[i] = blob
  })
  expect(output[0]?.size).toBe(5)
  expect(output.slice(1)).toEqual([null, null])
  expect(m.query).toHaveBeenCalledTimes(1)
  expect(m.sign).toHaveBeenCalledTimes(1)
  expect(m.link).toHaveBeenCalledTimes(2)
  expect(res.headers.get('cache-control')).toBe('private, no-store')
})
it('returns no image bytes if revoked while storage fetch runs', async () => {
  m.link
    .mockResolvedValueOnce({ event_id: 4, photo_ids: null })
    .mockRejectedValueOnce(new HttpError(404, 'Expired'))
  const res = await run([1])
  expect(res.status).toBe(404)
  expect(await res.text()).toBe('Expired')
  expect(m.fetch).toHaveBeenCalledTimes(1)
})
it('rejects changed selections before releasing bytes', async () => {
  m.link
    .mockResolvedValueOnce({ event_id: 4, photo_ids: [1] })
    .mockResolvedValueOnce({ event_id: 4, photo_ids: [2] })
  expect((await run([1])).status).toBe(404)
})
it('does no storage work for expired links or oversized batches', async () => {
  expect((await run(Array(9).fill(1))).status).toBe(400)
  m.link.mockRejectedValue(new HttpError(404, 'Expired'))
  expect((await run([1])).status).toBe(404)
  expect(m.sign).not.toHaveBeenCalled()
})

it('reuses bytes only after authorizing the current share and immutable thumbnail version', async () => {
  const first = await run([1])
  const versions = JSON.parse(first.headers.get('x-preview-versions')!)
  m.sign.mockClear()
  m.fetch.mockClear()
  m.link.mockClear()
  const cached = await run([1], [{ id: 1, version: versions[0] }])
  const statuses: number[] = []
  await readPreviewBatch(cached, 1, (_i, _blob, status) => statuses.push(status))
  expect(statuses).toEqual([304])
  expect(m.link).toHaveBeenCalledTimes(2)
  expect(m.sign).not.toHaveBeenCalled()
  expect(m.fetch).not.toHaveBeenCalled()
  m.link.mockRejectedValue(new HttpError(404, 'Expired'))
  expect((await run([1], [{ id: 1, version: versions[0] }])).status).toBe(404)
})
