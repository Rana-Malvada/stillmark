import { createSearchDatabase } from './fixtures/search-database'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  db: null as import('@electric-sql/pglite').PGlite | null,
  user: 'ALICE',
  flags: {} as Record<string, string>,
}))
// Every query runs as the web role with the caller's identity, exactly as in production.
vi.mock('@/lib/postgres', () => ({
  getDatabaseIdentity: async () => ({
    username: state.user,
    mainAdmin: state.flags.main_admin === 'true',
    adminRead: state.flags.admin_read === 'true',
    adminWrite: state.flags.admin_write === 'true',
    canWrite: state.flags.can_write !== 'false',
    accessManager: state.flags.access_manager === 'true',
  }),
  pgQuery: async (sql: string, params: unknown[] = []) => {
    const db = state.db!
    await db.exec('BEGIN;SET LOCAL ROLE personal_photos_app')
    try {
      for (const [k, v] of Object.entries({
        username: state.user,
        can_write: 'true',
        ...state.flags,
      }))
        await db.query('SELECT set_config($1,$2,true)', ['photos.' + k, v])
      return (await db.query(sql, params)).rows
    } finally {
      await db.exec('COMMIT')
    }
  },
}))
const fetchMock = vi.fn()
vi.mock('@/lib/snowflake', () => ({
  querySnowflake: vi.fn(),
  getSnowflakeBaseUrl: () => 'https://example.snowflakecomputing.com',
  getRestApiAuthHeader: () => 'Bearer test',
}))
const intentMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/search/search-intent', async (original) => ({
  ...(await original<typeof import('@/lib/search/search-intent')>()),
  interpretSearch: intentMock,
}))
import { search, searchOptions } from '@/lib/search'
import { namePhrases, parsePeople, redactNames } from '@/lib/people/people-search'

const DANA = '22222222-2222-4222-8222-222222222222'
const KEITH = '33333333-3333-4333-8333-333333333333'
const BOBS = '44444444-4444-4444-8444-444444444444'
const options = { query: '', limit: 50, eventId: null, semantic: false }
const ALICE_ALBUMS = [1, 2]
const ids = (r: { results: Record<string, unknown>[] }, key = 'photoId') =>
  r.results.map((x) => x[key]).sort()

beforeAll(async () => {
  state.db = await createSearchDatabase()
}, 60000)
afterAll(async () => state.db?.close())
beforeEach(() => {
  state.user = 'ALICE'
  state.flags = {}
  intentMock.mockReset()
  intentMock.mockImplementation(async (_query: string) => ({
    intent: {
      branches: [{ include: ['Keith Lambert', 'Dana'], exclude: [] }],
      keywords: '',
      excludedKeywords: [],
      fromYear: null,
      throughYear: null,
      clarification: null,
    },
    metrics: { mode: 'haiku', elapsedMs: 1, inputTokens: 10, outputTokens: 10 },
  }))
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(Response.json({ results: [] }))
  vi.stubGlobal('fetch', fetchMock)
})

describe('query parsing', () => {
  const visible = [
    { personId: DANA, name: 'Dana' },
    { personId: KEITH, name: 'Keith Lambert' },
  ]
  it('prefers the longest name and keeps the rest as keywords', () => {
    expect(parsePeople('Keith Lambert beach', visible)).toEqual({
      people: [{ personId: KEITH, name: 'Keith Lambert' }],
      remainder: 'beach',
    })
    expect(parsePeople('dana  and keith lambert', visible).people.map((p) => p.name)).toEqual([
      'Keith Lambert',
      'Dana',
    ])
  })
  it('treats identical full names as alternatives across library records', () => {
    const twins = [...visible, { personId: BOBS, name: 'Dana' }]
    expect(parsePeople('Dana beach', twins)).toEqual({
      people: [{ personId: DANA, name: 'Dana', personIds: [DANA, BOBS] }],
      remainder: 'beach',
    })
  })
  it('groups same-full-name records even when searching by first name', () => {
    const repeated = [visible[1], { personId: BOBS, name: 'Keith Lambert' }]
    expect(parsePeople('Keith at Zermatt', repeated)).toEqual({
      people: [{ ...visible[1], personIds: [KEITH, BOBS] }],
      remainder: 'at Zermatt',
    })
    expect(
      parsePeople('Keith at Zermatt', [...repeated, { personId: DANA, name: 'Keith Smith' }])
        .people[0].personIds,
    ).toEqual([KEITH, BOBS, DANA])
  })
  it('resolves all matching first names while a full name narrows the match', () => {
    expect(parsePeople('keith at Zermatt', visible)).toEqual({
      people: [visible[1]],
      remainder: 'at Zermatt',
    })
    const shared = [...visible, { personId: BOBS, name: 'Keith Smith' }]
    expect(parsePeople('Keith at Zermatt', shared).people).toEqual([
      { ...visible[1], name: 'Keith', personIds: [KEITH, BOBS] },
    ])
    expect(parsePeople('Keith Lambert at Zermatt', shared).people).toEqual([visible[1]])
    expect(parsePeople('Kev at Zermatt', visible).people).toEqual([])
    expect(redactNames('Keith at Zermatt', [visible[1]])).toBe('[person] at Zermatt')
  })
  it('includes long full names as candidates', () => {
    expect(namePhrases('a b c d')).toContain('a b c d')
  })
  it('redacts recognised names for activity logs', () => {
    expect(redactNames('Dana at the beach with keith lambert', visible)).toBe(
      '[person] at the beach with [person]',
    )
    expect(redactNames('Danaville trip', visible)).toBe('Danaville trip')
  })
})

describe('photo search by person', () => {
  it('requires both people in a natural-language together request', async () => {
    const result = await search(
      'photo',
      {
        ...options,
        query:
          'I want to see photos of Keith Lambert and Dana where they are together in the same photo',
      },
      ALICE_ALBUMS,
    )
    expect(result.source).toBe('people')
    expect(ids(result)).toEqual([1])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('finds settled matches only, never a caption that merely mentions the name', async () => {
    const result = await search('photo', { ...options, query: 'Dana' }, ALICE_ALBUMS)
    expect(result.source).toBe('people')
    expect(ids(result)).toEqual([1, 2])
    expect(result.people).toEqual([{ personId: DANA, name: 'Dana' }])
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('combines a name with keywords', async () => {
    expect(ids(await search('photo', { ...options, query: 'dana sunny' }, ALICE_ALBUMS))).toEqual([
      1,
    ])
  })
  it('combines a first name with photo location and preserves it when choosing a suggestion', async () => {
    await state.db!.exec("UPDATE photos SET city='Zermatt',country='Switzerland' WHERE photo_id=3")
    const result = await search('photo', { ...options, query: 'Keith at Zermatt' }, ALICE_ALBUMS)
    expect(ids(result)).toEqual([3])
    expect(result.people).toEqual([{ personId: KEITH, name: 'Keith Lambert' }])
    const suggestion = result.suggestions.find((p) => p.personId === KEITH)!
    expect(suggestion.query).toBe('at Zermatt')
    expect(
      ids(
        await search(
          'photo',
          { ...options, query: suggestion.query!, people: [KEITH] },
          ALICE_ALBUMS,
        ),
      ),
    ).toEqual([3])
    expect(intentMock).not.toHaveBeenCalled()
  })
  it('returns all people sharing a first name without requiring a choice', async () => {
    await state.db!.exec(`UPDATE face_people SET name='Keith Smith' WHERE person_id='${DANA}'`)
    fetchMock.mockImplementation(async () => Response.json({ results: [] }))
    try {
      const result = await search('photo', { ...options, query: 'Keith at Zermatt' }, ALICE_ALBUMS)
      expect(result.people[0].personIds?.sort()).toEqual([DANA, KEITH].sort())
      expect(ids(result)).toEqual([3])
      const broad = await search('photo', { ...options, query: 'Keith' }, ALICE_ALBUMS)
      expect(ids(broad)).toEqual([1, 2, 3])
      intentMock.mockResolvedValueOnce({
        intent: {
          branches: [{ include: ['Keith'], exclude: [] }],
          keywords: '',
          excludedKeywords: [],
          fromYear: null,
          throughYear: null,
          clarification: null,
        },
        metrics: { mode: 'haiku', elapsedMs: 1, inputTokens: 10, outputTokens: 10 },
      })
      const natural = await search('photo', { ...options, query: 'Show me Keith' }, ALICE_ALBUMS)
      expect(ids(natural)).toEqual([1, 2, 3])
      expect(natural).not.toHaveProperty('clarification')

      expect(
        ids(await search('photo', { ...options, query: 'Keith Lambert' }, ALICE_ALBUMS)),
      ).toEqual([1, 3])
      expect(result.suggestions.map((p) => p.personId).sort()).toEqual([DANA, KEITH].sort())
      expect(result.suggestions.every((p) => p.query === 'at Zermatt')).toBe(true)
    } finally {
      await state.db!.exec(`UPDATE face_people SET name='Dana' WHERE person_id='${DANA}'`)
    }
  })
  it('requires every named person in the photo', async () => {
    expect(
      ids(await search('photo', { ...options, query: 'Dana Keith Lambert' }, ALICE_ALBUMS)),
    ).toEqual([1])
  })
  it('accepts an explicit person filter and limits to an album', async () => {
    expect(ids(await search('photo', { ...options, people: [KEITH] }, ALICE_ALBUMS))).toEqual([
      1, 3,
    ])
    expect(
      ids(await search('photo', { ...options, people: [KEITH], eventId: 2 }, ALICE_ALBUMS)),
    ).toEqual([3])
  })
  it('excludes ignored faces', async () => {
    await state.db!.exec(`UPDATE faces SET ignored=true WHERE photo_id=2`)
    expect(ids(await search('photo', { ...options, query: 'Dana' }, ALICE_ALBUMS))).toEqual([1])
    await state.db!.exec(`UPDATE faces SET ignored=false WHERE photo_id=2`)
  })
  it('treats a hidden person as plain text', async () => {
    await state.db!.exec(`UPDATE face_people SET hidden=true WHERE person_id='${DANA}'`)
    fetchMock.mockImplementation(async () => Response.json({ results: [] }))
    const result = await search('photo', { ...options, query: 'Dana' }, ALICE_ALBUMS)
    expect(result.people).toEqual([])
    expect(ids(result)).toEqual([4])
    await state.db!.exec(`UPDATE face_people SET hidden=false WHERE person_id='${DANA}'`)
  })
  it('keeps plain keyword search unchanged when no name matches', async () => {
    const result = await search('photo', { ...options, query: 'snow' }, ALICE_ALBUMS)
    expect(result.source).toBe('postgres')
    expect(ids(result)).toEqual([3])
  })
})

describe('privacy', () => {
  it('never resolves another owner’s people', async () => {
    const result = await search('photo', { ...options, query: 'Dana' }, ALICE_ALBUMS)
    expect(result.people.map((p) => p.personId)).toEqual([DANA])
    await expect(
      search('photo', { ...options, people: [BOBS] }, ALICE_ALBUMS),
    ).rejects.toMatchObject({
      status: 404,
    })
  })
  it('gives a shared viewer nothing until the owner shares names, then only shared albums', async () => {
    state.user = 'CAROL'
    fetchMock.mockImplementation(async () => Response.json({ results: [] }))
    const firstName = await search('photo', { ...options, query: 'Keith at Zermatt' }, [1])
    expect(firstName.people).toEqual([])
    expect(firstName.suggestions).toEqual([])
    const hidden = await search('photo', { ...options, query: 'Dana' }, [1])
    expect(hidden.people).toEqual([])
    expect(hidden.suggestions).toEqual([])
    await state.db!.exec(`UPDATE face_settings SET share_names=true WHERE owner_username='ALICE'`)
    const shared = await search('photo', { ...options, query: 'Dana' }, [1])
    expect(ids(shared)).toEqual([1, 2])
    expect(shared.suggestions).toEqual([expect.objectContaining({ name: 'Dana', photoCount: 2 })])
    await state.db!.exec(`UPDATE face_settings SET share_names=false WHERE owner_username='ALICE'`)
  })
  it('gives public links no people results', async () => {
    state.user = ''
    fetchMock.mockImplementation(async () => Response.json({ results: [] }))
    const result = await search('photo', { ...options, query: 'Dana' }, [1])
    expect(result.people).toEqual([])
    expect(result.suggestions).toEqual([])
  })
})

describe('people suggestions and albums', () => {
  it('suggests people by partial name with counts limited to reachable albums', async () => {
    // A partial name is not a person filter, so photo results fall back to text search.
    fetchMock.mockImplementation(async () => Response.json({ results: [] }))
    const result = await search('photo', { ...options, query: 'dan' }, ALICE_ALBUMS)
    expect(result.suggestions).toEqual([
      expect.objectContaining({ personId: DANA, name: 'Dana', photoCount: 2 }),
    ])
    const leo = await search('photo', { ...options, query: 'lambert' }, ALICE_ALBUMS)
    expect(leo.suggestions.map((s) => s.name)).toEqual(['Keith Lambert'])
  })
  it('finds albums containing a person', async () => {
    const result = await search('event', { ...options, query: 'Keith Lambert' }, ALICE_ALBUMS)
    expect(ids(result, 'eventId')).toEqual([1, 2])
    expect(
      ids(await search('event', { ...options, query: 'Dana' }, ALICE_ALBUMS), 'eventId'),
    ).toEqual([1])
  })
})

describe('request parsing', () => {
  it('accepts repeated person ids and rejects malformed or excessive ones', () => {
    expect(
      searchOptions(new Request(`https://app/api/search?person=${DANA}&person=${DANA}`)).people,
    ).toEqual([DANA])
    expect(() => searchOptions(new Request('https://app/api/search?person=1 OR 1=1'))).toThrow()
    const many = Array.from({ length: 6 }, (_, i) => `person=${DANA.slice(0, -1)}${i}`).join('&')
    expect(() => searchOptions(new Request(`https://app/api/search?${many}`))).toThrow()
  })
})

it('searches separate same-name records across shared libraries without merging or widening access', async () => {
  const db = state.db!
  await db.exec(`INSERT INTO album_shares(event_id,username,created_by) VALUES(3,'ALICE','BOB');
    UPDATE face_settings SET share_names=true WHERE owner_username='BOB';`)
  try {
    const bothLibraries = await search('photo', { ...options, query: 'Dana' }, [1, 2, 3])
    expect(ids(bothLibraries)).toEqual([1, 2, 5])
    expect(bothLibraries.people[0].personIds?.sort()).toEqual([DANA, BOBS].sort())
    expect(bothLibraries.suggestions).toHaveLength(1)
    expect(bothLibraries.suggestions[0].photoCount).toBe(3)
    const selected = await search('photo', { ...options, query: '', people: [BOBS] }, [1, 2, 3])
    expect(ids(selected)).toEqual([1, 2, 5])
    const duplicateSelections = await search(
      'photo',
      { ...options, query: '', people: [DANA, BOBS] },
      [1, 2, 3],
    )
    expect(duplicateSelections.people).toHaveLength(1)
    expect(ids(duplicateSelections)).toEqual([1, 2, 5])
    const together = await search(
      'photo',
      {
        ...options,
        query:
          'I want to see photos of Keith Lambert and Dana where they are together in the same photo',
      },
      [1, 2, 3],
    )
    expect(ids(together)).toEqual([1])
    expect(ids(await search('photo', { ...options, query: 'Dana' }, [1, 2]))).toEqual([1, 2])
    await db.exec("UPDATE face_settings SET share_names=false WHERE owner_username='BOB'")
    expect(ids(await search('photo', { ...options, query: 'Dana' }, [1, 2, 3]))).toEqual([1, 2])
    const records = await db.query(
      'SELECT person_id FROM face_people WHERE person_id=ANY($1::uuid[])',
      [[DANA, BOBS]],
    )
    expect(records.rows).toHaveLength(2)
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    await db.exec(
      "DELETE FROM album_shares WHERE event_id=3 AND username='ALICE'; UPDATE face_settings SET share_names=false WHERE owner_username='BOB'",
    )
  }
})

it.each([false, true])(
  'handles same-photo wording without together (semantic=%s)',
  async (semantic) => {
    const result = await search(
      'photo',
      {
        ...options,
        semantic,
        query: 'Show me photos of Keith lambert and Dana where they are in the same photo',
      },
      ALICE_ALBUMS,
    )
    expect(result.source).toBe('people')
    expect(ids(result)).toEqual([1])
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

it('uses no LLM for basic names, conjunctions and keyword searches', async () => {
  await search('photo', { ...options, query: 'Dana and Keith Lambert' }, ALICE_ALBUMS)
  await search('photo', { ...options, query: 'Dana sunny' }, ALICE_ALBUMS)
  await search('photo', { ...options, query: 'beach' }, ALICE_ALBUMS)
  expect(intentMock).not.toHaveBeenCalled()
})
it('enforces interpreted OR and exclusion filters with database permissions', async () => {
  intentMock.mockResolvedValueOnce({
    intent: {
      branches: [
        { include: ['Dana'], exclude: ['Keith Lambert'] },
        { include: ['Keith Lambert'], exclude: ['Dana'] },
      ],
      keywords: '',
      excludedKeywords: [],
      fromYear: null,
      throughYear: null,
      clarification: null,
    },
    metrics: { mode: 'haiku', elapsedMs: 3, inputTokens: 20, outputTokens: 10 },
  })
  const result = await search(
    'photo',
    { ...options, query: 'Either Dana or Keith Lambert but not both' },
    ALICE_ALBUMS,
  )
  expect(ids(result)).toEqual([2, 3])
  expect(fetchMock).not.toHaveBeenCalled()
})
it('never falls back to unrelated results for inaccessible interpreted people', async () => {
  intentMock.mockResolvedValueOnce({
    intent: {
      branches: [{ include: ['Private Stranger'], exclude: [] }],
      keywords: '',
      excludedKeywords: [],
      fromYear: null,
      throughYear: null,
      clarification: null,
    },
    metrics: {},
  })
  const result = await search(
    'photo',
    { ...options, query: 'Find a picture of Private Stranger without Dana' },
    ALICE_ALBUMS,
  )
  expect(result.results).toEqual([])
  expect('clarification' in result).toBe(true)
  expect(fetchMock).not.toHaveBeenCalled()
})

it('applies interpreted date and scene constraints to the same photo', async () => {
  intentMock.mockResolvedValueOnce({
    intent: {
      branches: [{ include: ['Dana'], exclude: [] }],
      keywords: 'beach',
      excludedKeywords: ['dinner'],
      fromYear: 2024,
      throughYear: 2024,
      clarification: null,
    },
    metrics: {},
  })
  const result = await search(
    'photo',
    { ...options, query: 'Find Dana at the beach in 2024 but not dinner' },
    ALICE_ALBUMS,
  )
  expect(ids(result)).toEqual([1])
})
it('retains face constraints when a scene search falls back to semantics', async () => {
  intentMock.mockResolvedValueOnce({
    intent: {
      branches: [{ include: ['Dana'], exclude: [] }],
      keywords: 'unusual scenery',
      excludedKeywords: [],
      fromYear: null,
      throughYear: null,
      clarification: null,
    },
    metrics: {},
  })
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ results: [{ PHOTO_ID: 1 }, { PHOTO_ID: 4 }, { PHOTO_ID: 5 }] }),
  })
  const result = await search(
    'photo',
    { ...options, query: 'Find Dana surrounded by unusual scenery' },
    ALICE_ALBUMS,
  )
  expect(ids(result)).toEqual([1])
})

it('handles same-photo instructions locally even when conversational words happen to match a photo', async () => {
  const saved = await state.db!.query<{ v: string }>(
    'SELECT search_vector::text AS v FROM photos WHERE photo_id=1',
  )
  await state.db!.query(
    "UPDATE photos SET search_vector=to_tsvector('english',$1) WHERE photo_id=1",
    ['Show me photos of where they are in the same photo'],
  )
  try {
    const result = await search(
      'photo',
      {
        ...options,
        query: 'Show me photos of Keith Lambert and Dana where they are in the same photo',
      },
      ALICE_ALBUMS,
    )
    expect(intentMock).not.toHaveBeenCalled()
    expect(ids(result)).toEqual([1])
  } finally {
    await state.db!.query('UPDATE photos SET search_vector=$1::tsvector WHERE photo_id=1', [
      saved.rows[0].v,
    ])
  }
})

it('retrieves within the eligible people before top-K and preserves semantic order', async () => {
  fetchMock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body)
    expect(body.filter['@and'][1]['@or']).toEqual(
      expect.arrayContaining([
        { '@primarykey': { PHOTO_ID: '1' } },
        { '@primarykey': { PHOTO_ID: '3' } },
      ]),
    )
    return Response.json({ results: [{ PHOTO_ID: 3 }, { PHOTO_ID: 1 }, { PHOTO_ID: 5 }] })
  })
  const result = await search(
    'photo',
    { ...options, query: 'show me photos where Keith is eating at a restaurant' },
    ALICE_ALBUMS,
  )
  expect(result.results.map((p) => p.photoId)).toEqual([3, 1])
  expect(intentMock).not.toHaveBeenCalled()
})

it('semantic candidates supplement nonzero literal matches', async () => {
  fetchMock.mockResolvedValue(Response.json({ results: [{ PHOTO_ID: 2 }, { PHOTO_ID: 1 }] }))
  const result = await search('photo', { ...options, query: 'Dana sunny' }, ALICE_ALBUMS)
  expect(ids(result)).toEqual([1, 2])
})

it('pages a saved exact person search without another model call and rejects stale cursors', async () => {
  const { pagedSearch } = await import('@/lib/search/search-session')
  const first = await pagedSearch(
    'photo',
    new Request('https://app/api/search?q=Dana&limit=1'),
    ALICE_ALBUMS,
  )
  expect(first.results).toHaveLength(1)
  expect(first.nextCursor).toBeTruthy()
  expect(first.candidateCount).toBe(2)
  const second = await pagedSearch(
    'photo',
    new Request(`https://app/api/search?cursor=${first.nextCursor}&limit=1`),
    ALICE_ALBUMS,
  )
  expect(second.results).toHaveLength(1)
  expect(second.results[0].photoId).not.toBe(first.results[0].photoId)
  expect(intentMock).not.toHaveBeenCalled()
  state.user = 'BOB'
  await expect(
    pagedSearch('photo', new Request(`https://app/api/search?cursor=${first.nextCursor}`), [3]),
  ).rejects.toMatchObject({ status: 409 })
  state.user = 'ALICE'
  await state.db!.exec(
    "UPDATE face_settings SET share_names=NOT share_names WHERE owner_username='ALICE'",
  )
  await expect(
    pagedSearch(
      'photo',
      new Request(`https://app/api/search?cursor=${first.nextCursor}`),
      ALICE_ALBUMS,
    ),
  ).rejects.toMatchObject({ status: 409 })
})

it('queues new originals without running a job and fences enrichment after replacement', async () => {
  const db = state.db!
  const before = await db.query<{ revision: string }>(
    'SELECT revision FROM search_enrichment WHERE photo_id=1',
  )
  await db.exec("UPDATE photos SET original_stage_path='o/replaced' WHERE photo_id=1")
  const after = await db.query<{ revision: string; status: string }>(
    'SELECT revision,status FROM search_enrichment WHERE photo_id=1',
  )
  expect(after.rows[0].revision).not.toBe(before.rows[0].revision)
  expect(after.rows[0].status).toBe('queued')
  const runs = await db.query('SELECT * FROM search_batch_runs')
  expect(runs.rows).toHaveLength(0)
  await db.exec("UPDATE photos SET original_stage_path='o/1' WHERE photo_id=1")
})

it('enforces date constraints before retrieval and retains scene ranking', async () => {
  const result = await search('photo', { ...options, query: 'Keith in 2025' }, ALICE_ALBUMS)
  expect(ids(result)).toEqual([3])
  expect(intentMock).not.toHaveBeenCalled()
})

it('applies explicit GPS distance as a hard constraint', async () => {
  await state.db!.exec('UPDATE photos SET latitude=40,longitude=-73 WHERE photo_id=1')
  const result = await search(
    'photo',
    { ...options, query: 'Dana within 10 km of 40, -73' },
    ALICE_ALBUMS,
  )
  expect(ids(result)).toEqual([1])
  expect(intentMock).not.toHaveBeenCalled()
})

it('recognizes punctuated names without leaking them to activity text', () => {
  const visible = [{ personId: KEITH, name: 'Keith Lambert' }]
  const parsed = parsePeople('Keith, eating at a restaurant', visible)
  expect(parsed.people).toEqual(visible)
  expect(redactNames('Keith, eating at a restaurant', parsed.people)).not.toContain('Keith')
  expect(
    parsePeople('Jean Claude Van Damme eating', [{ personId: DANA, name: 'Jean Claude Van Damme' }])
      .people,
  ).toHaveLength(1)
})

it('does not invalidate saved rankings for zero-row or bookkeeping updates', async () => {
  const db = state.db!
  const version = async () =>
    String(
      (await db.query<{ revision: string }>('SELECT revision FROM search_catalog_revision')).rows[0]
        .revision,
    )
  const before = await version()
  await db.exec(
    'UPDATE photos SET updated_at=now() WHERE photo_id=-1; UPDATE photos SET search_synced_at=now() WHERE photo_id=1; UPDATE face_settings SET enabled=enabled;',
  )
  expect(await version()).toBe(before)
  await db.exec("UPDATE photos SET caption='New searchable caption' WHERE photo_id=1")
  expect(await version()).not.toBe(before)
})

it('keeps simple exclusions local after a catalog edit', async () => {
  const { pagedSearch } = await import('@/lib/search/search-session')
  intentMock.mockResolvedValue({
    intent: {
      branches: [{ include: ['Keith'], exclude: ['Dana'] }],
      keywords: '',
      excludedKeywords: [],
      fromYear: null,
      throughYear: null,
      clarification: null,
    },
    metrics: { mode: 'haiku', elapsedMs: 1, inputTokens: 10, outputTokens: 10 },
  })
  const request = () => new Request('https://app/api/search?q=Keith%20without%20Dana')
  const first = await pagedSearch('photo', request(), ALICE_ALBUMS)
  expect(ids(first)).toEqual([3])
  await state.db!.exec("UPDATE photos SET caption='Fresh search information' WHERE photo_id=3")
  const next = await pagedSearch('photo', request(), ALICE_ALBUMS)
  expect(ids(next)).toEqual([3])
  expect(intentMock).not.toHaveBeenCalled()
})

it('protects exact evidence through SQL retrieval, live RLS, and saved batch pagination', async () => {
  const db = state.db!
  const { pagedSearch } = await import('@/lib/search/search-session')
  await db.exec(`INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path,ai_description,search_vector) VALUES
    (901,1,'six.jpg','photo','READY','six','A motocross rider numbered 6.',to_tsvector('english','motocross rider number 6')),
    (902,1,'other.jpg','photo','READY','other','A motocross rider numbered 57.',to_tsvector('english','motocross rider number 57')),
    (903,1,'unknown.jpg','photo','READY','unknown','A motocross rider jumps.',to_tsvector('english','motocross rider jumps')),
    (904,3,'private.jpg','photo','READY','private','A motocross rider numbered 6.',to_tsvector('english','motocross rider number 6'))`)
  try {
    fetchMock.mockImplementation(async () =>
      Response.json({ results: [{ PHOTO_ID: 902 }, { PHOTO_ID: 904 }, { PHOTO_ID: 903 }] }),
    )
    const query = 'motocross rider number 6'
    const found = await search('photo', { ...options, query, semantic: true }, ALICE_ALBUMS)
    expect(found.results.map((r) => r.photoId)).toEqual([901])
    expect(intentMock).not.toHaveBeenCalled()
    const request = () =>
      new Request('https://app/api/search?q=' + encodeURIComponent(query) + '&limit=1')
    await pagedSearch('photo', request(), ALICE_ALBUMS)
    await db.query(
      "UPDATE search_sessions SET reranked_ids=ARRAY[904,902,903,901],rerank_status='completed' WHERE query=$1",
      [query],
    )
    vi.stubEnv('SEARCH_BATCH_RANKING_ENABLED', 'true')
    const first = await pagedSearch('photo', request(), ALICE_ALBUMS)
    expect(first.results.map((r) => r.photoId)).toEqual([901])
    expect(first.nextCursor).toBeNull()
    expect(first.candidateCount).toBe(1)
  } finally {
    vi.unstubAllEnvs()
    await db.exec('DELETE FROM photos WHERE photo_id BETWEEN 901 AND 904')
  }
})

it('paginates every exact person match beyond 1000 without model calls', async () => {
  const db = state.db!
  const { pagedSearch } = await import('@/lib/search/search-session')
  await db.exec(`INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path)
    SELECT i,1,i||'.jpg','photo','READY','o/'||i FROM generate_series(2000,3004) i;
    WITH f AS (INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding)
    SELECT i,'ALICE','detected','o/'||i,'m',0,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]' FROM generate_series(2000,3004) i RETURNING face_id)
    INSERT INTO face_assignments(face_id,person_id,owner_username,status) SELECT face_id,'${KEITH}','ALICE','confirmed' FROM f;`)
  try {
    const collected: number[] = []
    let cursor: string | null = null
    let count = 0
    do {
      const result = await pagedSearch(
        'photo',
        new Request(
          'https://app/api/search?q=Keith&limit=100' + (cursor ? '&cursor=' + cursor : ''),
        ),
        ALICE_ALBUMS,
      )
      collected.push(...result.results.map((p) => Number(p.photoId)))
      cursor = result.nextCursor
      count++
      expect(result.candidateCount).toBe(collected.length + (cursor ? 1 : 0))
      expect(result.countIsExact).toBe(!cursor)
      expect(result.results.length).toBeLessThanOrEqual(100)
    } while (cursor && count < 20)
    expect(cursor).toBeNull()
    expect(new Set(collected).size).toBe(1007)
    const stored = await db.query<{ n: number }>(
      "SELECT cardinality(candidate_ids) AS n FROM search_sessions WHERE query='Keith' AND payload->>'exactPaging'='true'",
    )
    expect(stored.rows.length).toBeGreaterThan(0)
    expect(stored.rows.every((row) => row.n <= 100)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(intentMock).not.toHaveBeenCalled()
  } finally {
    await db.exec('DELETE FROM photos WHERE photo_id BETWEEN 2000 AND 3004')
  }
})
it.each(['Keith without Dana', 'Keith excluding Dana', 'Keith but not Dana'])(
  'enforces %s without an LLM, even when interpretation is disabled',
  async (query) => {
    const result = await search(
      'photo',
      { ...options, query, interpretationAllowed: false },
      ALICE_ALBUMS,
    )
    expect(ids(result)).toEqual([3])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(intentMock).not.toHaveBeenCalled()
  },
)
it('does not invent a precise capture date from an album year', async () => {
  const result = await search(
    'photo',
    { ...options, query: 'photos on September 1 2026', interpretationAllowed: false },
    ALICE_ALBUMS,
  )
  expect(result.results).toEqual([])
  expect(fetchMock).not.toHaveBeenCalled()
  expect(intentMock).not.toHaveBeenCalled()
})
it('puts photo evidence ahead of an incidental album subject', async () => {
  const db = state.db!
  await db.exec(`INSERT INTO photos(photo_id,event_id,source_filename,media_type,ingest_status,original_stage_path,ai_description)
    VALUES(910,1,'dessert.jpg','photo','READY','o/910','A plate of cake inside a dining room')`)
  try {
    fetchMock.mockResolvedValue(
      Response.json({ results: [{ PHOTO_ID: 910 }, { PHOTO_ID: 1 }, { PHOTO_ID: 2 }] }),
    )
    const result = await search(
      'photo',
      { ...options, query: 'beach in 2024', semantic: true },
      ALICE_ALBUMS,
    )
    expect(result.results[0].photoId).toBe(1)
    expect(result.results.findIndex((p) => p.photoId === 910)).toBeGreaterThan(
      result.results.findIndex((p) => p.photoId === 2),
    )
  } finally {
    await db.exec('DELETE FROM photos WHERE photo_id=910')
  }
})

it('keeps weak-result fallback separate in the cache and preserves current access rules', async () => {
  const { pagedSearch } = await import('@/lib/search/search-session')
  fetchMock.mockImplementation(async () =>
    Response.json({
      results: [1, 2, 3, 5].map((PHOTO_ID) => ({
        PHOTO_ID,
        '@scores': { reranker_score: -11, text_match: 0 },
      })),
    }),
  )
  const url = 'https://app/api/search?q=unicorns%20on%20Mars&mode=semantic'
  const defaultResult = await pagedSearch('photo', new Request(url), ALICE_ALBUMS)
  expect(defaultResult.results).toEqual([])
  expect(defaultResult).toMatchObject({ relatedAvailable: true, candidateCount: 0 })
  const related = await pagedSearch(
    'photo',
    new Request(url + '&related=true&limit=1'),
    ALICE_ALBUMS,
  )
  expect(related.candidateCount).toBe(3)
  expect(related.results[0].photoId).not.toBe(5)
  expect(related.nextCursor).not.toBeNull()
  const next = await pagedSearch(
    'photo',
    new Request('https://app/api/search?cursor=' + related.nextCursor + '&limit=10'),
    ALICE_ALBUMS,
  )
  expect(next.results.every((p) => p.photoId !== 5)).toBe(true)
  const again = await pagedSearch('photo', new Request(url), ALICE_ALBUMS)
  expect(again.results).toEqual([])
  expect(intentMock).not.toHaveBeenCalled()
})

it('reads compact ranking metadata without returning stored OCR or description text', async () => {
  const { savedSearchColumns } = await import('@/lib/search/search-session')
  const { guardedBatchOrder } = await import('@/lib/search/search-evidence')
  const documents = [
    {
      id: 1,
      evidenceTier: 3,
      retrievalTier: 1,
      formatVersion: 2,
      text: 'Private OCR '.repeat(10000),
    },
    {
      id: 2,
      evidenceTier: 1,
      retrievalTier: 0,
      formatVersion: 2,
      text: 'Description '.repeat(10000),
    },
  ]
  const read = async (enabled: boolean, reranked: number[] | null) => {
    const result = await state.db!.query<{ documents: typeof documents }>(
      `SELECT ${savedSearchColumns(enabled)} FROM (SELECT
        'saved' AS id, now() AS last_used_at, '1' AS scope_revision, '{}'::jsonb AS options,
        ARRAY[1,2] AS candidate_ids, $1::int[] AS reranked_ids,
        '{}'::jsonb AS payload, $2::jsonb AS documents) s`,
      [reranked, JSON.stringify(documents)],
    )
    return result.rows[0].documents
  }
  expect(await read(false, [2, 1])).toEqual([])
  expect(await read(true, null)).toEqual([])
  const compact = await read(true, [2, 1])
  expect(compact).toEqual(documents.map(({ text: _, ...metadata }) => metadata))
  expect(JSON.stringify(compact).length).toBeLessThan(200)
  expect(guardedBatchOrder([1, 2], [2, 1], compact)).toEqual(
    guardedBatchOrder([1, 2], [2, 1], documents),
  )
})

it('isolates album generations, batches increments, and invalidates shared viewers after activation', async () => {
  const db = state.db!
  // Exercise activation in a rollback-only transaction: legacy tests retain their baseline.
  await db.exec('BEGIN')
  try {
    for (const table of [
      'photos',
      'events',
      'faces',
      'face_assignments',
      'face_people',
      'face_settings',
      'album_shares',
      'users',
      'gallery_main_admins',
    ])
      await db.exec(`DROP TRIGGER invalidate_saved_search ON ${table}`)
    const revision = async (albums: number[], user = 'ALICE') =>
      (
        await db.query<{ v: string }>('SELECT search_scope_revision($1::int[],$2) v', [
          albums,
          user,
        ])
      ).rows[0].v
    const untouched = await revision([3], 'BOB')
    const own = await revision([1, 2])
    const shared = await revision([1], 'CAROL')
    const global = (await db.query('SELECT revision FROM search_catalog_revision')).rows
    const counter = async () =>
      (
        await db.query<{ revision: number }>(
          "SELECT revision::int FROM search_scope_revisions WHERE scope='album:1'",
        )
      ).rows[0]?.revision ?? 0
    const before = await counter()
    await db.exec("UPDATE photos SET caption=coalesce(caption,'')||' changed' WHERE event_id=1")
    expect(await counter()).toBe(before + 1)
    expect(await revision([3], 'BOB')).toBe(untouched)
    expect(await revision([1, 2])).not.toBe(own)
    expect(await revision([1], 'CAROL')).not.toBe(shared)
    expect((await db.query('SELECT revision FROM search_catalog_revision')).rows).toEqual(global)
    const current = await revision([1, 2])
    await db.exec(
      'UPDATE photos SET updated_at=now(),search_synced_at=now(),ai_attempts=ai_attempts+1 WHERE event_id=1',
    )
    expect(await revision([1, 2])).toBe(current)
    await db.exec(
      "SET LOCAL ROLE personal_photos_app; SELECT set_config('photos.username','CAROL',true)",
    )
    expect(
      (await db.query("SELECT scope FROM search_scope_revisions WHERE scope='album:3'")).rows,
    ).toEqual([])
    const authorized = await revision([1], 'CAROL')
    await db.exec(
      "RESET ROLE; DELETE FROM album_shares WHERE event_id=1 AND username='CAROL'; SET LOCAL ROLE personal_photos_app",
    )
    expect(await revision([1], 'CAROL')).not.toBe(authorized)
    expect((await db.query('SELECT photo_id FROM photos WHERE event_id=1')).rows).toEqual([])
  } finally {
    await db.exec('ROLLBACK')
  }
})

it('defers exact-result hydration without truncating the matches or bypassing RLS', async () => {
  state.user = 'ALICE'
  const deferred = await search(
    'photo',
    { ...options, query: 'Dana', limit: 1, deferExactHydration: true },
    ALICE_ALBUMS,
  )
  const full = await search('photo', { ...options, query: 'Dana', limit: 1 }, ALICE_ALBUMS)
  expect(ids(deferred)).toEqual(ids(full))
  expect(deferred.results.length).toBeGreaterThan(1)
  expect(deferred.results.every((p) => !('aiDescription' in p) && !('displayUrl' in p))).toBe(true)
  expect(deferred.results.every((p) => ALICE_ALBUMS.includes(Number(p.eventId)))).toBe(true)
})

it('rebuilds cached exact searches for a different page size and retains interpreted filters', async () => {
  const { pagedSearch } = await import('@/lib/search/search-session')
  const url = 'https://app/api/search?q=' + encodeURIComponent('Dana or Keith')
  const intent = {
    branches: [
      { include: ['Dana'], exclude: [] },
      { include: ['Keith Lambert'], exclude: [] },
    ],
    keywords: '',
    excludedKeywords: [],
    fromYear: null,
    throughYear: null,
    clarification: null,
  }
  intentMock.mockResolvedValue({ intent, metrics: { mode: 'haiku' } })
  const first = await pagedSearch('photo', new Request(url + '&limit=1'), ALICE_ALBUMS)
  expect(first.results).toHaveLength(1)
  expect(first.nextCursor).toMatch(/^x:/)
  const second = await pagedSearch(
    'photo',
    new Request('https://app/api/search?limit=1&cursor=' + first.nextCursor),
    ALICE_ALBUMS,
  )
  expect(second.results).toHaveLength(1)
  expect(second.results[0].photoId).not.toBe(first.results[0].photoId)
  const larger = await pagedSearch('photo', new Request(url + '&limit=100'), ALICE_ALBUMS)
  expect(larger.results.length).toBeGreaterThan(1)
  expect(larger.nextCursor).toBeNull()
  expect(larger.countIsExact).toBe(true)
  expect(intentMock).toHaveBeenCalledTimes(1)
  expect(fetchMock).not.toHaveBeenCalled()
})

it('preserves microseconds, tied dates and nulls across exact photo and album pages', async () => {
  const db = state.db!
  const { pagedSearch } = await import('@/lib/search/search-session')
  try {
    for (const date of [
      "'2026-01-01 00:00:00.123457+00'::timestamptz",
      "'2026-01-01 00:00:00.123456+00'::timestamptz",
      'NULL',
    ]) {
      await db.exec(`UPDATE photos SET date_taken=CASE WHEN photo_id=1
        THEN '2026-01-01 00:00:00.123456+00'::timestamptz ELSE ${date} END
        WHERE photo_id IN (1,3)`)
      for (const kind of ['photo', 'event'] as const) {
        const collected: number[] = []
        let cursor: string | null = null
        do {
          const result = await pagedSearch(
            kind,
            new Request(
              'https://app/api/search?limit=1&person=' +
                KEITH +
                (cursor ? '&cursor=' + cursor : ''),
            ),
            ALICE_ALBUMS,
          )
          collected.push(
            ...result.results.map((row) => Number(row[kind === 'photo' ? 'photoId' : 'eventId'])),
          )
          cursor = result.nextCursor
        } while (cursor && collected.length < 10)
        expect(cursor).toBeNull()
        const expected = kind === 'photo' ? [3, 1] : [2, 1]
        expect(collected).toEqual(date === 'NULL' ? expected.reverse() : expected)
      }
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(intentMock).not.toHaveBeenCalled()
  } finally {
    await db.exec('UPDATE photos SET date_taken=NULL WHERE photo_id IN (1,3)')
  }
})

it('pages owner name options without whole-library counts and rechecks visibility', async () => {
  const db = state.db!
  const { peopleOptions } = await import('@/lib/people/people-options')
  await db.exec(`INSERT INTO face_people(person_id,owner_username,name)
    SELECT md5('picker-'||i)::uuid,'ALICE','Picker '||lpad(i::text,3,'0') FROM generate_series(1,65) i;
    WITH f AS (INSERT INTO faces(photo_id,owner_username,source,source_path,model_version,face_index,box_x,box_y,box_w,box_h,detection_score,quality,quality_ok,embedding)
    SELECT 1,'ALICE','detected','o/1','picker',i,0.1,0.1,0.2,0.2,0.9,0.9,true,'[1,0]' FROM generate_series(1,65) i RETURNING face_id,face_index)
    INSERT INTO face_assignments(face_id,person_id,owner_username,status)
    SELECT face_id,md5('picker-'||face_index)::uuid,'ALICE','confirmed' FROM f;`)
  try {
    const first = await peopleOptions('Picker')
    expect(first.people).toHaveLength(50)
    expect(first.people[0].name).toBe('Picker 001')
    expect(first.people.at(-1)?.name).toBe('Picker 050')
    expect(first.nextCursor).toBeTruthy()
    expect(first.people.every((p) => Object.keys(p).sort().join(',') === 'name,personId')).toBe(
      true,
    )
    const detailed = await peopleOptions('Picker', undefined, true)
    expect(detailed.people).toHaveLength(50)
    expect(detailed.people.map((p) => p.personId)).toEqual(first.people.map((p) => p.personId))
    expect(detailed.people.every((p) => p.photoCount === 1 && p.coverFaceId === null)).toBe(true)
    expect(detailed.nextCursor).toBe(first.nextCursor)
    await db.exec(
      `UPDATE face_people p SET cover_face_id=(SELECT a.face_id FROM face_assignments a WHERE a.person_id=p.person_id LIMIT 1) WHERE p.name='Picker 001'`,
    )
    const withCover = await peopleOptions('Picker 001', undefined, true)
    expect(typeof withCover.people[0].coverFaceId).toBe('number')
    expect(Number.isSafeInteger(withCover.people[0].coverFaceId)).toBe(true)
    await db.exec("UPDATE face_people SET hidden=true WHERE name='Picker 051'")
    const next = await peopleOptions('picker', first.nextCursor)
    expect(next.people).toHaveLength(14)
    expect(next.people[0].name).toBe('Picker 052')
    expect(next.nextCursor).toBeNull()
    await expect(peopleOptions('Dana', first.nextCursor)).rejects.toThrow(
      'Invalid face page cursor',
    )
    expect((await peopleOptions('%')).people).toEqual([])
    state.user = 'BOB'
    expect((await peopleOptions('picker', first.nextCursor)).people).toEqual([])
    expect((await peopleOptions('picker', undefined, true)).people).toEqual([])
    state.user = 'CAROL'
    expect((await peopleOptions('picker')).people).toEqual([])
    state.user = 'ALICE'
    await db.exec("UPDATE faces SET ignored=true WHERE model_version='picker'")
    expect((await peopleOptions('picker')).people).toEqual([])
  } finally {
    state.user = 'ALICE'
    await db.exec(
      "DELETE FROM face_people WHERE name LIKE 'Picker %';DELETE FROM faces WHERE model_version='picker'",
    )
  }
})

it('invalidates scoped search for person corrections and album transfers without touching unrelated owners', async () => {
  const db = state.db!
  await db.exec('BEGIN')
  try {
    for (const table of [
      'photos',
      'events',
      'faces',
      'face_assignments',
      'face_people',
      'face_settings',
      'album_shares',
      'users',
      'gallery_main_admins',
    ])
      await db.exec(`DROP TRIGGER invalidate_saved_search ON ${table}`)
    const revision = async (albums: number[], viewer: string) =>
      (
        await db.query<{ v: string }>('SELECT search_scope_revision($1::int[],$2) v', [
          albums,
          viewer,
        ])
      ).rows[0].v
    const unrelated = await revision([3], 'BOB')
    for (const sql of [
      `UPDATE face_people SET name='Dana revised' WHERE person_id='${DANA}'`,
      `UPDATE face_people SET hidden=true WHERE person_id='${DANA}'`,
      `UPDATE faces SET ignored=true WHERE photo_id=1`,
      `UPDATE face_settings SET share_names=NOT share_names WHERE owner_username='ALICE'`,
    ]) {
      const own = await revision([1, 2], 'ALICE')
      const shared = await revision([1], 'CAROL')
      await db.exec(sql)
      expect(await revision([1, 2], 'ALICE')).not.toBe(own)
      expect(await revision([1], 'CAROL')).not.toBe(shared)
      expect(await revision([3], 'BOB')).toBe(unrelated)
    }
    const beforeTransfer = await revision([2], 'ALICE')
    const unaffectedAlbum = await revision([1], 'CAROL')
    await db.exec("UPDATE events SET owner_username='BOB' WHERE event_id=2")
    expect(await revision([2], 'ALICE')).not.toBe(beforeTransfer)
    expect(await revision([1], 'CAROL')).toBe(unaffectedAlbum)
    await db.exec(
      "SET LOCAL ROLE personal_photos_app; SELECT set_config('photos.username','ALICE',true)",
    )
    expect((await db.query('SELECT photo_id FROM photos WHERE event_id=2')).rows).toEqual([])
    await db.exec("SELECT set_config('photos.username','BOB',true)")
    expect((await db.query('SELECT photo_id FROM photos WHERE event_id=2')).rows).toHaveLength(2)
  } finally {
    await db.exec('ROLLBACK')
  }
})

it('keeps SQL-filtered visual candidates equivalent to ID eligibility under live RLS', async () => {
  const { visualSearchQuery } = await import('@/lib/search/visual-search-query')
  const db = state.db!
  const vector = [1, ...Array(511).fill(0)]
  await db.exec('BEGIN')
  try {
    await db.query(
      "UPDATE search_enrichment SET status='completed',model_version='clip-b32@3d74acf9+ocr-tesseract5',visual_embedding=$1::vector",
      [JSON.stringify(vector)],
    )
    await db.exec(
      "SET LOCAL ROLE personal_photos_app; SELECT set_config('photos.username','ALICE',true)",
    )
    const run = async (selection?: import('@/lib/search/search-eligibility').SearchEligibility) => {
      const q = visualSearchQuery(
        vector,
        [1, 2, 3],
        selection ? undefined : [1, 2, 5],
        50,
        selection,
      )
      return (await db.query<{ photoId: number }>(q.sql, q.params)).rows.map((row) => row.photoId)
    }
    const filter = {
      where: 'p.event_id=ANY($1::int[]) AND p.photo_id=ANY($2::int[])',
      params: [
        [1, 2, 3],
        [1, 2, 5],
      ],
    }
    expect(await run(filter)).toEqual(await run())
    expect(await run(filter)).toEqual([1, 2])
    await db.exec("SELECT set_config('photos.username','BOB',true)")
    expect(await run(filter)).toEqual([5])
    await db.exec("SELECT set_config('photos.username','CAROL',true)")
    expect(await run(filter)).toEqual([1, 2])
    await db.exec('RESET ROLE; DELETE FROM album_shares WHERE event_id=1')
    await db.exec(
      "SET LOCAL ROLE personal_photos_app; SELECT set_config('photos.username','CAROL',true)",
    )
    expect(await run(filter)).toEqual([])
    await db.exec("SELECT set_config('photos.username','ALICE',true)")
    expect(
      await run({
        where: filter.where + ' AND e.event_year=$3::int',
        params: [...filter.params, 2025],
      }),
    ).toEqual([])
    await db.exec("RESET ROLE; UPDATE search_enrichment SET source_path='stale' WHERE photo_id=1")
    await db.exec(
      "SET LOCAL ROLE personal_photos_app; SELECT set_config('photos.username','ALICE',true)",
    )
    expect(await run(filter)).toEqual([2])
  } finally {
    await db.exec('ROLLBACK')
  }
})

it('preserves album retrieval order and live access while resolving constrained semantic photo IDs', async () => {
  fetchMock.mockResolvedValue(
    Response.json({
      results: [{ PHOTO_ID: 3 }, { PHOTO_ID: 1 }, { PHOTO_ID: 5 }, { PHOTO_ID: 3 }],
    }),
  )
  const result = await search(
    'event',
    { ...options, query: 'Keith eating at a restaurant' },
    ALICE_ALBUMS,
  )
  expect(result.results.map((row) => row.eventId)).toEqual([2, 1])
  expect(result.results.every((row) => !('aiDescription' in row))).toBe(true)
})

it('applies place, capture season and face to the same photo across search modes and albums', async () => {
  const db = state.db!
  const { pagedSearch } = await import('@/lib/search/search-session')
  const prior = await db.query<{
    photo_id: number
    city: string | null
    date_taken: string | null
    latitude: number | null
  }>('SELECT photo_id,city,date_taken,latitude FROM photos WHERE photo_id BETWEEN 1 AND 5')
  try {
    await db.exec(`UPDATE photos SET city=CASE photo_id WHEN 2 THEN 'Las Vegas' WHEN 4 THEN 'Sydney' ELSE 'Paris' END,
      date_taken=CASE photo_id WHEN 3 THEN '2024-03-12' WHEN 4 THEN '2024-01-05' ELSE '2024-07-08' END::date,
      latitude=CASE WHEN photo_id=4 THEN -34 ELSE 48 END WHERE photo_id BETWEEN 1 AND 5`)
    for (const kind of ['photo', 'event'] as const) {
      for (const suffix of ['', '&mode=semantic&related=true']) {
        const r = await pagedSearch(
          kind,
          new Request('https://app/api/search?q=Keith+in+paris+in+summer' + suffix),
          ALICE_ALBUMS,
        )
        expect(ids(r, kind === 'photo' ? 'photoId' : 'eventId')).toEqual([1])
      }
    }
    for (const [query, expected] of [
      ['Keith in Paris in spring', [3]],
      ['in Las Vegas in July', [2]],
      ['in Sydney during summer', [4]],
      ['in Sydney during winter', []],
      ['Dana in Paris in spring', []],
      ['in Atlantis in summer', []],
    ] as const) {
      expect(ids(await search('photo', { ...options, query }, ALICE_ALBUMS))).toEqual(expected)
    }
    await db.exec(
      "UPDATE events SET location='Paris, France' WHERE event_id=1; UPDATE photos SET city=NULL WHERE photo_id=1",
    )
    expect(
      ids(await search('photo', { ...options, query: 'Keith in Paris in summer' }, ALICE_ALBUMS)),
    ).toEqual([1])
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockImplementation(async () =>
      Response.json({
        results: [3, 2, 5, 1].map((PHOTO_ID) => ({ PHOTO_ID, '@scores': { reranker_score: 1 } })),
      }),
    )
    const mixed = new Request(
      'https://app/api/search?q=Keith+eating+in+paris+in+summer&related=true',
    )
    expect(ids(await pagedSearch('photo', mixed, ALICE_ALBUMS))).toEqual([1])
    expect(ids(await pagedSearch('event', mixed, ALICE_ALBUMS), 'eventId')).toEqual([1])
  } finally {
    await db.exec('UPDATE events SET location=NULL WHERE event_id=1')
    for (const row of prior.rows)
      await db.query('UPDATE photos SET city=$2,date_taken=$3,latitude=$4 WHERE photo_id=$1', [
        row.photo_id,
        row.city,
        row.date_taken,
        row.latitude,
      ])
  }
})

it('distinguishes excluded destinations from scenery behind a person across album and photo search', async () => {
  const db = state.db!
  await db.exec('BEGIN')
  await db.exec(
    "UPDATE events SET location=CASE event_id WHEN 1 THEN 'Lakeside, Country A' ELSE 'Highlands, Country A' END WHERE event_id IN (1,2); UPDATE photos SET ai_description='mountains visible across the water' WHERE photo_id=1; UPDATE photos SET city='Capital',country='Country A' WHERE photo_id=2",
  )
  try {
    const plan = {
      branches: [{ include: ['Dana'], exclude: [] }],
      place: 'Country A',
      excludedPlaces: ['Capital', 'Highlands'],
      keywords: '',
      excludedKeywords: [],
      fromYear: null,
      throughYear: null,
      clarification: null,
    }
    intentMock.mockResolvedValue({ intent: plan, metrics: {} })
    const query = 'Dana in Country A but not in Capital or the highlands'
    expect(ids(await search('photo', { ...options, query }, ALICE_ALBUMS))).toEqual([1])
    expect(ids(await search('event', { ...options, query }, ALICE_ALBUMS), 'eventId')).toEqual([1])
    intentMock.mockResolvedValue({
      intent: { ...plan, excludedKeywords: ['mountains'] },
      metrics: {},
    })
    expect(
      ids(
        await search(
          'photo',
          { ...options, query: 'Dana in Country A but without mountains visible' },
          ALICE_ALBUMS,
        ),
      ),
    ).toEqual([])
    intentMock.mockResolvedValue({
      intent: {
        ...plan,
        place: null,
        alternativePlaces: ['Capital', 'Lakeside'],
        excludedPlaces: [],
      },
      metrics: {},
    })
    expect(
      ids(
        await search('photo', { ...options, query: 'Dana in Capital or Lakeside' }, ALICE_ALBUMS),
      ).sort(),
    ).toEqual([1, 2])
    await db.exec(
      "UPDATE events SET location=CASE event_id WHEN 1 THEN 'Lake Como, Italy' ELSE 'Dolomites, Italy' END WHERE event_id IN (1,2);UPDATE photos SET city=NULL,country=NULL WHERE photo_id=3",
    )
    intentMock.mockResolvedValue({
      intent: {
        ...plan,
        branches: [{ include: ['Keith'], exclude: [] }],
        place: 'Italy',
        excludedPlaces: ['Rome'],
        excludeMountainDestinations: true,
      },
      metrics: {},
    })
    expect(
      ids(
        await search(
          'photo',
          { ...options, query: 'Keith in Italy but not Rome or the mountains' },
          ALICE_ALBUMS,
        ),
      ),
    ).toEqual([1])
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    await db.exec('ROLLBACK')
  }
})

it('checks required and forbidden matches across person, destination, period, visual exclusion and permissions', async () => {
  const db = state.db!
  const { searchInterpreted } = await import('@/lib/search')
  const rows = [
    {
      id: 1,
      event: 1,
      people: ['Dana', 'Keith Lambert'],
      city: 'Lakeside',
      country: 'North',
      year: 2024,
      dinner: false,
    },
    {
      id: 2,
      event: 1,
      people: ['Dana'],
      city: 'Capital',
      country: 'North',
      year: 2024,
      dinner: true,
    },
    {
      id: 3,
      event: 2,
      people: ['Keith Lambert'],
      city: 'Summit',
      country: 'South',
      year: 2025,
      dinner: false,
    },
  ]
  await db.exec('BEGIN')
  try {
    await db.exec(
      "UPDATE photos SET city=NULL,country=NULL WHERE photo_id=3; UPDATE events SET location=CASE event_id WHEN 1 THEN 'Lakeside, North' ELSE 'Summit, South' END WHERE event_id IN (1,2); UPDATE photos SET city='Capital',country='North' WHERE photo_id=2",
    )
    for (const person of ['Dana', 'Keith Lambert'])
      for (const country of [null, 'North', 'South'])
        for (const excluded of [null, 'Capital', 'Summit'])
          for (const fromYear of [null, 2025])
            for (const excludeDinner of [false, true]) {
              const expected = rows.filter(
                (r) =>
                  r.people.includes(person) &&
                  (!country || r.country === country) &&
                  r.city !== excluded &&
                  (!fromYear || r.year >= fromYear) &&
                  (!excludeDinner || !r.dinner),
              )
              const plan = {
                branches: [{ include: [person], exclude: [] }],
                place: country,
                excludedPlaces: excluded ? [excluded] : [],
                fromYear,
                throughYear: null,
                keywords: '',
                excludedKeywords: excludeDinner ? ['dinner'] : [],
                clarification: null,
              }
              for (const kind of ['photo', 'event'] as const) {
                const actual = await searchInterpreted(kind, options, ALICE_ALBUMS, [], plan)
                const key = kind === 'photo' ? 'photoId' : 'eventId'
                expect(new Set(ids(actual, key)), JSON.stringify({ kind, plan })).toEqual(
                  new Set(expected.map((r) => (kind === 'photo' ? r.id : r.event))),
                )
              }
            }
  } finally {
    await db.exec('ROLLBACK')
  }
})

it('filters typed photo and album metadata before paging and rejects unknown filters', async () => {
  const db = state.db!
  await db.exec('BEGIN')
  try {
    await db.exec(
      'UPDATE photos SET iso=400, flash_used=false WHERE photo_id=1; UPDATE photos SET iso=800,flash_used=true WHERE photo_id=2',
    )
    const { searchInterpreted } = await import('@/lib/search')
    const { validateIntent } = await import('@/lib/search/search-intent')
    const { metadataFields } = await import('@/lib/search/search-metadata')
    const plan = {
      branches: [{ include: ['Dana'], exclude: [] }],
      keywords: '',
      excludedKeywords: [],
      fromYear: null,
      throughYear: null,
      clarification: null,
    }
    for (const [field, { kind }] of metadataFields) {
      const value =
        kind === 'text'
          ? 'no such text'
          : kind === 'number'
            ? '8888'
            : kind === 'boolean'
              ? 'true'
              : '2024-01-01'
      const validated = validateIntent({ ...plan, metadata: [{ field, op: 'equals', value }] })
      await searchInterpreted('photo', options, ALICE_ALBUMS, [], validated)
    }
    const metadata = [
      { field: 'iso', op: 'gte', value: '800' },
      { field: 'flash_used', op: 'equals', value: 'true' },
      { field: 'album_event_name', op: 'contains', value: 'beach' },
    ]
    intentMock.mockResolvedValue({ intent: { ...plan, metadata }, metrics: {} })
    expect(
      ids(
        await search(
          'photo',
          { ...options, query: 'Dana at ISO 800 or higher with flash in the Beach album' },
          ALICE_ALBUMS,
        ),
      ),
    ).toEqual([2])
    for (const filter of [
      { field: 'password', op: 'equals', value: 'x' },
      { field: 'iso', op: 'gt', value: 'foo' },
      { field: 'date_taken', op: 'lt', value: '2025-02-30' },
    ])
      expect(() => validateIntent({ ...plan, metadata: [filter] })).toThrow()
  } finally {
    await db.exec('ROLLBACK')
  }
})

it('search sees a corrected face immediately without publishing a new search copy', async () => {
  const db = state.db!
  const assignment = (
    await db.query<{ face_id: string; person_id: string; status: string }>(
      'SELECT a.face_id,a.person_id,a.status FROM face_assignments a JOIN faces f USING(face_id) WHERE f.photo_id=2 LIMIT 1',
    )
  ).rows[0]
  const queueBefore = (await db.query('SELECT * FROM search_queue ORDER BY kind,id')).rows
  const revision = async () =>
    (await db.query<{ value: string }>("SELECT search_scope_revision(ARRAY[1,2],'ALICE') AS value"))
      .rows[0].value
  const before = await revision()
  try {
    await db.query("UPDATE face_assignments SET person_id=$1,status='confirmed' WHERE face_id=$2", [
      KEITH,
      assignment.face_id,
    ])
    expect(ids(await search('photo', { ...options, people: [KEITH] }, ALICE_ALBUMS))).toContain(2)
    expect(ids(await search('photo', { ...options, people: [DANA] }, ALICE_ALBUMS))).not.toContain(
      2,
    )
    expect(await revision()).not.toBe(before)
    expect((await db.query('SELECT * FROM search_queue ORDER BY kind,id')).rows).toEqual(
      queueBefore,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    await db.query('UPDATE face_assignments SET person_id=$1,status=$2 WHERE face_id=$3', [
      assignment.person_id,
      assignment.status,
      assignment.face_id,
    ])
  }
})

// Saved candidate IDs cross module boundaries but never replace current row security.
describe('saved search hydration under current permissions', () => {
  it('preserves requested order while dropping foreign and non-ready photos', async () => {
    const { hydrateSearchIds } = await import('@/lib/search')
    await state.db!.exec("UPDATE photos SET ingest_status='PENDING' WHERE photo_id=4")
    try {
      const photos = await hydrateSearchIds('photo', [3, 5, 4, 1], [1, 2, 3])
      expect(photos.map((row) => row.photoId)).toEqual([3, 1])
      const albums = await hydrateSearchIds('event', [2, 3, 1], [1, 2, 3])
      expect(albums.map((row) => row.eventId)).toEqual([2, 1])
      expect(albums.every((row) => 'coverUrl' in row && !('coverPath' in row))).toBe(true)
      expect(await hydrateSearchIds('photo', [1], [])).toEqual([])
    } finally {
      await state.db!.exec("UPDATE photos SET ingest_status='READY' WHERE photo_id=4")
    }
  })

  it('rejects stale saved photo and album IDs immediately after a reader share is revoked', async () => {
    const { hydrateSearchIds } = await import('@/lib/search')
    state.user = 'CAROL'
    expect((await hydrateSearchIds('photo', [3, 2, 1], [1, 2])).map((row) => row.photoId)).toEqual([
      2, 1,
    ])
    await state.db!.exec("DELETE FROM album_shares WHERE event_id=1 AND username='CAROL'")
    try {
      expect(await hydrateSearchIds('photo', [2, 1], [1])).toEqual([])
      expect(await hydrateSearchIds('event', [1], [1])).toEqual([])
    } finally {
      await state.db!.exec(
        "INSERT INTO album_shares(event_id,username,created_by) VALUES(1,'CAROL','ALICE')",
      )
    }
  })
})
