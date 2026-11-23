vi.mock('@/lib/albums/album-access', () => ({
  albumMutation: async (fn: Function) => {
    await mocks.admin()
    return fn({})
  },
  requirePhotoAccess: vi.fn(),
  albumCaller: async () => ({ username: 'ALICE', role: 'viewer', mainAdmin: false }),
  accessibleAlbumIds: async () => [1, 2],
}))
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  auth: vi.fn(),
  origin: vi.fn(),
  one: vi.fn(),
  query: vi.fn(),
}))
vi.mock('@/lib/identity/auth', () => ({
  requireAdmin: mocks.admin,
  requireAuth: mocks.auth,
  requireSameOrigin: mocks.origin,
}))
vi.mock('@/lib/postgres', () => ({
  pgQueryOne: mocks.one,
  pgQuery: mocks.query,
  pgTransaction: vi.fn(),
  pgReadIdentity: (_caller: unknown, fn: () => Promise<unknown>) => fn(),
}))
vi.mock('@/lib/media/image-urls', () => ({
  getImageProxyUrl: (path: string) => `/api/images?path=${encodeURIComponent(path)}`,
}))
import { photoLabels } from '@/lib/photos/photo-labels'
import { PATCH } from '@/app/api/photos/[photoId]/labels/route'
import { GET } from '@/app/api/favorites/route'
import { HttpError } from '@/lib/http'

const context = { params: Promise.resolve({ photoId: '12' }) }
const request = (body: unknown) =>
  new Request('https://app/api/photos/12/labels', { method: 'PATCH', body: JSON.stringify(body) })
beforeEach(() => vi.resetAllMocks())
it('validates bounded plain-text captions and tags and deduplicates labels', () => {
  expect(
    photoLabels({ caption: '  A family\nholiday  ', tags: [' Beach ', 'beach', 'Family'] }),
  ).toEqual({ caption: 'A family\nholiday', tags: ['Beach', 'Family'] })
  expect(photoLabels({ caption: ' ', tags: [] })).toEqual({ caption: null, tags: [] })
  for (const body of [
    { caption: 7, tags: [] },
    { caption: 'x'.repeat(5001), tags: [] },
    { caption: '\0', tags: [] },
    { caption: 'ok', tags: 'bad' },
    { caption: 'ok', tags: [12] },
    { caption: 'ok', tags: ['x'.repeat(65)] },
    { caption: 'ok', tags: Array(21).fill('x') },
  ])
    expect(() => photoLabels(body)).toThrow(HttpError)
})
it('requires album editing permission and same-origin for edits, rejects missing photos and stores literal text', async () => {
  mocks.admin.mockRejectedValueOnce(new HttpError(403, 'Admin required'))
  expect((await PATCH(request({ caption: 'a', tags: [] }), context)).status).toBe(403)
  mocks.origin.mockRejectedValueOnce(new HttpError(403, 'Wrong origin'))
  expect((await PATCH(request({ caption: 'a', tags: [] }), context)).status).toBe(403)
  expect(mocks.one).not.toHaveBeenCalled()
  mocks.one.mockResolvedValueOnce(null).mockResolvedValueOnce({ photo_id: 12 })
  expect((await PATCH(request({ caption: 'a', tags: [] }), context)).status).toBe(404)
  expect(
    (await PATCH(request({ caption: "It's <b>safe</b>", tags: ['Family'] }), context)).status,
  ).toBe(200)
  expect(mocks.one.mock.calls[1][1]).toEqual([12, "It's <b>safe</b>", ['Family']])
})
it('authenticates favorites and rejects unsafe filters before querying', async () => {
  mocks.auth.mockRejectedValueOnce(new HttpError(401, 'Sign in'))
  expect((await GET(new Request('https://app/api/favorites?paged=true'))).status).toBe(401)
  expect((await GET(new Request('https://app/api/favorites?paged=true&sort=bad'))).status).toBe(400)
  expect((await GET(new Request('https://app/api/favorites'))).status).toBe(400)
  expect(mocks.query).not.toHaveBeenCalled()
  mocks.query.mockResolvedValue([])
  expect(await (await GET(new Request('https://app/api/favorites?paged=true'))).json()).toEqual({
    items: [],
    nextCursor: null,
  })
})
