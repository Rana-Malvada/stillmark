import { beforeEach, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ query: vi.fn(), one: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQuery: db.query, pgQueryOne: db.one }))
vi.mock('@/lib/snowflake', () => ({
  querySnowflake: vi.fn(),
  getSnowflakeBaseUrl: () => 'https://example.snowflakecomputing.com',
  getRestApiAuthHeader: () => 'Bearer test',
}))
import { search, searchInterpreted } from '@/lib/search'

beforeEach(() => vi.resetAllMocks())
const options = { query: 'beach', eventId: 9, limit: 20, semantic: false }
const intent = { keywords: 'beach' } as Parameters<typeof searchInterpreted>[4]
it('rejects an album filter outside the caller scope on first search and on replay, before any lookup', async () => {
  for (const kind of ['photo', 'event'] as const) {
    await expect(search(kind, options, [1, 2])).rejects.toMatchObject({ status: 404 })
    await expect(searchInterpreted(kind, options, [1, 2], [], intent)).rejects.toMatchObject({
      status: 404,
    })
    await expect(searchInterpreted(kind, options, [], [], intent)).rejects.toMatchObject({
      status: 404,
    })
  }
  expect(db.query).not.toHaveBeenCalled()
  expect(db.one).not.toHaveBeenCalled()
})
