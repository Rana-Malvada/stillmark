vi.mock('@/lib/albums/album-access', () => ({ accessibleAlbumIds: async () => [1] }))
import { beforeEach, expect, it, vi } from 'vitest'

const s = vi.hoisted(() => ({
  track: vi.fn(),
  auth: vi.fn(),
  search: vi.fn(),
  after: vi.fn(),
  record: vi.fn(),
  session: vi.fn(),
}))
vi.mock('@/lib/identity/auth', () => ({ requireAuth: s.auth }))
vi.mock('@/lib/observability/activity-action', () => ({ trackAction: s.track }))
vi.mock('@/lib/search/search-session', () => ({ pagedSearch: s.search }))
import { GET } from '@/app/api/search/route'
import { HttpError } from '@/lib/http'

beforeEach(() => {
  vi.clearAllMocks()
  s.auth.mockResolvedValue({ username: 'alice' })
})
it('records actual search source, results, and query after successful search', async () => {
  s.search.mockResolvedValue({ source: 'semantic', count: 4, results: [], people: [] })
  expect((await GET(new Request('https://app/api/search?q=car'))).status).toBe(200)
  expect(s.track).toHaveBeenCalledWith(
    'search_performed',
    '',
    expect.objectContaining({ query: 'car', mode: 'semantic', results: 4, outcome: 'success' }),
  )
})
it('records sanitized failure category but no raw upstream error', async () => {
  s.search.mockRejectedValue(new HttpError(503, 'secret upstream details'))
  await GET(new Request('https://app/api/search?q=car'))
  expect(s.track).toHaveBeenCalledWith(
    'search_performed',
    '',
    expect.objectContaining({ status: 503, outcome: 'failed' }),
  )
  expect(JSON.stringify(s.track.mock.calls)).not.toContain('secret')
})
it('never records the names of recognised people in search activity', async () => {
  s.search.mockResolvedValue({
    source: 'people',
    count: 2,
    results: [],
    people: [{ personId: '22222222-2222-4222-8222-222222222222', name: 'Dana' }],
  })
  await GET(new Request('https://app/api/search?q=dana%20at%20the%20beach'))
  expect(s.track).toHaveBeenCalledWith(
    'search_performed',
    '',
    expect.objectContaining({ query: '[person] at the beach', mode: 'people' }),
  )
  expect(JSON.stringify(s.track.mock.calls).toLowerCase()).not.toContain('dana')
})
it('does not track unauthenticated requests or empty queries', async () => {
  s.auth.mockRejectedValue(new HttpError(401, 'no'))
  await GET(new Request('https://app/api/search?q=car'))
  expect(s.track).not.toHaveBeenCalled()
  s.auth.mockResolvedValue({ username: 'alice' })
  s.search.mockResolvedValue({ source: 'postgres', count: 0, results: [] })
  await GET(new Request('https://app/api/search?q='))
  expect(s.track).not.toHaveBeenCalled()
})
