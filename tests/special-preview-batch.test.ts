import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  origin: vi.fn(),
  query: vi.fn(),
  caller: vi.fn(),
  response: vi.fn(),
}))
vi.mock('@/lib/browse-request', () => ({ withBrowseRequest: (fn: unknown) => fn }))
vi.mock('@/lib/identity/auth', () => ({ requireAuth: m.auth, requireSameOrigin: m.origin }))
vi.mock('@/lib/postgres', () => ({ pgQuery: m.query }))
vi.mock('@/lib/albums/album-access', () => ({ albumCaller: m.caller }))
vi.mock('@/lib/media/image-urls', () => ({ getPresignedUrl: vi.fn() }))
vi.mock('@/lib/people/face-crops', () => ({
  signCrop: vi.fn(),
  validateCropPath: (path: string) => path,
}))
vi.mock('@/lib/media/preview-batch-response', () => ({ previewBatchResponse: m.response }))
import { POST as faces } from '@/app/api/faces/batch/route'
import { POST as trash } from '@/app/api/trash/batch/route'

const req = (ids: unknown) =>
  new Request('https://app/api/batch', { method: 'POST', body: JSON.stringify({ ids }) })
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('PREVIEW_BATCH_ENABLED', 'true')
  m.response.mockResolvedValue(new Response('ok'))
  m.caller.mockResolvedValue({ mainAdmin: false, username: 'alice' })
})
afterEach(() => vi.unstubAllEnvs())
it('face batch retains the ignored-face condition and inaccessible items stay missing', async () => {
  m.query.mockResolvedValue([{ face_id: 1, crop_path: 'faces/a.webp' }])
  expect((await faces(req([1, 2]))).status).toBe(200)
  expect(m.query.mock.calls[0][0]).toContain(
    '(NOT ignored OR owner_username=photo_security.username())',
  )
  expect(m.response.mock.calls[0][1]).toEqual(['faces/a.webp', null])
  expect(m.auth).toHaveBeenCalled()
  expect(m.origin).toHaveBeenCalled()
})
it('trash batch retains ownership, expiry and main-admin checks', async () => {
  m.query.mockResolvedValue([{ photo_id: 1, path: 'thumbnails/a.jpg' }])
  expect((await trash(req([1, 2]))).status).toBe(200)
  expect(m.query.mock.calls[0][1]).toEqual([[1, 2], false, 'alice'])
  expect(m.query.mock.calls[0][0]).toContain('expires_at>NOW()')
  expect(m.response.mock.calls[0][1]).toEqual(['thumbnails/a.jpg', null])
})
it('both reject oversized batches without reading resources', async () => {
  for (const handler of [faces, trash])
    expect((await handler(req(Array(9).fill(1)))).status).toBe(400)
  expect(m.query).not.toHaveBeenCalled()
})
