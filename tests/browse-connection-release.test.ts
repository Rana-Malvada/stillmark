import { beforeEach, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ active: false, denied: false, page: vi.fn() }))
vi.mock('@/lib/postgres', () => ({
  pgReadIdentity: async (_caller: unknown, fn: () => Promise<unknown>) => {
    m.active = true
    try {
      return await fn()
    } finally {
      m.active = false
    }
  },
}))
vi.mock('@/lib/identity/auth', () => ({
  requireAuth: vi.fn(),
  requireAdmin: vi.fn(),
  requireSameOrigin: vi.fn(),
}))
vi.mock('@/lib/albums/album-access', () => ({
  requireAlbumAccess: async () => {
    expect(m.active).toBe(true)
    if (m.denied) throw new Error('denied')
  },
  albumMutation: vi.fn(),
  albumCaller: async () => ({ username: 'ALICE', mainAdmin: false }),
}))
vi.mock('@/lib/photos/photo-page', () => ({ authorizedPhotoPage: m.page }))
vi.mock('@/lib/albums/events', () => ({ deleteEvent: vi.fn(), updateAlbumDetails: vi.fn() }))
vi.mock('@/lib/albums/folders', () => ({ requireFolderWrite: vi.fn() }))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: vi.fn() }))
vi.mock('@/lib/media/image-urls', () => ({
  getImageProxyUrl: (path: string) => {
    expect(m.active).toBe(false)
    return `/image/${path}`
  },
}))
import { GET } from '@/app/api/events/[eventId]/route'

beforeEach(() => {
  m.active = false
  m.denied = false
  m.page.mockReset()
})
it('releases the connection before constructing a response', async () => {
  m.page.mockImplementation(async () => {
    expect(m.active).toBe(true)
    return { items: [{ photoId: 1, thumbnailStagePath: 'thumb' }], nextCursor: null }
  })
  const response = await GET(new Request('https://app/api/events/1?paged=true'), {
    params: Promise.resolve({ eventId: '1' }),
  })
  expect(response.status).toBe(200)
  expect((await response.json()).items[0].thumbnailUrl).toBe('/image/thumb')
})
it.each(['', '?paged=false'])(
  'rejects an unpaged read before any database work (%s)',
  async (query) => {
    const response = await GET(new Request(`https://app/api/events/1${query}`), {
      params: Promise.resolve({ eventId: '1' }),
    })
    expect(response.status).toBe(400)
    expect(m.page).not.toHaveBeenCalled()
    expect(m.active).toBe(false)
  },
)
it('releases the connection without returning data when the authorized page read fails', async () => {
  m.page.mockRejectedValue(new Error('Album not found'))
  const response = await GET(new Request('https://app/api/events/1?paged=true'), {
    params: Promise.resolve({ eventId: '1' }),
  })
  expect(response.status).not.toBe(200)
  expect(m.page).toHaveBeenCalledTimes(1)
  expect(m.active).toBe(false)
})
