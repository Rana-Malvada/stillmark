import { beforeEach, expect, it, vi } from 'vitest'
import { SearchAdmission } from '@/lib/search/search-admission'
import { databaseContext } from '@/lib/database/database-context'

const mocks = vi.hoisted(() => ({ pg: vi.fn(), sf: vi.fn() }))
vi.mock('@/lib/postgres', () => ({ pgQuery: mocks.pg }))
vi.mock('@/lib/snowflake', () => ({
  querySnowflake: mocks.sf,
  getSnowflakeBaseUrl: () => 'https://example.snowflakecomputing.com',
  getRestApiAuthHeader: () => 'Bearer test',
}))
// Text search behaviour with no recognised people; people search is covered separately.
vi.mock('@/lib/people/people-search', async (actual) => ({
  ...(await actual<typeof import('@/lib/people/people-search')>()),
  resolvePeople: async (query: string) => ({ people: [], remainder: query }),
  peopleById: async () => [],
  suggestPeople: async () => [],
}))
vi.mock('@/lib/search/search-intent', async (actual) => ({
  ...(await actual<typeof import('@/lib/search/search-intent')>()),
  interpretSearch: vi.fn(async (query: string) => ({
    intent: {
      branches: [{ include: [], exclude: [] }],
      keywords: query,
      excludedKeywords: [],
      fromYear: null,
      throughYear: null,
      clarification: null,
    },
    metrics: { mode: 'haiku', elapsedMs: 1, inputTokens: 1, outputTokens: 1 },
  })),
}))
import { search, searchOptions } from '@/lib/search'
import { interpretSearch } from '@/lib/search/search-intent'

const options = { query: 'car', limit: 20, eventId: null, semantic: false }
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', vi.fn())
})
it('uses Postgres for basic photo matches without calling Snowflake', async () => {
  mocks.pg.mockResolvedValue([{ photoId: 1 }])
  const result = await search('photo', options, [1, 2, 7])
  expect(result.source).toBe('postgres')
  expect(fetch).not.toHaveBeenCalled()
  expect(mocks.sf).not.toHaveBeenCalled()
  expect(mocks.pg.mock.calls[0][1]).toEqual(['car', 20, null, [1, 2, 7]])
})
it('uses Postgres for album matches too', async () => {
  mocks.pg.mockResolvedValue([{ eventId: 1, coverPath: 'thumbnails/a.jpg' }])
  const result = await search('event', options, [1, 2, 7])
  expect(result.results[0]).toMatchObject({ coverUrl: '/api/images?path=thumbnails%2Fa.jpg' })
  expect(fetch).not.toHaveBeenCalled()
})
it('falls back only after no keyword matches and hydrates live data', async () => {
  mocks.pg.mockResolvedValueOnce([]).mockResolvedValueOnce([{ photoId: 3 }])
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ results: [{ PHOTO_ID: 3 }, { PHOTO_ID: 999 }, { PHOTO_ID: 3 }] }),
  )
  const result = await search('photo', options, [1, 2, 7])
  expect(result.results).toEqual([{ photoId: 3, scores: {} }])
  expect(result.source).toBe('semantic')
  expect(mocks.pg.mock.calls[1][1]).toEqual([[3, 999], null, [1, 2, 7], 'car'])
})
it('explicit semantic mode skips basic matching and preserves event filter', async () => {
  mocks.pg.mockResolvedValue([{ photoId: 2 }])
  vi.mocked(fetch).mockResolvedValue(Response.json({ results: [{ PHOTO_ID: 2 }] }))
  await search('photo', { ...options, semantic: true, eventId: 7 }, [1, 2, 7])
  expect(mocks.pg).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).filter).toEqual({
    '@or': [{ '@eq': { EVENT_ID: 7 } }],
  })
})
it('surfaces semantic service failure instead of presenting false no-results', async () => {
  mocks.pg.mockResolvedValue([])
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }))
  await expect(search('photo', options, [1, 2, 7])).rejects.toMatchObject({ status: 503 })
})
it('bounds search input and passes SQL-looking text as data', async () => {
  expect(() => searchOptions(new Request('https://app/api/search?q=car&limit=-1'))).toThrow()
  const query = "car' OR 1=1 --"
  mocks.pg.mockResolvedValue([{ photoId: 1 }])
  await search('photo', { ...options, query }, [1, 2, 7])
  expect(mocks.pg.mock.calls[0][0]).not.toContain(query)
  expect(mocks.pg.mock.calls[0][1]).toContain(query)
})

it('keeps finite scores attached to authorized hydrated results, including zero and negative scores', async () => {
  mocks.pg.mockResolvedValue([{ eventId: 7, coverPath: null }])
  vi.mocked(fetch).mockResolvedValue(
    Response.json({
      results: [
        {
          EVENT_ID: 7,
          '@scores': { reranker_score: -9.38, text_match: 0, cosine_similarity: 0.377 },
        },
        { EVENT_ID: 999, '@scores': { reranker_score: 10 } },
      ],
    }),
  )
  const result = await search('event', { ...options, semantic: true }, [7])
  expect(result.results).toEqual([
    {
      eventId: 7,
      coverUrl: null,
      scores: { reranker_score: -9.38, text_match: 0, cosine_similarity: 0.377 },
    },
  ])
  expect(mocks.pg.mock.calls[0][1]).toEqual([[7, 999], [7]])
})

it.each([
  'show me all the motocross racers with the number 6',
  'show me all the motocross racers with the nubmer 6',
])('keeps the original semantic search for %s without Haiku', async (query) => {
  mocks.pg
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ photoId: 6, aiDescription: 'A motocross rider number 6.' }])
  vi.mocked(fetch).mockResolvedValue(Response.json({ results: [{ PHOTO_ID: 6 }] }))
  const result = await search('photo', { ...options, query }, [1, 2, 7])
  expect(result.results).toEqual([
    { photoId: 6, aiDescription: 'A motocross rider number 6.', scores: {}, keywordMatch: true },
  ])
  expect(result.source).toBe('semantic')
  expect(interpretSearch).not.toHaveBeenCalled()
  expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).query).toBe(query)
})

it('keeps visual-only candidates below strong text matches in weighted fusion', async () => {
  const { fuseRanks } = await import('@/lib/search')
  expect(
    fuseRanks(
      [
        [1, 2],
        [2, 1],
        [99, 100],
      ],
      [1, 1, 0.25],
    ).slice(0, 2),
  ).toEqual([1, 2])
})

it('uses visual ranks only as support for text/semantic candidates', async () => {
  const { fuseSearchRanks } = await import('@/lib/search')
  const ids = fuseSearchRanks(
    [
      [1, 2, 3],
      [2, 1, 4],
    ],
    [999, 3, 4],
  )
  expect(new Set(ids)).toEqual(new Set([1, 2, 3, 4]))
  expect(ids[0]).toBe(1)
})

it('bounds partition concurrency and preserves every eligibility filter and album ACL', async () => {
  const { semanticMatches } = await import('@/lib/search')
  let active = 0
  let peak = 0
  const seen: number[] = []
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const payload = JSON.parse(String(init?.body))
    expect(payload.filter['@and'][0]).toEqual({ '@or': [{ '@eq': { EVENT_ID: 7 } }] })
    const ids = payload.filter['@and'][1]['@or'].map((r: any) => Number(r['@primarykey'].PHOTO_ID))
    seen.push(...ids)
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active--
    return Response.json({ results: [{ PHOTO_ID: ids[0], '@scores': { reranker_score: ids[0] } }] })
  })
  const ids = Array.from({ length: 15001 }, (_, i) => i + 1)
  const result = await semanticMatches('photo', options, [7], ids)
  expect(seen).toEqual(ids)
  expect(peak).toBe(2)
  expect(result.size).toBe(4)
})

it('preserves all 5k/50k/100k eligible IDs while bounding provider fanout across searches', async () => {
  const { semanticMatches } = await import('@/lib/search')
  const admission = new SearchAdmission(() => ({
    active: 2,
    perUser: 1,
    queued: 2,
    queuedPerUser: 1,
    subscribers: 8,
    subscribersPerUser: 2,
    timeoutMs: 5000,
  }))
  let active = 0
  let peak = 0
  const seen = new Map<string, number[]>()
  vi.mocked(fetch).mockImplementation(async (_url, init) => {
    const payload = JSON.parse(String(init?.body))
    const ids: number[] = payload.filter['@and'][1]['@or'].map((row: any) =>
      Number(row['@primarykey'].PHOTO_ID),
    )
    seen.set(payload.query, [...(seen.get(payload.query) ?? []), ...ids])
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active--
    return Response.json({
      results: [{ PHOTO_ID: ids.at(-1), '@scores': { reranker_score: ids.at(-1) } }],
    })
  })
  const sizes = [5000, 50000, 100000]
  const results = await Promise.all(
    sizes.map((size) =>
      admission.run(String(size), 'large', (signal) =>
        databaseContext.run({ kind: 'request', signal }, () =>
          semanticMatches(
            'photo',
            { ...options, query: String(size) },
            [7],
            Array.from({ length: size }, (_, index) => index + 1),
          ),
        ),
      ),
    ),
  )
  for (const [index, size] of sizes.entries()) {
    expect(seen.get(String(size))).toEqual(Array.from({ length: size }, (_, i) => i + 1))
    expect(results[index].has(size)).toBe(true)
  }
  expect(peak).toBeLessThanOrEqual(4)
})

it('retains admission until a rejected partition and its outstanding sibling both settle', async () => {
  const { semanticMatches } = await import('@/lib/search')
  const admission = new SearchAdmission(() => ({
    active: 1,
    perUser: 1,
    queued: 1,
    queuedPerUser: 1,
    subscribers: 4,
    subscribersPerUser: 2,
    timeoutMs: 5000,
  }))
  let finishSibling!: () => void
  vi.mocked(fetch)
    .mockRejectedValueOnce(Error('partition failed'))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishSibling = () => resolve(Response.json({ results: [] }))
        }),
    )
  const first = Promise.allSettled([
    admission.run('alice', 'first', (signal) =>
      databaseContext.run({ kind: 'request', signal }, () =>
        semanticMatches(
          'photo',
          options,
          [7],
          Array.from({ length: 10000 }, (_, i) => i + 1),
        ),
      ),
    ),
  ])
  const nextWork = vi.fn(async () => 'next')
  const next = admission.run('bob', 'next', nextWork)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  expect(nextWork).not.toHaveBeenCalled()
  finishSibling()
  expect((await first)[0]).toMatchObject({
    status: 'rejected',
    reason: { message: 'partition failed' },
  })
  await expect(next).resolves.toBe('next')
})

it('propagates cancellation instead of swallowing it into keyword fallback', async () => {
  const controller = new AbortController()
  mocks.pg.mockResolvedValue([{ photoId: 1, aiDescription: 'red car' }])
  vi.mocked(fetch).mockImplementation(
    (_url, init) =>
      new Promise((_, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }),
      ),
  )
  const pending = databaseContext.run({ kind: 'request', signal: controller.signal }, () =>
    search('photo', { ...options, query: 'red car' }, [7]),
  )
  const failed = expect(pending).rejects.toThrow('search deadline')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  controller.abort(Error('search deadline'))
  await failed
  expect(mocks.pg).toHaveBeenCalledTimes(1)
})

it('closes non-success provider response bodies before returning an error', async () => {
  const { semanticMatches } = await import('@/lib/search')
  const cancel = vi.fn()
  const body = new ReadableStream({ cancel })
  vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 503 }))
  await expect(semanticMatches('photo', options, [7])).rejects.toMatchObject({ status: 503 })
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('aborts constrained partitions without returning a partial keyword fallback', async () => {
  const controller = new AbortController()
  mocks.pg
    .mockResolvedValueOnce([{ photoId: 1 }])
    .mockResolvedValueOnce(Array.from({ length: 10000 }, (_, i) => ({ photoId: i + 1 })))
  vi.mocked(fetch).mockImplementation(
    (_url, init) =>
      new Promise((_, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }),
      ),
  )
  const pending = databaseContext.run({ kind: 'request', signal: controller.signal }, () =>
    search('photo', { ...options, query: 'wedding in 2020' }, [7]),
  )
  const failed = expect(pending).rejects.toThrow('total search deadline')
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  controller.abort(Error('total search deadline'))
  await failed
  expect(mocks.pg).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('stops a 100k-ID search at its total deadline without truncating it into success', async () => {
  vi.useFakeTimers()
  try {
    const { semanticMatches } = await import('@/lib/search')
    const admission = new SearchAdmission(() => ({
      active: 1,
      perUser: 1,
      queued: 1,
      queuedPerUser: 1,
      subscribers: 2,
      subscribersPerUser: 2,
      timeoutMs: 25,
    }))
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init!.signal!
          const abort = () => {
            clearTimeout(timer)
            reject(signal.reason)
          }
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort)
            resolve(Response.json({ results: [] }))
          }, 10)
          signal.addEventListener('abort', abort, { once: true })
        }),
    )
    const pending = admission.run('alice', 'deadline', (signal) =>
      databaseContext.run({ kind: 'request', signal }, () =>
        semanticMatches(
          'photo',
          options,
          [7],
          Array.from({ length: 100000 }, (_, i) => i + 1),
        ),
      ),
    )
    const failed = expect(pending).rejects.toMatchObject({ status: 504 })
    await vi.advanceTimersByTimeAsync(100)
    await failed
    expect(fetch).toHaveBeenCalledTimes(6)
    await expect(admission.run('alice', 'recovered', async () => 'ready')).resolves.toBe('ready')
  } finally {
    vi.useRealTimers()
  }
})
