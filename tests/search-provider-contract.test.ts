import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/postgres', () => ({ pgQuery: vi.fn() }))
vi.mock('@/lib/snowflake', () => ({
  querySnowflake: vi.fn(),
  getSnowflakeBaseUrl: () => 'https://example.snowflakecomputing.com',
  getRestApiAuthHeader: () => 'Bearer test',
}))
import { semanticMatches } from '@/lib/search'
import { pgQuery } from '@/lib/postgres'
import { querySnowflake } from '@/lib/snowflake'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
it.each([new Response('{broken'), Response.json({}), Response.json({ results: null })])(
  'reports malformed service responses as unavailable',
  async (response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    )
    await expect(
      semanticMatches(
        'photo',
        { query: 'a mountain', limit: 20, eventId: null, semantic: true },
        [1],
      ),
    ).rejects.toMatchObject({ status: 503 })
    expect(fetch).toHaveBeenCalledOnce()
    expect(pgQuery).not.toHaveBeenCalled()
    expect(querySnowflake).not.toHaveBeenCalled()
  },
)
it('keeps explicitly empty results distinct from malformed results', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ results: [] })),
  )
  expect(
    await semanticMatches(
      'photo',
      { query: 'a mountain', limit: 20, eventId: null, semantic: true },
      [1],
    ),
  ).toEqual(new Map())
})
