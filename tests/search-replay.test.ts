import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ pg: vi.fn(), search: vi.fn(), interpreted: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQuery: mock.pg }))
vi.mock('@/lib/search', () => ({ search: mock.search, searchInterpreted: mock.interpreted }))
vi.mock('@/lib/search/search-session', () => ({
  SEARCH_VERSION: 9,
  searchCacheKey: () => 'current-key',
}))
vi.mock('@/lib/people/people-search', () => ({ peopleById: async () => [] }))
import { refreshSavedSearches } from '@/lib/search/search-replay'

beforeEach(() => {
  vi.resetAllMocks()
  mock.pg.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM search_sessions'))
      return [
        {
          id: 'saved',
          username: 'viewer',
          kind: 'photo',
          options: { query: 'Keith without Raul', scopeIds: [1] },
          payload: {},
        },
      ]
    if (sql.includes('native_app_identity')) return [{ username: 'viewer' }]
    if (sql.includes('search_scope_revision') && !sql.includes('search_sessions'))
      return [{ revision: '2' }]
    if (sql.includes('FROM events')) return [{ event_id: 1 }]
    if (sql.startsWith('UPDATE')) return [{ id: 'saved' }]
    return []
  })
})
it('replays deterministic exclusions without a paid interpretation or reranking exact sets', async () => {
  mock.search.mockResolvedValue({
    source: 'people',
    results: [{ photoId: 1 }, { photoId: 2 }],
    count: 2,
  })
  expect(await refreshSavedSearches(5)).toBe(1)
  expect(mock.search).toHaveBeenCalledWith(
    'photo',
    expect.objectContaining({ interpretationAllowed: false }),
    [1],
  )
  expect(mock.interpreted).not.toHaveBeenCalled()
  const update = mock.pg.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))!
  expect(update[1][1]).toEqual([1, 2])
  expect(update[1][2]).toBe('[]')
  expect(update[1][7]).toBe('skipped')
})
it('leaves the saved search untouched when unresolved logic requires clarification', async () => {
  mock.search.mockResolvedValue({
    source: 'people',
    results: [],
    clarification: 'Clarify the request',
  })
  expect(await refreshSavedSearches(5)).toBe(0)
  expect(mock.pg.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false)
})

it('skips inactive or deleted accounts before reading albums or replaying a search', async () => {
  const implementation = mock.pg.getMockImplementation()!
  mock.pg.mockImplementation(async (sql: string, ...args: unknown[]) => {
    if (sql.includes('native_app_identity')) return []
    return implementation(sql, ...args)
  })
  expect(await refreshSavedSearches(5)).toBe(0)
  expect(mock.search).not.toHaveBeenCalled()
  expect(mock.pg.mock.calls.some(([sql]) => sql.includes('FROM events'))).toBe(false)
  const identity = mock.pg.mock.calls.find(([sql]) => sql.includes('native_app_identity'))!
  expect(identity[0]).toContain('enabled AND NOT revoked AND app_role IS NOT NULL')
  expect(identity[1]).toEqual(['viewer'])
})

it('does not begin replay after the update deadline', async () => {
  await expect(refreshSavedSearches(5, AbortSignal.abort())).rejects.toThrow()
})
