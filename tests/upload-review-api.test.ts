import { expect, it, vi } from 'vitest'

vi.mock('@/lib/postgres', () => ({ pgTransaction: (fn: () => Promise<unknown>) => fn() }))
const mocks = vi.hoisted(() => ({ page: vi.fn(), access: vi.fn() }))
vi.mock('@/lib/identity/auth', () => ({
  requireAuth: vi.fn(),
  requireAdmin: vi.fn(),
  requireSameOrigin: vi.fn(),
}))
vi.mock('@/lib/albums/album-access', () => ({
  requireAlbumAccess: mocks.access,
  albumMutation: vi.fn(),
}))
vi.mock('@/lib/albums/folders', () => ({ requireFolderWrite: vi.fn() }))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: vi.fn() }))
vi.mock('@/lib/albums/events', () => ({ deleteEvent: vi.fn(), updateAlbumDetails: vi.fn() }))
vi.mock('@/lib/photos/photo-page', () => ({ authorizedPhotoPage: mocks.page }))
vi.mock('@/lib/media/image-urls', () => ({ getImageProxyUrl: vi.fn() }))
import { HttpError } from '@/lib/http'
import { requireAuth } from '@/lib/identity/auth'
import { HEAD } from '@/app/api/events/[eventId]/route'

it.each([200, 403, 404])('checks album availability without loading photos: %s', async (status) => {
  mocks.page.mockClear()
  mocks.access.mockReset()
  if (status !== 200) mocks.access.mockRejectedValueOnce(new HttpError(status, 'Unavailable'))
  const response = await HEAD(
    new Request('https://example.com/api/events/745', { method: 'HEAD' }),
    {
      params: Promise.resolve({ eventId: '745' }),
    },
  )
  expect(response.status).toBe(status)
  expect(await response.text()).toBe('')
  expect(response.headers.get('Cache-Control')).toContain('no-store')
  expect(mocks.access).toHaveBeenCalledWith(745)
  expect(mocks.page).not.toHaveBeenCalled()
})
it('requires authentication before checking album availability', async () => {
  mocks.access.mockClear()
  vi.mocked(requireAuth).mockRejectedValueOnce(new HttpError(401, 'Unauthorized'))
  const response = await HEAD(
    new Request('https://example.com/api/events/745', { method: 'HEAD' }),
    {
      params: Promise.resolve({ eventId: '745' }),
    },
  )
  expect(response.status).toBe(401)
  expect(mocks.access).not.toHaveBeenCalled()
})
