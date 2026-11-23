import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  origin: vi.fn(),
  query: vi.fn(),
  sign: vi.fn(),
  fetch: vi.fn(),
}))
vi.mock('@/lib/browse-request', () => ({ withBrowseRequest: (handler: unknown) => handler }))
vi.mock('@/lib/identity/auth', () => ({ requireAuth: m.auth, requireSameOrigin: m.origin }))
vi.mock('@/lib/postgres', () => ({ pgQuery: m.query }))
vi.mock('@/lib/media/image-urls', () => ({ getPresignedUrls: m.sign }))
vi.mock('@/lib/media/media-fetch', () => ({ fetchMedia: m.fetch }))
import { POST } from '@/app/api/images/batch/route'
import { deployment } from '../config/deployment.mjs'
import { readPreviewBatch } from '../public/preview-batch.mjs'
import { HttpError } from '../lib/http'

const request = (paths: unknown, headers = {}) =>
  new Request('https://app/api/images/batch', {
    method: 'POST',
    headers,
    body: JSON.stringify({ paths }),
  })
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('PREVIEW_BATCH_ENABLED', 'true')
})
afterEach(() => vi.unstubAllEnvs())
it('resolves a mixed batch once under RLS and does not sign inaccessible paths', async () => {
  m.query.mockResolvedValue([{ thumbnail_stage_path: 'thumbnails/allowed.jpg' }])
  m.sign.mockResolvedValue(new Map([['thumbnails/allowed.jpg', 'https://storage/a']]))
  m.fetch.mockResolvedValue(new Response('ok', { headers: { 'Content-Type': 'image/jpeg' } }))
  const res = await POST(request(['thumbnails/allowed.jpg', 'thumbnails/forbidden.jpg']))
  const output: (Blob | null)[] = []
  await readPreviewBatch(res, 2, (i, blob) => (output[i] = blob))
  expect(output[0]?.size).toBe(2)
  expect(output[1]).toBeNull()
  expect(m.query).toHaveBeenCalledTimes(1)
  expect(m.sign).toHaveBeenCalledWith(['thumbnails/allowed.jpg'])
  expect(m.fetch).toHaveBeenCalledTimes(1)
})
it('emits a manifest only for the fixed gateway identity and handoff', async () => {
  m.query.mockResolvedValue([{ thumbnail_stage_path: 'thumbnails/a.jpg' }])
  const res = await POST(
    request(['thumbnails/a.jpg', 'thumbnails/b.jpg'], {
      'sf-context-current-user': deployment.GATEWAY_USER,
      'x-photo-media-transfer': 'preview-batch-v1',
    }),
  )
  expect(await res.json()).toEqual({ items: ['thumbnails/a.jpg', null] })
  expect(m.sign).not.toHaveBeenCalled()
  expect(m.auth).toHaveBeenCalled()
  expect(m.origin).toHaveBeenCalled()
})
it('rejects invalid and oversized batches before querying', async () => {
  for (const paths of [
    [],
    Array(9).fill('thumbnails/a.jpg'),
    ['originals/a.jpg'],
    ['thumbnails/../a.jpg'],
  ])
    expect((await POST(request(paths))).status).toBe(400)
  expect(m.query).not.toHaveBeenCalled()
})
it('does not use prior authorization after access is revoked', async () => {
  m.query.mockResolvedValue([])
  m.sign.mockResolvedValue(new Map())
  const res = await POST(request(['thumbnails/a.jpg']))
  await readPreviewBatch(res, 1, (_, blob) => expect(blob).toBeNull())
  expect(m.fetch).not.toHaveBeenCalled()
})
it('rejects unauthenticated requests and stays off by default', async () => {
  m.auth.mockRejectedValue(new HttpError(401, 'Authentication required'))
  expect((await POST(request(['thumbnails/a.jpg']))).status).toBe(401)
  vi.stubEnv('PREVIEW_BATCH_ENABLED', '')
  expect((await POST(request(['thumbnails/a.jpg']))).status).toBe(404)
  expect(m.query).not.toHaveBeenCalled()
})
it('reauthorizes cached selectors and returns reusable frames without storage work', async () => {
  const paths = ['thumbnails/allowed.jpg', 'thumbnails/revoked.jpg']
  m.query.mockResolvedValue([{ thumbnail_stage_path: paths[0] }])
  m.sign.mockResolvedValue(new Map())
  const res = await POST(
    new Request('https://app/api/images/batch', {
      method: 'POST',
      body: JSON.stringify({ paths, cached: paths }),
    }),
  )
  const statuses: number[] = []
  await readPreviewBatch(res, 2, (i, _, status) => {
    statuses[i] = status
  })
  expect(statuses).toEqual([304, 404])
  expect(m.query).toHaveBeenCalledTimes(1)
  expect(m.sign).toHaveBeenCalledWith([])
  expect(m.fetch).not.toHaveBeenCalled()
})
