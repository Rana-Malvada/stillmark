import { beforeEach, expect, it, vi } from 'vitest'
import { HttpError } from '@/lib/http'

const s = vi.hoisted(() => ({
  admin: vi.fn(),
  one: vi.fn(),
  query: vi.fn(),
  caller: vi.fn(),
  ids: vi.fn(),
  statistics: vi.fn(),
}))
vi.mock('@/lib/identity/auth', () => ({
  requireAdminRead: s.admin,
  requireAdmin: vi.fn(),
  requireSameOrigin: vi.fn(),
}))
vi.mock('@/lib/albums/album-access', () => ({
  albumCaller: s.caller,
  accessibleAlbumIds: s.ids,
  requireMainAdmin: vi.fn(),
}))
vi.mock('@/lib/postgres', () => ({ pgQueryOne: s.one, pgQuery: s.query }))
vi.mock('@/lib/gallery-statistics', () => ({ readGalleryStatistics: s.statistics }))
import { GET } from '@/app/api/activity/route'

beforeEach(() => {
  vi.resetAllMocks()
  s.caller.mockResolvedValue({ mainAdmin: true })
  s.ids.mockResolvedValue([1])
  s.one.mockResolvedValue({ active_ai: 0 })
  s.query.mockResolvedValue([])
  s.statistics.mockResolvedValue({
    pending_sync: 4,
    pending_search_removals: 2,
    photos_without_ai: 7,
  })
})
it('keeps Activity protected before reading status', async () => {
  s.admin.mockRejectedValue(new HttpError(403, 'Administrative visibility required'))
  expect((await GET()).status).toBe(403)
  expect(s.one).not.toHaveBeenCalled()
  expect(s.statistics).not.toHaveBeenCalled()
})
it('reads active unfinished descriptions with the live-claim index predicate', async () => {
  const response = await GET()
  expect(response.status).toBe(200)
  expect((await response.json()).summary).toEqual({
    active_ai: 0,
    pending_sync: 4,
    pending_search_removals: 2,
    pending_ai: 7,
  })
  expect(s.one.mock.calls[0][0]).toContain(
    'WHERE ai_claim IS NOT NULL AND ai_description IS NULL AND ai_lease_until>NOW()',
  )
  expect(s.query.mock.calls[0][1]).toEqual([[1]])
})
