import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  databaseContext,
  type DatabaseIdentity,
  databaseSignal,
} from '@/lib/database/database-context'

const state = vi.hoisted(() => ({ search: vi.fn(), pg: vi.fn(), hydrate: vi.fn(), revision: '1' }))
vi.mock('@/lib/postgres', () => ({
  pgQuery: state.pg,
  getDatabaseIdentity: async () => {
    const { databaseContext } = await import('@/lib/database/database-context')
    const context = databaseContext.getStore()
    if (context?.kind !== 'request' || !context.identity) throw Error('Missing identity')
    return context.identity
  },
}))
vi.mock('@/lib/search', async (original) => ({
  ...(await original<typeof import('@/lib/search')>()),
  search: state.search,
  hydrateSearchIds: state.hydrate,
}))
vi.mock('@/lib/people/people-search', async (original) => ({
  ...(await original<typeof import('@/lib/people/people-search')>()),
  peopleById: async () => [],
  suggestPeople: async () => [],
}))
import { pagedSearch } from '@/lib/search/search-session'

const identity = (username: string): DatabaseIdentity => ({
  username,
  mainAdmin: false,
  adminRead: false,
  adminWrite: false,
  canWrite: true,
  accessManager: false,
})
const request = (
  username: string,
  options: {
    signal?: AbortSignal
    albums?: number[]
    query?: string
    kind?: 'photo' | 'event'
    mainAdmin?: boolean
  } = {},
) =>
  databaseContext.run(
    {
      kind: 'request',
      signal: options.signal,
      identity: Promise.resolve({ ...identity(username), mainAdmin: options.mainAdmin ?? false }),
      requestBinding: { method: 'GET', target: '/private-binding' },
    },
    () =>
      pagedSearch(
        options.kind ?? 'photo',
        new Request(
          'https://app/api/search?q=' + encodeURIComponent(options.query ?? 'wedding in 2020'),
          { signal: options.signal },
        ),
        options.albums ?? [1],
      ),
  )
const retrieved = {
  source: 'semantic',
  query: 'wedding',
  people: [],
  results: [{ photoId: 1, subjectMatch: true }],
  count: 1,
}

beforeEach(() => {
  state.revision = '1'
  vi.clearAllMocks()
  state.hydrate.mockImplementation(async (_kind, ids) =>
    ids.map((photoId: number) => ({ photoId })),
  )
  state.pg.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT search_scope_revision')) return [{ revision: state.revision }]
    if (sql.includes('INSERT INTO search_sessions'))
      return [
        {
          id: '11111111-1111-4111-8111-111111111111',
          last_used_at: new Date().toISOString(),
          revision: params[4],
          options: JSON.parse(String(params[3])),
          payload: JSON.parse(String(params[5])),
          candidate_ids: params[6],
          reranked_ids: null,
          documents: [],
        },
      ]
    return []
  })
  state.search.mockResolvedValue(retrieved)
})

it('keeps coalesced request cancellation separate and hydrates only the surviving subscriber', async () => {
  let finish!: () => void
  let operationSignal: AbortSignal | undefined
  state.search.mockImplementation(() => {
    operationSignal = databaseSignal()
    expect(databaseContext.getStore()).not.toHaveProperty('requestBinding')
    return new Promise((resolve) => {
      finish = () => resolve(retrieved)
    })
  })
  const a = new AbortController()
  const b = new AbortController()
  const settled = Promise.allSettled([
    request('ALICE', { signal: a.signal }),
    request('ALICE', { signal: b.signal }),
  ])
  await vi.waitFor(() => expect(state.search).toHaveBeenCalledTimes(1))
  a.abort()
  expect(operationSignal?.aborted).toBe(false)
  state.hydrate.mockImplementation(async () => {
    expect(databaseSignal()).toBe(b.signal)
    expect(databaseContext.getStore()).toHaveProperty('requestBinding')
    return [{ photoId: 1 }]
  })
  finish()
  const results = await settled
  expect(results[0].status).toBe('rejected')
  expect(results[1]).toMatchObject({ status: 'fulfilled', value: { count: 1 } })
  expect(state.hydrate).toHaveBeenCalledTimes(1)
})

it('does not coalesce across users, permission flags, album scopes, query, or kind', async () => {
  vi.stubEnv('SEARCH_MAX_ACTIVE', '8')
  vi.stubEnv('SEARCH_MAX_ACTIVE_PER_USER', '8')
  const finish: (() => void)[] = []
  const seen: string[] = []
  state.search.mockImplementation(async () => {
    const context = databaseContext.getStore()
    seen.push(context?.kind === 'request' ? (await context.identity)!.username : 'missing')
    return new Promise((resolve) => {
      finish.push(() => resolve(retrieved))
    })
  })
  const results = Promise.all([
    request('ALICE'),
    request('BOB'),
    request('ALICE', { mainAdmin: true }),
    request('ALICE', { albums: [2] }),
    request('ALICE', { query: 'mountain in 2020' }),
    request('ALICE', { kind: 'event' }),
  ])
  await vi.waitFor(() => expect(state.search).toHaveBeenCalledTimes(6))
  finish.forEach((resolve) => resolve())
  await results
  expect(seen.filter((user) => user === 'BOB')).toHaveLength(1)
  expect(
    state.pg.mock.calls.filter(([sql]) => sql.includes('INSERT INTO search_sessions')),
  ).toHaveLength(6)
})

it('uses a new operation when the catalog revision changes and rechecks each live response', async () => {
  vi.stubEnv('SEARCH_MAX_ACTIVE_PER_USER', '2')
  const finish: (() => void)[] = []
  state.search.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish.push(() => resolve(retrieved))
      }),
  )
  const first = request('ALICE')
  await vi.waitFor(() => expect(state.search).toHaveBeenCalledTimes(1))
  state.revision = '2'
  const second = request('ALICE')
  await vi.waitFor(() => expect(state.search).toHaveBeenCalledTimes(2))
  finish.forEach((resolve) => resolve())
  const [oldRevision, newRevision] = await Promise.all([first, second])
  expect(oldRevision).toHaveProperty(
    'notice',
    'Your library changed during this search. Search again to refresh all matches.',
  )
  expect(newRevision).not.toHaveProperty('notice')
  expect(state.hydrate).toHaveBeenCalledTimes(2)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

it('coalesces simultaneous cold misses but hydrates each response under its own live request', async () => {
  const finish: (() => void)[] = []
  state.search.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish.push(() => resolve(retrieved))
      }),
  )
  const a = request('ALICE')
  const b = request('ALICE')
  await vi.waitFor(() => expect(state.search).toHaveBeenCalled())
  // Yield all cache-miss continuations before inspecting the expensive retrieval count.
  await new Promise((resolve) => setTimeout(resolve, 0))
  finish.forEach((resolve) => resolve())
  expect((await Promise.all([a, b])).map((result) => result.count)).toEqual([1, 1])
  expect(state.search).toHaveBeenCalledTimes(1)
  expect(
    state.pg.mock.calls.filter(([sql]) => sql.includes('INSERT INTO search_sessions')),
  ).toHaveLength(1)
  expect(state.hydrate).toHaveBeenCalledTimes(2)
})
