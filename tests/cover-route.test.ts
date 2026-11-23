vi.mock('@/lib/albums/album-access', () => ({
  albumMutation: async (fn: Function) => {
    await mocks.admin()
    return fn({})
  },
  requirePhotoAccess: vi.fn(),
  accessibleAlbumIds: async () => [1, 2],
}))
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ admin: vi.fn(), origin: vi.fn(), choose: vi.fn() }))
vi.mock('@/lib/identity/auth', () => ({
  requireAuth: vi.fn(),
  requireAdmin: mocks.admin,
  requireSameOrigin: mocks.origin,
}))
vi.mock('@/lib/albums/events', () => ({ getEvent: vi.fn(), chooseCoverPhoto: mocks.choose }))
vi.mock('@/lib/photos', () => ({
  getPhoto: vi.fn(),
  deletePhoto: vi.fn(),
}))
vi.mock('@/lib/media/image-urls', () => ({ getImageProxyUrl: vi.fn() }))
import { PATCH } from '@/app/api/photos/[photoId]/route'
import { HttpError } from '@/lib/http'

const context = { params: Promise.resolve({ photoId: '12' }) }
beforeEach(() => vi.resetAllMocks())
it('requires album editing permission access before changing a cover', async () => {
  mocks.admin.mockRejectedValue(new HttpError(403, 'Administrator access required'))
  expect(
    (await PATCH(new Request('https://app/api/photos/12', { method: 'PATCH' }), context)).status,
  ).toBe(403)
  expect(mocks.choose).not.toHaveBeenCalled()
})
it('rejects cross-origin cover changes', async () => {
  mocks.origin.mockRejectedValue(new HttpError(403, 'Same-origin request required'))
  expect(
    (await PATCH(new Request('https://app/api/photos/12', { method: 'PATCH' }), context)).status,
  ).toBe(403)
  expect(mocks.choose).not.toHaveBeenCalled()
})
it('sets a valid cover and reports missing photos', async () => {
  mocks.choose.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  expect(
    (await PATCH(new Request('https://app/api/photos/12', { method: 'PATCH' }), context)).status,
  ).toBe(200)
  expect(mocks.choose).toHaveBeenCalledWith(12)
  expect(
    (await PATCH(new Request('https://app/api/photos/12', { method: 'PATCH' }), context)).status,
  ).toBe(404)
})
