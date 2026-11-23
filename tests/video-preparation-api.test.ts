import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  origin: vi.fn(),
  status: vi.fn(),
  start: vi.fn(),
  skip: vi.fn(),
}))
vi.mock('@/lib/albums/album-access', () => ({ requireMainAdmin: mocks.admin }))
vi.mock('@/lib/identity/auth', () => ({ requireSameOrigin: mocks.origin }))
vi.mock('@/lib/video/video-preparation', () => ({
  preparationStatus: mocks.status,
  startPreparation: mocks.start,
  setPreparationSkipped: mocks.skip,
}))
import { GET, PATCH, POST } from '@/app/api/admin/video-preparation/route'
import { HttpError } from '@/lib/http'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.admin.mockResolvedValue({ username: 'admin' })
})
it('rejects non-admin reads and launches before accessing jobs', async () => {
  mocks.admin.mockRejectedValue(new HttpError(403, 'Forbidden'))
  expect((await GET()).status).toBe(403)
  expect((await POST()).status).toBe(403)
  expect(mocks.status).not.toHaveBeenCalled()
  expect(mocks.start).not.toHaveBeenCalled()
})
it('rejects cross-origin launches', async () => {
  mocks.origin.mockRejectedValue(new HttpError(403, 'Origin rejected'))
  expect((await POST()).status).toBe(403)
  expect(mocks.start).not.toHaveBeenCalled()
})
it('uses the authenticated admin identity', async () => {
  mocks.start.mockResolvedValue({ id: 'run' })
  expect((await POST()).status).toBe(200)
  expect(mocks.start).toHaveBeenCalledWith('admin')
})

const patch = (body: unknown) =>
  PATCH(
    new Request('http://localhost/api/admin/video-preparation', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  )
it('validates exclusion flags and IDs before modifying jobs', async () => {
  expect((await patch({ photoId: 2, skipped: 'true' })).status).toBe(400)
  expect((await patch({ photoId: -1, skipped: true })).status).toBe(400)
  expect(mocks.skip).not.toHaveBeenCalled()
  mocks.skip.mockResolvedValue({ photo_id: 2 })
  expect((await patch({ photoId: 2, skipped: true })).status).toBe(200)
  expect(mocks.skip).toHaveBeenCalledWith(2, true)
})
it('protects exclusions with admin and same-origin checks', async () => {
  mocks.admin.mockRejectedValueOnce(new HttpError(403, 'Forbidden'))
  expect((await patch({ photoId: 2, skipped: true })).status).toBe(403)
  mocks.origin.mockRejectedValueOnce(new HttpError(403, 'Origin rejected'))
  expect((await patch({ photoId: 2, skipped: true })).status).toBe(403)
  expect(mocks.skip).not.toHaveBeenCalled()
})
